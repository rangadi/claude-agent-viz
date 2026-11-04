#!/usr/bin/env python3
"""Local web viewer for Claude Code session traces.

Reads the JSONL transcripts Claude Code writes under ~/.claude/projects and serves
a browser UI on 127.0.0.1. Standard library only; requires Python 3.14+.

    python3 server.py [--port 8765] [--root ~/.claude/projects]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import threading
from collections import OrderedDict
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

STATIC_DIR = Path(__file__).resolve().parent / "static"
CLIP = 4000  # chars of any one text field sent inline; the rest is fetched on demand
HEAD_SCAN_BYTES = 4 * 1024 * 1024
TAIL_SCAN_BYTES = 256 * 1024

SAFE_DIR = re.compile(r"^[A-Za-z0-9._-]+$")
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]+$")

ROOT: Path = Path.home() / ".claude" / "projects"


# ---------------------------------------------------------------- helpers

def parse_ts(s: Any) -> Optional[float]:
    """ISO timestamp -> epoch milliseconds."""
    if not isinstance(s, str):
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return None


def iter_jsonl_at(path: Path):
    """Yield (byte offset, record), skipping lines that don't parse (e.g. a partial write at EOF)."""
    with path.open("rb") as f:
        off = 0
        for line in f:
            try:
                yield off, json.loads(line)
            except ValueError:
                pass
            off += len(line)


def iter_jsonl(path: Path):
    for _, d in iter_jsonl_at(path):
        yield d


def read_records_at(path: Path, offsets: List[int]) -> List[Any]:
    """Re-read the JSONL records that start at the given byte offsets."""
    out = []
    with path.open("rb") as f:
        for off in offsets:
            f.seek(off)
            try:
                out.append(json.loads(f.readline()))
            except ValueError:
                continue
    return out


REMINDER_RE = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
TAG_RE = re.compile(r"</?[a-zA-Z][\w-]*(?:\s[^<>]*)?>")
CMD_NAME_RE = re.compile(r"<command-name>(.*?)</command-name>", re.S)
CMD_ARGS_RE = re.compile(r"<command-args>(.*?)</command-args>", re.S)


def clean_prompt(text: str) -> str:
    """One-line human-readable preview of a prompt: drops reminders and markup tags."""
    m = CMD_NAME_RE.search(text)
    if m:
        args = CMD_ARGS_RE.search(text)
        name = m.group(1).strip()
        if not name.startswith("/"):
            name = "/" + name
        text = name + (" " + args.group(1).strip() if args else "")
    else:
        text = REMINDER_RE.sub("", text)
        text = TAG_RE.sub("", text)
    return " ".join(text.split())


def content_text(content: Any) -> Tuple[str, int]:
    """Flatten message content into text. Returns (text, image_count); image data is dropped."""
    if isinstance(content, str):
        return content, 0
    if not isinstance(content, list):
        return "", 0
    parts: List[str] = []
    images = 0
    for b in content:
        if not isinstance(b, dict):
            continue
        bt = b.get("type")
        if bt == "text":
            parts.append(b.get("text") or "")
        elif bt == "image":
            images += 1
            parts.append("[image]")
        elif bt == "tool_reference":
            parts.append("[tool reference: %s]" % b.get("tool_name", ""))
        elif bt == "document":
            parts.append("[document]")
        else:
            parts.append(json.dumps(b, indent=2)[:CLIP])
    return "\n".join(parts), images


def to_text(v: Any) -> str:
    if isinstance(v, str):
        return v
    return json.dumps(v, indent=2, ensure_ascii=False)


def tool_summary(name: str, inp: Dict[str, Any]) -> str:
    """Short description of a tool call for its collapsed row."""
    if not isinstance(inp, dict):
        return ""
    for key in ("description", "command", "file_path", "path", "pattern", "url", "query",
                "prompt", "skill", "notebook_path", "selector", "title", "name"):
        v = inp.get(key)
        if isinstance(v, str) and v.strip():
            if name == "Bash" and key == "description" and isinstance(inp.get("command"), str):
                return "%s — %s" % (v, inp["command"])
            return v
    for v in inp.values():
        if isinstance(v, str) and v.strip():
            return v
    return ""


def short_project(cwd: str) -> str:
    home = str(Path.home())
    return "~" + cwd[len(home):] if cwd.startswith(home) else cwd


# ---------------------------------------------------------------- parsing

class Clipper:
    """Per-session side store, filled while parsing.

    - Clips long strings for the inline payload and keeps the full text for /api/full.
    - Records which JSONL lines (byte offsets) each displayed item came from, for /api/raw.
    - Indexes every record's offset and parentUuid, so /api/context can walk a call's history."""

    def __init__(self) -> None:
        self.full: Dict[str, str] = {}
        self.raw: Dict[str, List[int]] = {}
        self.records: Dict[str, Tuple[int, Optional[str]]] = {}  # uuid -> (offset, parentUuid)
        self.ctx_start: Dict[str, Optional[str]] = {}  # "call:<message id>" -> parentUuid of its first record

    def link(self, item: Dict[str, Any], key: str, off: int) -> None:
        item["raw"] = key
        offs = self.raw.setdefault(key, [])
        if off not in offs:
            offs.append(off)

    def __call__(self, key: str, text: str) -> Dict[str, Any]:
        if len(text) <= CLIP:
            return {"t": text}
        self.full[key] = text
        return {"t": text[:CLIP], "n": len(text), "k": key}


CTX_CLIP = 1500  # inline chars per context entry; the rest goes through /api/full


def context_entries(d: Dict[str, Any], tool_names: Dict[str, str]) -> List[Dict[str, Any]]:
    """What one transcript record contributes to the model's context. Empty if it isn't sent.

    Attachments without `rendered` text (bookkeeping such as deferred-tool records) and
    system records (hook summaries, local command logs) are not part of the request."""
    typ = d.get("type")
    out: List[Dict[str, Any]] = []

    def add(kind: str, label: str, text: str, images: int = 0) -> None:
        out.append({"kind": kind, "label": label, "text": text, "images": images})

    if typ == "attachment":
        r = d.get("rendered")
        if r:
            parts = r if isinstance(r, list) else [r]
            text = "\n".join(to_text(x.get("content") if isinstance(x, dict) else x) for x in parts)
            add("injected context", (d.get("attachment") or {}).get("type") or "attachment", text)
    elif typ == "user":
        content = (d.get("message") or {}).get("content")
        blocks = content if isinstance(content, list) else [{"type": "text", "text": content or ""}]
        if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in blocks):
            for b in blocks:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "tool_result":
                    text, images = content_text(b.get("content"))
                    add("tool result", tool_names.get(b.get("tool_use_id"), "tool"), text, images)
                else:
                    text, images = content_text([b])
                    add("user", "text", text, images)
        else:
            text, images = content_text(content)
            origin = (d.get("origin") or {}).get("kind")
            if d.get("isCompactSummary"):
                add("compact summary", "summary", text, images)
            elif origin == "human" or (origin is None and not d.get("isMeta")):
                add("prompt", "human", text, images)
            else:
                add("user meta", origin or "meta", text, images)
    elif typ == "assistant":
        for b in (d.get("message") or {}).get("content") or []:
            if not isinstance(b, dict):
                continue
            bt = b.get("type")
            if bt == "text":
                add("assistant", "text", b.get("text") or "")
            elif bt in ("tool_use", "server_tool_use"):
                add("tool call", b.get("name") or "?", to_text(b.get("input") or {}))
            elif bt in ("thinking", "redacted_thinking"):
                add("thinking", "redacted" if not b.get("thinking") else "text", b.get("thinking") or "")
            elif (bt or "").endswith("_tool_result"):
                add("tool result", tool_names.get(b.get("tool_use_id"), "server tool"), to_text(b.get("content")))
    return out


def build_context(path: Path, store: "Clipper", key: str) -> Optional[Dict[str, Any]]:
    """Reconstruct the message history sent with one API call by walking parentUuid links.

    The walk ends at the session start or at a compaction boundary, whose summary
    replaces everything before it."""
    if key not in store.ctx_start:
        return None
    chain: List[int] = []
    seen = set()
    u = store.ctx_start[key]
    while u and u not in seen and u in store.records:
        seen.add(u)
        off, u = store.records[u]
        chain.append(off)
    records = read_records_at(path, list(reversed(chain)))
    tool_names = {b.get("id"): b.get("name") for d in records if d.get("type") == "assistant"
                  for b in (d.get("message") or {}).get("content") or []
                  if isinstance(b, dict) and b.get("type") in ("tool_use", "server_tool_use")}
    boundary = None
    if records and records[0].get("type") == "system" and records[0].get("subtype") == "compact_boundary":
        boundary = records[0].get("compactMetadata") or {}
    entries = []
    skipped = 0
    for d in records:
        es = context_entries(d, tool_names)
        if not es and d.get("type") in ("attachment", "system"):
            skipped += 1
        for j, e in enumerate(es):
            text = e.pop("text")
            ck = "ctx:%s:%d" % (d.get("uuid"), j)
            e.update({"uuid": d.get("uuid"), "ts": parse_ts(d.get("timestamp")), "chars": len(text),
                      "raw": "rec:%s" % d.get("uuid")})
            if len(text) > CTX_CLIP:
                store.full[ck] = text
                e["text"] = {"t": text[:CTX_CLIP], "n": len(text), "k": ck}
            else:
                e["text"] = {"t": text}
            entries.append(e)
    return {"entries": entries, "records": len(records), "skipped": skipped,
            "compactBoundary": boundary}


def load_subagent_links(session_dir: Path) -> Dict[str, Dict[str, Any]]:
    """Map Agent tool_use ids to the subagent transcripts they spawned."""
    links: Dict[str, Dict[str, Any]] = {}
    sub = session_dir / "subagents"
    if not sub.is_dir():
        return links
    for meta_path in sub.glob("agent-*.meta.json"):
        agent_id = meta_path.name[len("agent-"):-len(".meta.json")]
        try:
            meta = json.loads(meta_path.read_text())
        except (OSError, ValueError):
            continue
        tid = meta.get("toolUseId")
        if tid and (sub / ("agent-%s.jsonl" % agent_id)).exists():
            links[tid] = {"agentId": agent_id, "agentType": meta.get("agentType"),
                          "description": meta.get("description")}
    return links


def parse_session(path: Path, subagent_links: Dict[str, Dict[str, Any]]) -> Tuple[Dict[str, Any], Clipper]:
    clip = Clipper()
    info: Dict[str, Any] = {"title": None, "agentName": None, "cwd": None, "gitBranch": None,
                            "version": None, "cost": None, "prs": [], "models": []}
    turns: List[Dict[str, Any]] = []
    calls: Dict[str, Dict[str, Any]] = {}
    tools: Dict[str, Dict[str, Any]] = {}
    state = {"last_input": None, "last_call_end": None, "n_calls": 0}

    def turn(kind: str, ts: Optional[float], raw: str, images: int, key: str,
             off: Optional[int] = None) -> Dict[str, Any]:
        t = {"key": key, "kind": kind, "ts": ts, "preview": clean_prompt(raw)[:300],
             "prompt": clip("prompt:" + key, raw), "images": images, "items": []}
        if off is not None:
            clip.link(t, "turn:" + key, off)
        turns.append(t)
        return t

    def current(ts: Optional[float]) -> Dict[str, Any]:
        if not turns:
            return turn("start", ts, "", 0, "start")
        return turns[-1]

    def meta_item(ts: Optional[float], label: str, text: str, key: str, off: int) -> None:
        item = {"type": "meta", "ts": ts, "label": label, "text": clip("meta:" + key, text)}
        clip.link(item, "meta:" + key, off)
        current(ts)["items"].append(item)

    for off, d in iter_jsonl_at(path):
        if d.get("uuid"):
            clip.records[d["uuid"]] = (off, d.get("parentUuid"))
            clip.raw["rec:" + d["uuid"]] = [off]
        typ = d.get("type")
        ts = parse_ts(d.get("timestamp"))
        if info["cwd"] is None and d.get("cwd"):
            info["cwd"] = d.get("cwd")
        if d.get("gitBranch"):
            info["gitBranch"] = d.get("gitBranch")
        if d.get("version"):
            info["version"] = d.get("version")

        if typ == "user":
            msg = d.get("message") or {}
            content = msg.get("content")
            results = [b for b in content if isinstance(b, dict) and b.get("type") == "tool_result"] \
                if isinstance(content, list) else []
            if results:
                tur = d.get("toolUseResult")
                for b in results:
                    tool = tools.get(b.get("tool_use_id"))
                    if tool is None:
                        continue
                    out, _ = content_text(b.get("content"))
                    clip.link(tool, "tool:" + tool["id"], off)
                    tool["resultTs"] = ts
                    tool["isError"] = bool(b.get("is_error"))
                    tool["output"] = clip("out:" + tool["id"], out)
                    if isinstance(tur, dict) and len(results) == 1:
                        dur = tur.get("totalDurationMs") or tur.get("durationMs")
                        if isinstance(dur, (int, float)):
                            tool["reportedMs"] = dur
                        if tur.get("totalTokens") is not None:
                            tool["agentStats"] = {"tokens": tur.get("totalTokens"),
                                                  "toolUses": tur.get("totalToolUseCount")}
                    if tool["start"] is not None and ts is not None:
                        tool["durationMs"] = ts - tool["start"]
                if ts is not None:
                    state["last_input"] = ts
                continue

            text, images = content_text(content)
            origin = (d.get("origin") or {}).get("kind")
            key = d.get("uuid") or str(len(turns))
            if d.get("isCompactSummary"):
                item = {"type": "compact", "ts": ts, "text": clip("meta:" + key, text)}
                clip.link(item, "meta:" + key, off)
                current(ts)["items"].append(item)
            elif origin == "human" or origin == "task-notification" or (
                    origin is None and not d.get("isMeta") and not text.startswith("[Request interrupted")):
                turn("task" if origin == "task-notification" else "human", ts, text, images, key, off)
            elif text.startswith("[Request interrupted"):
                meta_item(ts, "interrupted", text, key, off)
            else:
                meta_item(ts, origin or "context", text, key, off)
            if ts is not None:
                state["last_input"] = ts

        elif typ == "assistant":
            msg = d.get("message") or {}
            mid = msg.get("id") or d.get("uuid")
            call = calls.get(mid)
            if call is None:
                starts = [x for x in (state["last_input"], state["last_call_end"]) if x is not None]
                state["n_calls"] += 1
                call = {"type": "call", "id": mid, "n": state["n_calls"], "requestId": d.get("requestId"),
                        "model": msg.get("model"), "start": max(starts) if starts else ts,
                        "firstTs": ts, "end": ts, "stopReason": None, "usage": None,
                        "texts": [], "thinking": 0, "tools": [], "error": bool(d.get("isApiErrorMessage"))}
                calls[mid] = call
                clip.ctx_start["call:" + mid] = d.get("parentUuid")
                current(ts)["items"].append(call)
                if call["model"] and call["model"] not in info["models"] and call["model"] != "<synthetic>":
                    info["models"].append(call["model"])
            clip.link(call, "call:" + mid, off)
            call["end"] = ts if ts is not None else call["end"]
            call["stopReason"] = msg.get("stop_reason") or call["stopReason"]
            if msg.get("usage"):
                call["usage"] = msg["usage"]
            for i, b in enumerate(msg.get("content") or []):
                if not isinstance(b, dict):
                    continue
                bt = b.get("type")
                if bt == "text":
                    call["texts"].append(clip("text:%s:%d" % (d.get("uuid"), i), b.get("text") or ""))
                elif bt in ("thinking", "redacted_thinking"):
                    call["thinking"] += 1
                    if b.get("thinking"):
                        call.setdefault("thinkingText", []).append(
                            clip("think:%s:%d" % (d.get("uuid"), i), b["thinking"]))
                elif bt in ("tool_use", "server_tool_use"):
                    tid = b.get("id") or "%s:%d" % (d.get("uuid"), i)
                    name = b.get("name") or "?"
                    inp = b.get("input") if isinstance(b.get("input"), dict) else {}
                    tool = {"id": tid, "name": name, "server": bt == "server_tool_use", "start": ts,
                            "summary": tool_summary(name, inp)[:300],
                            "input": {k: clip("in:%s:%s" % (tid, k), to_text(v)) for k, v in inp.items()},
                            "resultTs": None, "durationMs": None, "isError": False, "output": None}
                    clip.link(tool, "tool:" + tid, off)
                    if tid in subagent_links:
                        tool["subagent"] = subagent_links[tid]
                    tools[tid] = tool
                    call["tools"].append(tool)
                elif (bt or "").endswith("_tool_result") and b.get("tool_use_id") in tools:
                    tool = tools[b["tool_use_id"]]
                    clip.link(tool, "tool:" + tool["id"], off)
                    tool["resultTs"] = ts
                    tool["output"] = clip("out:" + tool["id"], to_text(b.get("content")))
                    if tool["start"] is not None and ts is not None:
                        tool["durationMs"] = ts - tool["start"]
            if ts is not None:
                state["last_call_end"] = ts

        elif typ == "system":
            sub = d.get("subtype")
            key = d.get("uuid") or str(ts)
            if sub == "compact_boundary":
                item = {"type": "compact", "ts": ts, "text": {"t": "Context compacted"}}
                clip.link(item, "meta:" + key, off)
                current(ts)["items"].append(item)
            elif sub in ("local_command", "informational", "api_error") or d.get("level") == "error":
                meta_item(ts, sub or "system", to_text(d.get("content") or d.get("error") or ""), key, off)

        elif typ == "custom-title":
            info["title"] = d.get("customTitle") or info["title"]
        elif typ == "agent-name":
            info["agentName"] = d.get("agentName") or info["agentName"]
        elif typ == "summary" and not info["title"]:
            info["title"] = d.get("summary")
        elif typ == "cost-state":
            info["cost"] = d.get("totalCostUSD")
        elif typ == "pr-link" and d.get("prUrl") and d["prUrl"] not in info["prs"]:
            info["prs"].append(d["prUrl"])

    info["turns"] = turns
    return info, clip


# ---------------------------------------------------------------- session index

class Index:
    """Session list metadata, cached per file by (mtime, size)."""

    def __init__(self) -> None:
        self.cache: Dict[str, Tuple[Tuple[float, int], Dict[str, Any]]] = {}
        self.lock = threading.Lock()

    def list(self) -> List[Dict[str, Any]]:
        out = []
        if not ROOT.is_dir():
            return out
        for pdir in ROOT.iterdir():
            if not pdir.is_dir():
                continue
            for f in pdir.glob("*.jsonl"):
                try:
                    st = f.stat()
                except OSError:
                    continue
                sig = (st.st_mtime, st.st_size)
                with self.lock:
                    hit = self.cache.get(str(f))
                if hit and hit[0] == sig:
                    out.append(hit[1])
                    continue
                meta = self.scan(f, st)
                with self.lock:
                    self.cache[str(f)] = (sig, meta)
                out.append(meta)
        out.sort(key=lambda m: m["lastActivity"], reverse=True)
        return out

    @staticmethod
    def scan(f: Path, st: os.stat_result) -> Dict[str, Any]:
        meta: Dict[str, Any] = {"project": f.parent.name, "session": f.stem, "mtime": st.st_mtime * 1000,
                                "size": st.st_size, "cwd": None, "gitBranch": None, "firstPrompt": None,
                                "lastPrompt": None, "title": None, "start": None,
                                "subagents": len(list((f.parent / f.stem / "subagents").glob("agent-*.jsonl")))
                                if (f.parent / f.stem / "subagents").is_dir() else 0}
        with f.open("rb") as fh:
            read = 0
            for line in fh:
                read += len(line)
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                meta["cwd"] = meta["cwd"] or d.get("cwd")
                meta["gitBranch"] = meta["gitBranch"] or d.get("gitBranch")
                meta["start"] = meta["start"] or parse_ts(d.get("timestamp"))
                if d.get("type") == "user" and not d.get("isMeta") and meta["firstPrompt"] is None:
                    content = (d.get("message") or {}).get("content")
                    if isinstance(content, list) and any(
                            isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
                        continue
                    origin = (d.get("origin") or {}).get("kind")
                    if origin in (None, "human"):
                        text, _ = content_text(content)
                        meta["firstPrompt"] = clean_prompt(text)[:300]
                if (meta["firstPrompt"] and meta["cwd"]) or read > HEAD_SCAN_BYTES:
                    break
            fh.seek(max(0, st.st_size - TAIL_SCAN_BYTES))
            tail = fh.read().splitlines()
        title = agent_name = summary = last_ts = None
        for line in tail:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            t = d.get("type")
            if t == "custom-title":
                title = d.get("customTitle") or title
            elif t == "agent-name":
                agent_name = d.get("agentName") or agent_name
            elif t == "summary":
                summary = d.get("summary") or summary
            elif t == "last-prompt" and d.get("lastPrompt"):
                meta["lastPrompt"] = clean_prompt(d["lastPrompt"])[:300]
            if d.get("gitBranch"):
                meta["gitBranch"] = d["gitBranch"]
            last_ts = parse_ts(d.get("timestamp")) or last_ts
        meta["title"] = title or agent_name or summary
        # Claude Code can append untimestamped bookkeeping records (last-prompt, cost-state)
        # to old transcripts, so file mtime overstates recent activity.
        meta["lastActivity"] = last_ts or meta["start"] or meta["mtime"]
        meta["cwdShort"] = short_project(meta["cwd"]) if meta["cwd"] else f.parent.name
        return meta


class SessionCache:
    """Parsed sessions, keyed by file and invalidated on (mtime, size) change."""

    def __init__(self, capacity: int = 8) -> None:
        self.capacity = capacity
        self.items: "OrderedDict[str, Tuple[Tuple[float, int], Dict[str, Any], Clipper]]" = OrderedDict()
        self.lock = threading.Lock()

    def get(self, path: Path, session_dir: Path) -> Tuple[Dict[str, Any], Clipper]:
        st = path.stat()
        sig = (st.st_mtime, st.st_size)
        with self.lock:
            hit = self.items.get(str(path))
            if hit and hit[0] == sig:
                self.items.move_to_end(str(path))
                return hit[1], hit[2]
        data, store = parse_session(path, load_subagent_links(session_dir))
        data["mtime"] = st.st_mtime * 1000
        data["size"] = st.st_size
        with self.lock:
            self.items[str(path)] = (sig, data, store)
            while len(self.items) > self.capacity:
                self.items.popitem(last=False)
        return data, store


INDEX = Index()
SESSIONS = SessionCache()


def resolve(q: Dict[str, List[str]]) -> Tuple[Path, Path]:
    """Map query ids (p=project dir, s=session id, a=optional agent id) to a transcript path.

    Raises ValueError for anything that isn't a plain id or resolves outside ROOT."""
    p = (q.get("p") or [""])[0]
    s = (q.get("s") or [""])[0]
    a = (q.get("a") or [""])[0]
    if not SAFE_DIR.match(p) or p in (".", "..") or not SAFE_ID.match(s) or (a and not SAFE_ID.match(a)):
        raise ValueError("bad id")
    session_dir = ROOT / p / s
    path = session_dir / "subagents" / ("agent-%s.jsonl" % a) if a else ROOT / p / ("%s.jsonl" % s)
    if ROOT.resolve() not in path.resolve().parents:
        raise ValueError("outside root")
    if not path.is_file():
        raise FileNotFoundError(str(path))
    return path, session_dir


# ---------------------------------------------------------------- http

class Handler(BaseHTTPRequestHandler):
    server_version = "agent-traffic/1"

    def log_message(self, fmt: str, *args: Any) -> None:  # quiet by default
        pass

    def send_json(self, obj: Any, status: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_static(self, name: str) -> None:
        path = (STATIC_DIR / name).resolve()
        if STATIC_DIR not in path.parents or not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        ctype = {".html": "text/html", ".js": "text/javascript", ".css": "text/css"}.get(path.suffix, "text/plain")
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        # Reject other Host names so a DNS-rebinding page can't read transcripts.
        port = self.server.server_address[1]
        if self.headers.get("Host") not in ("127.0.0.1:%d" % port, "localhost:%d" % port):
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        url = urlparse(self.path)
        q = parse_qs(url.query)
        try:
            if url.path == "/":
                self.send_static("index.html")
            elif url.path.startswith("/static/"):
                self.send_static(url.path[len("/static/"):])
            elif url.path == "/api/sessions":
                self.send_json({"root": str(ROOT), "sessions": INDEX.list()})
            elif url.path == "/api/session":
                path, session_dir = resolve(q)
                data, _ = SESSIONS.get(path, session_dir)
                if q.get("a"):
                    meta = path.with_name(path.name[:-len(".jsonl")] + ".meta.json")
                    try:
                        data = dict(data, agent=json.loads(meta.read_text()))
                    except (OSError, ValueError):
                        pass
                self.send_json(data)
            elif url.path == "/api/stat":
                path, _ = resolve(q)
                st = path.stat()
                self.send_json({"mtime": st.st_mtime * 1000, "size": st.st_size})
            elif url.path == "/api/full":
                path, session_dir = resolve(q)
                _, store = SESSIONS.get(path, session_dir)
                key = (q.get("k") or [""])[0]
                if key not in store.full:
                    self.send_json({"error": "not found"}, 404)
                else:
                    self.send_json({"t": store.full[key]})
            elif url.path == "/api/context":
                path, session_dir = resolve(q)
                _, store = SESSIONS.get(path, session_dir)
                ctx = build_context(path, store, (q.get("k") or [""])[0])
                if ctx is None:
                    self.send_json({"error": "not found"}, 404)
                else:
                    self.send_json(ctx)
            elif url.path == "/api/raw":
                path, session_dir = resolve(q)
                _, store = SESSIONS.get(path, session_dir)
                key = (q.get("k") or [""])[0]
                if key not in store.raw:
                    self.send_json({"error": "not found"}, 404)
                else:
                    self.send_json({"records": read_records_at(path, store.raw[key])})
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
        except ValueError:
            self.send_json({"error": "bad request"}, 400)
        except FileNotFoundError:
            self.send_json({"error": "not found"}, 404)
        except Exception as e:  # surface parser bugs on odd transcripts instead of dropping the connection
            self.send_json({"error": "%s: %s" % (type(e).__name__, e)}, 500)


def main() -> None:
    global ROOT
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8765")))
    ap.add_argument("--root", default=str(ROOT), help="Claude projects dir (default: ~/.claude/projects)")
    args = ap.parse_args()
    ROOT = Path(os.path.expanduser(args.root)).resolve()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("agent-traffic: http://127.0.0.1:%d  (reading %s)" % (args.port, ROOT), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

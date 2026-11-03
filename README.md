# Agent Traffic

A local web viewer for Claude Code session traces. It reads the JSONL transcripts that
Claude Code writes under `~/.claude/projects` and shows each session's prompts, API
round trips, tool calls and timings, newest first.

```bash
uv run server.py             # http://127.0.0.1:8765
uv run server.py --port 9000 --root /path/to/projects
```

It has no dependencies beyond the Python 3.9+ standard library, so `python3 server.py`
works too. The server binds to `127.0.0.1`
only, because transcripts contain prompts, file paths and command output.

## What you see

- **Sessions**: every transcript, most recently active first. Filter by title,
  prompt, project or branch. A green dot means the file changed in the last two minutes.
- **Turns**: one card per prompt (human prompts, plus task notifications that wake the
  agent). The collapsed row shows wall time, API calls, tool calls and output tokens.
  The newest turn starts expanded. The strip under the prompt is a timeline: blue for
  model requests, orange for tool execution.
- **Round trips**: one row per API response, with model, latency, input/output tokens,
  stop reason and the tools it called. Expand a row for the token breakdown, assistant
  text, and each tool call's arguments and output.
- **Subagents**: an `Agent` tool call links to the subagent's own trace.

Live refresh re-polls the open transcript every 2.5 seconds and keeps your expanded rows open.

## How timings are derived

Transcripts record when each record was written, not when requests were sent, so the
numbers are reconstructed:

- An API response is spread over several `assistant` records that share a `message.id`.
  They are grouped back into one round trip, and its `usage` is counted once.
- **Request start** is the later of the previous input record (prompt or tool result)
  and the previous response's last block. **Latency** runs from there to the response's
  last block. "First block" is when the first content block was written, which is later
  than time-to-first-token.
- **Tool duration** runs from the `tool_use` block to its `tool_result` record.

## Layout

- `server.py`: transcript parsing, session index (cached by file mtime and size), JSON API.
- `static/`: the single-page UI, in plain JS. All transcript content is inserted with
  `textContent`. Keep it that way, because prompts and tool output contain arbitrary markup.

Text fields longer than 4,000 characters are clipped in the session payload. The UI
fetches the full value from `/api/full` when you click "show all".

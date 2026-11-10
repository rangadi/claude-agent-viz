# Agent Traffic

A local web viewer for Claude Code session traces. It reads the JSONL transcripts that
Claude Code writes under `~/.claude/projects` and shows each session's prompts, API
round trips, tool calls and timings, newest first.

```bash
uv run server.py             # http://127.0.0.1:8765
uv run server.py --port 9000 --root /path/to/projects
```

Requires Python 3.14+. It uses only the standard library, so any Python 3.14
interpreter can also run `server.py` directly. The server binds to `127.0.0.1` only,
because transcripts contain prompts, file paths and command output.

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
- **Markdown**: prompts and assistant text render as markdown. A "raw text" link under
  each block switches it to the exact characters. Tool output and thinking stay plain.
- **Subagents**: an `Agent` tool call links to the subagent's own trace.
- **Context**: each round trip has a "Context" panel that rebuilds the message history
  sent with that call when you open it. It shows a breakdown by kind (tool results,
  injected reminders, assistant text and so on) and each entry with an approximate token
  size, sortable by size. See [Reconstructed context](#reconstructed-context).
- **Raw JSON**: every prompt, round trip, tool call and meta row has a "Raw JSON" panel
  with the transcript records it was built from, pretty-printed. For a round trip that
  is each record sharing its `message.id`. For a tool call it is the `tool_use` record
  and the `tool_result` record.

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

## Reconstructed context

Each record links to the previous one through `parentUuid`. The context for a call is
the chain from its first record back to the session start, or back to a compaction
boundary, where the summary replaces earlier history. Injected `<system-reminder>`
blocks come from each attachment record's `rendered` field. Attachments without that
field, and system records, are not sent to the model and are left out.

The transcript does not store the system prompt, the tool definitions, or thinking
text, so the visible entries add up to less than the call's actual input tokens (the
exact total from `usage`). Per-entry sizes are estimates, at 4 characters per token.

## Layout

- `server.py`: transcript parsing, session index (cached by file mtime and size), JSON API.
- `static/`: the single-page UI, in plain JS. All transcript content is inserted with
  `textContent`. Keep it that way, because prompts and tool output contain arbitrary markup.
  `static/markdown.js` follows the same rule: it builds DOM nodes, links only http(s) and
  mailto targets, and shows images as links without loading them.

Text fields longer than 4,000 characters are clipped in the session payload. The UI
fetches the full value from `/api/full` when you click "show all".

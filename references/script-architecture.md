# Script Architecture

How `search.js` works internally. Read this when you need to debug, extend, or write a new sub-command.

## State machine

```
[init] → open → login-check → ensure-model → send → wait → extract → [done]
            ↓         ↓             ↓           ↓       ↓        ↓
          exit 4   exit 4        exit 4      exit 4  exit 3   exit 4
```

Each stage writes a record to the per-session state file when it completes successfully. On `--resume`, stages marked `done` are skipped; stages that fail mid-execution don't get marked done and will be retried.

## State file

Location: `<script dir>/state/<session>.json`. The directory is auto-created on first run.

Schema (v1):
```json
{
  "version": 1,
  "session": "gpt-pro-1",
  "createdAt": 1700000000000,
  "updatedAt": 1700000120000,
  "prompt": "the prompt text that was sent (or attempted)",
  "promptSource": "cli | file:<path> | stdin",
  "output": "/abs/path/to/response.md",
  "model": "auto | pro | extended",
  "stages": {
    "open":        {"done": true,  "at": ..., "data": {"tabId": 123, "url": "https://chatgpt.com/"}},
    "loginCheck":  {"done": true,  "at": ..., "data": {"state": "logged_in"}},
    "ensureModel": {"done": true,  "at": ..., "data": {"from": "thinking", "to": "extended", "changed": true}},
    "send":        {"done": true,  "at": ..., "data": {"chars": 1500, "fillMode": "contenteditable"}},
    "wait":        {"done": true,  "at": ..., "data": {"status": "complete", "elapsed": 105}},
    "extract":     {"done": true,  "at": ..., "data": {"length": 3500, "path": "/abs/path/to/response.md"}}
  }
}
```

The `prompt` field is what was *actually sent* (or attempted). On `--resume`, the `send` stage compares the new prompt argument to this; if they differ, the stage re-runs even if marked done.

## Sub-command lifecycle

Each sub-command is a function that:
1. Reads the current state (if `--resume`).
2. If the stage is `done` AND preconditions still hold (e.g. the tab is still open), exits 0 immediately.
3. Otherwise executes the stage, writes the result to state, exits 0 — or exits 4 with a structured error if it can't proceed.

Stages that take a prompt (`send`, `run`) also accept `-f` and `-` (stdin). When called as `send` directly, the prompt comes from the `prompt` field in state (for `--resume`) or the CLI arg.

## Resume semantics

- Without `--resume`: state is read but not consulted. Every stage runs. This is the default for `run`.
- With `--resume`: each stage is gated on `state.stages[name].done`. Pre-flight checks (e.g. "is the tab still open?") confirm the previous work is still valid; if not, the stage re-runs.
- `cleanup` is always safe to re-run.
- The state file is rewritten on every successful stage completion. If the process crashes mid-stage, the file shows the last completed stage and the next one will retry.

## Automation / robustness

- **Auto-retry on transient errors**: each `cmd()` call retries up to 3 times with exponential backoff (200ms, 600ms, 1800ms) for network / daemon / `extension_error: No current window` cases.
- **Auto-reuse tabs**: `open` calls `find_tab` first; if a ChatGPT tab already exists in the session, it reuses it instead of opening a new one.
- **Auto-cleanup**: on full success, the state file is kept (default) so the Agent can inspect what happened. Pass `--cleanup-state` to delete it. To keep the browser tab open, use `--keep-session` (state still records the run).
- **Idempotent model switch**: `ensure-model` probes the popover, and only clicks the target option if the current selection is different.

## Adding a new sub-command

1. Add a stage name to the `STAGES` constant.
2. Implement `stage<Name>(session, state, args)` that returns `{ok, data}` or `{ok: false, code, message}`.
3. Wire it into the `run` pipeline in the right order.
4. Update the state schema in this doc and the `references/intervention-points.md` if it can fail in a new way.

# Script Architecture

How `search.js` works internally. Read this when you need to debug, extend, or write a new sub-command.

## State machine

```
[init] → open → login-check → ensure-model → ensure-tool → upload → send → wait → extract → [done]
            ↓         ↓             ↓             ↓          ↓       ↓       ↓        ↓
          exit 4   exit 4        exit 4        exit 4     exit 4  exit 4  exit 3   exit 4

image mode:
[init] → open → login-check → ensure-model → ensure-tool → upload → send → wait(image) → extractImages → [done]
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
  "uploads": ["/abs/path/to/brief.pdf"],
  "uploadSelector": "input#upload-files[type=\"file\"]",
  "imageDir": "/abs/or/relative/path/to/generated-images",
  "imagePrefix": "optional-file-prefix",
  "model": "auto | pro | extended | thinking | instant",
  "tool": "auto | none | deep-research | web-search | create-image",
  "images": [],
  "active": {
    "stage": "wait",
    "status": "waiting",
    "kind": "deep-research",
    "startedAt": 1700000060000,
    "updatedAt": 1700000180000,
    "elapsed": 120,
    "waitLimitSec": null,
    "unlimited": true,
    "refreshIntervalSec": 300,
    "lastRefresh": {
      "method": "navigate",
      "elapsed": 300,
      "urlBefore": "https://chatgpt.com/c/...",
      "urlAfter": "https://chatgpt.com/c/..."
    },
    "need": "running/export-probe>=1"
  },
  "stages": {
    "open":        {"done": true,  "at": ..., "data": {"tabId": 123, "url": "https://chatgpt.com/"}},
    "loginCheck":  {"done": true,  "at": ..., "data": {"state": "logged_in"}},
    "ensureModel": {"done": true,  "at": ..., "data": {"from": "thinking", "to": "extended", "changed": true}},
    "ensureTool":  {"done": true,  "at": ..., "data": {"target": "deep-research", "selected": "deep-research", "changed": true}},
    "upload":      {"done": true,  "at": ..., "data": {"files": ["/abs/path/to/brief.pdf"], "selector": "input#upload-files[type=\"file\"]"}},
    "send":        {"done": true,  "at": ..., "data": {"chars": 1500, "assistantBefore": 2, "mode": "replace", "uploadSignature": "[...]"}},
    "wait":        {"done": true,  "at": ..., "data": {"kind": "text", "status": "complete", "elapsed": 650, "length": 4200, "minChars": 240, "stableSec": 60}},
    "extract":     {"done": true,  "at": ..., "data": {"length": 3500, "path": "/abs/path/to/response.md", "assistantIndex": 2}},
    "extractImages": {"done": true, "at": ..., "data": {"imageCount": 1, "manifestPath": "/abs/path/to/manifest.json", "images": [{"path": "/abs/path/to/image.png"}]}}
  }
}
```

The `prompt` field is what was *actually sent* (or attempted). On `--resume`, the `send` stage compares the new prompt argument to this; if they differ, the stage re-runs even if marked done.

`send.data.assistantBefore` records how many assistant messages existed before the current turn. `wait` and `extract` use it to ensure the script is watching the reply for the corresponding turn, not a previous answer.

`uploads` records normalized absolute paths for `--upload` files. The `upload` stage runs after `ensureTool` and before `send`; if upload files change, downstream `send` / `wait` / `extract` state is cleared. Non-resume new prompts do not inherit old uploads unless `--upload` is passed again.

`tool` records an explicit ChatGPT composer tool target. `auto` means "do not change whatever ChatGPT currently has selected." `--deep-research` and `--deep-search` normalize to `deep-research`; `--web-search` normalizes to `web-search`; `--tool none` clears an active tool chip. If an explicit tool target changes, `ensureTool`, `send`, `wait`, `extract`, and `extractImages` are cleared so the next run cannot reuse a response produced under the wrong tool.

In image mode, `wait.data.kind` is `image`. A single ChatGPT conversation waits for one large generated image in the latest assistant message, waits until generation controls disappear, and requires the image signature to stay unchanged for `--stable` seconds. `extractImages` saves image bytes into `--image-dir` and writes a manifest JSON; `state.output` points to that manifest.

For full `image` runs with `--image-count N > 1`, `--image-count` is the total requested image count, not a per-conversation wait target. The parent process starts one child session per image (`<base-session>-image-01`, etc.), runs at most `--image-concurrency` sessions in parallel (default/cap: `3`), and writes a top-level `*-parallel-manifest.json` that records child manifests, saved images, failed jobs, and the child session for each image. Each child still uses the normal single-image pipeline with `--image-count 1`.

Full image runs default to `model: "instant"` unless `--model` is passed. `--model think` is normalized to `thinking`; both `thinking` and `instant` are valid targets for ChatGPT web image generation.

Deep research runs default to `--wait 3600` unless `--wait` is passed, because ChatGPT's Deep research tool can run much longer than Pro Extended text replies.

Passing `--until-complete` (aliases: `--wait-forever`, `--hang`) disables the wait timeout for text, image, and Deep research waits. During an active wait, the script rewrites `active` in the state file with progress fields such as `elapsed`, `need`, status-specific counts, `last`, and `lastRefresh`. It refreshes the same ChatGPT tab every `--refresh` seconds (default `300`; `0` disables) so a frozen page can recover without opening a new tab or re-sending the prompt. On completion, `active` is removed and the `wait` stage is marked done.

`research`, `deep-research`, and `deep-search` are command aliases for the agent-safe Deep research flow. They normalize to `run` with `tool=deep-research` and `--until-complete`, so callers do not need to know about plan confirmation, stale top-frame widget state, or DOCX export extraction.

`doctor` is a no-prompt readiness check. It verifies WebBridge health, opens or reuses a ChatGPT tab, checks login, opens the composer tools menu, confirms `Deep research` / `Web search` are visible, and closes the tab on success unless `--keep-session` is passed.

## Sub-command lifecycle

Each sub-command is a function that:
1. Reads the current state (if `--resume`).
2. If the stage is `done` AND preconditions still hold (e.g. the tab is still open), exits 0 immediately.
3. Otherwise executes the stage, writes the result to state, exits 0 — or exits 4 with a structured error if it can't proceed.

Stages that take a prompt (`send`, `run`, `image`) also accept `-f` and `-` (stdin). When called as `send` directly, the prompt comes from the `prompt` field in state (for `--resume`) or the CLI arg.

## Resume semantics

- Without `--resume`: state is read but not consulted. Every stage runs. This is the default for `run`.
- With `--resume`: each stage is gated on `state.stages[name].done`. Pre-flight checks (e.g. "is the tab still open?") confirm the previous work is still valid; if not, the stage re-runs.
- `cleanup` is always safe to re-run.
- The state file is rewritten on every successful stage completion. If the process crashes mid-stage, the file shows the last completed stage and the next one will retry.
- `wait` timeouts exit `3` and are not marked done. The next `--resume` or `latest` command re-polls instead of extracting a partial answer by accident.
- `--until-complete` is the preferred agent mode: it keeps the CLI process alive across long runs and only exits after `wait` completes, a terminal error occurs, or human intervention is required. Successful run output is written to stdout before tab cleanup so a watching agent sees the result as soon as extraction finishes.
- `research "..."` is the preferred Deep research mode for agents. It implies the Deep research tool and unlimited wait, then prints the extracted report.
- `latest` is not part of the main pipeline. It opens/recovers the named session, force-runs `wait` and `extract`, prints the newest complete answer, and closes the tab on success unless `--keep-session` is passed. With `--image`, it force-runs image wait + `extractImages` and prints a saved-path summary.
- `ensure-tool` can be run directly to pre-select or clear a tool without sending a prompt: `search.js ensure-tool deep-research` or `search.js ensure-tool none`.

## Automation / robustness

- **Auto-retry on transient errors**: each `cmd()` call retries up to 3 times with exponential backoff (200ms, 600ms, 1800ms) for network / daemon / `extension_error: No current window` cases.
- **Auto-reuse tabs**: `open` calls `find_tab` first; if a ChatGPT tab already exists in the session, it reuses it instead of opening a new one.
- **Auto-cleanup**: one-shot `run`, `research` / `deep-search`, `image`, `latest`, `doctor`, and `--dry-run` commands close their ChatGPT tab on success. The state file is kept (default) so the Agent can inspect what happened or recover the saved conversation URL. Pass `--cleanup-state` to delete it. To keep the browser tab open, use `--keep-session` or `--continue` (state still records the run).
- **Idempotent model switch**: `ensure-model` probes the popover, and only clicks the target option if the current selection is different.
- **Idempotent tool switch**: `ensure-tool` checks the active tool chip and the `Add files and more` menu before clicking `Deep research`, `Web search`, `Create image`, or clearing the current selection.

## Adding a new sub-command

1. Add a stage name to the `STAGES` constant.
2. Implement `stage<Name>(session, state, args)` that returns `{ok, data}` or `{ok: false, code, message}`.
3. Wire it into the `run` pipeline in the right order.
4. Update the state schema in this doc and the `references/intervention-points.md` if it can fail in a new way.

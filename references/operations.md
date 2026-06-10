# Operations: daemon, sessions, failure modes, time budget

## Daemon endpoint

- URL: `http://127.0.0.1:10086/command`
- Method: POST
- Headers: `Content-Type: application/json`
- Body: `{"action": "<tool>", "args": {...}, "session": "<name>"}`
- Tool list & args: see the `kimi-webbridge` skill

## Response envelope

| Field | Type | Notes |
|---|---|---|
| `ok` | bool | `true` on success, `false` on error |
| `data` | object | Tool-specific payload, present when `ok:true` |
| `error.code` | string | `extension_error` / `tool_error` / `internal_error` (when `ok:false`) |
| `error.message` | string | Human-readable detail |

A `search.js` failure-mode that returns `error.message` containing `No current window` means the browser has no focused window — ask the user to focus Chrome/Edge and retry.

## Session naming

| Session | Purpose |
|---|---|
| `gpt-pro-1` … `gpt-pro-4` | Parallel prompt tabs |
| `gpt-pro-decision` | Final synthesis / decision prompt |
| `gpt-pro-<timestamp>` | `search.js` default (one-shot use) |

Each session maps to a separate tab group in the browser, so parallel prompts don't fight over a single tab.

## Tab lifecycle

One-shot commands (`run`, `research` / `deep-search`, `image`, `latest`, `doctor`, and `--dry-run`) close their ChatGPT tab on success by default. The state file remains, including the saved conversation URL, so later recovery is still possible.

Use `--keep-session` or `--continue` only when an immediate follow-up needs the same open tab. For staged/manual work, run `search.js -s <session> cleanup` once the tab is no longer needed. Add `--cleanup-state` only when the recovery state should be deleted too.

## Directory structure (parallel runs)

```
pitch/gpt-pro/
├── prompts/
│   ├── prompt-1.md
│   ├── prompt-2.md
│   ├── prompt-3.md
│   └── meta-decision.md
├── responses/
│   ├── prompt-1-response.md
│   ├── prompt-2-response.md
│   ├── prompt-3-response.md
│   └── final-decision.md
└── LOG.md
```

## Failure recovery

| Failure | Fix |
|---|---|
| `fill` returns "No node with given id" | Click the input first, then retry `fill` |
| Model not switching | Take a snapshot, find the composer pill, dispatch the pointer-event sequence (see [dom-selectors.md](dom-selectors.md)), then click the desired menuitemradio |
| Tool not switching | Run `search.js doctor --json`; if it fails, open **Add files and more**, choose `Deep research` / `Web search` manually, then run `search.js ensure-tool deep-research --resume --until-complete` |
| Response timeout (>20 min) | Run `search.js -s <session> latest --until-complete`; screenshot the tab if it still stalls after status stops changing — may have hit rate limit, captcha, or login wall |
| Empty response extraction | Try `[data-message-author-role=assistant]` first, then `.markdown` fallback, then full body text |
| File upload failed | Confirm paths are regular files; default selector is `input#upload-files[type="file"]`; retry with `--upload-selector` if ChatGPT DOM changed; `Not allowed` usually means the Kimi WebBridge extension needs **Allow access to file URLs** / **允许访问文件网址** enabled |
| Generated image not saved | Run `search.js -s <session> latest --image --until-complete --image-dir <dir>`; if candidates exist but saving fails, inspect the manifest and image DOM |
| Rate limit ("Please wait") | Wait 60s, retry. Stagger parallel sends by 30s |
| ChatGPT not logged in | Ask user to log in manually, then re-run `search.js` |
| Click `Uncaught` SyntaxError | Selector contains single quotes — switch to double quotes or no quotes (see [dom-selectors.md](dom-selectors.md)) |
| `extension_error: No current window` | Ask user to focus Chrome/Edge and retry |

## Time budget

| Step | Time |
|---|---|
| Health check | 30s |
| Prepare 3 prompts | 5-10 min |
| Open 3 tabs + verify Extended | 2-3 min |
| Select Deep research / Web search | 30s-1 min |
| Send prompts | 1-2 min |
| Wait for GPT Pro Think / Pro Extended | 30+ min patience budget |
| Wait for Deep research | 50+ min patience budget |
| Extract + save | 2-3 min |
| Synthesize + final decision (if ≥3 prompts) | 15-20 min |
| **Total (3 prompts, no synthesis)** | **~35-45+ min** |
| **Total (3 prompts + synthesis)** | **~65-80+ min** |

During `wait`, the CLI refreshes the same ChatGPT tab every 5 minutes by default (`--refresh 300`). This is a same-tab recovery refresh, not a new research run and not a prompt re-send.

## When to escalate

- Daemon unhealthy AND `~/.kimi-webbridge/bin/kimi-webbridge start` fails → see the `kimi-webbridge` skill's `references/operations.md`
- Extension version out of sync with skill version → user must update the extension: https://kimi.com/features/webbridge
- Model not switchable automatically → ask user to switch manually in the browser, then re-run

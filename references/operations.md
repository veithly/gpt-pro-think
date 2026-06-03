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
| Response timeout (>15 min) | Screenshot the tab — may have hit rate limit, captcha, or login wall |
| Empty response extraction | Try `[data-message-author-role=assistant]` first, then `.markdown` fallback, then full body text |
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
| Send prompts | 1-2 min |
| Wait for parallel responses | 10-15 min |
| Extract + save | 2-3 min |
| Synthesize + final decision (if ≥3 prompts) | 15-20 min |
| **Total (3 prompts, no synthesis)** | **~20-30 min** |
| **Total (3 prompts + synthesis)** | **~35-50 min** |

## When to escalate

- Daemon unhealthy AND `~/.kimi-webbridge/bin/kimi-webbridge start` fails → see the `kimi-webbridge` skill's `references/operations.md`
- Extension version out of sync with skill version → user must update the extension: https://kimi.com/features/webbridge
- Model not switchable automatically → ask user to switch manually in the browser, then re-run

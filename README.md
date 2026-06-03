# GPT Pro Think

Drive [ChatGPT Pro](https://chatgpt.com) (or **Pro Extended** with deep reasoning) through your real browser, and bring the response back into any agent or terminal session. Built on top of [Kimi WebBridge](https://kimi.com/features/webbridge), so it uses your existing ChatGPT login — no API key, no separate auth.

## Why

- **No API key needed.** Uses your real ChatGPT Pro subscription through a local browser daemon.
- **Extended Pro deep reasoning.** A single `--model extended` flag puts the model in the deepest reasoning tier.
- **Resumable.** A 6-stage state machine (`open` → `login-check` → `ensure-model` → `send` → `wait` → `extract`) writes progress to disk. If anything fails, re-run with `--resume` and pick up where you left off.
- **Idempotent stages.** Each sub-command can be re-run safely; the tab is reused, the model is only switched if needed, and the prompt is only re-sent if it changed.
- **Surgical intervention.** The script stops at well-defined failure points (login wall, captcha, model switch failed, rate limit) with a clear message and a runbook for what to do.

## Install

Prerequisites:
- Node.js ≥ 18 (zero npm dependencies; uses only built-ins)
- [Kimi WebBridge](https://kimi.com/features/webbridge) installed (`~/.kimi-webbridge/bin/kimi-webbridge status` should report healthy)
- A Chrome/Edge window open with the WebBridge extension connected
- ChatGPT Pro/Pro Extended account, logged in

```bash
git clone https://github.com/veithly/gpt-pro-think
cd gpt-pro-think
# no install step — it's a single Node script
```

## Quick start

```bash
# Run a prompt
./search.js "What is 17 * 23? Show your work." --model extended

# Read prompt from file, JSON output
./search.js -f ./prompt.md -o ./answer.md --json

# Health check
./search.js --status

# Open tab and verify Extended Pro without sending
./search.js --dry-run --model extended

# After a failure: pick up where it left off
./search.js --resume
```

## Sub-commands

The script runs as a state machine. `run` (the default) executes every stage; each sub-command runs just one.

| Sub-command | Stage | Idempotent |
|---|---|---|
| `open` | Open a ChatGPT tab; reuse if one exists | ✓ |
| `login-check` | Detect whether ChatGPT is logged in | ✓ |
| `ensure-model [target]` | Verify / switch the model pill | ✓ |
| `send [prompt]` | Fill the input and click send | ✓ (skips if prompt unchanged) |
| `wait` | Poll until the response completes | ✓ |
| `extract` | Save the last assistant message | ✓ |
| `status` | Print the current session state | — |
| `cleanup` | Close the session tab | — |
| `run` (default) | All of the above | — |

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| `0` | Success | Use the saved file / stdout output |
| `1` | Daemon or network error | Re-run after fixing the daemon |
| `2` | Bad arguments | Read `--help` |
| `3` | Timeout during `wait` | Re-run with `--resume` and a longer `--wait`, or run `extract` to grab what's on screen |
| `4` | **Human intervention required** | See [references/intervention-points.md](references/intervention-points.md) |

## How it works

```
┌─ kimi-webbridge daemon (127.0.0.1:10086) ─┐
│ Chrome/Edge  ◄──WebBridge extension──┐    │
│                                       │    │
│ ChatGPT tab  ◄──────────────────┐     │    │
└─────────────────────────────────┼─────┼────┘
                                  │     │
   search.js ──── HTTP ──────────┘     │
       │                                 │
       └─► state/<session>.json (per-session, persisted)
```

Each stage is a thin wrapper around one or two `cmd()` calls to the daemon. The script keeps no in-memory state between sub-commands; everything you need is on disk.

## Documentation

- **[SKILL.md](SKILL.md)** — full usage guide (intended as an AI agent skill)
- **[references/intervention-points.md](references/intervention-points.md)** — runbook for each `exit 4` failure
- **[references/script-architecture.md](references/script-architecture.md)** — state schema, sub-command lifecycle, resume semantics
- **[references/dom-selectors.md](references/dom-selectors.md)** — CSS / ARIA selectors + popover pointer-event gotchas
- **[references/operations.md](references/operations.md)** — daemon envelope, session naming, failure recovery, time budget
- **[references/manual-fallback.md](references/manual-fallback.md)** — raw curl flow for when sub-commands aren't enough

## License

MIT — see [LICENSE](LICENSE).

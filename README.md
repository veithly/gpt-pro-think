# GPT Pro Think

Drive [ChatGPT Pro](https://chatgpt.com) (or **Pro Extended** with deep reasoning) through your real browser, and bring the response back into any agent or terminal session. Built on top of [Kimi WebBridge](https://kimi.com/features/webbridge), so it uses your existing ChatGPT login — no API key, no separate auth.

## Why

- **No API key needed.** Uses your real ChatGPT Pro subscription through a local browser daemon.
- **Extended Pro deep reasoning.** A single `--model extended` flag puts the model in the deepest reasoning tier.
- **Deep research / Web search.** `--deep-research` / `--deep-search` selects ChatGPT's Deep research tool; `--web-search` selects the lighter Web search tool.
- **Agent-safe research command.** `research "..."` hides the Deep research plan/iframe/export details and returns the final report.
- **Resumable.** The text pipeline (`open` → `login-check` → `ensure-model` → `ensure-tool` → `upload` → `send` → `wait` → `extract`) writes progress to disk; image mode swaps in `extract-images`. If anything fails, re-run with `--resume` and pick up where you left off.
- **Image generation capture.** `image` / `--image` waits for generated images in ChatGPT's web UI, saves them under `--image-dir`, and writes a manifest.
- **Long-wait safe.** Default wait is 20 minutes; `--until-complete` / `--wait-forever` / `--hang` keeps the CLI alive until the full answer or report is ready.
- **Latest retrieval.** `latest` recovers a named session, waits for the newest complete reply, saves it, prints it directly, and closes the recovered tab unless `--keep-session` is passed.
- **Browser cleanup.** One-shot runs close ChatGPT tabs on success by default; keep a tab open only for immediate follow-up turns.
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
# Run a deep prompt
./search.js --model extended --until-complete "Analyze the tradeoffs of this architecture and recommend next steps."

# Run ChatGPT Deep research / deep search
./search.js doctor --json
./search.js research "Research current competitors and cite sources."
./search.js deep-search "Do a deep market scan."

# Run lighter web search
./search.js --web-search --until-complete "Find the latest release notes."

# Intentionally terse answer: lower the completion length threshold
./search.js "What is 17 * 23? Reply with just the number." --min-chars 0

# Read prompt from file, JSON output
./search.js -f ./prompt.md -o ./answer.md --json

# Health check
./search.js --status

# Verify Extended Pro without sending; closes the tab unless --keep-session is passed
./search.js --dry-run --model extended

# Verify Deep research selection without sending; closes the tab unless --keep-session is passed
./search.js --dry-run --deep-research

# After a failure: pick up where it left off
./search.js --resume --until-complete

# Recover a named session and print the newest complete answer
./search.js -s my-thread latest --until-complete

# Generate image(s) in ChatGPT and save them into the project
node ./search.js image --until-complete "Create a square watercolor icon of a tiny robot reading." --image-dir ./assets/generated

# Upload local file(s) before sending a prompt
node ./search.js --upload ./brief.pdf --until-complete "Summarize this file and list the action items."
```

## Browser tab lifecycle

`run`, `research` / `deep-search`, `image`, `latest`, `doctor`, and `--dry-run` close the ChatGPT tab on successful completion. The state file is kept so a later run can recover the saved conversation URL. Pass `--keep-session` or use `--continue` only when the next immediate step needs the same open tab. If you use staged sub-commands manually and later decide the tab is no longer needed, run `./search.js -s <session> cleanup`.

## Sub-commands

The script runs as a state machine. `run` (the default) executes every stage; each sub-command runs just one.

| Sub-command | Stage | Idempotent |
|---|---|---|
| `open` | Open a ChatGPT tab; reuse if one exists | ✓ |
| `login-check` | Detect whether ChatGPT is logged in | ✓ |
| `ensure-model [target]` | Verify / switch the model pill | ✓ |
| `ensure-tool [target]` | Verify / switch the ChatGPT composer tool | ✓ |
| `upload` | Upload `--upload` file(s) into the composer | ✓ |
| `send [prompt]` | Fill the input and click send | ✓ (skips if prompt unchanged) |
| `wait` | Poll until the response completes | ✓ |
| `extract` | Save the last assistant message | ✓ |
| `image [prompt]` | Run the full image-generation flow and save generated images | — |
| `extract-images` | Save generated images from the latest assistant message | ✓ |
| `latest` | Recover the session, wait for the latest complete reply, save + print it | ✓ |
| `status` | Print the current session state | — |
| `cleanup` | Close the session tab | — |
| `run` (default) | All of the above | — |
| `research` / `deep-search` | Agent-safe Deep research run; waits for exported report | — |
| `doctor` | Verify WebBridge, ChatGPT login, and research tool selectors | — |

Completion defaults are tuned for Pro Extended: `--wait 1200`, `--interval 15`, `--stable 60`, `--min-chars 240`. With `--deep-research` / `--deep-search`, the default wait becomes `3600` seconds unless you pass `--wait`. For agent-driven work, pass `--until-complete` so the process hangs, writes `active` wait progress into `state/<session>.json`, and only prints after the full answer is extracted. Use `--min-chars 0` only when you intentionally expect a terse answer.

Deep research uses a separate completion path: the script prints the generated plan, confirms it through the connector or a narrow Start/Confirm/Continue research button fallback, polls the connector's `get_state` because the visible ChatGPT status can lag behind, and extracts the final report through DOCX export. Agents should use `research "..."` instead of hand-assembling these steps.

To use ChatGPT's composer tools, pass `--deep-research`, `--deep-search`, `--web-search`, or the generic `--tool <auto|none|deep-research|web-search|create-image>`. The `ensure-tool` stage runs after model selection and before upload/send.

```bash
node ./search.js doctor --json
node ./search.js research "Research the current API gateway market and cite sources."
node ./search.js --web-search --until-complete "Find the latest changelog and summarize it."
node ./search.js ensure-tool deep-research
node ./search.js ensure-tool none
```

To attach files, pass `--upload <path>` one or more times before the prompt. The upload stage runs after tool selection and before send, targets ChatGPT's hidden `input#upload-files`, and waits for attachment chips before sending. In Chrome/Edge, Kimi WebBridge also needs **Allow access to file URLs** / **允许访问文件网址** enabled for local file injection.

```bash
node ./search.js --upload ./brief.pdf --until-complete "Summarize this file."
node ./search.js --upload ./brief.pdf --upload ./data.csv --until-complete "Compare these two files."
node ./search.js -s file-thread --resume --until-complete
```

For image generation, use `image` or `--image`. Full image runs default to `--model instant` because ChatGPT image generation must be sent from Thinking/Instant rather than Extended Pro; pass `--model think` / `--model thinking` for the Thinking option. The script waits for at least `--image-count` large generated image(s) in the newest assistant message, waits until generation controls disappear and the image set is stable for `--stable` seconds, then writes files into `--image-dir` (default `./gpt-pro-images`). It also writes a JSON manifest with paths, dimensions, byte sizes, and any failed candidates.

```bash
node ./search.js image --until-complete "Create a cinematic product render of a translucent desk lamp." --image-dir ./assets/generated
node ./search.js image --model think --until-complete "Create a detailed isometric app icon." --image-dir ./assets/generated
node ./search.js --image --model instant --until-complete "Create four sticker-style UI mascots." --image-count 4 --image-dir ./assets/generated
node ./search.js -s design-thread latest --image --until-complete --image-dir ./assets/generated
node ./search.js -s design-thread extract-images --resume --image-dir ./assets/generated
node ./scripts/transparent-cutout.js ./assets/generated/icon-on-green.png ./assets/generated/icon-transparent.png --bg 0,255,0 --threshold 42 --padding 24
```

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| `0` | Success | Use the saved file / stdout output |
| `1` | Daemon or network error | Re-run after fixing the daemon |
| `2` | Bad arguments | Read `--help` |
| `3` | Timeout during `wait` | Re-run with `--resume --until-complete` or `-s <session> latest --until-complete`; timeout does not mark `wait` done |
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
- **[references/image-generation.md](references/image-generation.md)** — image generation + transparent cutout workflow
- **[references/operations.md](references/operations.md)** — daemon envelope, session naming, failure recovery, time budget
- **[references/manual-fallback.md](references/manual-fallback.md)** — raw curl flow for when sub-commands aren't enough

## License

MIT — see [LICENSE](LICENSE).

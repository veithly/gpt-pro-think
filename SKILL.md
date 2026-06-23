---
name: gpt-pro-think
description: |
  Send deep-reasoning prompts to ChatGPT Pro Extended via kimi-webbridge and collect text responses or generated image files. Use when you need external LLM brainstorming, expert analysis, cross-model validation, ChatGPT Deep research / Web search, image generation through ChatGPT's web UI, or deep research that benefits from GPT Pro's extended reasoning. Triggers: "ask GPT Pro", "use ChatGPT Pro", "GPT Pro think", "让 GPT Pro 想想", "问下 GPT", "consult GPT Pro Extended", "deep research with GPT".
---

# GPT Pro Think

Run a prompt on ChatGPT Pro (or Pro Extended) through the user's real browser and bring the response back. The default entry point is `search.js` in this directory. When the script can't proceed on its own, it stops at a well-defined point and tells you exactly what to do next.

## Agent contract

When using this skill from an agent, run the CLI in a long-lived shell command and wait for the command to exit with the complete answer. Do not return a "still searching" or "try latest later" response to the user while ChatGPT is still working.

- Use `--until-complete` (aliases: `--wait-forever`, `--hang`) for normal agent calls, especially Pro Extended and Deep research.
- During `wait`, the CLI refreshes the same ChatGPT tab every 5 minutes by default (`--refresh 300`) to recover from a frozen page. This is a same-tab refresh, not a new page and not a re-send.
- As soon as wait/extract completes, the CLI writes the answer or image manifest to stdout before tab cleanup, so the watching agent should consume that output immediately.
- Patience budget is mandatory: allow at least **30 minutes** for a normal GPT Pro Think / Pro Extended response and at least **50 minutes** for ChatGPT Deep research before suspecting the run is stuck.
- Ten minutes with no stdout is normal. Do **not** assume the run is broken, open a new ChatGPT page, start a fresh browser research, or re-send the prompt just because nothing has printed for 10 minutes.
- For ChatGPT Deep research, prefer `research "..."`; it implies `--deep-research --until-complete` and waits for the exported report.
- Before delegating research to another agent, run `doctor` once to verify WebBridge, ChatGPT login, and Deep research tool availability.
- The CLI auto-starts the Kimi WebBridge daemon when `status` reports `running:false`, including removing a stale `~/.kimi-webbridge/daemon.pid` left by a dead daemon process. If startup still fails, follow the printed hint.
- If the shell tool yields while the process is still running, keep the process/session alive and poll it again. The CLI writes wait progress to the session state file.
- Use `node ... search.js -s <session> status` from another shell to inspect `active.stage`, `active.status`, `active.elapsed`, and `active.need` while a wait is in progress.
- If a non-hanging run exits `3`, immediately re-run with `--resume --until-complete` or `-s <session> latest --until-complete`; do not ask the user to manually re-run.
- Only answer the user after exit `0` with extracted text/image paths, or exit `4` when the browser genuinely needs human intervention.
- Treat ChatGPT tabs as disposable. Full `run` / `research` / `image`, `latest`, `doctor`, and `--dry-run` close their tab on success by default. Use `--keep-session` only when another immediate step needs the same open tab.
- If you opened a tab with staged sub-commands (`open`, `send`, `wait`, `extract`, etc.) or decide to abandon a named session, run `node ... search.js -s <session> cleanup` as soon as no later turn needs that tab. This closes the browser tab but keeps the state file for recovery unless `--cleanup-state` is passed.

## Quick start

```bash
# All-in-one: send a prompt, wait, save the response
node ~/.claude/skills/gpt-pro-think/search.js --until-complete "Your prompt"

# Force Extended Pro (Pro model + Extended reasoning)
node ~/.claude/skills/gpt-pro-think/search.js --model extended --until-complete "Your prompt"

# Use ChatGPT's Deep research tool for searched, cited research
node ~/.claude/skills/gpt-pro-think/search.js research "Research current competitors and cite sources."

# Alias for users who say "deep search"
node ~/.claude/skills/gpt-pro-think/search.js deep-search "Do a deep market scan."

# Use the lighter Web search tool
node ~/.claude/skills/gpt-pro-think/search.js --web-search --until-complete "Find the latest release notes."

# Read prompt from a file, get JSON, custom output path
node ~/.claude/skills/gpt-pro-think/search.js -f ./prompt.md -o ./answer.md --json

# Resume a previous run that was interrupted (skips already-done stages)
node ~/.claude/skills/gpt-pro-think/search.js --resume --until-complete

# Check/recover a named session and print the newest complete answer; closes tab unless --keep-session is passed
node ~/.claude/skills/gpt-pro-think/search.js -s my-thread latest --until-complete

# Generate image(s) in ChatGPT and save them into the current project
# Image mode defaults to strict Pro Extended; add --allow-image-model-fallback only when Instant fallback is acceptable.
node ~/.claude/skills/gpt-pro-think/search.js image --until-complete "Create a square watercolor icon of a tiny robot reading." --image-dir ./assets/generated

# Upload local file(s) into ChatGPT before sending a prompt
node ~/.claude/skills/gpt-pro-think/search.js --upload ./brief.pdf --until-complete "Summarize this file and list action items."

# Recover a still-open / saved conversation and save the latest generated image(s)
node ~/.claude/skills/gpt-pro-think/search.js -s my-thread latest --image --until-complete --image-dir ./assets/generated

# Multi-turn conversation: each --continue pushes another turn into the same
# ChatGPT tab so the model keeps the context. Use --continue on EVERY turn,
# including the first one, to keep the tab open.
node ~/.claude/skills/gpt-pro-think/search.js -s my-thread --continue --until-complete "Explain X."
node ~/.claude/skills/gpt-pro-think/search.js -s my-thread --continue --until-complete "Now give me an example."
node ~/.claude/skills/gpt-pro-think/search.js -s my-thread --continue --until-complete "How would you test that?"

# Health check / dry-run / all options
node ~/.claude/skills/gpt-pro-think/search.js --status
node ~/.claude/skills/gpt-pro-think/search.js doctor --json
node ~/.claude/skills/gpt-pro-think/search.js --dry-run --model extended
node ~/.claude/skills/gpt-pro-think/search.js --dry-run --deep-research
node ~/.claude/skills/gpt-pro-think/search.js --help
```

## Sub-commands (stage-by-stage control)

`search.js` runs as a state machine. `run` (the default) executes the text pipeline in order; `image` uses the same setup/send/wait stages and swaps text extraction for image extraction. Each stage sub-command runs just one step. Use them when the script stops in the middle and you want to retry from a specific point, or when you want to chain stages manually. `latest` is a convenience command that recovers a session, waits for the newest complete assistant reply, extracts it, and prints it.

| Sub-command | Stage | Idempotent | Re-run on resume |
|---|---|---|---|
| `open` | Open a ChatGPT tab in a session; reuse if one already exists | ✓ | skipped if done |
| `login-check` | Detect whether ChatGPT is logged in | ✓ | skipped if done |
| `ensure-model` | Verify / switch the model pill (default target: `auto` = whatever's selected) | ✓ | skipped if done |
| `ensure-tool` | Verify / switch the ChatGPT composer tool (`deep-research`, `web-search`, `create-image`, or `none`) | ✓ | skipped if same tool is active |
| `upload` | Attach `--upload` file(s) to the composer before sending | ✓ | skipped if same files + same prompt |
| `send` | Fill the input with the prompt and click send | ✓ | re-sent if prompt changed |
| `wait` | Poll until the response completes (or times out) | ✓ | skipped if done |
| `extract` | Pull the last assistant message, save to `--output` | ✓ | skipped if done |
| `image` | Send a prompt, wait for generated image(s), save them to `--image-dir` | — | — |
| `extract-images` | Save generated image(s) from the latest assistant message | ✓ | skipped if done |
| `latest` | Recover the `--session`, force wait + extract, print latest complete reply | ✓ | always re-checks |
| `status` | Print the current session state and exit (no side effects) | — | n/a |
| `cleanup` | Close the session | — | n/a |
| `run` (default) | All of the above in order | — | — |
| `research` | Agent-safe Deep research run: tool select, plan confirm, wait, export, extract | — | — |
| `doctor` | Verify browser/WebBridge/login/tool selectors before a research run | — | n/a |

`--resume` reads the per-session state file and skips stages already marked `done`; stages with an unmet precondition are re-run. See [references/script-architecture.md](references/script-architecture.md) for the state schema.

### Waiting and completion criteria

Default `wait` is tuned for Pro Extended: `--wait 1200` (20 min), `--interval 15`, `--stable 60`, `--min-chars 240`. Agent-driven runs should use `--until-complete` and keep a patience budget of at least **30 minutes** for GPT Pro Think / Pro Extended and at least **50 minutes** for Deep research. When `--deep-research` / `--deep-search` is used and no explicit `--wait` is passed, the default wait becomes `3600` seconds (60 min). A response counts as complete only when:

- A new assistant message exists after the current turn was sent
- The visible assistant text is not a short thinking/placeholder string
- The text is at least `--min-chars` characters (`--min-chars 0` for intentionally terse answers)
- ChatGPT's generation controls are gone and the assistant text has stayed unchanged for `--stable` seconds

If `wait` times out, it exits `3` and does **not** mark the `wait` stage done. Re-run `--resume`, or use `-s <session> latest` to recover the corresponding session and print the newest complete answer when it is ready.

For agent-driven work, prefer `--until-complete`. It disables the wait timeout, keeps the CLI process alive, updates `state/<session>.json` with `active: { stage: "wait", status, elapsed, need, lastRefresh, ... }`, refreshes the same ChatGPT tab every 5 minutes by default, and prints the extracted answer only after completion. If the command is still running with no stdout, keep polling the process; do not stop early unless the user explicitly cancels, the script exits, or the patience budget has been exceeded and `status` shows no progress.

For Deep research, `wait` uses the connector state rather than only the visible ChatGPT message text. It prints the generated research plan, confirms it through the Deep research connector or a narrow Start/Confirm/Continue research button fallback, polls `get_state` because the top-level UI can remain stale, and probes DOCX export until the full report is available.

### Deep research and Web search

Use `--deep-research` when the user explicitly wants ChatGPT's Deep research tool, current-source investigation, or a searched report with citations. `--deep-search` is an alias because users often describe the same ChatGPT UI feature that way.

```bash
node ~/.claude/skills/gpt-pro-think/search.js doctor --json
node ~/.claude/skills/gpt-pro-think/search.js research "Research the current API gateway market and cite sources."
node ~/.claude/skills/gpt-pro-think/search.js deep-search "Do a full competitive scan."
node ~/.claude/skills/gpt-pro-think/search.js --web-search --until-complete "Find the latest changelog and summarize it."
node ~/.claude/skills/gpt-pro-think/search.js ensure-tool deep-research
node ~/.claude/skills/gpt-pro-think/search.js ensure-tool none
```

The tool stage runs after `ensure-model` and before `upload` / `send`. It opens ChatGPT's **Add files and more** menu, selects `Deep research` / `Web search`, and records `ensureTool` in the state file. `--tool none` or `ensure-tool none` clears the active tool chip if one is selected. For a normal run without an explicit tool flag, the script leaves ChatGPT's current tool state alone.

### File upload

Use `--upload <path>` one or more times to attach local files before sending the prompt. The stage runs after `ensure-tool` and before `send`, targets ChatGPT's hidden `input#upload-files[type="file"]`, and waits up to `--upload-wait` seconds for attachment chips.

```bash
node ~/.claude/skills/gpt-pro-think/search.js --upload ./brief.pdf --until-complete "Summarize this file."
node ~/.claude/skills/gpt-pro-think/search.js --upload ./brief.pdf --upload ./data.csv --until-complete "Compare these files."
node ~/.claude/skills/gpt-pro-think/search.js -s file-thread --resume --until-complete
```

For a failed upload run, re-run with `--resume`; the state file retains the normalized absolute upload paths. For a new non-resume prompt, uploads are not carried over unless `--upload` is passed again.

If upload fails with `upload_not_allowed`, the browser/WebBridge extension blocked local file injection. Open the Kimi WebBridge extension details page in Chrome/Edge and enable **Allow access to file URLs** / **允许访问文件网址**, then re-run with `--resume`. Do not treat daemon `v1.9.16` + extension `1.9.13` as a mismatch by itself; `1.9.13` is the current browser extension build seen in Edge.

### Image generation

Use `image` (or `--image` with `run` / `latest`) when the prompt asks ChatGPT's web UI to create images. A full image run defaults to strict Pro Extended (`--model extended`). If Pro Extended cannot be selected, the command fails instead of silently using Instant; add `--allow-image-model-fallback` only when a one-image Instant fallback is acceptable. You can still pass `--model think` / `--model thinking` or `--model instant` explicitly for a single fallback-style image run.

Pro Extended can return about 10 separate generated images from one prompt. For `--image-count N`, the script treats `N` as the number of images to wait for and save from the same ChatGPT response (cap: 10). Always include the same count in the prompt text, for example "Create exactly 6 separate square images...". If `--allow-image-model-fallback` is used and Pro Extended is unavailable, the script falls back to Instant and limits the run to 1 image.

Generated files are written to `--image-dir` (default `./gpt-pro-images`) using `--image-prefix` or `gpt-image-<createdAt>`. For multi-image runs, saved files use numbered suffixes and the manifest records file paths, dimensions, byte sizes, source session, requested image count, required image count, and any failed downloads.

For transparent illustrations, do not ask the web UI to make transparency directly. Ask for the subject on a high-contrast solid background, with no shadows and clear separation from the edge, then run the local cutout script. Prefer backgrounds unlikely to appear inside the subject, such as pure green (`#00ff00`), magenta (`#ff00ff`), or cyan (`#00ffff`).

```bash
node ~/.claude/skills/gpt-pro-think/search.js image --until-complete "Create a cinematic product render of a translucent desk lamp." --image-dir ./assets/generated
node ~/.claude/skills/gpt-pro-think/search.js image --model extended --until-complete "Create a detailed isometric app icon." --image-dir ./assets/generated
node ~/.claude/skills/gpt-pro-think/search.js --image --model extended --until-complete "Create exactly four sticker-style UI mascots as separate images." --image-count 4 --image-dir ./assets/generated
node ~/.claude/skills/gpt-pro-think/search.js -s design-thread latest --image --until-complete --image-dir ./assets/generated
node ~/.claude/skills/gpt-pro-think/search.js -s design-thread extract-images --resume --image-dir ./assets/generated
node ~/.claude/skills/gpt-pro-think/scripts/transparent-cutout.js ./assets/generated/icon-on-green.png ./assets/generated/icon-transparent.png --bg 0,255,0 --threshold 42 --padding 24
```

### Multi-turn with `--continue` (preferred when you know upfront)

For conversations where later prompts depend on earlier responses, pass `--continue` (alias `-C`) on **every** turn, including the first. This:

- Reuses the same ChatGPT tab so context is preserved
- Uses `document.execCommand('insertText')` instead of `fill` to avoid clobbering an unsent draft
- Forces `send` / `wait` / `extract` to re-run even if state shows them as done
- Implies `--keep-session` so the tab stays open between turns
- Saves each turn to `gpt-pro-response-<createdAt>-turn-<N>.md` plus a `gpt-pro-response-<createdAt>.md` "latest" file

### Auto-recovery from the conversation history (when you forgot `--continue`)

If you didn't use `--continue` and the script closed the tab after a run, the next run on the same `--session` will automatically recover the conversation by **navigating to the saved ChatGPT URL** and verifying messages loaded (up to 8 s wait, polled every second). The URL is captured at the end of every successful `extract` stage. If the URL is stale (conversation deleted, or you're signed out), the script falls back to **searching the sidebar by conversation title** and clicking the match.

Pass `--fresh` to skip recovery and start a brand new conversation (useful when the prior thread is no longer relevant).

Examples:
```bash
# Open a tab and verify Extended Pro, then close it when no later step needs it
node ~/.claude/skills/gpt-pro-think/search.js -s prep-thread open
node ~/.claude/skills/gpt-pro-think/search.js -s prep-thread ensure-model extended
node ~/.claude/skills/gpt-pro-think/search.js -s prep-thread ensure-tool deep-research
node ~/.claude/skills/gpt-pro-think/search.js -s prep-thread cleanup

# A previous run timed out at "wait" — re-run from wait, keep the prompt
node ~/.claude/skills/gpt-pro-think/search.js wait --resume --until-complete

# A previous run lost the response — re-extract without re-sending
node ~/.claude/skills/gpt-pro-think/search.js extract --resume

# A previous run is still thinking — poll the same session until the full answer is ready
node ~/.claude/skills/gpt-pro-think/search.js -s my-thread latest --until-complete

# If a staged/manual session will not be used again, close the tab
node ~/.claude/skills/gpt-pro-think/search.js -s my-thread cleanup

# Monitor a long-running wait from another shell
node ~/.claude/skills/gpt-pro-think/search.js -s my-thread status
```

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| `0` | Success | Use the saved file / stdout output |
| `1` | Daemon, extension, or network error | The CLI auto-starts the daemon first; follow the printed hint if startup or extension connection still fails |
| `2` | Bad arguments | Read `--help` |
| `3` | Timeout during `wait` | Re-run with `--resume --until-complete` or `-s <session> latest --until-complete`; `wait` is not marked done on timeout |
| `4` | **Human intervention required** | Read the message + see [references/intervention-points.md](references/intervention-points.md) |

Exit `4` is the key contract: the script stops at a well-defined point, prints exactly which stage failed and why, and waits for the Agent (or user) to fix it in the browser before resuming.

## When to use

- Need a second LLM opinion or extended-reasoning analysis
- Cross-model validation of a design, plan, or piece of analysis
- Deep research where the user accepts a 50+ min wait per prompt

## When NOT to use

- Deadline < 2h away
- Simple factual lookup — use WebSearch instead
- Daemon unhealthy and can't be fixed — see [references/operations.md](references/operations.md)

## References

- [references/intervention-points.md](references/intervention-points.md) — **read this when exit code is 4** (login, captcha, model switch, rate limit, lost focus)
- [references/script-architecture.md](references/script-architecture.md) — state file schema, sub-command lifecycle, resume semantics
- [references/dom-selectors.md](references/dom-selectors.md) — stable CSS / ARIA selectors, popover pointer-event sequence, quoting gotchas
- [references/image-generation.md](references/image-generation.md) — image generation, transparent cutout workflow, and local post-processing
- [references/manual-fallback.md](references/manual-fallback.md) — raw curl flow for when sub-commands aren't enough
- [references/operations.md](references/operations.md) — daemon endpoint, response envelope, session naming, time budget

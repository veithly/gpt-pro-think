---
name: gpt-pro-think
description: |
  Send deep-reasoning prompts to ChatGPT Pro Extended via kimi-webbridge and collect text responses or generated image files. Use when you need external LLM brainstorming, expert analysis, cross-model validation, ChatGPT Deep research / Web search, image generation through ChatGPT's web UI, or deep research that benefits from GPT Pro's extended reasoning. Triggers: "ask GPT Pro", "use ChatGPT Pro", "GPT Pro think", "让 GPT Pro 想想", "问下 GPT", "consult GPT Pro Extended", "deep research with GPT".
---

# GPT Pro Think

Run a prompt on ChatGPT Pro (or Pro Extended) through the user's real browser and bring the response back. The default entry point is `search.js` in this directory. When the script can't proceed on its own, it stops at a well-defined point and tells you exactly what to do next.

## Quick start

```bash
# All-in-one: send a prompt, wait, save the response
node ~/.claude/skills/gpt-pro-think/search.js "Your prompt"

# Force Extended Pro (Pro model + Extended reasoning)
node ~/.claude/skills/gpt-pro-think/search.js "Your prompt" --model extended

# Use ChatGPT's Deep research tool for searched, cited research
node ~/.claude/skills/gpt-pro-think/search.js --deep-research "Research current competitors and cite sources."

# Alias for users who say "deep search"; default wait becomes 60 minutes
node ~/.claude/skills/gpt-pro-think/search.js --deep-search "Do a deep market scan."

# Use the lighter Web search tool
node ~/.claude/skills/gpt-pro-think/search.js --web-search "Find the latest release notes."

# Read prompt from a file, get JSON, custom output path
node ~/.claude/skills/gpt-pro-think/search.js -f ./prompt.md -o ./answer.md --json

# Resume a previous run that was interrupted (skips already-done stages)
node ~/.claude/skills/gpt-pro-think/search.js --resume

# Check/recover a named session and print the newest complete answer
node ~/.claude/skills/gpt-pro-think/search.js -s my-thread latest

# Generate image(s) in ChatGPT and save them into the current project
# Image mode defaults to Instant; use --model think for Thinking.
node ~/.claude/skills/gpt-pro-think/search.js image "Create a square watercolor icon of a tiny robot reading." --image-dir ./assets/generated

# Upload local file(s) into ChatGPT before sending a prompt
node ~/.claude/skills/gpt-pro-think/search.js --upload ./brief.pdf "Summarize this file and list action items."

# Recover a still-open / saved conversation and save the latest generated image(s)
node ~/.claude/skills/gpt-pro-think/search.js -s my-thread latest --image --image-dir ./assets/generated

# Multi-turn conversation: each --continue pushes another turn into the same
# ChatGPT tab so the model keeps the context. Use --continue on EVERY turn,
# including the first one, to keep the tab open.
node ~/.claude/skills/gpt-pro-think/search.js -s my-thread --continue "Explain X."
node ~/.claude/skills/gpt-pro-think/search.js -s my-thread --continue "Now give me an example."
node ~/.claude/skills/gpt-pro-think/search.js -s my-thread --continue "How would you test that?"

# Health check / dry-run / all options
node ~/.claude/skills/gpt-pro-think/search.js --status
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

`--resume` reads the per-session state file and skips stages already marked `done`; stages with an unmet precondition are re-run. See [references/script-architecture.md](references/script-architecture.md) for the state schema.

### Waiting and completion criteria

Default `wait` is tuned for Pro Extended: `--wait 1200` (20 min), `--interval 15`, `--stable 60`, `--min-chars 240`. When `--deep-research` / `--deep-search` is used and no explicit `--wait` is passed, the default wait becomes `3600` seconds (60 min). A response counts as complete only when:

- A new assistant message exists after the current turn was sent
- The visible assistant text is not a short thinking/placeholder string
- The text is at least `--min-chars` characters (`--min-chars 0` for intentionally terse answers)
- ChatGPT's generation controls are gone and the assistant text has stayed unchanged for `--stable` seconds

If `wait` times out, it exits `3` and does **not** mark the `wait` stage done. Re-run `--resume`, or use `-s <session> latest` to recover the corresponding session and print the newest complete answer when it is ready.

When using this skill from an agent, budget at least 20 minutes per Pro Extended prompt and up to 60 minutes for Deep research. If the command is still running with no stdout, keep polling the process; do not stop early unless the user explicitly cancels or the script exits.

### Deep research and Web search

Use `--deep-research` when the user explicitly wants ChatGPT's Deep research tool, current-source investigation, or a searched report with citations. `--deep-search` is an alias because users often describe the same ChatGPT UI feature that way.

```bash
node ~/.claude/skills/gpt-pro-think/search.js --deep-research "Research the current API gateway market and cite sources."
node ~/.claude/skills/gpt-pro-think/search.js --deep-search --wait 5400 "Do a full competitive scan."
node ~/.claude/skills/gpt-pro-think/search.js --web-search "Find the latest changelog and summarize it."
node ~/.claude/skills/gpt-pro-think/search.js ensure-tool deep-research
node ~/.claude/skills/gpt-pro-think/search.js ensure-tool none
```

The tool stage runs after `ensure-model` and before `upload` / `send`. It opens ChatGPT's **Add files and more** menu, selects `Deep research` / `Web search`, and records `ensureTool` in the state file. `--tool none` or `ensure-tool none` clears the active tool chip if one is selected. For a normal run without an explicit tool flag, the script leaves ChatGPT's current tool state alone.

### File upload

Use `--upload <path>` one or more times to attach local files before sending the prompt. The stage runs after `ensure-tool` and before `send`, targets ChatGPT's hidden `input#upload-files[type="file"]`, and waits up to `--upload-wait` seconds for attachment chips.

```bash
node ~/.claude/skills/gpt-pro-think/search.js --upload ./brief.pdf "Summarize this file."
node ~/.claude/skills/gpt-pro-think/search.js --upload ./brief.pdf --upload ./data.csv "Compare these files."
node ~/.claude/skills/gpt-pro-think/search.js -s file-thread --resume
```

For a failed upload run, re-run with `--resume`; the state file retains the normalized absolute upload paths. For a new non-resume prompt, uploads are not carried over unless `--upload` is passed again.

If upload fails with `upload_not_allowed`, the browser/WebBridge extension blocked local file injection. Open the Kimi WebBridge extension details page in Chrome/Edge and enable **Allow access to file URLs** / **允许访问文件网址**, then re-run with `--resume`. Do not treat daemon `v1.9.16` + extension `1.9.13` as a mismatch by itself; `1.9.13` is the current browser extension build seen in Edge.

### Image generation

Use `image` (or `--image` with `run` / `latest`) when the prompt asks ChatGPT's web UI to create images. A full image run defaults to `--model instant` because image generation must be sent from Thinking/Instant rather than Extended Pro; pass `--model think` / `--model thinking` to select Thinking. The image flow uses the same open/login/model/send stages, then waits for at least `--image-count` large generated image(s) in the newest assistant message. It treats the image result as complete only after ChatGPT generation controls are gone and the image set is stable for `--stable` seconds.

Generated files are written to `--image-dir` (default `./gpt-pro-images`) using `--image-prefix` or `gpt-image-<createdAt>`. A manifest JSON is saved next to the images with file paths, dimensions, byte sizes, the source conversation URL, and any failed candidates.

For transparent illustrations, do not ask the web UI to make transparency directly. Ask for the subject on a high-contrast solid background, with no shadows and clear separation from the edge, then run the local cutout script. Prefer backgrounds unlikely to appear inside the subject, such as pure green (`#00ff00`), magenta (`#ff00ff`), or cyan (`#00ffff`).

```bash
node ~/.claude/skills/gpt-pro-think/search.js image "Create a cinematic product render of a translucent desk lamp." --image-dir ./assets/generated
node ~/.claude/skills/gpt-pro-think/search.js image --model think "Create a detailed isometric app icon." --image-dir ./assets/generated
node ~/.claude/skills/gpt-pro-think/search.js --image --model instant "Create four sticker-style UI mascots." --image-count 4 --image-dir ./assets/generated
node ~/.claude/skills/gpt-pro-think/search.js -s design-thread latest --image --image-dir ./assets/generated
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
# Open a tab and verify Extended Pro, then stop
node ~/.claude/skills/gpt-pro-think/search.js open
node ~/.claude/skills/gpt-pro-think/search.js ensure-model extended
node ~/.claude/skills/gpt-pro-think/search.js ensure-tool deep-research

# A previous run timed out at "wait" — re-run from wait, keep the prompt
node ~/.claude/skills/gpt-pro-think/search.js wait --resume

# A previous run lost the response — re-extract without re-sending
node ~/.claude/skills/gpt-pro-think/search.js extract --resume

# A previous run is still thinking — poll the same session until the full answer is ready
node ~/.claude/skills/gpt-pro-think/search.js -s my-thread latest --wait 1200
```

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| `0` | Success | Use the saved file / stdout output |
| `1` | Daemon or network error | Check `~/.kimi-webbridge/bin/kimi-webbridge status`; re-run |
| `2` | Bad arguments | Read `--help` |
| `3` | Timeout during `wait` | Re-run with `--resume` or `-s <session> latest --wait 1200`; `wait` is not marked done on timeout |
| `4` | **Human intervention required** | Read the message + see [references/intervention-points.md](references/intervention-points.md) |

Exit `4` is the key contract: the script stops at a well-defined point, prints exactly which stage failed and why, and waits for the Agent (or user) to fix it in the browser before resuming.

## When to use

- Need a second LLM opinion or extended-reasoning analysis
- Cross-model validation of a design, plan, or piece of analysis
- Deep research where the user accepts a 20-60 min wait per prompt

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

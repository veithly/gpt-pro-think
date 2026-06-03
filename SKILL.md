---
name: gpt-pro-think
description: |
  Send deep-reasoning prompts to ChatGPT Pro Extended via kimi-webbridge and collect responses. Use when you need external LLM brainstorming, expert analysis, cross-model validation, or deep research that benefits from GPT Pro's extended reasoning. Triggers: "ask GPT Pro", "use ChatGPT Pro", "GPT Pro think", "让 GPT Pro 想想", "问下 GPT", "consult GPT Pro Extended", "deep research with GPT".
---

# GPT Pro Think

Run a prompt on ChatGPT Pro (or Pro Extended) through the user's real browser and bring the response back. The default entry point is `search.js` in this directory. When the script can't proceed on its own, it stops at a well-defined point and tells you exactly what to do next.

## Quick start

```bash
# All-in-one: send a prompt, wait, save the response
node ~/.claude/skills/gpt-pro-think/search.js "Your prompt"

# Force Extended Pro (Pro model + Extended reasoning)
node ~/.claude/skills/gpt-pro-think/search.js "Your prompt" --model extended

# Read prompt from a file, get JSON, custom output path
node ~/.claude/skills/gpt-pro-think/search.js -f ./prompt.md -o ./answer.md --json

# Resume a previous run that was interrupted (skips already-done stages)
node ~/.claude/skills/gpt-pro-think/search.js --resume

# Multi-turn conversation: each --continue pushes another turn into the same
# ChatGPT tab so the model keeps the context. Use --continue on EVERY turn,
# including the first one, to keep the tab open.
node ~/.claude/skills/gpt-pro-think/search.js -s my-thread --continue "Explain X."
node ~/.claude/skills/gpt-pro-think/search.js -s my-thread --continue "Now give me an example."
node ~/.claude/skills/gpt-pro-think/search.js -s my-thread --continue "How would you test that?"

# Health check / dry-run / all options
node ~/.claude/skills/gpt-pro-think/search.js --status
node ~/.claude/skills/gpt-pro-think/search.js --dry-run --model extended
node ~/.claude/skills/gpt-pro-think/search.js --help
```

## Sub-commands (stage-by-stage control)

`search.js` runs as a state machine with seven stages. `run` (the default) executes them in order; each sub-command runs just one. Use them when the script stops in the middle and you want to retry from a specific point, or when you want to chain stages manually.

| Sub-command | Stage | Idempotent | Re-run on resume |
|---|---|---|---|
| `open` | Open a ChatGPT tab in a session; reuse if one already exists | ✓ | skipped if done |
| `login-check` | Detect whether ChatGPT is logged in | ✓ | skipped if done |
| `ensure-model` | Verify / switch the model pill (default target: `auto` = whatever's selected) | ✓ | skipped if done |
| `send` | Fill the input with the prompt and click send | ✓ | re-sent if prompt changed |
| `wait` | Poll until the response completes (or times out) | ✓ | skipped if done |
| `extract` | Pull the last assistant message, save to `--output` | ✓ | skipped if done |
| `status` | Print the current session state and exit (no side effects) | — | n/a |
| `cleanup` | Close the session | — | n/a |
| `run` (default) | All of the above in order | — | — |

`--resume` reads the per-session state file and skips stages already marked `done`; stages with an unmet precondition are re-run. See [references/script-architecture.md](references/script-architecture.md) for the state schema.

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

# A previous run timed out at "wait" — re-run from wait, keep the prompt
node ~/.claude/skills/gpt-pro-think/search.js wait --resume

# A previous run lost the response — re-extract without re-sending
node ~/.claude/skills/gpt-pro-think/search.js extract --resume
```

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| `0` | Success | Use the saved file / stdout output |
| `1` | Daemon or network error | Check `~/.kimi-webbridge/bin/kimi-webbridge status`; re-run |
| `2` | Bad arguments | Read `--help` |
| `3` | Timeout during `wait` | Re-run with `--resume` (or `--wait <longer>`); if response is partial, the saved file may still be useful |
| `4` | **Human intervention required** | Read the message + see [references/intervention-points.md](references/intervention-points.md) |

Exit `4` is the key contract: the script stops at a well-defined point, prints exactly which stage failed and why, and waits for the Agent (or user) to fix it in the browser before resuming.

## When to use

- Need a second LLM opinion or extended-reasoning analysis
- Cross-model validation of a design, plan, or piece of analysis
- Deep research where the user accepts a 10-20 min wait per prompt

## When NOT to use

- Deadline < 2h away
- Simple factual lookup — use WebSearch instead
- Daemon unhealthy and can't be fixed — see [references/operations.md](references/operations.md)

## References

- [references/intervention-points.md](references/intervention-points.md) — **read this when exit code is 4** (login, captcha, model switch, rate limit, lost focus)
- [references/script-architecture.md](references/script-architecture.md) — state file schema, sub-command lifecycle, resume semantics
- [references/dom-selectors.md](references/dom-selectors.md) — stable CSS / ARIA selectors, popover pointer-event sequence, quoting gotchas
- [references/manual-fallback.md](references/manual-fallback.md) — raw curl flow for when sub-commands aren't enough
- [references/operations.md](references/operations.md) — daemon endpoint, response envelope, session naming, time budget

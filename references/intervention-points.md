# Intervention Points

When `search.js` exits with code `4`, it has reached a stage it cannot complete on its own. This file is the runbook for what to do at each one. The script's stderr message names the exact stage; match it against the table below.

After you fix the issue, re-run with `--resume` and the script will pick up from the failed stage.

---

## 1. `open` — `extension_error: No current window`

**Stage:** open
**Cause:** the Chrome/Edge window is closed, minimized, or not focused. The Kimi WebBridge extension can only drive tabs in a focused window.

**Fix:**
1. Ask the user to open Chrome/Edge and bring a window to the front.
2. Confirm the Kimi WebBridge extension icon shows as connected.
3. Re-run with `--resume`. The `open` stage will re-attempt; if a tab is already in the session it will be reused.

---

## 2. `login-check` — `login_required`

**Stage:** login-check
**Cause:** the ChatGPT tab loaded but the input box is missing — user is not logged in (or the page is mid-redirect to the login page).

**Fix:**
1. Ask the user to log into ChatGPT in the browser.
2. Once logged in, the composer input (`[contenteditable="true"]`) should appear.
3. Re-run with `--resume`. The `login-check` stage will re-detect; if logged in it marks done and `ensure-model` proceeds.

---

## 3. `ensure-model` — `could not switch to <target>`

**Stage:** ensure-model
**Cause:** the script could not find the desired option in the model popover, or the popover did not open. Usually means the popover UI changed or the click target moved.

**Fix:**
1. Take a fresh snapshot (the script will print the popover HTML it saw on failure).
2. Compare to the documented structure in [dom-selectors.md](dom-selectors.md).
3. Either:
   - **Ask the user to switch the model manually** in the browser — click the composer pill, choose "Pro • Extended", close. Then re-run with `--resume`. The detection will now see `extended` and the stage is marked done.
   - **Or, if the UI genuinely changed**, update the popover click logic in `search.js` and re-run from scratch (no `--resume`).

---

## 4. `send` — `fill returned "No node with given id"` or empty input

**Stage:** send
**Cause:** the composer input isn't where the script expects, or there was stale content and `fill` failed to replace it.

**Fix:**
1. The script auto-clicks the input first; if that still fails, the selector is wrong.
2. Re-run with `--resume` — the `send` stage re-clicks and re-fills.
3. If it keeps failing, the ChatGPT page may have changed. Take a screenshot and check the [dom-selectors.md](dom-selectors.md) table for the new input selector.

---

## 5. `wait` — `login_required` mid-generation

**Stage:** wait
**Cause:** a login wall appeared mid-response (session expired, kicked out by another tab, etc.).

**Fix:**
1. Ask the user to re-log in in the browser.
2. The partially-generated response may be lost; re-run **without** `--resume` (or use `send` only after re-login) to start fresh.

---

## 6. `wait` — `rate_limited`

**Stage:** wait
**Cause:** ChatGPT returned a "please wait" / "too many requests" page.

**Fix:**
1. Wait 60s, then re-run with `--resume`. The `wait` stage will re-poll.
2. If you ran multiple prompts in parallel, stagger their `--send` times by 30s+.

---

## 7. `wait` — `timeout`

**Stage:** wait (exit code `3`, not `4`)
**Cause:** response didn't complete within `--wait` seconds. Pro Extended typically takes 8-12 min; if you set `--wait 600` and it timed out, the response is just slow.

**Fix:**
1. Re-run with `--resume` and a longer `--wait` (e.g. `1800`).
2. Or: take a screenshot to see the current state, then `extract` (with `--resume`) to grab whatever is on screen.

---

## 8. `extract` — `no assistant message found`

**Stage:** extract
**Cause:** the response didn't render, or the script looked at the wrong tab. Possible if the user opened a second ChatGPT tab in the meantime.

**Fix:**
1. Re-run with `--resume` — extraction is read-only so it's safe to retry.
2. If still empty, the response generation never started. Re-run from `send` (no `--resume`) to retry the whole send+wait+extract.

---

## 9. `cleanup` — tab not found

**Stage:** cleanup
**Cause:** the user closed the tab manually before the script could close it.

**Fix:** None needed — just informational. The daemon cleans up empty sessions automatically.

---

## Quick reference table

| Exit 4 reason | Stage | Re-run command |
|---|---|---|
| `No current window` | open | `search.js open --resume` |
| `login_required` (initial) | login-check | user logs in → `search.js login-check --resume` |
| `could not switch to <model>` | ensure-model | user switches manually → `search.js ensure-model extended --resume` |
| fill / click input error | send | `search.js send --resume` |
| `login_required` (mid-gen) | wait | user logs in → `search.js run "prompt" --model extended` (start over) |
| `rate_limited` | wait | wait 60s → `search.js wait --resume` |
| `no assistant message found` | extract | `search.js extract --resume` |

For mid-generation login walls, starting over is usually faster than trying to recover the partial response.

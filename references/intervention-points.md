# Intervention Points

When `search.js` exits with code `4`, it has reached a stage it cannot complete on its own. This file is the runbook for what to do at each one. The script's stderr message names the exact stage; match it against the table below.

After you fix the issue, re-run with `--resume --until-complete` and the script will pick up from the failed stage, then keep waiting for the full answer.

---

## 1. `open` — `extension_error: No current window`

**Stage:** open
**Cause:** the Chrome/Edge window is closed, minimized, or not focused. The Kimi WebBridge extension can only drive tabs in a focused window.

**Fix:**
1. Ask the user to open Chrome/Edge and bring a window to the front.
2. Confirm the Kimi WebBridge extension icon shows as connected.
3. Re-run with `--resume --until-complete`. The `open` stage will re-attempt; if a tab is already in the session it will be reused.

---

## 2. `login-check` — `login_required`

**Stage:** login-check
**Cause:** the ChatGPT tab loaded but the input box is missing — user is not logged in (or the page is mid-redirect to the login page).

**Fix:**
1. Ask the user to log into ChatGPT in the browser.
2. Once logged in, the composer input (`[contenteditable="true"]`) should appear.
3. Re-run with `--resume --until-complete`. The `login-check` stage will re-detect; if logged in it marks done and `ensure-model` proceeds.

---

## 3. `ensure-model` — `could not switch to <target>`

**Stage:** ensure-model
**Cause:** the script could not find the desired option in the model popover, or the popover did not open. Usually means the popover UI changed or the click target moved.

**Fix:**
1. Take a fresh snapshot (the script will print the popover HTML it saw on failure).
2. Compare to the documented structure in [dom-selectors.md](dom-selectors.md).
3. Either:
   - **Ask the user to switch the model manually** in the browser — click the composer pill, choose "Pro • Extended" for deep text, or "Thinking"/"Instant" for image generation, close. Then re-run with `--resume --until-complete`. The detection will now see the target and the stage is marked done.
   - **Or, if the UI genuinely changed**, update the popover click logic in `search.js` and re-run from scratch (no `--resume`).

---

## 4. `ensure-tool` — `could not ensure tool=<target>`

**Stage:** ensure-tool
**Cause:** the script could not open ChatGPT's **Add files and more** menu, could not find the target tool option, or could not verify the active tool chip after clicking.

**Fix:**
1. In the browser, click **Add files and more** in the composer.
2. Choose the requested tool manually: `Deep research`, `Web search`, or `Create image`. To clear a tool, click the active tool chip such as `Deep research`.
3. Re-run with `--resume --until-complete`. The `ensure-tool` stage will re-detect the active chip and mark done.
4. If the UI changed, inspect the menu DOM and update `detectToolState`, `openToolsMenu`, or `clickToolMenuItem` in `search.js`.

---

## 5. `send` — `fill returned "No node with given id"` or empty input

**Stage:** send
**Cause:** the composer input isn't where the script expects, or there was stale content and `fill` failed to replace it.

**Fix:**
1. The script auto-clicks the input first; if that still fails, the selector is wrong.
2. Re-run with `--resume --until-complete` — the `send` stage re-clicks and re-fills.
3. If it keeps failing, the ChatGPT page may have changed. Take a screenshot and check the [dom-selectors.md](dom-selectors.md) table for the new input selector.

---

## 6. `upload` / `send` — `upload_file_invalid`, `upload_input_not_found`, `upload_not_allowed`, or `send_button_not_ready`

**Stage:** upload / send
**Cause:** an upload path is missing/not a file, ChatGPT's file input selector changed, the browser/WebBridge extension blocked file injection, or ChatGPT did not finish processing the attachment before the send timeout.

**Fix:**
1. Confirm every `--upload` path exists and is a regular file.
2. If paths are correct, inspect the current DOM for `input[type="file"]`.
3. Re-run with a selector override if needed: `--upload-selector 'input#upload-files[type="file"]'`.
4. If the error is `upload_not_allowed`, enable **Allow access to file URLs** / **允许访问文件网址** in the Kimi WebBridge extension details page, then verify `~/.kimi-webbridge/bin/kimi-webbridge status` is connected.
5. If the error is `send_button_not_ready`, wait for the attachment preview to finish in ChatGPT or increase `--upload-wait`, then re-run with `--resume --until-complete`.
6. Re-run with `--resume --until-complete`; upload paths are retained in state.

---

## 7. `wait` — `login_required` mid-generation

**Stage:** wait
**Cause:** a login wall appeared mid-response (session expired, kicked out by another tab, etc.).

**Fix:**
1. Ask the user to re-log in in the browser.
2. The partially-generated response may be lost; re-run **without** `--resume` (or use `send` only after re-login) to start fresh.

---

## 8. `wait` — `rate_limited`

**Stage:** wait
**Cause:** ChatGPT returned a "please wait" / "too many requests" page.

**Fix:**
1. Wait 60s, then re-run with `--resume --until-complete`. The `wait` stage will re-poll until complete.
2. If you ran multiple prompts in parallel, stagger their `--send` times by 30s+.

---

## 9. `wait` — `timeout`

**Stage:** wait (exit code `3`, not `4`)
**Cause:** response didn't complete within `--wait` seconds. Pro Extended commonly takes around 10 min and can take 20 min for long prompts; Deep research can take up to 60 min or more. Short "thinking" / "searching" text is not treated as a complete answer.

**Fix:**
1. Re-run with `--resume --until-complete`. Timeout does not mark `wait` done, so resume will keep polling.
2. If you know the session name, run `search.js -s <session> latest --until-complete` to recover the matching ChatGPT conversation and print the newest complete answer.
3. Only use `extract --resume` when you explicitly want the partial text currently on screen.

---

## 10. `extract` — `no assistant message found`

**Stage:** extract
**Cause:** the response didn't render, or the script looked at the wrong tab. Possible if the user opened a second ChatGPT tab in the meantime.

**Fix:**
1. Re-run with `--resume --until-complete` — extraction is read-only so it's safe to retry.
2. If still empty, the response generation never started. Re-run from `send` (no `--resume`) to retry the whole send+wait+extract.

---

## 11. `extract-images` — `no_images`

**Stage:** extract-images
**Cause:** the latest assistant message did not contain any generated-image candidate matching the size/visibility filters. The image may still be generating, ChatGPT may have returned text-only refusal/error, or the DOM changed.

**Fix:**
1. Re-run `search.js -s <session> latest --image --until-complete --image-dir <dir>` to poll again and extract when ready.
2. If the browser visibly shows the generated image, inspect the latest assistant message DOM and update the image filter in `search.js` / [dom-selectors.md](dom-selectors.md).
3. If ChatGPT returned only text, revise the prompt and run `image` again.

---

## 12. `extract-images` — `image_save_failed`

**Stage:** extract-images
**Cause:** the script found generated image elements, but could not obtain image bytes through page-context fetch or public URL download. This usually means the image source is protected in a way the current extraction path cannot read.

**Fix:**
1. Check the manifest path printed in `stageData`; it contains the failed candidates.
2. Re-run `extract-images --resume` once in case the temporary URL was still materializing.
3. If it repeats, use the browser's visible image download UI or update the extractor for the new ChatGPT image element shape.

---

## 13. `cleanup` — tab not found

**Stage:** cleanup
**Cause:** the user closed the tab manually before the script could close it.

**Fix:** None needed — just informational. The daemon cleans up empty sessions automatically.

---

## Quick reference table

| Exit 4 reason | Stage | Re-run command |
|---|---|---|
| `No current window` | open | `search.js open --resume` |
| `login_required` (initial) | login-check | user logs in → `search.js --resume --until-complete` |
| `could not switch to <model>` | ensure-model | user switches manually → `search.js --resume --until-complete` |
| `tool_switch_failed` | ensure-tool | user selects tool manually → `search.js --resume --until-complete` |
| `upload_file_invalid` | upload | fix path → `search.js --resume --until-complete` |
| `upload_input_not_found` | upload | inspect DOM or pass `--upload-selector` |
| `upload_not_allowed` | upload | enable Kimi WebBridge file URL access → `search.js --resume --until-complete` |
| `send_button_not_ready` | send | wait longer or pass `--upload-wait 120` → `search.js --resume --until-complete` |
| fill / click input error | send | `search.js send --resume` |
| `login_required` (mid-gen) | wait | user logs in → `search.js --model extended --until-complete "prompt"` (start over) |
| `rate_limited` | wait | wait 60s → `search.js wait --resume --until-complete` |
| `wait_timeout` | wait | `search.js -s <session> latest --until-complete` |
| `no assistant message found` | extract | `search.js extract --resume` |
| `no_images` | extract-images | `search.js -s <session> latest --image --until-complete` |
| `image_save_failed` | extract-images | `search.js extract-images --resume --image-dir <dir>` |

For mid-generation login walls, starting over is usually faster than trying to recover the partial response.

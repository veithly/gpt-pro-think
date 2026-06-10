# Manual Fallback Workflow

Use these steps when `search.js` errors out and the Agent must drive the browser directly. Each step maps to a section of `search.js` — when the script fails, the Agent can read the corresponding function and replicate it via curl.

The daemon endpoint is `http://127.0.0.1:10086/command` (POST, JSON body). Common envelope:

```json
{"action": "<tool>", "args": {...}, "session": "<name>"}
```

Successful response: `{"ok": true, "data": {...}}`. Error: `{"ok": false, "error": {"code": "...", "message": "..."}}`. See [operations.md](operations.md) for the full envelope.

---

## Step 1 — Health check

```bash
~/.kimi-webbridge/bin/kimi-webbridge status
```

| Result | Action |
|---|---|
| `running: true, extension_connected: true` | Healthy, continue |
| `running: false` | `~/.kimi-webbridge/bin/kimi-webbridge start` |
| `extension_connected: false` | Ask user: "请打开浏览器，确保 Kimi WebBridge 扩展已连接" |
| Command not found | `curl -fsSL https://cdn.kimi.com/webbridge/install.sh \| bash` |

## Step 2 — Prepare prompts

Save each prompt to a file before sending (enables retry):

```
pitch/gpt-pro/prompts/prompt-N.md
```

Each prompt should include: context, focus/angle, output format, constraints. Recommended ≥3 prompts from different angles for parallel execution.

## Step 3 — Open tabs

For each prompt, open a ChatGPT tab in its own session:

```bash
SESSION="gpt-pro-N"
curl -s -X POST http://127.0.0.1:10086/command \
  -H 'Content-Type: application/json' \
  -d "{\"action\":\"navigate\",\"args\":{\"url\":\"https://chatgpt.com\",\"newTab\":true,\"group_title\":\"GPT Pro Think - $SESSION\"},\"session\":\"$SESSION\"}"
```

Wait 3s for the page to load.

## Step 4 — Verify / switch to Pro Extended

**Method A — script (preferred):** `node search.js --dry-run --model extended` for deep text work, `node search.js doctor --json` before ChatGPT Deep research, or `node search.js --dry-run --model instant` / `--model think` before image generation (see SKILL.md).

**Method B — manual:** Take a `snapshot`, find the composer pill (text contains `Heavy` / `Extended Pro` / `Thinking` / `Instant`). To open its popover, dispatch the pointer-event sequence documented in [dom-selectors.md](dom-selectors.md). Click the menuitemradio with text matching the desired mode (`Pro • Extended` for Extended Pro).

## Step 5 — Select ChatGPT tool (optional)

For ChatGPT Deep research / deep search, prefer the script:

```bash
node search.js doctor --json
node search.js research "Research current competitors and cite sources."
node search.js ensure-tool deep-research
node search.js ensure-tool none
```

Manual selection:
1. Open the composer **Add files and more** button (`[data-testid="composer-plus-btn"]`) with the pointer-event sequence in [dom-selectors.md](dom-selectors.md).
2. In the opened `[role="menu"]`, click the `[role="menuitemradio"]` with text `Deep research` or `Web search`.
3. Verify the composer shows an active chip like `Deep research, click to remove`.

If Deep research is enabled, plan for a longer wait. Agent-driven runs should pass `--until-complete`; manual fallback should wait until the full report is available before extracting.

## Step 6 — Send the prompt

If the prompt needs local files, prefer the script:

```bash
node search.js --upload ./brief.pdf --upload ./data.csv --until-complete "Summarize and compare these files."
```

Manual upload through WebBridge:

```bash
curl -s -X POST http://127.0.0.1:10086/command \
  -H 'Content-Type: application/json' \
  -d "{\"action\":\"upload\",\"args\":{\"selector\":\"input#upload-files[type=\\\"file\\\"]\",\"files\":[\"$PWD/brief.pdf\"]},\"session\":\"$SESSION\"}"
```

Then wait until the attachment chip/file name appears in the composer before sending the text prompt. The current general file input is `input#upload-files[type="file"]`; image-only inputs such as `input#upload-photos` should be used only when you intentionally want ChatGPT's photo/image upload path.

```bash
# Read prompt file and JSON-encode for the value field
ESCAPED=$(node -e "const fs=require('fs');const s=fs.readFileSync('prompt-file-path.md','utf8');process.stdout.write(JSON.stringify(s))")

# Click input to focus (use double-quoted selector — see dom-selectors.md)
curl -s -X POST http://127.0.0.1:10086/command \
  -H 'Content-Type: application/json' \
  -d "{\"action\":\"click\",\"args\":{\"selector\":\"[contenteditable=\\\"true\\\"]\"},\"session\":\"$SESSION\"}"

# Fill
curl -s -X POST http://127.0.0.1:10086/command \
  -H 'Content-Type: application/json' \
  -d "{\"action\":\"fill\",\"args\":{\"selector\":\"[contenteditable=\\\"true\\\"]\",\"value\":$ESCAPED},\"session\":\"$SESSION\"}"

# Send
curl -s -X POST http://127.0.0.1:10086/command \
  -H 'Content-Type: application/json' \
  -d "{\"action\":\"click\",\"args\":{\"selector\":\"[data-testid=\\\"send-button\\\"]\"},\"session\":\"$SESSION\"}"
```

**Send-button fallbacks** (try in order):
1. `[data-testid="send-button"]`
2. `form button[type="submit"]`
3. Last `@e` ref button after the input in a fresh snapshot

**Stagger parallel sends by 30s** to avoid rate limiting.

## Step 7 — Wait for responses

For agent-driven runs, keep a hard patience budget of at least **30 min** for GPT Pro Think / Pro Extended and at least **50 min** for Deep research. Ten minutes with no stdout is normal; do not open a new ChatGPT page, re-send the prompt, or start a fresh browser research just because nothing printed. The CLI refreshes the same tab every 5 minutes by default (`--refresh 300`) while it waits. For parallel Pro Extended tabs, expect the wait to stretch; for Deep research, use fewer parallel sends and wait for the exported report.

Poll every 2-3 min. Treat completion as conservative:
- `Stop generating` button count = 0
- The latest assistant text is not a short "thinking" / placeholder string
- The latest assistant text is substantive (default script threshold: 240 chars)
- The latest assistant text is stable for about 60s
- Input is active again

```bash
curl -s -X POST http://127.0.0.1:10086/command \
  -H 'Content-Type: application/json' \
  -d "{\"action\":\"snapshot\",\"session\":\"$SESSION\"}"
```

Then parse with a small node script: look for `Stop generating` and `Copy` counts.

## Step 8 — Extract responses

```bash
curl -s -X POST http://127.0.0.1:10086/command \
  -H 'Content-Type: application/json' \
  -d "{\"action\":\"evaluate\",\"args\":{\"code\":\"(() => { const m = document.querySelectorAll('[data-message-author-role=assistant]'); if (!m.length) return JSON.stringify({error:'no messages'}); const last = m[m.length-1]; return JSON.stringify({len: last.innerText.length, text: last.innerText}); })()\"},\"session\":\"$SESSION\"}"
```

Save to `pitch/gpt-pro/responses/prompt-N-response.md`.

If extraction returns empty: try `.markdown` selector fallback, then fall back to a full-page screenshot + visual reading.

### Extract generated images

Preferred path:

```bash
node search.js image --until-complete "Create a square watercolor icon." --image-dir ./assets/generated
node search.js -s "$SESSION" latest --image --until-complete --image-dir ./assets/generated
node search.js -s "$SESSION" extract-images --resume --image-dir ./assets/generated
```

Manual inspection path:

```bash
curl -s -X POST http://127.0.0.1:10086/command \
  -H 'Content-Type: application/json' \
  -d "{\"action\":\"evaluate\",\"args\":{\"code\":\"(() => { const msgs=[...document.querySelectorAll('[data-message-author-role=assistant]')]; const last=msgs[msgs.length-1]; const imgs=last?[...last.querySelectorAll('img')].map(img=>({src:img.currentSrc||img.src,width:img.naturalWidth,height:img.naturalHeight,complete:img.complete,alt:img.alt})):[]; return JSON.stringify({count:imgs.length, imgs}); })()\"},\"session\":\"$SESSION\"}"
```

The automatic extractor saves only visible large image candidates from the latest assistant message. It first reads bytes with page-context `fetch(..., { credentials: 'include' })`, then falls back to a public Node download for `http(s)` sources.

## Step 9 — Synthesize (optional, when ≥3 prompts)

1. Combine key insights from all responses
2. Add cross-reference and contradiction analysis
3. Send meta-prompt in a new session `gpt-pro-decision`
4. Wait with the same 30+ min GPT Pro Think patience budget, then collect final decision into `final-decision.md`

## Step 10 — Cleanup

```bash
for s in gpt-pro-1 gpt-pro-2 gpt-pro-3 gpt-pro-decision; do
  curl -s -X POST http://127.0.0.1:10086/command \
    -H 'Content-Type: application/json' \
    -d "{\"action\":\"close_session\",\"session\":\"$s\"}"
done
```

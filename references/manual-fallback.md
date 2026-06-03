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

**Method A — script (preferred):** `node search.js --dry-run --model extended` (see SKILL.md).

**Method B — manual:** Take a `snapshot`, find the composer pill (text contains `Heavy` / `Extended Pro` / `Thinking` / `Instant`). To open its popover, dispatch the pointer-event sequence documented in [dom-selectors.md](dom-selectors.md). Click the menuitemradio with text matching the desired mode (`Pro • Extended` for Extended Pro).

## Step 5 — Send the prompt

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

## Step 6 — Wait for responses

Pro Extended typically takes **8-12 min** per response. For 3 parallel tabs, total wait ≈ **10-15 min**.

Poll every 2-3 min. Completion indicators:
- `Stop generating` button count = 0
- `Copy` button count ≥ 2 (1 in user prompt + 1 in assistant reply)
- Input is active again

```bash
curl -s -X POST http://127.0.0.1:10086/command \
  -H 'Content-Type: application/json' \
  -d "{\"action\":\"snapshot\",\"session\":\"$SESSION\"}"
```

Then parse with a small node script: look for `Stop generating` and `Copy` counts.

## Step 7 — Extract responses

```bash
curl -s -X POST http://127.0.0.1:10086/command \
  -H 'Content-Type: application/json' \
  -d "{\"action\":\"evaluate\",\"args\":{\"code\":\"(() => { const m = document.querySelectorAll('[data-message-author-role=assistant]'); if (!m.length) return JSON.stringify({error:'no messages'}); const last = m[m.length-1]; return JSON.stringify({len: last.innerText.length, text: last.innerText}); })()\"},\"session\":\"$SESSION\"}"
```

Save to `pitch/gpt-pro/responses/prompt-N-response.md`.

If extraction returns empty: try `.markdown` selector fallback, then fall back to a full-page screenshot + visual reading.

## Step 8 — Synthesize (optional, when ≥3 prompts)

1. Combine key insights from all responses
2. Add cross-reference and contradiction analysis
3. Send meta-prompt in a new session `gpt-pro-decision`
4. Wait ~10 min, collect final decision into `final-decision.md`

## Step 9 — Cleanup

```bash
for s in gpt-pro-1 gpt-pro-2 gpt-pro-3 gpt-pro-decision; do
  curl -s -X POST http://127.0.0.1:10086/command \
    -H 'Content-Type: application/json' \
    -d "{\"action\":\"close_session\",\"session\":\"$s\"}"
done
```

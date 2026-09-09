# DOM Selectors

Stable CSS / ARIA selectors for ChatGPT (https://chatgpt.com) verified July 2026. These survived multiple sessions and tab opens — prefer them over scanning the full accessibility tree.

## Element reference

| Element | Stable selector | ARIA role | Visible name / value |
|---|---|---|---|
| Chat input | `[contenteditable="true"][class*="ProseMirror"]` (preferred) — fall back to `[contenteditable="true"]` | textbox | "Chat with ChatGPT" |
| Model / intelligence pill | `button.__composer-pill` | button | With the picker CLOSED this reads the selected tier (`6Pro` / `Instant` / …) — but after the Power slider is touched it mirrors the effort label (`High`). While the picker is OPEN it reads the `Thinking effort` tooltip instead. Always verify via the closed pill first, then the picker's `Select model` row |
| Intelligence picker content | `[data-testid="composer-intelligence-picker-content"]` (preferred) | — | visible picker root under the model pill |
| Popover item | `[role="menuitemradio"]` | menuitemradio | `极速 5.5` / `中` / `高` / `极高` / `Pro` (English builds use `Instant` / `Medium` / `High` / `Very High` / `Pro`); current = `aria-checked="true"` |
| Popover header | picker text root | — | `智能` / `Intelligence` |
| Send button | `[data-testid="send-button"]` — readiness and click resolve the same element from the priority chain `[data-testid="send-button"]`, `button[aria-label="Send prompt"]`, `button[aria-label*="Send"]`, `button[aria-label*="发送"]` (some builds drop the testid) | button | "Send prompt" |
| Stop generating | `button[aria-label="Stop generating"]` | button | "Stop generating" |
| Profile badge | `button[aria-label*="open profile menu"]` | button | `"{username} Pro"` |
| Assistant message | `[data-message-author-role="assistant"]` | — | last child = most recent reply |
| Generated file entity | `button.behavior-btn[aria-label]` inside the latest assistant message | button | filename such as `HackathonHunter_G0R_Research_Pack.md`; click triggers `/backend-api/files/...` download flow |
| Generated images | `img` inside the latest assistant message and sibling `[class*="group/imagegen-image"]` roots after the latest user turn | img | ordinary images require at least 128x128 and 65,536 px area; imagegen thumbnails are accepted above the 32 px visibility floor and deduplicated by source URL |
| File attachment button | `[data-testid="composer-plus-btn"]` | button | `添加文件等` / `Add files and more` |
| Composer tools menu | popover opened by trusted-click `[data-testid="composer-plus-btn"]` | — (no role=menu ancestor; rows are `div[tabindex="0"]`) | contains `Create image`, `Deep research`, `Web search` (`创建图片` / `深度研究` / `网页搜索`); self-dismisses on background windows — see the Sept 2026 section |
| Composer tool option | menu row via a11y snapshot (`[N]<div tabindex=0` + child spans) | — | match the row's FIRST LINE exactly (`Deep research`); click by snapshot ref |
| Active tool chip | `button,[role="button"]` with `aria-label*="click to remove"` | button | e.g. `Deep research, click to remove` |
| Deep Research mode | visible `[role="tablist"]` / `[role="tabpanel"]` containing `深度研究` or `Deep research` | tablist / tabpanel | New UI exposes `推荐` / `报告` tabs and a `发送提示` button instead of a removable chip |
| General file input | `input#upload-files[type="file"]` | — | hidden input, `multiple=true`, accepts general files |
| Photo file input | `input#upload-photos[type="file"]` | — | image-only input, `accept="image/*"` |
| Dictation / Voice | `button[aria-label="Start dictation"]`, `button[aria-label="Start Voice"]` | button | voice I/O |

## Popover mechanics — IMPORTANT

The composer pill (`button.__composer-pill`) opens a Radix-based popover that does **not** respond to a synthetic `el.click()`. The React/Radix event system expects real pointer events.

To open the popover, dispatch this sequence (in this order, on the pill element, with a real `clientX`/`clientY` from `getBoundingClientRect()`):

```js
for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) {
  pill.dispatchEvent(new PointerEvent(t, {bubbles:true, cancelable:true, clientX:r.x+5, clientY:r.y+5, button:0}));
}
```

The popover renders inside the page (not a separate portal root in current ChatGPT builds). The most stable inner root in the current UI is `[data-testid="composer-intelligence-picker-content"]`; the surrounding Radix container still exposes `[role=menu]`.

### Sept 2026 picker structure

Clicking the pill opens a popover containing:

- a `menuitem` with `aria-label="Select model"` whose visible text is the current tier (`6Pro`) or, after the Power slider is touched, the effort label (`Extra High`)
- a `menuitem` with `aria-label="Power"` (tooltip `Thinking effort`) — a 0-4 slider (`role=slider`, `aria-valuenow` 0-3 = Low…Extra High) driven by Arrow keys while focused
- `menuitemradio` entries for the chat models behind `Select model` (e.g. `Latest`, `GPT-5.6 Sol`, `GPT-5.5`), current one `aria-checked="true"`

`ensure-model` therefore verifies the closed-state pill first and only walks this popover when a switch is actually needed; image runs move Power to Extra High by pressing ArrowRight until the picker text says `Extra High`.

### Composer tools menu — IMPORTANT (Sept 2026)

The `Add files and more` popover renders tool rows as plain `div[tabindex="0"]` elements with **no** `role=menu` ancestor, and the popover **self-dismisses ~1-2s after opening on background windows** — cross-process polling and in-page synthetic events both lose the race (in-page pointer events often never open it at all).

The only reliable recipe (verified live) is all CLI-side, via trusted clicks and an a11y snapshot:

1. Re-issue `open <same-url>` WITHOUT the background flag — same-URL open reuses the tab and raises the window (the page may reload; wait for `readyState=complete` plus ~800ms hydration).
2. Trusted click `[data-testid="composer-plus-btn"]`.
3. `opencli browser <s> state` — parse row containers (`[N]<div tabindex=0`) and their child span texts until the next container; match the row by EXACT first-line text (substring matching pulls sidebar titles like "Create Sticker Images").
4. Trusted click the matched row ref.

After selection a `[data-inline-selection-pill]` chip appears (e.g. `Deep research`); on some builds the chip is not detectable, so image runs continue when verification fails despite a successful click.

### Uploads

OpenCLI's native `upload` clicks the input and waits for a file chooser, which never fires for the hidden composer `input#upload-files` (even if un-hidden). The working transport is an in-page `DataTransfer` attach plus synthetic `input`/`change` events; ChatGPT then shows the normal `Remove file N: <name>` chip.

## Resilience notes

- `opencli keys` prints plain text (`Pressed: X`) — pass through as plain output, never JSON-parse it.
- `opencli fill` cannot carry multi-line prompt values as CLI arguments; insert prompt text with in-page `document.execCommand('insertText')`.
- Evaluations on freshly opened background tabs can fail with a bare "Command failed" (execution context destroyed mid-navigation) — retry transiently.

## Generated image extraction

Image mode scans the latest `[data-message-author-role="assistant"]` node plus every sibling `[class*="group/imagegen-image"]` root after the latest user turn. ChatGPT can expose one generated result as the large active image and the remaining results only as 48 px thumbnail roots, so all roots must be included and deduplicated by source URL.

It filters out small or hidden ordinary assets so avatars, icons, emoji, and logos are not saved accidentally. The current threshold is:

- visible element (`display` and `visibility` are active, rendered box > 32 px)
- natural/rendered size at least 128x128
- area at least 65,536 px
- descriptor does not look like avatar/profile/user/icon/emoji/logo unless the largest edge is at least 512 px

Images inside an `imagegen` root are exempt from the 128x128 and area thresholds, but still need a visible rendered box above 32 px. This preserves the 48 px alternate-result thumbnails while keeping unrelated small UI assets out.

For saving, the script first tries `fetch(src, { credentials: 'include' })` in the page context so authenticated ChatGPT image URLs and `blob:` URLs can be read. If that fails and the source is `http(s)`, Node tries a public download fallback.

## Quoting gotcha

The kimi-webbridge `click` action wraps the CSS selector in a JS template literal with single quotes. **Single quotes inside the selector value cause a `SyntaxError: Uncaught`** in the click handler. Always use double quotes or no quotes:

```js
// ❌ Fails: "Uncaught"
"[contenteditable='true']"

// ✅ Works
'[contenteditable="true"]'
'[contenteditable=true]'
```

## When CSS selectors fail

Take a `snapshot` and read the tree. Each interactive node has an `@e<number>` ref you can pass back to `click` / `fill` directly. Note that refs change between snapshots — never reuse an `@e` from an older snapshot.

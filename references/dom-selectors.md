# DOM Selectors

Stable CSS / ARIA selectors for ChatGPT (https://chatgpt.com) as of late 2025. These survived multiple sessions and tab opens — prefer them over scanning the full accessibility tree.

## Element reference

| Element | Stable selector | ARIA role | Visible name / value |
|---|---|---|---|
| Chat input | `[contenteditable="true"][class*="ProseMirror"]` (preferred) — fall back to `[contenteditable="true"]` | textbox | "Chat with ChatGPT" |
| Model / thinking pill | `button.__composer-pill` | button | current mode label: `Heavy` / `Extended Pro` / `Thinking` / `Instant` |
| Popover item | `[role="menuitemradio"]` | menuitemradio | `Instant` / `Thinking • <effort>` / `Pro • <variant>`; current = `aria-checked="true"` |
| Popover header | `.__menu-label` | — | section header, e.g. `Latest • 5.5` |
| Send button | `[data-testid="send-button"]` | button | "Send prompt" |
| Stop generating | `button[aria-label="Stop generating"]` | button | "Stop generating" |
| Profile badge | `button[aria-label*="open profile menu"]` | button | `"{username} Pro"` |
| Assistant message | `[data-message-author-role="assistant"]` | — | last child = most recent reply |
| Generated images | `img` inside the latest assistant message | img | filtered to visible images at least 128x128 and 65,536 px area |
| File attachment button | `button.composer-btn[aria-label="Add files and more"]` | button | "Add files and more" |
| Composer tools menu | `[role="menu"]` opened from `[data-testid="composer-plus-btn"]` | menu | contains `Create image`, `Deep research`, `Web search` |
| Composer tool option | `[role="menuitemradio"]` inside tools menu | menuitemradio | `Create image` / `Deep research` / `Web search`; current = `aria-checked="true"` |
| Active tool chip | `button,[role="button"]` with `aria-label*="click to remove"` | button | e.g. `Deep research, click to remove` |
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

The popover renders inside the page (not a separate portal root in current ChatGPT builds), so `document.querySelectorAll('[role=menu]')` finds it after dispatching.

## Composer tools menu

As of the verified ChatGPT UI, the `Add files and more` button (`[data-testid="composer-plus-btn"]`) opens a Radix menu whose relevant radio options are:

- `Create image`
- `Deep research`
- `Web search`

Use the same pointer-event sequence as the model popover for both the plus button and the target `[role="menuitemradio"]`. After selecting `Deep research`, the composer shows an active chip whose accessible label is `Deep research, click to remove`. After selecting `Web search`, the chip label is currently `Search, click to remove`. The script uses those chips for idempotent detection and for `ensure-tool none`.

## Generated image extraction

Image mode only scans the latest `[data-message-author-role="assistant"]` node. It collects `img` elements and filters out small or hidden assets so avatars, icons, emoji, and logos are not saved accidentally. The current threshold is:

- visible element (`display` and `visibility` are active, rendered box > 32 px)
- natural/rendered size at least 128x128
- area at least 65,536 px
- descriptor does not look like avatar/profile/user/icon/emoji/logo unless the largest edge is at least 512 px

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

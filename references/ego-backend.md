# ego-browser backend (ego lite)

How `search.js` drives ChatGPT through ego-browser, and the runtime quirks the
adapter works around. Read this before changing `egoBrowserCommand`,
`buildEgoProgram`, `snapshotToolMenuEgo`, `ensureModelEgo`, or `ensurePowerEgo`.

## Architecture

- The backend is selected with `--browser-backend ego` or resolved by `auto`
  (ego → opencli → webbridge; ego always wins when installed). Sessions store
  the concrete backend in `state/<session>.json`; `--resume` keeps it unless
  the flag is passed.
- Each session maps to one ego **task space** named `gpt-pro-think <session>`,
  created/resumed via `taskSpace(name)` (skill 2.0 API). `cleanup` runs
  `task.finish({ keep: [] })`, which closes agent-managed Pages and the space.
- Every daemon action (`evaluate`, `click`, `navigate`, `upload`, ...) maps to
  ONE one-shot `ego-browser nodejs` program (`buildEgoProgram`). The request
  travels as a JS literal inside the program text (`egoJsonLiteral`); the
  result comes back as a `@@EGO_RESULT@@{...}` marker line.
- Page resolution per action: the active chatgpt.com tab in the space wins,
  an unmanaged chatgpt tab is adopted (`task.adopt`), otherwise the space's
  first Page `p1` is used.

## ego runtime quirks (verified on 0.5.0.28, skill 2.0.0)

1. **Wrap every program in an async IIFE.** The runtime compiles stdin as a
   plain vm.Script; bare top-level `await` is tolerated in some shapes but
   `await` inside a top-level `try {}` is rejected ("await is only valid in
   async functions"). The IIFE is standard semantics and the runtime waits
   for the promise before exiting.
2. **All script output is stderr, flushed at exit.** `console.log` and the
   old `cliLog` both land on the process stderr after the script finishes.
   Parse the merged stdout+stderr for the marker; never stream. Uncaught
   errors exit 1.
3. **The child environment is sanitized** and **stdin belongs to the
   runtime**, so requests cannot travel via env or a persistent worker; one
   process per action (~0.3s warm) is the reliable shape.
4. **Selectors require exactly one match.** Multi-match throws ("matched N
   elements"); the adapter retries with `selector + ' >> nth=0'`. A
   zero-match click waits out its `timeout` option (default 3000ms) before
   failing.
5. **All times are milliseconds.** Waits use `page.waitForTimeout(ms)`.
6. **`page.evaluate(fnOrString)` returns JSON strings verbatim** — parse
   if-string (`__j` helper) whenever the page code returns
   `JSON.stringify(...)`.
7. **`page.setInputFiles(selector, paths)`** replaces the file list and takes
   an array; it has no eval-size limit, so uploads ride it instead of the
   DataTransfer eval transport.
8. **Upgrade notices**: if the runtime output contains
   `[ego-browser:notice]`, the adapter logs that an `ego-browser upgrade` is
   available — surface it to the user, run it only with their approval.

## ChatGPT UI quirks the ego flows handle

- **The tools popover self-dismisses** ~1-2s after the driving runtime goes
  away, and in-page synthetic events do not open it. `snapshotToolMenuEgo`
  therefore trusted-clicks the plus button, finds rows via DOM, tags the
  target row with `data-ego-tag`, and real-clicks it — all inside ONE spawn.
- **The popover rows are plain divs without a11y names** on the Sept 2026 UI,
  so `snapshot()` cannot carry their labels; DOM matching (exact first-line
  `innerText` match, sidebar excluded) is used instead.
- **Row titles and subtitles share one `innerText`** ("网页搜索\n查找实时新闻
  和信息"). Split the RAW text on newlines BEFORE normalizing, or `norm()`
  collapses the lines and exact label matching never fires.
- **Localized control names.** The Power control is `Power` / `Thinking
  effort` in English and `能力` in the Chinese UI; the extra-high position
  reads "item 5 of 5" / "第 5 项，共 5 项". `ensurePowerEgo` walks the slider
  with arrow keys and accepts both spellings. The default `gpt-6-pro` target
  is verified from the composer pill ("6 Pro"), which is language-stable.
- **The send button can swallow trusted clicks** (enabled, click dispatches,
  no user turn) while the in-page `el.click()` works; the send pipeline
  escalates trusted click → in-page click → Enter key for that reason.

## Failure semantics

- `user is controlling` errors map to `user_controlling` → exit 4 (human
  intervention), same contract as OpenCLI's intervention points.
- Missing binary maps to `ego_not_found` with an install hint; task-space
  errors map to `ego_task_space_unavailable` (retry with `--resume`).
- OpenCLI is never used as an internal fallback on the ego backend (it cannot
  attach to the ego runtime); ensure-model falls back to the WebBridge DOM
  flow, which is pure page-side scripting.

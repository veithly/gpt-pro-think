# ego-browser backend (ego lite)

How `search.js` drives ChatGPT through ego-browser, and the runtime quirks the
adapter works around. Read this before changing `egoBrowserCommand`,
`buildEgoProgram`, `snapshotToolMenuEgo`, `ensureModelEgo`, or `ensurePowerEgo`.

## Architecture

- The backend is selected with `--browser-backend ego` or resolved by `auto`
  (ego → opencli → webbridge). Sessions store the concrete backend in
  `state/<session>.json`; `--resume` keeps it unless the flag is passed.
- Each session maps to one ego **task space** named `gpt-pro-think <session>`.
  `useOrCreateTaskSpace` re-attaches to it on every action; `cleanup` closes
  all of its tabs, which closes the space.
- Every daemon action (`evaluate`, `click`, `navigate`, `upload`, ...) maps to
  ONE one-shot `ego-browser nodejs` program (`buildEgoProgram`). The request
  travels as a JS literal inside the program text (`egoJsonLiteral`); the
  result comes back as a `@@EGO_RESULT@@{...}` marker line.

## ego runtime quirks (verified on 0.4.7.4)

1. **All script output is stderr, flushed at exit.** `cliLog`, `console.log`,
   and `process.stdout.write` all land on the process stderr after the script
   finishes. Parse the merged stdout+stderr for the marker; never stream.
2. **The child environment is sanitized.** Custom env vars (including
   `__EGO_ARGS__` and `EGO_BROWSER_BIN`) do not reach the embedded Node, so
   requests cannot travel via env.
3. **stdin belongs to the runtime.** In `-e`/stdin modes the runtime consumes
   stdin; a persistent worker reading request lines never sees `data` events
   (only `end`). One process per action is the reliable shape; warm spawns
   cost ~0.3s.
4. **`js()` returns JSON strings verbatim.** Page code that returns
   `JSON.stringify(...)` gives a string, not an object. Inside ego programs
   use the `__j` helper (parse-if-string); the Node-side `evaluate()` wrapper
   already does this for `cmd('evaluate')`.
5. **`uploadFile(selector, paths)` replaces the file list but accepts an
   array**, so multi-file upload is one call. It goes through CDP file
   handling and has no eval-size limit, so large uploads should ride the
   `upload` action instead of the DataTransfer eval transport.
6. **Uncaught errors exit 1** with the stack on stderr. ego programs always
   wrap work in try/catch and emit a structured `ok:false` result instead.

## ChatGPT UI quirks the ego flows handle

- **The tools popover self-dismisses** ~1-2s after the driving runtime goes
  away, and in-page synthetic events do not open it. `snapshotToolMenuEgo`
  therefore trusted-clicks the plus button, finds rows via DOM, tags the
  target row with `data-ego-tag`, and real-clicks it — all inside ONE spawn.
- **The popover rows are plain divs without a11y names** on the Sept 2026 UI,
  so `snapshotText()` cannot carry their labels; DOM matching (exact
  first-line `innerText` match, sidebar excluded) is used instead.
- **Row titles and subtitles share one `innerText`** ("网页搜索\n查找实时新闻
  和信息"). Split the RAW text on newlines BEFORE normalizing, or `norm()`
  collapses the lines and exact label matching never fires.
- **Localized control names.** The Power control is `Power` / `Thinking
  effort` in English and `能力` in the Chinese UI; the extra-high position
  reads "item 5 of 5" / "第 5 项，共 5 项". `ensurePowerEgo` walks the slider
  with arrow keys and accepts both spellings. The model picker's tier radios
  carry generation-specific names (最新 / GPT-5.6 Sol / ...); the default
  `gpt-6-pro` target is verified from the composer pill ("6 Pro"), which is
  language-stable.

## Failure semantics

- `user is controlling` errors map to `user_controlling` → exit 4 (human
  intervention), same contract as OpenCLI's intervention points.
- Missing binary maps to `ego_not_found` with an install hint; task-space
  errors map to `ego_task_space_unavailable` (retry with `--resume`).
- OpenCLI is never used as an internal fallback on the ego backend (it cannot
  attach to the ego runtime); ensure-model falls back to the WebBridge DOM
  flow, which is pure page-side scripting.

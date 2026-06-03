#!/usr/bin/env node
// search.js - Drive ChatGPT Pro (or Pro Extended) via kimi-webbridge.
//
// Default entry: `search.js "Your prompt"` runs the full pipeline.
// Sub-commands: open | login-check | ensure-model | send | wait | extract
//               | status | cleanup | run
// Per-session state file: <script dir>/state/<session>.json
// `--resume` skips stages already marked done.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DAEMON_HOST = '127.0.0.1';
const DAEMON_PORT = 10086;
const STATUS_BIN = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.kimi-webbridge', 'bin',
  process.platform === 'win32' ? 'kimi-webbridge.exe' : 'kimi-webbridge'
);
const STATE_DIR = path.join(__dirname, 'state');
const STATE_VERSION = 1;
const STAGE_NAMES = ['open', 'loginCheck', 'ensureModel', 'send', 'wait', 'extract'];
const CHATGPT_HOST_RE = /^https?:\/\/(www\.)?chatgpt\.com\//;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error('[search]', ...a);

// --- Daemon RPC --------------------------------------------------------------

async function cmd(action, args = {}, session = 'default', opts = {}) {
  const body = JSON.stringify({ action, args, session });
  const maxAttempts = opts.retries !== undefined ? opts.retries : 3;
  const baseDelay = opts.baseDelay || 250;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await cmdOnce(body, action);
    } catch (e) {
      lastErr = e;
      const transient =
        /ECONNREFUSED|ECONNRESET|socket hang up|ETIMEDOUT|timeout/i.test(e.message) ||
        /No current window/i.test(e.message);
      if (!transient || attempt === maxAttempts - 1) break;
      const delay = baseDelay * Math.pow(3, attempt);
      log(`retry ${attempt + 1}/${maxAttempts - 1} after ${delay}ms (${e.message.slice(0, 80)})`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

function cmdOnce(body, action) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST', host: DAEMON_HOST, port: DAEMON_PORT, path: '/command',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 30000,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); }
          catch { reject(new Error(`${action}: invalid JSON: ${buf.slice(0, 200)}`)); }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`${action}: daemon timeout`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function unwrap(r, actionHint) {
  if (!r) throw new Error(`${actionHint || 'daemon'}: empty response`);
  if (r.ok === false) {
    const code = (r.error && r.error.code) || 'error';
    const msg = (r.error && r.error.message) || 'daemon error';
    if (/no current window/i.test(msg)) {
      const e = new Error(`chrome has no focused window - please open Chrome (or focus an existing window) and retry`);
      e.code = 'no_current_window';
      throw e;
    }
    if (/no tab/i.test(msg)) {
      const e = new Error(`session has no open tab: ${msg}`);
      e.code = 'no_tab';
      throw e;
    }
    throw new Error(`${code}: ${msg}`);
  }
  return r.data !== undefined ? r.data : r;
}

// --- Health check ------------------------------------------------------------

async function healthCheck() {
  return new Promise((resolve, reject) => {
    execFile(STATUS_BIN, ['status'], { timeout: 10000 }, (err, stdout) => {
      if (err) return reject(new Error(`kimi-webbridge status failed: ${err.message}`));
      try {
        const s = JSON.parse(stdout);
        if (!s.running) return reject(new Error('daemon not running'));
        if (!s.extension_connected) return reject(new Error('browser extension not connected'));
        resolve(s);
      } catch (e) {
        reject(new Error(`Cannot parse status output: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

// --- State file --------------------------------------------------------------

function statePath(session) {
  return path.join(STATE_DIR, `${session}.json`);
}

function loadState(session) {
  const p = statePath(session);
  if (!fs.existsSync(p)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (s.version !== STATE_VERSION) {
      log(`state version mismatch (have ${s.version}, want ${STATE_VERSION}); ignoring`);
      return null;
    }
    return s;
  } catch (e) {
    log(`corrupt state file: ${e.message}`);
    return null;
  }
}

function saveState(state) {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  state.updatedAt = Date.now();
  fs.writeFileSync(statePath(state.session), JSON.stringify(state, null, 2));
}

function newState(session, opts) {
  return {
    version: STATE_VERSION,
    session,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    prompt: opts.prompt || '',
    promptSource: opts.promptSource || '',
    output: opts.output || '',
    model: opts.model || 'auto',
    stages: {},
  };
}

function markStage(state, name, data) {
  state.stages[name] = { done: true, at: Date.now(), data: data || {} };
}

function clearStage(state, name) {
  delete state.stages[name];
}

// --- Page interaction helpers -----------------------------------------------

async function snapshot(session) {
  const r = unwrap(await cmd('snapshot', {}, session), 'snapshot');
  return r && r.tree ? r : { tree: '' };
}

async function evaluate(session, code) {
  const r = unwrap(await cmd('evaluate', { code }, session), 'evaluate');
  if (!r) return null;
  if (typeof r.value === 'string') {
    try { return JSON.parse(r.value); } catch { return r.value; }
  }
  return r.value !== undefined ? r.value : r;
}

async function findChatgptTab(session) {
  try {
    const data = unwrap(await cmd('list_tabs', {}, session), 'list_tabs');
    const tabs = (data && data.tabs) || [];
    return tabs.find((t) => CHATGPT_HOST_RE.test(t.url || '')) || null;
  } catch (e) {
    return null;
  }
}

// --- Stages ------------------------------------------------------------------

async function stageOpen(state, opts) {
  if (state.stages.open && state.stages.open.done) {
    // Pre-flight: is the tab still there?
    const existing = await findChatgptTab(state.session);
    if (existing) {
      log(`open: reusing existing tab ${existing.tabId} (${existing.url})`);
      return { skipped: true, data: state.stages.open.data };
    }
    log(`open: state says done but tab is gone, re-opening`);
    clearStage(state, 'open');
    // also clear downstream stages since the tab context changed
    for (const n of STAGE_NAMES) if (n !== 'open') clearStage(state, n);
  }
  const tab = await findChatgptTab(state.session);
  let data;
  if (tab) {
    log(`open: reusing existing tab ${tab.tabId} (${tab.url})`);
    data = { tabId: tab.tabId, url: tab.url, reused: true };
  } else {
    const r = unwrap(
      await cmd('navigate', { url: 'https://chatgpt.com/', newTab: true, group_title: `GPT Pro Search - ${state.session}` }, state.session),
      'navigate'
    );
    data = { tabId: r.tabId, url: r.url || 'https://chatgpt.com/', reused: false };
    log(`open: created tab ${data.tabId} (${data.url})`);
  }
  await sleep(3000); // let the SPA hydrate
  markStage(state, 'open', data);
  saveState(state);
  return { skipped: false, data };
}

async function stageLoginCheck(state) {
  if (state.stages.loginCheck && state.stages.loginCheck.done) {
    return { skipped: true, data: state.stages.loginCheck.data };
  }
  const v = await evaluate(
    state.session,
    `(() => { const ce = document.querySelector('[contenteditable="true"]'); const login = /Log in|Sign in|Continue with/.test(document.body.innerText); return JSON.stringify({ hasInput: !!ce, looksLikeLogin: login }); })()`
  );
  if (!v) throw new Error('login-check: no evaluation result');
  const data = { state: v.looksLikeLogin && !v.hasInput ? 'login_required' : v.hasInput ? 'logged_in' : 'unknown' };
  if (data.state === 'login_required') {
    const e = new Error('chatgpt login required - please log in manually in the browser, then re-run with --resume');
    e.code = 'login_required';
    e.stageData = data;
    throw e;
  }
  if (data.state === 'unknown') {
    log('login-check: warning - could not confirm login state, continuing');
  }
  markStage(state, 'loginCheck', data);
  saveState(state);
  return { skipped: false, data };
}

async function stageEnsureModel(state) {
  if (state.stages.ensureModel && state.stages.ensureModel.done) {
    return { skipped: true, data: state.stages.ensureModel.data };
  }
  const target = state.model;
  const result = await ensureModel(state.session, target);
  if (target !== 'auto' && !result.ok) {
    const e = new Error(`could not ensure model=${target} (current=${result.state.model}). Please switch manually in the browser, then re-run with --resume.`);
    e.code = 'model_switch_failed';
    e.stageData = { ...result, target };
    throw e;
  }
  const data = { from: 'unknown', to: result.state.model, effort: result.state.effort, changed: result.changed };
  markStage(state, 'ensureModel', data);
  saveState(state);
  return { skipped: false, data };
}

async function stageSend(state, opts) {
  const prompt = state.prompt;
  if (!prompt) throw new Error('send: no prompt in state — pass a prompt on the CLI or use --resume with prior state');
  const prior = state.stages.send;
  if (prior && prior.done && prior.data && prior.data.prompt === prompt) {
    return { skipped: true, data: prior.data };
  }
  log(`clicking input...`);
  unwrap(await cmd('click', { selector: '[contenteditable="true"]' }, state.session), 'click input');
  await sleep(300);
  log(`filling ${prompt.length} chars...`);
  const fillRes = unwrap(await cmd('fill', { selector: '[contenteditable="true"]', value: prompt }, state.session), 'fill');
  if (fillRes && fillRes.mode) log(`fill mode=${fillRes.mode}`);
  await sleep(300);
  log('clicking send...');
  unwrap(await cmd('click', { selector: '[data-testid="send-button"]' }, state.session), 'click send');
  const data = { chars: prompt.length, fillMode: (fillRes && fillRes.mode) || 'value', prompt };
  markStage(state, 'send', data);
  state.prompt = prompt;
  saveState(state);
  return { skipped: false, data };
}

async function stageWait(state, opts) {
  if (state.stages.wait && state.stages.wait.done) {
    return { skipped: true, data: state.stages.wait.data };
  }
  const maxWait = opts.wait || 900;
  const interval = opts.interval || 30;
  log(`waiting up to ${maxWait}s (poll ${interval}s)...`);
  const result = await waitForCompletion(state.session, maxWait, interval);
  log(`wait result: ${result.status} (${result.elapsed}s)`);
  const data = { status: result.status, elapsed: result.elapsed };
  if (result.status === 'login_required') {
    const e = new Error('login wall appeared during generation - log in then re-run');
    e.code = 'login_required';
    e.stageData = data;
    throw e;
  }
  if (result.status === 'rate_limited') {
    const e = new Error('rate limited by chatgpt - wait 60s then re-run with --resume');
    e.code = 'rate_limited';
    e.stageData = data;
    throw e;
  }
  markStage(state, 'wait', data);
  saveState(state);
  if (result.status === 'timeout') {
    // Timeout is exit 3, not 4. Throw a special error.
    const e = new Error(`wait timed out after ${maxWait}s - re-run with --resume and a longer --wait, or run extract to grab what's on screen`);
    e.code = 'wait_timeout';
    e.stageData = data;
    throw e;
  }
  return { skipped: false, data };
}

async function stageExtract(state, opts) {
  if (state.stages.extract && state.stages.extract.done) {
    return { skipped: true, data: state.stages.extract.data };
  }
  const extracted = await extractLastAssistant(state.session);
  if (!extracted.text) {
    const e = new Error('no assistant message found - re-run with --resume, or run send again if generation never started');
    e.code = 'no_response';
    e.stageData = { error: extracted.error };
    throw e;
  }
  const out = state.output || `gpt-pro-response-${Date.now()}.md`;
  fs.writeFileSync(out, extracted.text, 'utf8');
  log(`saved -> ${out}`);
  const data = { length: extracted.text.length, path: out };
  markStage(state, 'extract', data);
  state.output = out;
  saveState(state);
  return { skipped: false, data };
}

async function stageStatus(state) {
  // Read-only: print the state.
  return { skipped: true, data: state };
}

async function stageCleanup(state, opts) {
  if (!opts.keepSession) {
    try { await cmd('close_session', {}, state.session); } catch (e) { log(`close warning: ${e.message}`); }
  }
  if (opts.cleanupState) {
    const p = statePath(state.session);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  return { skipped: false, data: { closed: !opts.keepSession, stateRemoved: !!opts.cleanupState } };
}

// --- Model detection & switching --------------------------------------------

async function detectModel(session) {
  const popover = await probePopover(session);
  const v = await evaluate(
    session,
    `(() => { const pill = [...document.querySelectorAll('button.__composer-pill')].map(b => (b.innerText||'').trim()).filter(Boolean); return JSON.stringify({ pills: pill }); })()`
  );
  const pills = (v && v.pills) || [];
  let mode = 'unknown';
  let sub = 'unknown';
  if (popover) {
    const selected = await evaluate(
      session,
      `(() => { const items = [...document.querySelectorAll('[role=menuitemradio]')]; const cur = items.find(el => el.getAttribute('aria-checked') === 'true'); if (!cur) return null; return { testid: cur.getAttribute('data-testid'), text: (cur.innerText||'').trim() }; })()`
    );
    if (selected) {
      const t = selected.testid || '';
      if (/-pro$/.test(t)) mode = /Extended/i.test(selected.text) ? 'extended' : 'pro';
      else if (/-thinking$/.test(t)) mode = 'thinking';
      else if (/-instant$/.test(t) || t.endsWith('-5-5')) mode = 'instant';
      const m = selected.text.match(/•\s*(\w+)/);
      if (m) sub = m[1].toLowerCase();
    }
  }
  if (mode === 'unknown' && pills[0]) {
    const p = pills[0].toLowerCase();
    if (/extended/.test(p)) mode = 'extended';
    else if (/pro/.test(p)) mode = 'pro';
    else if (/thinking/.test(p)) mode = 'thinking';
    else if (/instant/.test(p)) mode = 'instant';
    else if (/heavy/.test(p)) mode = 'extended';
    else mode = p;
  }
  return { model: mode, effort: sub, pills };
}

async function probePopover(session) {
  const opened = await evaluate(
    session,
    `(() => { const pill = [...document.querySelectorAll('button.__composer-pill')][0]; if (!pill) return false; const r = pill.getBoundingClientRect(); for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) { pill.dispatchEvent(new PointerEvent(t, {bubbles:true, cancelable:true, clientX:r.x+5, clientY:r.y+5, button:0})); } return true; })()`
  );
  if (!opened) return null;
  await sleep(700);
  const html = await evaluate(session, `(() => { const m = document.querySelector('[role=menu]'); return m ? m.outerHTML : null; })()`);
  await evaluate(session, `(() => { document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); document.body.click(); })()`);
  await sleep(300);
  return html;
}

async function ensureModel(session, target) {
  if (target === 'auto') return { ok: true, state: await detectModel(session), changed: false };
  const state = await detectModel(session);
  if (target === 'extended' && state.model === 'extended') return { ok: true, state, changed: false };
  if (target === 'pro' && (state.model === 'pro' || state.model === 'thinking')) return { ok: true, state, changed: false };
  const labelRe = target === 'extended' || target === 'pro' ? 'Pro' : target === 'thinking' ? 'Thinking' : target === 'instant' ? 'Instant' : null;
  if (!labelRe) return { ok: false, state, changed: false, error: `unknown target: ${target}` };
  await evaluate(
    session,
    `(() => { const pill = [...document.querySelectorAll('button.__composer-pill')][0]; if (!pill) return false; const r = pill.getBoundingClientRect(); for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) { pill.dispatchEvent(new PointerEvent(t, {bubbles:true, cancelable:true, clientX:r.x+5, clientY:r.y+5, button:0})); } return true; })()`
  );
  await sleep(800);
  const picked = await evaluate(
    session,
    `(() => { const items = [...document.querySelectorAll('[role=menuitemradio]')]; for (const it of items) { const span = it.querySelector('span'); const primary = span ? (span.childNodes[0] && span.childNodes[0].textContent || span.innerText).trim().split('\\n')[0] : ''; if (primary === ${JSON.stringify(labelRe)}) { const fullText = (it.innerText||'').trim(); if (${JSON.stringify(target)} === 'extended' && !/Extended/i.test(fullText)) continue; it.click(); return { primary, fullText, testid: it.getAttribute('data-testid') }; } } return null; })()`
  );
  await sleep(700);
  await evaluate(session, `(() => { document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); document.body.click(); })()`);
  await sleep(300);
  if (!picked) return { ok: false, state, changed: false, error: `could not find "${labelRe}" option in popover` };
  const after = await detectModel(session);
  return { ok: after.model === target || (target === 'extended' && after.model === 'extended'), state: after, changed: true, picked };
}

// --- Wait & extract ----------------------------------------------------------

async function waitForCompletion(session, maxWaitSec, intervalSec) {
  const start = Date.now();
  let lastReport = 0;
  let prevSig = '';
  let stableRounds = 0;
  while ((Date.now() - start) / 1000 < maxWaitSec) {
    await sleep(intervalSec * 1000);
    const tree = JSON.stringify((await snapshot(session)).tree || '');
    const stopCount = (tree.match(/Stop generating/gi) || []).length;
    const copyCount = (tree.match(/"Copy"/g) || []).length;
    const elapsed = Math.floor((Date.now() - start) / 1000);
    if (elapsed - lastReport >= 30) {
      log(`[${elapsed}s] stop=${stopCount} copy=${copyCount}`);
      lastReport = elapsed;
    }
    if (/(Log in|Sign up)/i.test(tree) && stopCount === 0 && copyCount === 0) {
      return { status: 'login_required', elapsed };
    }
    if (/too many requests|please wait a moment|slow down/i.test(tree)) {
      return { status: 'rate_limited', elapsed };
    }
    if (stopCount === 0 && copyCount >= 1) {
      await sleep(intervalSec * 1000);
      return { status: 'complete', elapsed };
    }
    const sig = tree.length + ':' + tree.slice(-200);
    if (sig === prevSig) {
      stableRounds++;
      if (stableRounds >= 4 && stopCount === 0) return { status: 'complete', elapsed };
    } else {
      stableRounds = 0;
      prevSig = sig;
    }
  }
  return { status: 'timeout', elapsed: maxWaitSec };
}

async function extractLastAssistant(session) {
  const code = `(() => { const msgs = document.querySelectorAll('[data-message-author-role="assistant"]'); if (!msgs.length) { const alt = document.querySelectorAll('.markdown, .prose'); if (alt.length) { const t = alt[alt.length-1].innerText; return JSON.stringify({ len: t.length, text: t }); } return JSON.stringify({ error: 'no_messages' }); } const last = msgs[msgs.length-1]; return JSON.stringify({ len: last.innerText.length, text: last.innerText }); })()`;
  const v = await evaluate(session, code);
  if (!v) return { text: '', error: 'no_value' };
  if (typeof v === 'string') return { text: v };
  return { text: v.text || '', len: v.len, error: v.error };
}

// --- Sub-command pipeline ---------------------------------------------------

const PIPELINE = ['open', 'loginCheck', 'ensureModel', 'send', 'wait', 'extract'];

async function runPipeline(state, opts) {
  const results = {};
  // dry-run stops after ensureModel
  const stages = opts.dryRun ? PIPELINE.slice(0, PIPELINE.indexOf('ensureModel') + 1) : PIPELINE;
  for (const stage of stages) {
    const fn = STAGE_FNS[stage];
    try {
      const r = await fn(state, opts);
      results[stage] = r;
    } catch (e) {
      // Special-case: wait_timeout is exit 3, not 4
      if (e.code === 'wait_timeout') {
        results[stage] = { error: e.message, data: e.stageData };
        throw e;
      }
      // Save what we have so --resume can pick up
      saveState(state);
      results[stage] = { error: e.message, data: e.stageData, code: e.code };
      const wrapped = new Error(`[${stage}] ${e.message}`);
      wrapped.code = e.code;
      wrapped.stage = stage;
      wrapped.stageData = e.stageData;
      throw wrapped;
    }
  }
  return results;
}

const STAGE_FNS = {
  open: stageOpen,
  loginCheck: stageLoginCheck,
  ensureModel: stageEnsureModel,
  send: stageSend,
  wait: stageWait,
  extract: stageExtract,
};

// Map kebab-case subcommand names to stage function keys.
const SUBCOMMAND_TO_STAGE = {
  open: 'open',
  'login-check': 'loginCheck',
  'ensure-model': 'ensureModel',
  send: 'send',
  wait: 'wait',
  extract: 'extract',
};

// --- CLI --------------------------------------------------------------------

const SUBCOMMANDS = ['run', 'open', 'login-check', 'ensure-model', 'send', 'wait', 'extract', 'status', 'cleanup'];

function printHelp() {
  process.stdout.write(`search.js - drive ChatGPT Pro via kimi-webbridge (stateful, resumable)

Usage:
  search.js [global-flags] [SUBCOMMAND] [args...]

Sub-commands:
  run [prompt...]      All stages in order (default if no subcommand given)
  open                 Open a ChatGPT tab (or reuse an existing one)
  login-check          Detect whether ChatGPT is logged in
  ensure-model [tgt]   Verify / switch model. tgt: auto|pro|extended (default: state value)
  send [prompt...]     Fill the input and click send
  wait                 Poll until response completes
  extract              Pull the last assistant message to --output
  status               Print session state and exit
  cleanup              Close the session tab

Global flags (can appear before or after the subcommand):
  -s, --session NAME   Session name (default: gpt-pro-<timestamp>)
  -o, --output PATH    Output file (default: ./gpt-pro-response-<ts>.md)
  -m, --model NAME     Target model: auto|pro|extended|extended-pro (default: auto)
  -w, --wait SECONDS   Max wait for response (default: 900)
  -i, --interval SEC   Poll interval (default: 30)
      --resume         Skip stages already marked done in state file
      --keep-session   Do not close the browser tab when finished
      --cleanup-state  Delete the state file when finished
      --dry-run        Like run but stop after ensure-model
      --status         Health check only, no session
      --json           Output result as JSON
  -v, --verbose        Verbose logging
  -h, --help           Show this help

Exit codes:
  0  success
  1  daemon / network error
  2  bad arguments
  3  timeout during wait
  4  human intervention required (login, captcha, model switch, etc.) — see references/intervention-points.md

State file: <script dir>/state/<session>.json
  - Auto-created on first run.
  - Each successful stage is marked done; --resume skips done stages.
  - For 'send', the stage re-runs if the new prompt differs from the stored one.

Examples:
  search.js "What is 2+2? Reply with just the number."
  search.js --model extended "Reason about X in deep mode."
  search.js -f ./prompt.md -o ./answer.md --json
  search.js --status
  search.js --dry-run --model extended
  search.js open
  search.js ensure-model extended
  search.js send "now actually send it"
  search.js --resume                # pick up where a previous run left off
  search.js --resume --wait 1800    # resume with longer timeout
`);
}

function parseArgs(argv) {
  const opts = {
    subcommand: 'run',
    subcommandArgs: [],
    session: `gpt-pro-${Date.now()}`,
    output: '',
    model: 'auto',
    wait: 900,
    interval: 30,
    resume: false,
    keepSession: false,
    cleanupState: false,
    dryRun: false,
    statusOnly: false,
    json: false,
    verbose: false,
    help: false,
  };
  const positional = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--verbose') opts.verbose = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--status') opts.statusOnly = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--resume') opts.resume = true;
    else if (a === '--keep-session') opts.keepSession = true;
    else if (a === '--cleanup-state') opts.cleanupState = true;
    else if (a === '-f' || a === '--file') { opts.promptFile = argv[++i] || ''; opts.subcommandArgs.push('-f', opts.promptFile); }
    else if (a === '-s' || a === '--session') { opts.session = argv[++i] || opts.session; }
    else if (a === '-o' || a === '--output') { opts.output = argv[++i] || ''; }
    else if (a === '-m' || a === '--model') { opts.model = argv[++i] || 'auto'; }
    else if (a === '-w' || a === '--wait') { opts.wait = parseInt(argv[++i], 10) || opts.wait; }
    else if (a === '-i' || a === '--interval') { opts.interval = parseInt(argv[++i], 10) || opts.interval; }
    else if (a === '-') { opts.stdin = true; opts.subcommandArgs.push('-'); }
    else if (a === '--') { i++; while (i < argv.length) { positional.push(argv[i]); i++; } break; }
    else if (a.startsWith('--')) {
      const m = a.match(/^--([a-z-]+)=(.*)$/);
      if (m) {
        const k = m[1], v = m[2];
        if (k === 'file') { opts.promptFile = v; opts.subcommandArgs.push('--file=' + v); }
        else if (k === 'session') opts.session = v;
        else if (k === 'output') opts.output = v;
        else if (k === 'model') opts.model = v;
        else if (k === 'wait') opts.wait = parseInt(v, 10) || opts.wait;
        else if (k === 'interval') opts.interval = parseInt(v, 10) || opts.interval;
        else die(2, `unknown option: --${k}`);
      } else die(2, `unknown option: ${a}`);
    }
    else if (a.startsWith('-') && a.length > 1) {
      const letters = a.slice(1);
      let consumed = false;
      for (let j = 0; j < letters.length; j++) {
        const ch = letters[j];
        if (ch === 'v') opts.verbose = true;
        else if (ch === 'h') opts.help = true;
        else if (ch === 'f') { opts.promptFile = argv[++i] || ''; opts.subcommandArgs.push('-f', opts.promptFile); consumed = true; break; }
        else if (ch === 's') { opts.session = argv[++i] || opts.session; consumed = true; break; }
        else if (ch === 'o') { opts.output = argv[++i] || ''; consumed = true; break; }
        else if (ch === 'm') { opts.model = argv[++i] || 'auto'; consumed = true; break; }
        else if (ch === 'w') { opts.wait = parseInt(argv[++i], 10) || opts.wait; consumed = true; break; }
        else if (ch === 'i') { opts.interval = parseInt(argv[++i], 10) || opts.interval; consumed = true; break; }
        else die(2, `unknown short flag: -${ch}`);
      }
    }
    else positional.push(a);
    i++;
  }
  // First positional is subcommand if known, else it's a prompt
  if (positional.length && SUBCOMMANDS.includes(positional[0])) {
    opts.subcommand = positional[0];
    opts.subcommandArgs.push(...positional.slice(1));
  } else {
    opts.subcommandArgs.push(...positional);
  }
  return opts;
}

function die(code, msg, extra) {
  if (extra !== undefined) console.error(JSON.stringify({ error: msg, ...extra }));
  else log('Error:', msg);
  process.exit(code);
}

async function readPrompt(opts, state) {
  if (opts.stdin) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return { text: Buffer.concat(chunks).toString('utf8'), source: 'stdin' };
  }
  if (opts.promptFile) {
    if (!fs.existsSync(opts.promptFile)) die(2, `prompt file not found: ${opts.promptFile}`);
    return { text: fs.readFileSync(opts.promptFile, 'utf8'), source: `file:${opts.promptFile}` };
  }
  // From subcommand args
  if (opts.subcommandArgs.length) {
    return { text: opts.subcommandArgs.join(' '), source: 'cli' };
  }
  // From state (for --resume)
  if (state && state.prompt) {
    return { text: state.prompt, source: 'state' };
  }
  return { text: '', source: '' };
}

// --- Main -------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); return; }
  if (opts.verbose) log('opts:', JSON.stringify({ ...opts, subcommandArgs: '[redacted]' }));

  log('health check...');
  let daemonStatus;
  try {
    daemonStatus = await healthCheck();
  } catch (e) {
    die(1, `health check failed: ${e.message}`, { hint: 'try: ~/.kimi-webbridge/bin/kimi-webbridge start' });
  }
  log(`daemon v${daemonStatus.version} | extension v${daemonStatus.extension_version}`);

  if (opts.statusOnly) {
    console.log(JSON.stringify({ status: 'ok', ...daemonStatus }, null, 2));
    return;
  }

  // Load existing state (always try — sub-commands like status/cleanup should
  // read the existing file rather than overwrite it). Only create new state for
  // the default `run` flow when no prior state exists.
  let state = loadState(opts.session);
  if (state) log(`loaded existing state for ${state.session} (stages: ${Object.keys(state.stages).join(',') || 'none'})`);
  if (!state) {
    state = newState(opts.session, { output: opts.output, model: opts.model === 'extended-pro' ? 'extended' : opts.model });
  }
  if (opts.output) state.output = opts.output;
  if (opts.model && opts.model !== 'auto') state.model = opts.model === 'extended-pro' ? 'extended' : opts.model;
  // Only save back if we actually have something to record (don't pollute state
  // for read-only sub-commands like status).
  if (opts.subcommand !== 'status') saveState(state);

  // --- Sub-commands ---

  if (opts.subcommand === 'status') {
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  if (opts.subcommand === 'cleanup') {
    await stageCleanup(state, opts);
    console.log(JSON.stringify({ ok: true, ...(state.output ? { output: state.output } : {}) }, null, 2));
    return;
  }

  // For send/run, resolve the prompt (dry-run skips this)
  let promptInfo = { text: '', source: '' };
  if (['send', 'run'].includes(opts.subcommand) && !opts.dryRun) {
    promptInfo = await readPrompt(opts, state);
    if (!promptInfo.text) {
      die(2, `no prompt provided. Pass it as a positional arg, -f file, or - (stdin), or use --resume with prior state.`);
    }
    state.prompt = promptInfo.text;
    state.promptSource = promptInfo.source;
    saveState(state);
  }

  // For ensure-model subcommand, override the target if first arg given
  if (opts.subcommand === 'ensure-model' && opts.subcommandArgs.length) {
    state.model = String(opts.subcommandArgs[0]).toLowerCase();
    if (state.model === 'extended-pro') state.model = 'extended';
    saveState(state);
  }

  // --- Execute ---

  // Short-circuit before doing any work: if --resume and extract is done and
  // the output file exists, just return the cached response. This avoids
  // re-opening tabs and re-sending prompts when the user just wants the answer.
  if (opts.resume && opts.subcommand === 'run' && state.stages.extract && state.stages.extract.done) {
    const cachedOut = state.stages.extract.data && state.stages.extract.data.path;
    if (cachedOut && fs.existsSync(cachedOut)) {
      log(`resume: all stages already done, returning cached output`);
      if (!opts.json) {
        process.stdout.write(fs.readFileSync(cachedOut, 'utf8'));
      } else {
        console.log(JSON.stringify({ ok: true, cached: true, output: cachedOut, length: state.stages.extract.data.length }, null, 2));
      }
      process.exit(0);
    }
  }

  const startTime = Date.now();
  let result;
  try {
    if (opts.subcommand === 'run') {
      result = await runPipeline(state, opts);
    } else if (SUBCOMMAND_TO_STAGE[opts.subcommand]) {
      const stageName = SUBCOMMAND_TO_STAGE[opts.subcommand];
      const fn = STAGE_FNS[stageName];
      result = { [stageName]: await fn(state, opts) };
    } else {
      die(2, `unknown subcommand: ${opts.subcommand}`);
    }
  } catch (e) {
    const code = e.code === 'wait_timeout' ? 3 : 4;
    const out = {
      ok: false,
      code: e.code || 'unknown',
      stage: e.stage || opts.subcommand,
      message: e.message,
      stageData: e.stageData,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      state: state.session,
      hint: code === 4 ? 'see references/intervention-points.md; fix the issue, then re-run with --resume' : undefined,
    };
    if (opts.json) console.log(JSON.stringify(out, null, 2));
    else {
      log(`failed at stage=${out.stage} code=${out.code}: ${out.message}`);
      if (out.hint) log(out.hint);
    }
    process.exit(code);
  }

  // --- Success ---

  // Final cleanup
  if (opts.subcommand === 'run' && !opts.dryRun) {
    try { await stageCleanup(state, opts); } catch (e) { log(`cleanup warning: ${e.message}`); }
  } else if (opts.subcommand !== 'cleanup' && !opts.keepSession && opts.subcommand !== 'status') {
    // For individual sub-commands, don't auto-cleanup unless it's the final stage
  }

  const waitData = (result.wait && result.wait.data) || (state.stages.wait && state.stages.wait.data) || {};
  const extractData = (result.extract && result.extract.data) || (state.stages.extract && state.stages.extract.data) || {};

  const out = {
    ok: true,
    session: state.session,
    elapsed: Math.floor((Date.now() - startTime) / 1000),
    stages: Object.keys(state.stages),
    model: state.model,
    output: extractData.path || state.output || null,
    length: extractData.length || 0,
    wait: waitData,
  };
  if (opts.json) {
    if (extractData.path && fs.existsSync(extractData.path)) {
      out.response = fs.readFileSync(extractData.path, 'utf8');
    }
    console.log(JSON.stringify(out, null, 2));
  } else {
    if (opts.subcommand === 'run' && !opts.dryRun && extractData.path) {
      log(`response (${out.length} chars) saved to ${out.output}`);
    }
    if (extractData.path && fs.existsSync(extractData.path)) {
      process.stdout.write(fs.readFileSync(extractData.path, 'utf8'));
    } else if (opts.subcommand !== 'status' && opts.subcommand !== 'cleanup') {
      // For non-extract sub-commands, print a brief summary
      console.log(JSON.stringify(out, null, 2));
    }
  }
  process.exit(0);
}

// --- Dry-run and main() integration ----------------------------------------

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, code: 'uncaught', message: e.message, stack: process.env.DEBUG ? e.stack : undefined }, null, 2));
  process.exit(1);
});

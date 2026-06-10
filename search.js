#!/usr/bin/env node
// search.js - Drive ChatGPT Pro (or Pro Extended) via kimi-webbridge.
//
// Default entry: `search.js "Your prompt"` runs the full pipeline.
// Sub-commands: open | login-check | ensure-model | ensure-tool | upload
//               | send | wait | extract | image | extract-images | latest
//               | status | cleanup | run
// Per-session state file: <script dir>/state/<session>.json
// `--resume` skips stages already marked done.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFile, spawn } = require('child_process');

const DAEMON_HOST = '127.0.0.1';
const DAEMON_PORT = 10086;
const STATUS_BIN = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.kimi-webbridge', 'bin',
  process.platform === 'win32' ? 'kimi-webbridge.exe' : 'kimi-webbridge'
);
const STATE_DIR = path.join(__dirname, 'state');
const STATE_VERSION = 1;
const STAGE_NAMES = ['open', 'loginCheck', 'ensureModel', 'ensureTool', 'upload', 'send', 'wait', 'extract', 'extractImages'];
const CHATGPT_HOST_RE = /^https?:\/\/(www\.)?chatgpt\.com\//;
const DEFAULT_WAIT_SECONDS = 1200;
const DEFAULT_DEEP_RESEARCH_WAIT_SECONDS = 3600;
const DEFAULT_INTERVAL_SECONDS = 15;
const DEFAULT_MIN_RESPONSE_CHARS = 240;
const DEFAULT_STABLE_SECONDS = 60;
const DEFAULT_WAIT_REFRESH_SECONDS = 300;
const DEFAULT_WAIT_REFRESH_SETTLE_MS = 5000;
const DEFAULT_IMAGE_DIR = 'gpt-pro-images';
const DEFAULT_IMAGE_COUNT = 1;
const DEFAULT_IMAGE_CONCURRENCY = 3;
const DEFAULT_MAX_IMAGES = 8;
const DEFAULT_IMAGE_MODEL = 'instant';
const DEFAULT_UPLOAD_SELECTOR = 'input#upload-files[type="file"]';
const DEFAULT_UPLOAD_WAIT_SECONDS = 60;
const DEFAULT_TOOL = 'auto';
const DEEP_RESEARCH_APP_URI = 'connectors://connector_openai_deep_research';
const DEEP_RESEARCH_IFRAME_TITLE = 'internal://deep-research';
const DEEP_RESEARCH_TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'error',
  'rate_limited',
  'rate_limit_exceeded',
  'moderation_blocked',
  'user_stopped',
  'stopped',
  'cancelled',
  'canceled',
]);

const TOOL_TARGETS = {
  'deep-research': {
    label: 'Deep research',
    labels: ['Deep research', 'Deep Research', 'Deep search', 'Deep Search', '深度研究', '深度搜索'],
  },
  'web-search': {
    label: 'Web search',
    labels: ['Web search', 'Web Search', 'Search the web', 'Browse', '联网搜索', '网页搜索', '网络搜索', '搜索网页'],
    activeLabels: ['Search', 'Web search', 'Web Search', '联网搜索', '网页搜索', '网络搜索', '搜索网页'],
  },
  'create-image': {
    label: 'Create image',
    labels: ['Create image', 'Create Image', 'Image', '创建图像', '创建图片', '生成图片', '图像生成'],
  },
};

const IMAGE_COLLECTOR_JS = `
  const collectMeaningfulImages = (root) => {
    if (!root) return [];
    const seen = new Set();
    return [...root.querySelectorAll('img')].map((img, index) => {
      const rect = img.getBoundingClientRect();
      const style = window.getComputedStyle(img);
      const src = img.currentSrc || img.src || img.getAttribute('src') || '';
      const alt = img.getAttribute('alt') || '';
      const className = typeof img.className === 'string' ? img.className : '';
      const width = img.naturalWidth || Math.round(rect.width) || 0;
      const height = img.naturalHeight || Math.round(rect.height) || 0;
      const descriptor = [alt, className, src].join(' ');
      const chatgptGenerated = /Generated image|imagegen|backend-api\\/estuary\\/content/i.test(descriptor);
      const ready = !!img.complete || (chatgptGenerated && /^https?:\\/\\/chatgpt\\.com\\/backend-api\\/estuary\\/content/i.test(src));
      return {
        index,
        src,
        alt,
        className: className.slice(0, 160),
        width,
        height,
        rectWidth: Math.round(rect.width) || 0,
        rectHeight: Math.round(rect.height) || 0,
        complete: !!img.complete,
        ready,
        visible: rect.width > 32 && rect.height > 32 && style.display !== 'none' && style.visibility !== 'hidden'
      };
    }).filter((img) => {
      if (!img.src || seen.has(img.src)) return false;
      seen.add(img.src);
      const w = img.width || img.rectWidth || 0;
      const h = img.height || img.rectHeight || 0;
      if (!img.visible) return false;
      if (w < 128 || h < 128) return false;
      if (w * h < 65536) return false;
      const filterDescriptor = [img.alt, img.className, img.src].join(' ');
      if (/avatar|profile|user|icon|emoji|logo/i.test(filterDescriptor) && Math.max(w, h) < 512) return false;
      return true;
    });
  };
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error('[search]', ...a);

function normalizeModelName(model) {
  const value = String(model || 'auto').trim().toLowerCase();
  if (value === 'extended-pro') return 'extended';
  if (value === 'think') return 'thinking';
  return value || 'auto';
}

function normalizeToolName(tool) {
  const value = String(tool || DEFAULT_TOOL).trim().toLowerCase().replace(/_/g, '-');
  if (!value || value === 'default') return DEFAULT_TOOL;
  if (value === 'off' || value === 'clear' || value === 'disable' || value === 'disabled' || value === 'no-tool') return 'none';
  if (value === 'deep' || value === 'research' || value === 'deepresearch' || value === 'deep-research' || value === 'deep-search') return 'deep-research';
  if (value === 'web' || value === 'search' || value === 'browse' || value === 'websearch' || value === 'web-search') return 'web-search';
  if (value === 'image' || value === 'images' || value === 'create-image' || value === 'image-generation') return 'create-image';
  if (value === 'auto' || value === 'none') return value;
  return value;
}

function toolLabel(tool) {
  const target = TOOL_TARGETS[normalizeToolName(tool)];
  return target ? target.label : String(tool || DEFAULT_TOOL);
}

function normalizeUploadFiles(files) {
  const list = Array.isArray(files) ? files : [];
  return [...new Set(list.filter(Boolean).map((file) => path.resolve(String(file))))];
}

function uploadSignature(files) {
  return JSON.stringify(normalizeUploadFiles(files));
}

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

function setActiveStage(state, name, data = {}) {
  const prior = state.active && state.active.stage === name ? state.active : {};
  state.active = {
    stage: name,
    startedAt: prior.startedAt || Date.now(),
    updatedAt: Date.now(),
    ...data,
  };
  saveState(state);
}

function clearActiveStage(state, name) {
  if (!state.active) return;
  if (name && state.active.stage !== name) return;
  delete state.active;
  saveState(state);
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
    uploads: normalizeUploadFiles(opts.uploads || []),
    uploadSelector: opts.uploadSelector || DEFAULT_UPLOAD_SELECTOR,
    imageDir: opts.imageDir || '',
    imagePrefix: opts.imagePrefix || '',
    model: opts.model || 'auto',
    tool: normalizeToolName(opts.tool || DEFAULT_TOOL),
    conversationUrl: '',
    conversationTitle: '',
    images: [],
    turns: 0,
    active: null,
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
  let lostPriorTab = false;
  if (state.stages.open && state.stages.open.done) {
    // Pre-flight: is the tab still there?
    const existing = await findChatgptTab(state.session);
    if (existing) {
      log(`open: reusing existing tab ${existing.tabId} (${existing.url})`);
      return { skipped: true, data: state.stages.open.data };
    }
    log(`open: state says done but tab is gone, will attempt recovery`);
    lostPriorTab = true;
    clearStage(state, 'open');
  }
  const tab = await findChatgptTab(state.session);
  let data;
  if (tab) {
    log(`open: reusing existing tab ${tab.tabId} (${tab.url})`);
    data = { tabId: tab.tabId, url: tab.url, reused: true };
  } else {
    // Try to recover the previous conversation if we have its URL.
    // Skip recovery if --fresh is set (start a brand new conversation).
    let navUrl = 'https://chatgpt.com/';
    let recovered = false;
    if (!opts.fresh && state.conversationUrl && /\/c\//.test(state.conversationUrl)) {
      log(`recovering conversation from URL: ${state.conversationUrl}`);
      navUrl = state.conversationUrl;
    }
    const r = unwrap(
      await cmd('navigate', { url: navUrl, newTab: true, group_title: `GPT Pro Search - ${state.session}` }, state.session),
      'navigate'
    );
    data = { tabId: r.tabId, url: r.url || navUrl, reused: false, recovered: false };
    log(`open: created tab ${data.tabId} (${data.url})`);
    await sleep(3000); // let the SPA hydrate

    // Verify the conversation actually loaded. If the URL was for a deleted
    // conversation, ChatGPT redirects to chatgpt.com and the page is empty.
    if (!opts.fresh && state.conversationUrl && /\/c\//.test(navUrl)) {
      const loaded = await waitForMessages(state.session, 8);
      if (loaded && loaded.msgCount > 0) {
        log(`recovery: ${loaded.msgCount} message(s) loaded from ${loaded.url}`);
        data.recovered = true;
        data.url = loaded.url;
      } else {
        log(`recovery: URL didn't resolve to a conversation (count=${loaded && loaded.msgCount}, url=${loaded && loaded.url})`);
        log(`recovery: falling back to sidebar search by title "${state.conversationTitle}"`);
        // First re-navigate to chatgpt.com to make sure the sidebar is visible
        await cmd('navigate', { url: 'https://chatgpt.com/', newTab: false }, state.session);
        await sleep(2500);
        const searchResult = await searchSidebarForConversation(state.session, state.conversationTitle);
        if (searchResult && searchResult.found) {
          log(`recovery: found "${searchResult.text}" in sidebar, clicking...`);
          const clicked = await evaluate(
            state.session,
            `(() => { const links = [...document.querySelectorAll('a[href*="/c/"]')]; const link = links.find(a => (a.innerText || '').trim() === ${JSON.stringify(searchResult.text)}); if (link) { link.click(); return true; } return false; })()`
          );
          if (clicked) {
            const after = await waitForMessages(state.session, 12);
            if (after && after.msgCount > 0 && after.url.indexOf('/c/') >= 0) {
              log(`recovery: sidebar click worked, ${after.msgCount} message(s) at ${after.url}`);
              data.recovered = true;
              data.url = after.url;
            } else {
              log(`recovery: sidebar click did not load a conversation; starting fresh`);
            }
          }
        } else {
          log(`recovery: no matching conversation in sidebar; starting fresh`);
        }
      }
    } else if (!opts.fresh && state.conversationTitle) {
      // No URL, but we have a title. Open chatgpt.com and search the sidebar.
      log(`no prior URL, trying sidebar search for "${state.conversationTitle}"`);
      const searchResult = await searchSidebarForConversation(state.session, state.conversationTitle);
      if (searchResult && searchResult.found) {
        log(`recovery: found "${searchResult.text}" in sidebar, clicking...`);
        const clicked = await evaluate(
          state.session,
          `(() => { const links = [...document.querySelectorAll('a[href*="/c/"]')]; const link = links.find(a => (a.innerText || '').trim() === ${JSON.stringify(searchResult.text)}); if (link) { link.click(); return true; } return false; })()`
        );
        if (clicked) {
          const after = await waitForMessages(state.session, 12);
          if (after && after.msgCount > 0 && after.url.indexOf('/c/') >= 0) {
            log(`recovery: ${after.msgCount} message(s) at ${after.url}`);
            data.recovered = true;
            data.url = after.url;
          }
        }
      }
    }
  }
  if (lostPriorTab && !data.recovered && !data.reused) {
    log(`open: prior tab was not recovered; clearing downstream stages`);
    for (const n of STAGE_NAMES) if (n !== 'open') clearStage(state, n);
  }
  if (data.url && /\/c\//.test(data.url)) {
    state.conversationUrl = data.url;
  }
  markStage(state, 'open', data);
  saveState(state);
  return { skipped: false, data };
}

async function searchSidebarForConversation(session, title) {
  if (!title) return null;
  return evaluate(
    session,
    `(() => { const links = [...document.querySelectorAll('a[href*="/c/"]')]; const target = ${JSON.stringify(title)}; let match = links.find(a => (a.innerText || '').trim() === target); if (match) return { found: true, text: (match.innerText || '').trim(), href: match.getAttribute('href') }; match = links.find(a => { const t = (a.innerText || '').trim(); return t && (t === target || t.startsWith(target) || target.startsWith(t)); }); if (match) return { found: true, text: (match.innerText || '').trim(), href: match.getAttribute('href'), partial: true }; return { found: false, candidates: links.slice(0, 10).map(a => (a.innerText || '').trim().slice(0, 50)) }; })()`
  );
}

async function waitForMessages(session, maxSeconds) {
  // Poll for messages to appear in the DOM. Returns {msgCount, url} or {msgCount:0, url}.
  const deadline = Date.now() + maxSeconds * 1000;
  let last = null;
  while (Date.now() < deadline) {
    const v = await evaluate(
      session,
      `(() => { const m = document.querySelectorAll('[data-message-author-role]'); return JSON.stringify({ msgCount: m.length, url: location.href }); })()`
    );
    if (v && v.msgCount > 0) return v;
    last = v;
    await sleep(1000);
  }
  return last || { msgCount: 0, url: '' };
}

async function getConversationProgress(session) {
  const v = await evaluate(
    session,
    `(() => {
      const textOf = (el) => ((el && (el.innerText || el.textContent)) || '').trim();
      const attrText = (el) => [el.getAttribute('aria-label'), el.getAttribute('data-testid'), textOf(el)].filter(Boolean).join(' ');
      ${IMAGE_COLLECTOR_JS}
      const assistants = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
      const users = [...document.querySelectorAll('[data-message-author-role="user"]')];
      const messages = [...document.querySelectorAll('[data-message-author-role]')];
      const imageRoots = [...document.querySelectorAll('[class*="group/imagegen-image"]')];
      const virtualAssistantCount = assistants.length || (imageRoots.length ? Math.max(users.length, imageRoots.length) : 0);
      const buttons = [...document.querySelectorAll('button,[role="button"]')];
      const bodyText = textOf(document.body);
      const last = assistants[assistants.length - 1] || imageRoots[imageRoots.length - 1] || null;
      const lastText = textOf(last);
      const lastImages = collectMeaningfulImages(last);
      const imageSignature = lastImages.map((img) => {
        const src = String(img.src || '');
        return [img.width, img.height, img.complete ? 1 : 0, src.slice(0, 80), src.slice(-80)].join(':');
      }).join('|');
      const stopCount = buttons.filter((b) => /stop generating|stop responding|停止生成|停止回答/i.test(attrText(b))).length;
      const copyCount = buttons.filter((b) => /copy|复制/i.test(attrText(b))).length;
      const sendButton = document.querySelector('[data-testid="send-button"]');
      const input = document.querySelector('[contenteditable="true"]');
      const busy =
        stopCount > 0 ||
        !!document.querySelector('[data-testid*="stop"], [aria-label*="Stop generating"], [aria-label*="停止生成"]') ||
        buttons.some((b) => /stop generating|stop responding|停止生成|停止回答/i.test(attrText(b)));
      return JSON.stringify({
        assistantCount: virtualAssistantCount,
        assistantRoleCount: assistants.length,
        imageRootCount: imageRoots.length,
        userCount: users.length,
        messageCount: messages.length,
        lastAssistantLen: lastText.length,
        lastAssistantText: lastText,
        lastAssistantImageCount: lastImages.length,
        lastAssistantImages: lastImages,
        lastAssistantImageSignature: imageSignature,
        stopCount,
        copyCount,
        busy,
        hasInput: !!input,
        sendDisabled: sendButton ? !!sendButton.disabled : null,
        looksLikeLogin: /Log in|Sign in|Continue with|登录|登入/.test(bodyText),
        looksRateLimited: /too many requests|please wait a moment|slow down|rate limit|请稍候|请求过多/i.test(bodyText),
        url: location.href,
        title: document.title
      });
    })()`
  );
  return v || {};
}

async function captureConversationContext(state) {
  try {
    const info = await evaluate(
      state.session,
      `(() => ({ url: location.href, title: document.title }))()`
    );
    if (!info) return;
    if (info.url && /\/c\//.test(info.url)) {
      state.conversationUrl = info.url;
      log(`captured conversation URL: ${info.url}`);
    }
    const cleanTitle = (info.title || '').replace(/^ChatGPT\s*[-—–]\s*/i, '').trim();
    if (cleanTitle && cleanTitle !== 'ChatGPT' && cleanTitle.length < 200) {
      state.conversationTitle = cleanTitle;
      log(`captured conversation title: ${cleanTitle}`);
    }
    saveState(state);
  } catch (e) {
    log(`conversation context capture failed: ${e.message}`);
  }
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

async function stageEnsureTool(state, opts) {
  const target = normalizeToolName(state.tool || DEFAULT_TOOL);
  if (target === DEFAULT_TOOL) {
    return { skipped: true, data: { target, state: await detectToolState(state.session) } };
  }
  const prior = state.stages.ensureTool;
  if (!opts.continueMode && prior && prior.done && prior.data && prior.data.target === target) {
    const current = await detectToolState(state.session);
    const selected = current.selectedTool || '';
    if ((target === 'none' && !selected) || selected === target) {
      return { skipped: true, data: { ...prior.data, state: current } };
    }
    log(`ensure-tool: state says done but current tool is ${selected || 'none'}, re-checking`);
    clearStage(state, 'ensureTool');
  }
  if (target !== 'none' && !TOOL_TARGETS[target]) {
    const e = new Error(`unknown tool target: ${target}`);
    e.code = 'tool_switch_failed';
    e.stageData = { target, valid: ['auto', 'none', ...Object.keys(TOOL_TARGETS)] };
    throw e;
  }

  const before = await detectToolState(state.session);
  let changed = false;
  let picked = null;

  if (target === 'none') {
    if (before.selectedTool) {
      picked = await clickActiveToolButton(state.session, before.selectedTool);
      if (!picked || !picked.clicked) picked = await clickCheckedToolMenuItem(state.session);
      changed = !!(picked && picked.clicked);
    }
  } else if (before.selectedTool !== target) {
    picked = await clickToolMenuItem(state.session, target);
    changed = !!(picked && picked.clicked);
  }

  await sleep(900);
  const after = await detectToolState(state.session);
  const ok = target === 'none' ? !after.selectedTool : after.selectedTool === target;
  if (!ok) {
    const e = new Error(`could not ensure tool=${target} (current=${after.selectedTool || 'none'}). Please select "${toolLabel(target)}" manually from Add files and more, then re-run with --resume.`);
    e.code = 'tool_switch_failed';
    e.stageData = { target, before, after, picked };
    throw e;
  }

  if (changed) {
    clearStage(state, 'send');
    clearStage(state, 'wait');
    clearStage(state, 'extract');
    clearStage(state, 'extractImages');
  }
  const data = {
    target,
    selected: after.selectedTool || '',
    label: after.selectedLabel || '',
    changed,
    picked,
  };
  markStage(state, 'ensureTool', data);
  saveState(state);
  return { skipped: false, data };
}

async function detectToolState(session) {
  const targets = {};
  for (const [key, cfg] of Object.entries(TOOL_TARGETS)) {
    targets[key] = { labels: cfg.labels || [], activeLabels: cfg.activeLabels || cfg.labels || [] };
  }
  const v = await evaluate(
    session,
    `(() => {
      const targets = ${JSON.stringify(targets)};
      const textOf = (el) => ((el && (el.innerText || el.textContent)) || '').trim();
      const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const matchesAny = (text, labels) => {
        const t = norm(text);
        if (!t) return false;
        return labels.some((label) => {
          const l = norm(label);
          return t === l || t.startsWith(l + ',') || t.includes(l);
        });
      };
      const targetFor = (text, active) => {
        for (const [key, cfg] of Object.entries(targets)) {
          const labels = active ? cfg.activeLabels : cfg.labels;
          if (matchesAny(text, labels)) return key;
        }
        return '';
      };
      const describe = (el) => {
        const text = textOf(el);
        const aria = el.getAttribute('aria-label') || '';
        const title = el.getAttribute('title') || '';
        const role = el.getAttribute('role') || '';
        const hay = [text, aria, title].filter(Boolean).join(' ');
        return {
          text,
          aria,
          title,
          role,
          checked: el.getAttribute('aria-checked') || '',
          state: el.getAttribute('data-state') || '',
          testid: el.getAttribute('data-testid') || '',
          tool: targetFor(hay, /click to remove|remove|移除|取消|清除/i.test(hay)),
        };
      };
      const menus = [...document.querySelectorAll('[role="menu"]')];
      const toolsMenu = menus.find((m) => /Deep research|Web search|Create image|深度研究|深度搜索|网页搜索|联网搜索|创建图像|生成图片/i.test(textOf(m))) || null;
      const radios = toolsMenu
        ? [...toolsMenu.querySelectorAll('[role="menuitemradio"]')].map(describe).filter((item) => item.tool)
        : [];
      const checkedRadio = radios.find((item) => item.checked === 'true' || item.state === 'checked') || null;
      const removable = [...document.querySelectorAll('button,[role="button"]')]
        .map(describe)
        .filter((item) => item.tool && /click to remove|remove|移除|取消|清除/i.test([item.aria, item.title].join(' ')));
      const selected = removable[0] || checkedRadio || null;
      return JSON.stringify({
        selectedTool: selected ? selected.tool : '',
        selectedLabel: selected ? (selected.text || selected.aria || selected.title || '') : '',
        selectedSource: selected ? (removable[0] ? 'chip' : 'menu') : '',
        activeTools: removable,
        menuOpen: !!toolsMenu,
        radios,
      });
    })()`
  );
  return v || { selectedTool: '', activeTools: [], menuOpen: false, radios: [] };
}

async function readToolsMenu(session) {
  const targets = {};
  for (const [key, cfg] of Object.entries(TOOL_TARGETS)) targets[key] = cfg.labels;
  const v = await evaluate(
    session,
    `(() => {
      const targets = ${JSON.stringify(targets)};
      const textOf = (el) => ((el && (el.innerText || el.textContent)) || '').trim();
      const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const targetFor = (text) => {
        const t = norm(text);
        for (const [key, labels] of Object.entries(targets)) {
          if (labels.some((label) => {
            const l = norm(label);
            return t === l || t.includes(l);
          })) return key;
        }
        return '';
      };
      const menus = [...document.querySelectorAll('[role="menu"]')];
      const menu = menus.find((m) => /Deep research|Web search|Create image|深度研究|深度搜索|网页搜索|联网搜索|创建图像|生成图片/i.test(textOf(m))) || null;
      const items = menu ? [...menu.querySelectorAll('[role="menuitemradio"],[role="menuitem"]')].map((el) => ({
        text: textOf(el),
        role: el.getAttribute('role') || '',
        checked: el.getAttribute('aria-checked') || '',
        state: el.getAttribute('data-state') || '',
        tool: targetFor(textOf(el)),
      })) : [];
      return JSON.stringify({ open: !!menu, text: menu ? textOf(menu) : '', items });
    })()`
  );
  return v || { open: false, items: [] };
}

async function openToolsMenu(session) {
  let menu = await readToolsMenu(session);
  if (menu.open) return { ...menu, opened: false };
  const opened = await evaluate(
    session,
    `(() => {
      const btn =
        document.querySelector('[data-testid="composer-plus-btn"]') ||
        document.querySelector('button[aria-label*="Add files"]') ||
        document.querySelector('button[aria-label*="添加"]');
      if (!btn) return JSON.stringify({ opened: false, reason: 'button_not_found' });
      const r = btn.getBoundingClientRect();
      for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) {
        btn.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, clientX: r.x + 5, clientY: r.y + 5, button: 0 }));
      }
      return JSON.stringify({ opened: true });
    })()`
  );
  await sleep(800);
  menu = await readToolsMenu(session);
  return { ...menu, opened: !!(opened && opened.opened), openAttempt: opened };
}

async function clickToolMenuItem(session, target) {
  const normalized = normalizeToolName(target);
  const cfg = TOOL_TARGETS[normalized];
  if (!cfg) return { clicked: false, reason: 'unknown_target', target: normalized };
  const menu = await openToolsMenu(session);
  if (!menu.open) return { clicked: false, reason: 'menu_not_open', target: normalized, menu };
  const picked = await evaluate(
    session,
    `(() => {
      const labels = ${JSON.stringify(cfg.labels)};
      const textOf = (el) => ((el && (el.innerText || el.textContent)) || '').trim();
      const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const matches = (text) => {
        const t = norm(text);
        return labels.some((label) => {
          const l = norm(label);
          return t === l || t.includes(l);
        });
      };
      const menus = [...document.querySelectorAll('[role="menu"]')];
      const menu = menus.find((m) => /Deep research|Web search|Create image|深度研究|深度搜索|网页搜索|联网搜索|创建图像|生成图片/i.test(textOf(m))) || null;
      if (!menu) return JSON.stringify({ clicked: false, reason: 'menu_not_found' });
      const items = [...menu.querySelectorAll('[role="menuitemradio"]')];
      const item = items.find((el) => matches(textOf(el)));
      if (!item) return JSON.stringify({ clicked: false, reason: 'item_not_found', items: items.map((el) => textOf(el)) });
      const r = item.getBoundingClientRect();
      for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) {
        item.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, clientX: r.x + 5, clientY: r.y + 5, button: 0 }));
      }
      return JSON.stringify({ clicked: true, text: textOf(item), checked: item.getAttribute('aria-checked') || '', state: item.getAttribute('data-state') || '' });
    })()`
  );
  return { target: normalized, menu, ...(picked || {}) };
}

async function clickActiveToolButton(session, target) {
  const normalized = normalizeToolName(target);
  const cfg = TOOL_TARGETS[normalized];
  if (!cfg) return { clicked: false, reason: 'unknown_target', target: normalized };
  const labels = cfg.activeLabels || cfg.labels || [];
  const picked = await evaluate(
    session,
    `(() => {
      const labels = ${JSON.stringify(labels)};
      const textOf = (el) => ((el && (el.innerText || el.textContent)) || '').trim();
      const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const matches = (text) => {
        const t = norm(text);
        return labels.some((label) => {
          const l = norm(label);
          return t === l || t.startsWith(l + ',') || t.includes(l);
        });
      };
      const buttons = [...document.querySelectorAll('button,[role="button"]')];
      const button = buttons.find((el) => {
        const hay = [textOf(el), el.getAttribute('aria-label') || '', el.getAttribute('title') || ''].join(' ');
        return matches(hay) && /click to remove|remove|移除|取消|清除/i.test(hay);
      });
      if (!button) return JSON.stringify({ clicked: false, reason: 'active_button_not_found' });
      const r = button.getBoundingClientRect();
      for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) {
        button.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, clientX: r.x + 5, clientY: r.y + 5, button: 0 }));
      }
      return JSON.stringify({ clicked: true, text: textOf(button), aria: button.getAttribute('aria-label') || '' });
    })()`
  );
  return { target: normalized, ...(picked || {}) };
}

async function clickCheckedToolMenuItem(session) {
  const menu = await openToolsMenu(session);
  if (!menu.open) return { clicked: false, reason: 'menu_not_open', menu };
  const picked = await evaluate(
    session,
    `(() => {
      const textOf = (el) => ((el && (el.innerText || el.textContent)) || '').trim();
      const menus = [...document.querySelectorAll('[role="menu"]')];
      const menu = menus.find((m) => /Deep research|Web search|Create image|深度研究|深度搜索|网页搜索|联网搜索|创建图像|生成图片/i.test(textOf(m))) || null;
      if (!menu) return JSON.stringify({ clicked: false, reason: 'menu_not_found' });
      const item = [...menu.querySelectorAll('[role="menuitemradio"]')].find((el) => el.getAttribute('aria-checked') === 'true' || el.getAttribute('data-state') === 'checked');
      if (!item) return JSON.stringify({ clicked: false, reason: 'checked_item_not_found' });
      const r = item.getBoundingClientRect();
      for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) {
        item.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, clientX: r.x + 5, clientY: r.y + 5, button: 0 }));
      }
      return JSON.stringify({ clicked: true, text: textOf(item), checked: item.getAttribute('aria-checked') || '', state: item.getAttribute('data-state') || '' });
    })()`
  );
  return { menu, ...(picked || {}) };
}

function uploadFilesForState(state) {
  return normalizeUploadFiles(state.uploads || []);
}

function validateUploadFiles(files) {
  const missing = [];
  const invalid = [];
  for (const file of files) {
    if (!fs.existsSync(file)) {
      missing.push(file);
      continue;
    }
    const stat = fs.statSync(file);
    if (!stat.isFile()) invalid.push(file);
  }
  if (missing.length || invalid.length) {
    const e = new Error(`upload file check failed${missing.length ? `; missing: ${missing.join(', ')}` : ''}${invalid.length ? `; not files: ${invalid.join(', ')}` : ''}`);
    e.code = 'upload_file_invalid';
    e.stageData = { missing, invalid };
    throw e;
  }
}

async function waitForUploadInput(session, selector, maxSeconds = 8) {
  const deadline = Date.now() + maxSeconds * 1000;
  let last = null;
  while (Date.now() < deadline) {
    const found = await evaluate(
      session,
      `(() => {
        const selector = ${JSON.stringify(selector)};
        let input = document.querySelector(selector);
        let selectorUsed = selector;
        if (!input && selector !== ${JSON.stringify(DEFAULT_UPLOAD_SELECTOR)}) {
          input = document.querySelector(${JSON.stringify(DEFAULT_UPLOAD_SELECTOR)});
          selectorUsed = ${JSON.stringify(DEFAULT_UPLOAD_SELECTOR)};
        }
        if (!input) {
          input = document.querySelector('input[type="file"][multiple], input[type="file"]');
          selectorUsed = 'input[type="file"][multiple], input[type="file"]';
        }
        return JSON.stringify({
          found: !!input,
          id: input ? input.id : '',
          selectorUsed,
          accept: input ? input.accept : '',
          multiple: input ? !!input.multiple : false
        });
      })()`
    );
    if (found && found.found) return found;
    last = found;
    const clicked = await evaluate(
      session,
      `(() => { const btn = document.querySelector('[data-testid="composer-plus-btn"], button[aria-label*="Add files"], button[aria-label*="添加"]'); if (btn) { btn.click(); return true; } return false; })()`
    ).catch(() => false);
    if (clicked) await sleep(500);
    await sleep(500);
  }
  return last || { found: false };
}

async function waitForUploadedFileNames(session, files, maxSeconds) {
  const names = files.map((file) => path.basename(file));
  const deadline = Date.now() + Math.max(0, maxSeconds) * 1000;
  let last = null;
  while (Date.now() < deadline) {
    const result = await evaluate(
      session,
      `(() => {
        const names = ${JSON.stringify(names)};
        const bodyText = (document.body.innerText || document.body.textContent || '');
        const visible = names.filter((name) => bodyText.includes(name));
        const fileInputs = [...document.querySelectorAll('input[type="file"]')].map((input) => ({
          id: input.id || '',
          count: input.files ? input.files.length : 0,
          names: input.files ? [...input.files].map((file) => file.name) : []
        }));
        const elementText = [...document.querySelectorAll('[aria-label], [title], img[alt]')]
          .map((el) => [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('alt')].filter(Boolean).join(' '))
          .join('\\n');
        const searchableText = bodyText + '\\n' + elementText;
        const attributeVisible = names.filter((name) => searchableText.includes(name));
        const inputVisible = names.filter((name) => fileInputs.some((input) => input.names.includes(name)));
        return JSON.stringify({ visible, attributeVisible, inputVisible, fileInputs });
      })()`
    );
    last = result;
    const seen = new Set([...(result && result.visible || []), ...(result && result.attributeVisible || []), ...(result && result.inputVisible || [])]);
    if (names.every((name) => seen.has(name))) return { ok: true, names, ...result };
    await sleep(1000);
  }
  return { ok: false, names, ...(last || {}) };
}

async function waitForSendButtonReady(session, maxSeconds) {
  const deadline = Date.now() + Math.max(0, maxSeconds) * 1000;
  let last = null;
  while (Date.now() < deadline) {
    const result = await evaluate(
      session,
      `(() => {
        const button = document.querySelector('[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label*="Send"], button[aria-label*="发送"]');
        const composer = document.querySelector('#prompt-textarea, [contenteditable="true"]');
        const attachments = [...document.querySelectorAll('[aria-label*="Remove file"], [aria-label*="Open image"], [aria-label*="移除"], [aria-label*="打开图片"], [class*="file-tile"]')]
          .map((el) => ({
            tag: el.tagName,
            aria: el.getAttribute('aria-label') || '',
            text: (el.innerText || '').slice(0, 160)
          }));
        return JSON.stringify({
          found: !!button,
          disabled: button ? !!button.disabled : null,
          aria: button ? (button.getAttribute('aria-label') || '') : '',
          text: button ? (button.innerText || '') : '',
          composerText: composer ? ((composer.innerText || composer.textContent || '').slice(0, 240)) : '',
          attachments
        });
      })()`
    );
    last = result;
    if (result && result.found && result.disabled === false) return { ok: true, ...result };
    await sleep(1000);
  }
  return { ok: false, ...(last || {}) };
}

async function stageUpload(state, opts) {
  const files = uploadFilesForState(state);
  if (!files.length) {
    return { skipped: true, data: { files: [] } };
  }
  const signature = uploadSignature(files);
  const prompt = state.prompt || '';
  const prior = state.stages.upload;
  if (!opts.continueMode && prior && prior.done && prior.data && prior.data.signature === signature && prior.data.prompt === prompt) {
    return { skipped: true, data: prior.data };
  }
  validateUploadFiles(files);
  const requestedSelector = state.uploadSelector || opts.uploadSelector || DEFAULT_UPLOAD_SELECTOR;
  const input = await waitForUploadInput(state.session, requestedSelector, 8);
  if (!input || !input.found) {
    const e = new Error(`upload input not found for selector ${requestedSelector}`);
    e.code = 'upload_input_not_found';
    e.stageData = { selector: requestedSelector, files };
    throw e;
  }
  const selector = input.selectorUsed || requestedSelector;
  log(`uploading ${files.length} file(s)...`);
  let uploadResult;
  try {
    uploadResult = unwrap(
      await cmd('upload', { selector, files }, state.session, { retries: 1 }),
      'upload'
    );
  } catch (e) {
    if (/Not allowed/i.test(e.message)) {
      const err = new Error('upload was blocked by the browser/WebBridge extension (Not allowed)');
      err.code = 'upload_not_allowed';
      err.stageData = {
        selector,
        files,
        hint: 'Enable "Allow access to file URLs" / "允许访问文件网址" for the Kimi WebBridge extension, then retry with --resume.',
      };
      throw err;
    }
    throw e;
  }
  const waitSeconds = Number.isFinite(opts.uploadWait) ? opts.uploadWait : DEFAULT_UPLOAD_WAIT_SECONDS;
  const attachmentState = await waitForUploadedFileNames(state.session, files, waitSeconds).catch((e) => ({ ok: false, error: e.message }));
  if (!attachmentState.ok) {
    log(`upload warning: could not confirm attachment chip(s) within ${waitSeconds}s`);
  }
  const data = {
    files,
    names: files.map((file) => path.basename(file)),
    signature,
    prompt,
    selector,
    input,
    uploadResult,
    attachmentState,
  };
  clearStage(state, 'send');
  clearStage(state, 'wait');
  clearStage(state, 'extract');
  clearStage(state, 'extractImages');
  markStage(state, 'upload', data);
  saveState(state);
  return { skipped: false, data };
}

async function stageSend(state, opts) {
  const prompt = state.prompt;
  if (!prompt) throw new Error('send: no prompt in state — pass a prompt on the CLI or use --resume with prior state');
  const prior = state.stages.send;
  // In --continue mode, always re-send even if the prompt matches the prior turn
  // (the user is explicitly asking to push another turn into the conversation).
  const uploadFiles = uploadFilesForState(state);
  const uploadSig = uploadSignature(uploadFiles);
  if (!opts.continueMode && prior && prior.done && prior.data && prior.data.prompt === prompt && prior.data.uploadSignature === uploadSig) {
    return { skipped: true, data: prior.data };
  }
  const before = await getConversationProgress(state.session).catch(() => ({}));
  log(`clicking input...`);
  unwrap(await cmd('click', { selector: '[contenteditable="true"]' }, state.session), 'click input');
  await sleep(300);
  if (opts.continueMode) {
    // In continue mode, the input should be empty (previous turn was sent), but
    // use insertText (not fill) so we never accidentally clobber an unsent draft.
    log(`appending ${prompt.length} chars (continue mode)...`);
    const inserted = await evaluate(
      state.session,
      `(() => { const ce = document.querySelector('[contenteditable="true"]'); if (!ce) return JSON.stringify({err:'no input'}); ce.focus(); const sel = window.getSelection(); const range = document.createRange(); range.selectNodeContents(ce); range.collapse(false); sel.removeAllRanges(); sel.addRange(range); const ok = document.execCommand('insertText', false, ${JSON.stringify(prompt)}); return JSON.stringify({ok, len: ce.innerText.length}); })()`
    );
    if (!inserted || !inserted.ok) throw new Error('send: failed to insert text into contenteditable');
  } else {
    log(`filling ${prompt.length} chars...`);
    const fillRes = unwrap(await cmd('fill', { selector: '[contenteditable="true"]', value: prompt }, state.session), 'fill');
    if (fillRes && fillRes.mode) log(`fill mode=${fillRes.mode}`);
  }
  await sleep(300);
  const readyWait = uploadFiles.length ? Math.max(10, Number.isFinite(opts.uploadWait) ? opts.uploadWait : DEFAULT_UPLOAD_WAIT_SECONDS) : 10;
  const sendReady = await waitForSendButtonReady(state.session, readyWait);
  if (!sendReady.ok) {
    const e = new Error(`send button did not become ready within ${readyWait}s`);
    e.code = 'send_button_not_ready';
    e.stageData = sendReady;
    throw e;
  }
  log('clicking send...');
  unwrap(await cmd('click', { selector: '[data-testid="send-button"]' }, state.session), 'click send');
  const data = {
    chars: prompt.length,
    mode: opts.continueMode ? 'continue-insert' : 'replace',
    prompt,
    turn: (state.turns || 0) + 1,
    sentAt: Date.now(),
    assistantBefore: Number.isFinite(before.assistantCount) ? before.assistantCount : null,
    userBefore: Number.isFinite(before.userCount) ? before.userCount : null,
    messageBefore: Number.isFinite(before.messageCount) ? before.messageCount : null,
    uploadSignature: uploadSig,
    uploads: uploadFiles,
  };
  clearStage(state, 'wait');
  clearStage(state, 'extract');
  clearStage(state, 'extractImages');
  markStage(state, 'send', data);
  state.prompt = prompt;
  state.turns = data.turn;
  saveState(state);
  return { skipped: false, data };
}

async function stageWait(state, opts) {
  // In --continue mode, always re-wait for the new response
  const deepResearch = isDeepResearchState(state) && !opts.imageMode;
  const waitKind = opts.imageMode ? 'image' : deepResearch ? 'deep-research' : 'text';
  const priorWait = state.stages.wait;
  const priorKind = priorWait && priorWait.data && priorWait.data.kind ? priorWait.data.kind : 'text';
  if (!opts.forceWait && !opts.continueMode && priorWait && priorWait.done && priorKind === waitKind) {
    clearActiveStage(state, 'wait');
    return { skipped: true, data: priorWait.data };
  }
  const maxWait = opts.waitForever ? Number.POSITIVE_INFINITY : Number.isFinite(opts.wait) ? opts.wait : DEFAULT_WAIT_SECONDS;
  const interval = Number.isFinite(opts.interval) ? opts.interval : DEFAULT_INTERVAL_SECONDS;
  const refreshSec = Math.max(0, Number.isFinite(opts.refreshSec) ? opts.refreshSec : DEFAULT_WAIT_REFRESH_SECONDS);
  const recordWaitProgress = (progress = {}) => {
    setActiveStage(state, 'wait', {
      status: progress.status || 'waiting',
      kind: waitKind,
      ...waitLimitState(maxWait),
      refreshIntervalSec: refreshSec,
      elapsed: Number.isFinite(progress.elapsed) ? progress.elapsed : 0,
      ...progress,
    });
  };
  recordWaitProgress({ status: 'waiting', elapsed: 0 });
  if (opts.imageMode) {
    const imageCriteria = imageWaitCriteriaFromState(state, opts);
    log(`waiting ${waitLimitLabel(maxWait)} for image(s) (poll ${interval}s, stable ${imageCriteria.stableSec}s, min ${imageCriteria.requiredImages} image)...`);
    const result = await waitForImageCompletion(state.session, {
      maxWaitSec: maxWait,
      intervalSec: interval,
      refreshSec,
      ...imageCriteria,
      onProgress: recordWaitProgress,
    });
    log(`wait result: ${result.status} (${result.elapsed}s)`);
    const data = {
      kind: 'image',
      status: result.status,
      elapsed: result.elapsed,
      imageCount: result.imageCount || 0,
      requiredImages: imageCriteria.requiredImages,
      assistantCount: result.assistantCount || 0,
      stableFor: result.stableFor || 0,
      stableSec: imageCriteria.stableSec,
      assistantBefore: imageCriteria.assistantBefore,
      images: result.images || [],
      last: result.last,
    };
    if (result.status === 'login_required') {
      recordWaitProgress({ status: result.status, elapsed: result.elapsed, last: result.last });
      const e = new Error('login wall appeared during image generation - log in then re-run');
      e.code = 'login_required';
      e.stageData = data;
      throw e;
    }
    if (result.status === 'rate_limited') {
      recordWaitProgress({ status: result.status, elapsed: result.elapsed, last: result.last });
      const e = new Error('rate limited by chatgpt - wait 60s then re-run with --resume');
      e.code = 'rate_limited';
      e.stageData = data;
      throw e;
    }
    if (result.status === 'timeout') {
      recordWaitProgress({ status: result.status, elapsed: result.elapsed, last: result.last });
      const e = new Error(`image wait timed out after ${maxWait}s - re-run with --resume --until-complete or "-s ${state.session} latest --image --until-complete"`);
      e.code = 'wait_timeout';
      e.stageData = data;
      throw e;
    }
    clearActiveStage(state, 'wait');
    markStage(state, 'wait', data);
    saveState(state);
    return { skipped: false, data };
  }
  if (deepResearch) {
    const deepCriteria = deepResearchWaitCriteriaFromState(state, opts);
    log(`waiting ${waitLimitLabel(maxWait)} for Deep research (poll ${interval}s)...`);
    const result = await waitForDeepResearchCompletion(state.session, {
      maxWaitSec: maxWait,
      intervalSec: interval,
      refreshSec,
      ...deepCriteria,
      onProgress: recordWaitProgress,
    });
    log(`wait result: ${result.status} (${result.elapsed}s)`);
    const data = {
      kind: 'deep-research',
      status: result.status,
      elapsed: result.elapsed,
      length: result.length || 0,
      stableFor: result.stableFor || 0,
      minChars: deepCriteria.minChars,
      assistantBefore: deepCriteria.assistantBefore,
      plan: result.plan || null,
      widgetStatus: result.widgetStatus || '',
      sessionId: result.sessionId || '',
      export: result.export || null,
      last: result.last,
    };
    if (result.status === 'login_required') {
      recordWaitProgress({ status: result.status, elapsed: result.elapsed, last: result.last });
      const e = new Error('login wall appeared during Deep research - log in then re-run');
      e.code = 'login_required';
      e.stageData = data;
      throw e;
    }
    if (result.status === 'rate_limited' || result.status === 'rate_limit_exceeded') {
      recordWaitProgress({ status: result.status, elapsed: result.elapsed, last: result.last });
      const e = new Error('rate limited by ChatGPT Deep research - wait, then re-run with --resume');
      e.code = 'rate_limited';
      e.stageData = data;
      throw e;
    }
    if (result.status === 'timeout') {
      recordWaitProgress({ status: result.status, elapsed: result.elapsed, last: result.last });
      const e = new Error(`Deep research wait timed out after ${maxWait}s - re-run with --resume --until-complete or "-s ${state.session} latest --deep-research --until-complete"`);
      e.code = 'wait_timeout';
      e.stageData = data;
      throw e;
    }
    if (result.status && result.status !== 'complete') {
      recordWaitProgress({ status: result.status, elapsed: result.elapsed, last: result.last });
      const e = new Error(`Deep research ended with status=${result.status}`);
      e.code = `deep_research_${result.status}`;
      e.stageData = data;
      throw e;
    }
    clearActiveStage(state, 'wait');
    markStage(state, 'wait', data);
    saveState(state);
    return { skipped: false, data };
  }
  const criteria = waitCriteriaFromState(state, opts);
  log(`waiting ${waitLimitLabel(maxWait)} (poll ${interval}s, stable ${criteria.stableSec}s, min ${criteria.minChars} chars)...`);
  const result = await waitForCompletion(state.session, {
    maxWaitSec: maxWait,
    intervalSec: interval,
    refreshSec,
    ...criteria,
    onProgress: recordWaitProgress,
  });
  log(`wait result: ${result.status} (${result.elapsed}s)`);
  const data = {
    kind: 'text',
    status: result.status,
    elapsed: result.elapsed,
    length: result.length || 0,
    assistantCount: result.assistantCount || 0,
    stableFor: result.stableFor || 0,
    minChars: criteria.minChars,
    stableSec: criteria.stableSec,
    assistantBefore: criteria.assistantBefore,
    last: result.last,
  };
  if (result.status === 'login_required') {
    recordWaitProgress({ status: result.status, elapsed: result.elapsed, last: result.last });
    const e = new Error('login wall appeared during generation - log in then re-run');
    e.code = 'login_required';
    e.stageData = data;
    throw e;
  }
  if (result.status === 'rate_limited') {
    recordWaitProgress({ status: result.status, elapsed: result.elapsed, last: result.last });
    const e = new Error('rate limited by chatgpt - wait 60s then re-run with --resume');
    e.code = 'rate_limited';
    e.stageData = data;
    throw e;
  }
  if (result.status === 'timeout') {
    // Timeout is exit 3, not 4. Throw a special error.
    recordWaitProgress({ status: result.status, elapsed: result.elapsed, last: result.last });
    const e = new Error(`wait timed out after ${maxWait}s - latest reply is not complete yet; re-run with --resume --until-complete or "-s ${state.session} latest --until-complete"`);
    e.code = 'wait_timeout';
    e.stageData = data;
    throw e;
  }
  clearActiveStage(state, 'wait');
  markStage(state, 'wait', data);
  saveState(state);
  return { skipped: false, data };
}

async function stageExtract(state, opts) {
  // In --continue mode, always re-extract to get the latest response
  const deepResearch = isDeepResearchState(state) && !opts.imageMode;
  const extractKind = deepResearch ? 'deep-research' : 'text';
  const priorExtract = state.stages.extract;
  const priorKind = priorExtract && priorExtract.data && priorExtract.data.kind ? priorExtract.data.kind : 'text';
  if (!opts.forceExtract && !opts.continueMode && priorExtract && priorExtract.done && priorKind === extractKind) {
    return { skipped: true, data: state.stages.extract.data };
  }
  const criteria = waitCriteriaFromState(state, opts);
  const extracted = deepResearch
    ? await extractDeepResearchReport(state.session)
    : await extractLastAssistant(state.session, criteria.requireNewAssistant ? criteria : {});
  if (!extracted.text) {
    const e = new Error(deepResearch
      ? 'no Deep research report found - re-run with --resume after the report completes'
      : 'no assistant message found - re-run with --resume, or run send again if generation never started');
    e.code = 'no_response';
    e.stageData = {
      error: extracted.error,
      assistantCount: extracted.assistantCount,
      assistantBefore: criteria.assistantBefore,
      deepResearch: extracted.deepResearch,
    };
    throw e;
  }
  // File naming:
  //   explicit --output:  used as-is (overwrites on each turn — caller's choice)
  //   continue mode:      gpt-pro-response-<createdAt>-turn-<N>.md, one per turn
  //                       PLUS a "latest" file with the current turn's content
  //   normal mode:        gpt-pro-response-<Date.now()>.md (overwrites; one-off)
  let out, latest;
  if (opts.latestMode) {
    out = state.output || `gpt-pro-response-${state.createdAt || Date.now()}-latest.md`;
  } else if (opts.continueMode) {
    const turn = state.turns || 1;
    out = `gpt-pro-response-${state.createdAt || Date.now()}-turn-${turn}.md`;
    latest = `gpt-pro-response-${state.createdAt || Date.now()}.md`;
  } else if (state.output) {
    out = state.output;
  } else {
    out = `gpt-pro-response-${Date.now()}.md`;
  }
  fs.writeFileSync(out, extracted.text, 'utf8');
  log(`saved -> ${out}`);
  if (latest) {
    fs.writeFileSync(latest, extracted.text, 'utf8');
    log(`latest -> ${latest}`);
  }
  const data = {
    kind: extractKind,
    length: extracted.text.length,
    path: out,
    turn: state.turns || 1,
    assistantCount: extracted.assistantCount,
    assistantIndex: extracted.index,
    deepResearch: extracted.deepResearch,
  };
  markStage(state, 'extract', data);
  state.output = out;
  saveState(state);
  // Capture conversation URL and title for future recovery (sidebar navigation).
  // No-op if already captured (e.g. on a re-extract).
  if (!state.conversationUrl || !/\/c\//.test(state.conversationUrl)) {
    await captureConversationContext(state);
  }
  return { skipped: false, data };
}

async function stageExtractImages(state, opts) {
  if (!opts.forceExtract && !opts.continueMode && state.stages.extractImages && state.stages.extractImages.done) {
    return { skipped: true, data: state.stages.extractImages.data };
  }
  const criteria = imageWaitCriteriaFromState(state, opts);
  const maxImages = Math.max(criteria.requiredImages, Number.isFinite(opts.maxImages) ? opts.maxImages : DEFAULT_MAX_IMAGES);
  const extracted = await extractLastAssistantImages(state.session, criteria.requireNewAssistant ? criteria : {}, maxImages);
  if (!extracted.images.length) {
    const e = new Error('no generated images found in the latest assistant message - re-run with --resume after generation completes');
    e.code = 'no_images';
    e.stageData = {
      error: extracted.error,
      assistantCount: extracted.assistantCount,
      assistantBefore: criteria.assistantBefore,
    };
    throw e;
  }
  const saved = await saveExtractedImages(state, opts, extracted);
  if (!saved.images.length) {
    const e = new Error('generated image(s) were found, but none could be saved');
    e.code = 'image_save_failed';
    e.stageData = {
      manifest: saved.manifestPath,
      failed: saved.failed,
      candidateCount: extracted.images.length,
    };
    throw e;
  }
  const data = {
    imageCount: saved.images.length,
    failedCount: saved.failed.length,
    dir: saved.dir,
    manifestPath: saved.manifestPath,
    images: saved.images,
    failed: saved.failed,
    turn: state.turns || 1,
    assistantCount: extracted.assistantCount,
    assistantIndex: extracted.index,
  };
  markStage(state, 'extractImages', data);
  state.output = saved.manifestPath;
  state.images = saved.images;
  saveState(state);
  if (!state.conversationUrl || !/\/c\//.test(state.conversationUrl)) {
    await captureConversationContext(state);
  }
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

async function runLatest(state, opts) {
  const existing = await findChatgptTab(state.session);
  if (!existing && !state.conversationUrl && !state.conversationTitle) {
    const e = new Error(`latest: no prior tab or saved conversation for session "${state.session}"`);
    e.code = 'no_session_context';
    e.stageData = { session: state.session };
    throw e;
  }
  const latestOpts = { ...opts, forceWait: true, forceExtract: true, latestMode: true };
  const results = {};
  results.open = await stageOpen(state, latestOpts);
  results.loginCheck = await stageLoginCheck(state, latestOpts);
  results.wait = await stageWait(state, latestOpts);
  if (opts.imageMode) {
    results.extractImages = await stageExtractImages(state, latestOpts);
  } else {
    results.extract = await stageExtract(state, latestOpts);
  }
  return results;
}

async function runDoctor(state, opts, daemonStatus) {
  const checks = [
    {
      name: 'webbridge',
      ok: true,
      daemonVersion: daemonStatus && daemonStatus.version || '',
      extensionVersion: daemonStatus && daemonStatus.extension_version || '',
    },
  ];
  const doctorOpts = { ...opts, keepSession: true };
  let openResult = null;
  let loginResult = null;
  let toolMenu = null;
  try {
    openResult = await stageOpen(state, doctorOpts);
    checks.push({
      name: 'chatgpt_tab',
      ok: true,
      url: openResult && openResult.data && openResult.data.url || '',
      reused: !!(openResult && openResult.data && openResult.data.reused),
    });
  } catch (e) {
    checks.push({ name: 'chatgpt_tab', ok: false, error: e.message, code: e.code || '' });
  }

  if (checks.every((check) => check.ok)) {
    try {
      loginResult = await stageLoginCheck(state, doctorOpts);
      checks.push({
        name: 'chatgpt_login',
        ok: loginResult && loginResult.data && loginResult.data.state !== 'login_required',
        state: loginResult && loginResult.data && loginResult.data.state || 'unknown',
      });
    } catch (e) {
      checks.push({ name: 'chatgpt_login', ok: false, error: e.message, code: e.code || '' });
    }
  }

  if (checks.every((check) => check.ok)) {
    try {
      toolMenu = await openToolsMenu(state.session);
      const items = Array.isArray(toolMenu.items) ? toolMenu.items : [];
      const deepResearch = items.find((item) => item.tool === 'deep-research') || null;
      const webSearch = items.find((item) => item.tool === 'web-search') || null;
      checks.push({
        name: 'composer_tools_menu',
        ok: !!toolMenu.open,
        opened: !!toolMenu.opened,
        itemCount: items.length,
      });
      checks.push({
        name: 'deep_research_tool',
        ok: !!deepResearch,
        label: deepResearch && deepResearch.text || '',
      });
      checks.push({
        name: 'web_search_tool',
        ok: !!webSearch,
        label: webSearch && webSearch.text || '',
      });
    } catch (e) {
      checks.push({ name: 'composer_tools_menu', ok: false, error: e.message, code: e.code || '' });
    } finally {
      await evaluate(state.session, `(() => { document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); document.body.click(); return true; })()`).catch(() => false);
    }
  }

  const ok = checks.every((check) => check.ok);
  const data = {
    ok,
    checks,
    recommendedResearchCommand: `node ${path.basename(__filename)} research --until-complete "Research your topic and cite sources."`,
    state: state.session,
    conversationUrl: state.conversationUrl || '',
  };
  if (!ok) {
    const e = new Error('doctor found an environment problem');
    e.code = 'doctor_failed';
    e.stageData = data;
    throw e;
  }
  return { doctor: { skipped: false, data } };
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

async function detectModelReady(session, maxSeconds = 10) {
  const deadline = Date.now() + Math.max(0, maxSeconds) * 1000;
  let state = await detectModel(session);
  while (state.model === 'unknown' && Date.now() < deadline) {
    await sleep(750);
    state = await detectModel(session);
  }
  return state;
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
  if (target === 'auto') return { ok: true, state: await detectModelReady(session, 4), changed: false };
  const state = await detectModelReady(session, 12);
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

function textSignature(text) {
  const t = String(text || '');
  return `${t.length}:${t.slice(0, 160)}:${t.slice(-500)}`;
}

function waitLimitLabel(maxWait) {
  return Number.isFinite(maxWait) ? `up to ${maxWait}s` : 'until complete';
}

function waitLimitState(maxWait) {
  return {
    waitLimitSec: Number.isFinite(maxWait) ? maxWait : null,
    unlimited: !Number.isFinite(maxWait),
  };
}

function emitWaitProgress(config, progress) {
  if (typeof config.onProgress !== 'function') return;
  try {
    config.onProgress(progress);
  } catch (e) {
    log(`wait progress update failed: ${e.message}`);
  }
}

async function describeCurrentPage(session) {
  return evaluate(
    session,
    `(() => JSON.stringify({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      messageCount: document.querySelectorAll('[data-message-author-role]').length,
      assistantCount: document.querySelectorAll('[data-message-author-role="assistant"]').length
    }))()`
  ).catch((e) => ({ error: e.message }));
}

async function refreshCurrentWaitPage(session, meta = {}) {
  const before = await describeCurrentPage(session);
  const url = before && before.url && CHATGPT_HOST_RE.test(before.url)
    ? before.url
    : 'https://chatgpt.com/';
  const reason = [meta.kind || 'wait', meta.need || ''].filter(Boolean).join(' ');
  log(`refreshing ChatGPT page after ${meta.elapsed || 0}s (${reason || 'wait'})`);
  let method = 'navigate';
  let navigateError = '';
  let reloadError = '';
  try {
    unwrap(await cmd('navigate', { url, newTab: false }, session, { retries: 2 }), 'refresh navigate');
  } catch (e) {
    method = 'reload';
    navigateError = e.message;
    log(`refresh navigate failed, trying location.reload(): ${e.message}`);
    await evaluate(session, `(() => { location.reload(); return true; })()`).catch((reloadErr) => {
      reloadError = reloadErr.message;
    });
  }
  await sleep(DEFAULT_WAIT_REFRESH_SETTLE_MS);
  const after = await describeCurrentPage(session);
  const error = reloadError
    ? `${navigateError}; reload failed: ${reloadError}`
    : navigateError;
  return {
    ok: !navigateError || !reloadError,
    method,
    elapsed: meta.elapsed || 0,
    urlBefore: before && before.url || '',
    urlAfter: after && after.url || '',
    messageCount: after && after.messageCount || 0,
    assistantCount: after && after.assistantCount || 0,
    error,
  };
}

async function maybeRefreshWaitPage(session, config, meta = {}) {
  const refreshSec = Math.max(0, Number.isFinite(config.refreshSec) ? config.refreshSec : DEFAULT_WAIT_REFRESH_SECONDS);
  const elapsed = Number.isFinite(meta.elapsed) ? meta.elapsed : 0;
  const lastRefreshAt = Number.isFinite(meta.lastRefreshAt) ? meta.lastRefreshAt : 0;
  if (!refreshSec || elapsed < refreshSec || elapsed - lastRefreshAt < refreshSec) return lastRefreshAt;
  emitWaitProgress(config, {
    status: 'refreshing',
    elapsed,
    need: meta.need || '',
    last: meta.last || null,
  });
  const refresh = await refreshCurrentWaitPage(session, meta).catch((e) => ({
    ok: false,
    elapsed,
    error: e.message,
  }));
  emitWaitProgress(config, {
    status: 'waiting',
    elapsed,
    need: meta.need || '',
    lastRefresh: refresh,
    last: meta.last || null,
  });
  return elapsed;
}

function looksLikeThinkingPlaceholder(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return true;
  if (/^(thinking|reasoning|working|searching|analyzing|generating|one moment|please wait|思考中|正在思考|正在分析|正在生成|请稍等)[\s.。…-]*$/i.test(t)) {
    return true;
  }
  if (t.length <= 240 && /(thinking|reasoning|working on it|still working|one moment|please wait|思考中|正在思考|正在分析|正在生成|请稍等)/i.test(t)) {
    return true;
  }
  return false;
}

function isSubstantiveAssistantText(text, minChars) {
  const t = String(text || '').trim();
  if (looksLikeThinkingPlaceholder(t)) return false;
  if (minChars > 0 && t.length < minChars) return false;
  return true;
}

function isDeepResearchState(state) {
  return normalizeToolName(state && state.tool) === 'deep-research';
}

function deepResearchWaitCriteriaFromState(state, opts) {
  const sendData = state.stages && state.stages.send && state.stages.send.data;
  const assistantBefore = sendData && Number.isFinite(sendData.assistantBefore) ? sendData.assistantBefore : null;
  return {
    assistantBefore,
    requireNewAssistant: assistantBefore !== null,
    // Deep research reports can intentionally be terse; keep the default from
    // blocking completion unless the caller explicitly asks for a minimum.
    minChars: opts.minCharsExplicit ? Math.max(0, Number.isFinite(opts.minChars) ? opts.minChars : DEFAULT_MIN_RESPONSE_CHARS) : 1,
  };
}

function summarizePlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const title = String(plan.title || plan.name || plan.heading || '').trim();
  const rawSteps = Array.isArray(plan.steps)
    ? plan.steps
    : Array.isArray(plan.items)
      ? plan.items
      : Array.isArray(plan.plan)
        ? plan.plan
        : [];
  const steps = rawSteps.map((step, index) => {
    if (typeof step === 'string') return { id: `step-${index + 1}`, text: step, status: '' };
    if (!step || typeof step !== 'object') return { id: `step-${index + 1}`, text: String(step || ''), status: '' };
    return {
      id: String(step.id || `step-${index + 1}`),
      text: String(step.text || step.title || step.name || step.description || '').trim(),
      status: String(step.status || ''),
      reason: step.reason || null,
    };
  }).filter((step) => step.text);
  if (!title && !steps.length) return null;
  return { title, steps };
}

function deepResearchPlanSignature(plan) {
  if (!plan) return '';
  return JSON.stringify({
    title: plan.title || '',
    steps: (plan.steps || []).map((step) => [step.text || '', step.status || '']),
  });
}

function isDeepResearchTerminalStatus(status) {
  return DEEP_RESEARCH_TERMINAL_STATUSES.has(String(status || '').toLowerCase());
}

function collectDeepResearchMessages(body) {
  const meta = body && (body._meta || body.meta) || {};
  const structured = body && (body.structuredContent || body.structured_content) || {};
  const candidates = [
    meta.deep_research_widget_messages,
    structured.deep_research_widget_messages,
    structured.messages,
    body && body.deep_research_widget_messages,
    body && body.messages,
  ];
  const messages = [];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) messages.push(...candidate);
  }
  return messages;
}

function firstStringAtPaths(root, paths) {
  for (const pathParts of paths) {
    let value = root;
    for (const part of pathParts) {
      value = value && value[part];
      if (value === undefined || value === null) break;
    }
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function getDeepResearchMessageContent(message) {
  const content = message && message.content || {};
  if (Array.isArray(content.parts)) return content.parts.filter(Boolean).join('\n').trim();
  if (typeof content.text === 'string') return content.text.trim();
  if (typeof content.content === 'string' && content.content_type !== 'reasoning_recap') return content.content.trim();
  return '';
}

function normalizeDeepResearchToolState(progress, result) {
  const body = result && result.body || {};
  const meta = body && (body._meta || body.meta) || {};
  const structured = body && (body.structuredContent || body.structured_content) || {};
  const messages = collectDeepResearchMessages(body);
  let status = firstStringAtPaths(body, [
    ['status'],
    ['state'],
    ['workflow_status'],
    ['deep_research_status'],
    ['_meta', 'status'],
    ['meta', 'status'],
    ['structuredContent', 'status'],
    ['structured_content', 'status'],
    ['structuredContent', 'state'],
    ['structured_content', 'state'],
  ]);
  let plan = summarizePlan(
    structured.plan ||
    structured.venus_plan ||
    meta.venus_plan ||
    meta.plan ||
    body.plan
  );
  let finalSignal = false;
  let lastMessageStatus = '';
  let lastText = '';
  for (const message of messages) {
    const metadata = message && message.metadata || {};
    const sdk = metadata.chatgpt_sdk || {};
    const trm = sdk.tool_response_metadata || {};
    const widgetState = trm.venus_widget_state || metadata.venus_widget_state || {};
    const messageStatus = String(widgetState.status || metadata.status || message.status || '').trim();
    if (messageStatus) lastMessageStatus = messageStatus;
    const messagePlan = summarizePlan(trm.venus_plan || widgetState.plan || metadata.venus_plan);
    if (messagePlan) plan = messagePlan;
    if (metadata.venus_message_type === 'final_widget_status_signal') finalSignal = true;
    const text = getDeepResearchMessageContent(message);
    if (text) lastText = text;
  }
  if (!status && lastMessageStatus) status = lastMessageStatus;
  if (finalSignal && !status) status = 'completed';

  const lowerStatus = String(status || '').toLowerCase();
  const completed = finalSignal || lowerStatus === 'completed' || lowerStatus === 'complete' || lowerStatus === 'succeeded' || lowerStatus === 'success';
  const terminal = completed || isDeepResearchTerminalStatus(lowerStatus);
  return {
    ok: true,
    status,
    completed,
    terminal,
    messageCount: messages.length,
    hasMessages: messages.length > 0,
    textLength: lastText.length,
    lastText,
    plan: plan || (progress && progress.plan) || null,
    sessionId: (progress && progress.sessionId) || '',
    widgetSessionId: (progress && progress.widgetSessionId) || '',
    rawStatus: status,
  };
}

async function getDeepResearchState(session, progress) {
  if (!progress || !progress.sessionId) {
    return { ok: false, error: 'missing_session_id', messageCount: 0, hasMessages: false };
  }
  try {
    const result = await callDeepResearchTool(session, progress, 'get_state', { session_id: progress.sessionId });
    return normalizeDeepResearchToolState(progress, result);
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      code: e.code || '',
      messageCount: 0,
      hasMessages: false,
      sessionId: progress.sessionId || '',
    };
  }
}

function deepResearchHasAdvanceControl(progress) {
  const controls = progress && Array.isArray(progress.controls) ? progress.controls : [];
  const advanceRe = /(start|begin|run)\s+(deep\s+)?research|deep research.*(start|begin|run)|confirm(\s+(plan|research))?|continue(\s+(research|with research))?|approve|开始(研究|搜索)|确认(计划|研究|开始)?|继续(研究|搜索)?|提交计划/i;
  return controls.some((label) =>
    advanceRe.test(label) &&
    !/stop|cancel|delete|discard|停止|取消|删除|放弃/i.test(label)
  );
}

async function clickDeepResearchAdvanceControl(session) {
  const clicked = await evaluate(
    session,
    `(() => {
      const textOf = (el) => ((el && (el.innerText || el.textContent)) || '').trim();
      const attrText = (el) => [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-testid'), textOf(el)].filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim();
      const isAdvance = (label) =>
        /(start|begin|run)\\s+(deep\\s+)?research|deep research.*(start|begin|run)|confirm(\\s+(plan|research))?|continue(\\s+(research|with research))?|approve|开始(研究|搜索)|确认(计划|研究|开始)?|继续(研究|搜索)?|提交计划/i.test(label) &&
        !/stop|cancel|delete|discard|停止|取消|删除|放弃/i.test(label);
      const buttons = [...document.querySelectorAll('button,[role="button"]')];
      const button = buttons.find((el) => {
        const label = attrText(el);
        if (!label || !isAdvance(label)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
      });
      if (!button) return JSON.stringify({ clicked: false, reason: 'button_not_found', candidates: buttons.map(attrText).filter(Boolean).slice(0, 40) });
      const rect = button.getBoundingClientRect();
      for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) {
        button.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, clientX: rect.x + Math.min(10, rect.width / 2), clientY: rect.y + Math.min(10, rect.height / 2), button: 0 }));
      }
      return JSON.stringify({ clicked: true, label: attrText(button) });
    })()`
  );
  return clicked || { clicked: false, reason: 'no_result' };
}

async function getDeepResearchProgress(session) {
  const v = await evaluate(
    session,
    `(() => {
      const textOf = (el) => ((el && (el.innerText || el.textContent)) || '').trim();
      const attrText = (el) => [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-testid'), textOf(el)].filter(Boolean).join(' ');
      const fiberOf = (el) => {
        if (!el) return null;
        const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
        return key ? el[key] : null;
      };
      const parseJson = (text) => {
        if (!text || typeof text !== 'string') return null;
        try { return JSON.parse(text); } catch { return null; }
      };
      const normalizePlan = (plan) => {
        if (!plan || typeof plan !== 'object') return null;
        const rawSteps = Array.isArray(plan.steps) ? plan.steps : Array.isArray(plan.items) ? plan.items : Array.isArray(plan.plan) ? plan.plan : [];
        const steps = rawSteps.map((step, index) => {
          if (typeof step === 'string') return { id: 'step-' + (index + 1), text: step, status: '' };
          if (!step || typeof step !== 'object') return { id: 'step-' + (index + 1), text: String(step || ''), status: '' };
          return {
            id: String(step.id || 'step-' + (index + 1)),
            text: String(step.text || step.title || step.name || step.description || '').trim(),
            status: String(step.status || ''),
            reason: step.reason || null
          };
        }).filter((step) => step.text);
        const title = String(plan.title || plan.name || plan.heading || '').trim();
        return title || steps.length ? { title, steps } : null;
      };
      const out = {
        status: '',
        statuses: [],
        completed: false,
        terminal: false,
        plan: null,
        sessionId: '',
        asyncTaskConversationId: '',
        widgetSessionId: '',
        websocketUrl: '',
        toolMessageId: '',
        widgetId: '',
        waitingUntil: '',
        venusMessageType: '',
        messageCount: 0,
        assistantSectionCount: 0,
        iframe: null,
        controls: [],
        looksLikeLogin: /Log in|Sign in|Continue with|登录|登入/.test(textOf(document.body)),
        looksRateLimited: /too many requests|please wait a moment|slow down|rate limit|请稍候|请求过多/i.test(textOf(document.body)),
        url: location.href,
        title: document.title
      };
      const iframe = document.querySelector('iframe[title=${JSON.stringify(DEEP_RESEARCH_IFRAME_TITLE)}]');
      if (iframe) {
        const rect = iframe.getBoundingClientRect();
        out.iframe = {
          title: iframe.getAttribute('title') || '',
          src: iframe.getAttribute('src') || '',
          visible: rect.width > 20 && rect.height > 20,
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      }
      out.controls = [...document.querySelectorAll('button,[role="button"]')]
        .map((el) => attrText(el).replace(/\\s+/g, ' ').trim())
        .filter((label) => /start|confirm|continue|stop|cancel|edit|copy|download|开始|确认|继续|停止|取消|编辑|复制|下载/i.test(label))
        .slice(0, 40);
      const sections = [...document.querySelectorAll('section[data-turn="assistant"]')];
      out.assistantSectionCount = sections.length;
      for (const section of sections) {
        const fiber = fiberOf(section);
        let messages = [];
        try { messages = fiber && fiber.memoizedProps && fiber.memoizedProps.children.props.turn.messages || []; } catch {}
        out.messageCount += messages.length;
        for (const message of messages) {
          const metadata = message && message.metadata || {};
          const sdk = metadata.chatgpt_sdk || {};
          const trm = sdk.tool_response_metadata || {};
          const widgetState = trm.venus_widget_state || metadata.venus_widget_state || {};
          const plan = normalizePlan(trm.venus_plan || widgetState.plan || metadata.venus_plan);
          const status = String(widgetState.status || '').trim();
          if (status) out.statuses.push(status);
          if (plan) out.plan = plan;
          if (metadata.venus_message_type) out.venusMessageType = metadata.venus_message_type;
          if (trm['openai/widgetSessionId']) out.widgetSessionId = trm['openai/widgetSessionId'];
          if (trm.widgetSessionId) out.widgetSessionId = trm.widgetSessionId;
          if (trm.async_task_conversation_id) {
            out.asyncTaskConversationId = trm.async_task_conversation_id;
            out.sessionId = trm.async_task_conversation_id;
          }
          if (trm.websocket_url) out.websocketUrl = trm.websocket_url;
          if (widgetState.waiting_for_user_response_on_plan_until) out.waitingUntil = widgetState.waiting_for_user_response_on_plan_until;
          if (message && message.author && message.author.name === 'api_tool.call_tool') {
            out.toolMessageId = message.id || out.toolMessageId;
            out.widgetId = message.id || out.widgetId;
          }
          const content = message && message.content || {};
          const toolPayload = parseJson(content.text || (Array.isArray(content.parts) ? content.parts.join('') : ''));
          if (toolPayload && toolPayload.session_id && !out.sessionId) out.sessionId = toolPayload.session_id;
        }
      }
      out.status = out.statuses.length ? out.statuses[out.statuses.length - 1] : '';
      if (out.venusMessageType === 'final_widget_status_signal' && !out.status) out.status = 'completed';
      out.completed = out.status === 'completed' || out.venusMessageType === 'final_widget_status_signal';
      out.terminal = out.completed || ${JSON.stringify([...DEEP_RESEARCH_TERMINAL_STATUSES])}.includes(String(out.status || '').toLowerCase());
      if (!out.widgetId && out.toolMessageId) out.widgetId = out.toolMessageId;
      return JSON.stringify(out);
    })()`
  );
  if (!v || typeof v !== 'object') return {};
  if (v.plan) v.plan = summarizePlan(v.plan);
  return v;
}

async function callDeepResearchTool(session, progress, toolName, toolInput) {
  const meta = progress || {};
  const sessionId = meta.sessionId || meta.asyncTaskConversationId || (toolInput && toolInput.session_id) || '';
  const messageId = meta.toolMessageId || meta.widgetId || '';
  const widgetId = meta.widgetId || meta.toolMessageId || messageId;
  if (!sessionId) {
    const e = new Error(`Deep research ${toolName}: missing session_id`);
    e.code = 'deep_research_session_missing';
    throw e;
  }
  const v = await evaluate(
    session,
    `(async () => {
      const auth = await fetch('/api/auth/session', { credentials: 'include' })
        .then((r) => r.json())
        .then((j) => j && j.accessToken);
      if (!auth) return JSON.stringify({ ok: false, status: 401, error: 'missing_access_token' });
      const payload = {
        app_uri: ${JSON.stringify(DEEP_RESEARCH_APP_URI)},
        tool_name: ${JSON.stringify(toolName)},
        tool_input: ${JSON.stringify({ ...(toolInput || {}), session_id: sessionId })},
        call_context: {
          message_id: ${JSON.stringify(messageId)},
          widget_context: {
            app_uri: ${JSON.stringify(DEEP_RESEARCH_APP_URI)},
            widget_id: ${JSON.stringify(widgetId)},
            widget_session_id: ${JSON.stringify(meta.widgetSessionId || '')},
            source: 'iframe'
          }
        }
      };
      const res = await fetch('/backend-api/ecosystem/call_mcp', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth },
        body: JSON.stringify(payload)
      });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch {}
      return JSON.stringify({
        ok: res.ok,
        status: res.status,
        contentType: res.headers.get('content-type') || '',
        body,
        text: body ? '' : text.slice(0, 4000)
      });
    })()`
  );
  if (!v || typeof v !== 'object') return { ok: false, status: 0, error: 'no_value' };
  if (!v.ok) {
    const e = new Error(`Deep research ${toolName} failed (${v.status || 'unknown'}): ${v.error || v.text || 'request failed'}`);
    e.code = v.status === 401 ? 'deep_research_auth_failed' : 'deep_research_tool_failed';
    e.stageData = { status: v.status, contentType: v.contentType, text: v.text };
    throw e;
  }
  return v;
}

async function startDeepResearchNow(session, progress) {
  if (!progress || (progress.status !== 'waiting_for_user_response_on_plan' && !deepResearchHasAdvanceControl(progress))) {
    return { attempted: false, reason: 'not_waiting_for_plan' };
  }
  let mcpResult = null;
  try {
    if (progress.sessionId) {
      const result = await callDeepResearchTool(session, progress, 'skip_sleep', { session_id: progress.sessionId });
      const isError = !!(result.body && result.body.isError);
      mcpResult = {
        attempted: true,
        ok: !isError,
        method: 'skip_sleep',
        status: result.status,
        isError,
      };
      if (!isError) return mcpResult;
    }
  } catch (e) {
    mcpResult = {
      attempted: true,
      ok: false,
      method: 'skip_sleep',
      error: e.message,
      code: e.code,
    };
  }
  const uiResult = await clickDeepResearchAdvanceControl(session);
  if (uiResult.clicked) {
    return {
      attempted: true,
      ok: true,
      method: 'ui_button',
      label: uiResult.label || '',
      fallbackFrom: mcpResult && mcpResult.error || '',
    };
  }
  return {
    attempted: true,
    ok: false,
    method: progress.sessionId ? 'skip_sleep+ui_button' : 'ui_button',
    error: (mcpResult && mcpResult.error) || uiResult.reason || 'missing_session_id',
    ui: uiResult,
  };
}

function findZipEntry(buffer, wantedName) {
  let eocd = -1;
  const min = Math.max(0, buffer.length - 65558);
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('docx export is not a valid zip: missing EOCD');
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < totalEntries; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error(`docx export is not a valid zip: bad central directory at ${offset}`);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.slice(offset + 46, offset + 46 + nameLen).toString('utf8');
    if (name === wantedName) {
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`docx export is not a valid zip: bad local header for ${wantedName}`);
      const localNameLen = buffer.readUInt16LE(localOffset + 26);
      const localExtraLen = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      const compressed = buffer.slice(start, start + compressedSize);
      if (method === 0) return compressed;
      if (method === 8) return zlib.inflateRawSync(compressed);
      throw new Error(`docx export uses unsupported zip compression method ${method}`);
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractDocxText(buffer) {
  const documentXml = findZipEntry(buffer, 'word/document.xml');
  if (!documentXml) throw new Error('docx export did not contain word/document.xml');
  const xml = documentXml.toString('utf8');
  const chunks = [];
  const tokenRe = /(<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<\/w:p>|<w:t\b[^>]*>([\s\S]*?)<\/w:t>)/g;
  let match;
  while ((match = tokenRe.exec(xml))) {
    const token = match[1];
    if (token.startsWith('<w:t')) chunks.push(decodeXmlEntities(match[2] || ''));
    else if (token.startsWith('<w:tab')) chunks.push('\t');
    else chunks.push('\n');
  }
  return chunks.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function extractTextFromDeepResearchMessages(body) {
  const messages = collectDeepResearchMessages(body);
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] || {};
    const content = message.content || {};
    let text = '';
    if (Array.isArray(content.parts)) text = content.parts.filter(Boolean).join('\n');
    else if (typeof content.text === 'string') text = content.text;
    else if (typeof content.content === 'string' && content.content_type !== 'reasoning_recap') text = content.content;
    if (text && text.trim()) return text.trim();
  }
  return '';
}

async function extractDeepResearchReport(session, progress = null) {
  const current = progress && progress.sessionId ? progress : await getDeepResearchProgress(session);
  if (!current || !current.sessionId) {
    return { text: '', error: 'deep_research_session_missing', deepResearch: current || null };
  }
  let exported;
  try {
    exported = await callDeepResearchTool(session, current, 'export', {
      session_id: current.sessionId,
      export_type: 'docx',
    });
  } catch (e) {
    return {
      text: '',
      error: e.message,
      deepResearch: {
        status: current.status || '',
        sessionId: current.sessionId || '',
        plan: current.plan || null,
      },
    };
  }
  const body = exported.body || {};
  const encoded = body && ((body._meta && body._meta.encoded_data) || (body.meta && body.meta.encoded_data));
  if (encoded) {
    try {
      const buffer = Buffer.from(encoded, 'base64');
      const text = extractDocxText(buffer);
      return {
        text,
        len: text.length,
        deepResearch: {
          status: current.status || '',
          sessionId: current.sessionId || '',
          plan: current.plan || null,
          export: {
            type: 'docx',
            bytes: buffer.length,
            contentDisposition: (body._meta && body._meta.content_disposition) || (body.meta && body.meta.content_disposition) || '',
          },
        },
      };
    } catch (e) {
      return { text: '', error: `docx_export_parse_failed: ${e.message}`, deepResearch: { status: current.status || '', sessionId: current.sessionId || '' } };
    }
  }
  const fallbackText = extractTextFromDeepResearchMessages(body);
  return {
    text: fallbackText,
    len: fallbackText.length,
    error: fallbackText ? undefined : 'deep_research_report_unavailable',
    deepResearch: {
      status: current.status || '',
      sessionId: current.sessionId || '',
      plan: current.plan || null,
    },
  };
}

async function waitForDeepResearchCompletion(session, config) {
  const maxWaitSec = Math.max(0, config.maxWaitSec);
  const intervalSec = Math.max(1, config.intervalSec);
  const minChars = Math.max(0, Number.isFinite(config.minChars) ? config.minChars : 1);
  const start = Date.now();
  let lastReport = 0;
  let lastPlanSig = '';
  let startAttempt = null;
  let lastStartAttemptAt = -Infinity;
  let lastExportAttemptAt = -Infinity;
  let lastProgress = null;
  let lastToolState = null;
  let lastExtract = null;
  let lastRefreshAt = 0;

  while (true) {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    const progress = await getDeepResearchProgress(session);
    lastProgress = progress;
    const toolState = progress.sessionId ? await getDeepResearchState(session, progress) : null;
    if (toolState && toolState.ok) {
      lastToolState = toolState;
      if (!progress.plan && toolState.plan) progress.plan = toolState.plan;
      if (toolState.hasMessages && (!startAttempt || startAttempt.ok === false)) {
        startAttempt = { attempted: false, ok: true, method: 'get_state', reason: 'messages_present' };
      }
    }

    const plan = (toolState && toolState.plan) || progress.plan;
    const planSig = deepResearchPlanSignature(plan);
    if (planSig && planSig !== lastPlanSig) {
      lastPlanSig = planSig;
      log(`Deep research plan: ${plan.title || '(untitled)'}`);
      for (const step of plan.steps || []) log(`  - ${step.text}`);
    }

    if (progress.looksLikeLogin && !progress.sessionId) return { status: 'login_required', elapsed, last: summarizeDeepResearchProgress(progress, toolState, lastExtract) };
    if (progress.looksRateLimited) return { status: 'rate_limited', elapsed, last: summarizeDeepResearchProgress(progress, toolState, lastExtract) };

    const hasToolMessages = !!(toolState && toolState.ok && toolState.hasMessages);
    const waitingForPlan = progress.status === 'waiting_for_user_response_on_plan' && !hasToolMessages;
    const shouldAdvance = (waitingForPlan || deepResearchHasAdvanceControl(progress)) && elapsed - lastStartAttemptAt >= 15 && !hasToolMessages;
    if (shouldAdvance) {
      log('Deep research is waiting for plan confirmation; starting research via skip_sleep...');
      startAttempt = await startDeepResearchNow(session, progress);
      lastStartAttemptAt = elapsed;
      if (startAttempt.ok) log(`Deep research plan confirmed (${startAttempt.method || 'unknown'})`);
      else log(`Deep research plan confirmation did not complete automatically: ${startAttempt.error || startAttempt.reason || 'unknown'}`);
      await sleep(1200);
    }

    const effectiveStatus = (
      (toolState && toolState.completed) ? 'completed' :
      (toolState && toolState.status) ||
      (hasToolMessages && progress.status === 'waiting_for_user_response_on_plan' ? 'researching' : '') ||
      progress.status ||
      ''
    );
    const completed = !!(progress.completed || progress.status === 'completed' || (toolState && toolState.completed));
    const shouldTryExport =
      !!progress.sessionId &&
      (completed ||
        (hasToolMessages && (!lastExtract || elapsed - lastExportAttemptAt >= 30)) ||
        (toolState && toolState.terminal && !lastExtract));

    if (shouldTryExport) {
      lastExportAttemptAt = elapsed;
      lastExtract = await extractDeepResearchReport(session, progress);
      const text = lastExtract.text || '';
      if (text.trim() && text.trim().length >= minChars) {
        return {
          status: 'complete',
          elapsed,
          length: text.length,
          stableFor: 0,
          minChars,
          widgetStatus: effectiveStatus || 'completed',
          sessionId: progress.sessionId || '',
          plan: plan || null,
          export: lastExtract.deepResearch && lastExtract.deepResearch.export || null,
          last: summarizeDeepResearchProgress(progress, toolState, lastExtract),
        };
      }
    }

    const lowerStatus = String(effectiveStatus || '').toLowerCase();
    if (lowerStatus && isDeepResearchTerminalStatus(lowerStatus) && lowerStatus !== 'completed') {
      return {
        status: lowerStatus,
        elapsed,
        widgetStatus: effectiveStatus || '',
        sessionId: progress.sessionId || '',
        plan: plan || null,
        last: summarizeDeepResearchProgress(progress, toolState, lastExtract),
      };
    }

    const need = waitingForPlan
      ? 'plan-confirmation'
      : completed
        ? `exported-report>=${minChars}`
        : hasToolMessages
          ? `running/export-probe>=${minChars}`
          : 'completed-report';
    const getState = toolState && toolState.ok
      ? `get_state=${toolState.status || 'unknown'} msg=${toolState.messageCount || 0}`
      : toolState && toolState.error
        ? `get_state_error=${toolState.error.slice(0, 120)}`
        : 'get_state=unavailable';
    emitWaitProgress(config, {
      status: 'waiting',
      elapsed,
      widgetStatus: effectiveStatus || progress.status || '',
      sessionId: progress.sessionId || '',
      length: lastExtract && lastExtract.text ? lastExtract.text.length : 0,
      need,
      plan: plan || null,
      last: summarizeDeepResearchProgress(progress, toolState, lastExtract),
    });

    if (elapsed - lastReport >= 30) {
      log(`[${elapsed}s] deep-research status=${effectiveStatus || progress.status || 'unknown'} top=${progress.status || 'unknown'} ${getState} session=${progress.sessionId || 'none'} iframe=${progress.iframe && progress.iframe.visible ? 1 : 0} exported=${lastExtract && lastExtract.text ? lastExtract.text.length : 0} need=${need}`);
      lastReport = elapsed;
    }

    if (elapsed >= maxWaitSec) break;
    lastRefreshAt = await maybeRefreshWaitPage(session, config, {
      elapsed,
      lastRefreshAt,
      kind: 'deep-research',
      need,
      last: summarizeDeepResearchProgress(progress, toolState, lastExtract),
    });
    await sleep(Math.min(intervalSec, Math.max(1, maxWaitSec - elapsed)) * 1000);
  }

  return { status: 'timeout', elapsed: maxWaitSec, last: summarizeDeepResearchProgress(lastProgress, lastToolState, lastExtract) };
}

function summarizeDeepResearchProgress(progress, toolState, extract) {
  return {
    status: (progress && progress.status) || '',
    toolStatus: (toolState && toolState.status) || '',
    toolMessageCount: (toolState && toolState.messageCount) || 0,
    toolStateError: (toolState && toolState.error) || '',
    completed: !!(progress && progress.completed),
    terminal: !!(progress && progress.terminal),
    sessionId: (progress && progress.sessionId) || '',
    widgetSessionId: (progress && progress.widgetSessionId) || '',
    hasPlan: !!(progress && progress.plan),
    plan: (progress && progress.plan) || null,
    iframe: (progress && progress.iframe) || null,
    exportError: extract && extract.error || '',
    exportedLength: extract && extract.text ? extract.text.length : 0,
    url: (progress && progress.url) || '',
  };
}

function summarizeProgress(page, criteria) {
  const text = (page && page.lastAssistantText) || '';
  return {
    assistantCount: (page && page.assistantCount) || 0,
    lastAssistantLen: text.length,
    busy: !!(page && page.busy),
    copyCount: (page && page.copyCount) || 0,
    hasNewAssistant: criteria.requireNewAssistant
      ? ((page && page.assistantCount) || 0) > criteria.assistantBefore
      : ((page && page.assistantCount) || 0) > 0,
    url: (page && page.url) || '',
  };
}

function summarizeImageProgress(page, criteria) {
  const images = (page && page.lastAssistantImages) || [];
  return {
    assistantCount: (page && page.assistantCount) || 0,
    imageCount: images.length,
    requiredImages: criteria.requiredImages,
    busy: !!(page && page.busy),
    copyCount: (page && page.copyCount) || 0,
    hasNewAssistant: criteria.requireNewAssistant
      ? ((page && page.assistantCount) || 0) > criteria.assistantBefore
      : ((page && page.assistantCount) || 0) > 0,
    images: images.map((img) => ({
      width: img.width || 0,
      height: img.height || 0,
      complete: !!img.complete,
      srcHint: String(img.src || '').slice(0, 120),
    })),
    url: (page && page.url) || '',
  };
}

function waitCriteriaFromState(state, opts) {
  const sendData = state.stages && state.stages.send && state.stages.send.data;
  const assistantBefore = sendData && Number.isFinite(sendData.assistantBefore) ? sendData.assistantBefore : null;
  return {
    assistantBefore,
    requireNewAssistant: assistantBefore !== null,
    minChars: Math.max(0, Number.isFinite(opts.minChars) ? opts.minChars : DEFAULT_MIN_RESPONSE_CHARS),
    stableSec: Math.max(0, Number.isFinite(opts.stableSec) ? opts.stableSec : DEFAULT_STABLE_SECONDS),
  };
}

function imageWaitCriteriaFromState(state, opts) {
  const sendData = state.stages && state.stages.send && state.stages.send.data;
  const assistantBefore = sendData && Number.isFinite(sendData.assistantBefore) ? sendData.assistantBefore : null;
  return {
    assistantBefore,
    requireNewAssistant: assistantBefore !== null,
    requiredImages: 1,
    stableSec: Math.max(0, Number.isFinite(opts.stableSec) ? opts.stableSec : DEFAULT_STABLE_SECONDS),
  };
}

async function waitForCompletion(session, config) {
  const maxWaitSec = Math.max(0, config.maxWaitSec);
  const intervalSec = Math.max(1, config.intervalSec);
  const criteria = {
    assistantBefore: Number.isFinite(config.assistantBefore) ? config.assistantBefore : null,
    requireNewAssistant: !!config.requireNewAssistant,
    minChars: Math.max(0, config.minChars),
    stableSec: Math.max(0, config.stableSec),
  };
  const start = Date.now();
  let lastReport = 0;
  let prevSig = '';
  let stableSince = Date.now();
  let lastPage = null;
  let lastRefreshAt = 0;
  while (true) {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    const page = await getConversationProgress(session);
    lastPage = page;
    const hasNewAssistant = criteria.requireNewAssistant
      ? (page.assistantCount || 0) > criteria.assistantBefore
      : (page.assistantCount || 0) > 0;
    const text = page.lastAssistantText || '';
    const substantive = hasNewAssistant && isSubstantiveAssistantText(text, criteria.minChars);
    const generating = !!page.busy || (page.stopCount || 0) > 0;
    const sig = `${page.assistantCount || 0}:${textSignature(text)}`;
    if (sig !== prevSig) {
      prevSig = sig;
      stableSince = Date.now();
    }
    const stableFor = Math.floor((Date.now() - stableSince) / 1000);

    const need = !hasNewAssistant
      ? 'new-assistant'
      : !substantive
        ? `substantive-text>=${criteria.minChars}`
        : generating
          ? 'generation-stop'
          : `stable ${stableFor}/${criteria.stableSec}s`;
    emitWaitProgress(config, {
      status: 'waiting',
      elapsed,
      assistantCount: page.assistantCount || 0,
      length: text.length,
      busy: generating,
      stableFor,
      need,
      last: summarizeProgress(lastPage, criteria),
    });

    if (elapsed - lastReport >= 30) {
      log(`[${elapsed}s] assistant=${page.assistantCount || 0} len=${text.length} busy=${generating ? 1 : 0} copy=${page.copyCount || 0} need=${need}`);
      lastReport = elapsed;
    }

    if (page.looksLikeLogin && !page.hasInput) {
      return { status: 'login_required', elapsed };
    }
    if (page.looksRateLimited) {
      return { status: 'rate_limited', elapsed };
    }

    if (substantive && !generating && stableFor >= criteria.stableSec) {
      return {
        status: 'complete',
        elapsed,
        length: text.length,
        assistantCount: page.assistantCount || 0,
        stableFor,
        minChars: criteria.minChars,
        url: page.url || '',
      };
    }

    if (elapsed >= maxWaitSec) break;
    lastRefreshAt = await maybeRefreshWaitPage(session, config, {
      elapsed,
      lastRefreshAt,
      kind: 'text',
      need,
      last: summarizeProgress(lastPage, criteria),
    });
    await sleep(Math.min(intervalSec, Math.max(1, maxWaitSec - elapsed)) * 1000);
  }
  return { status: 'timeout', elapsed: maxWaitSec, last: summarizeProgress(lastPage, criteria) };
}

async function waitForImageCompletion(session, config) {
  const maxWaitSec = Math.max(0, config.maxWaitSec);
  const intervalSec = Math.max(1, config.intervalSec);
  const criteria = {
    assistantBefore: Number.isFinite(config.assistantBefore) ? config.assistantBefore : null,
    requireNewAssistant: !!config.requireNewAssistant,
    requiredImages: Math.max(1, Number.isFinite(config.requiredImages) ? config.requiredImages : DEFAULT_IMAGE_COUNT),
    stableSec: Math.max(0, config.stableSec),
  };
  const start = Date.now();
  let lastReport = 0;
  let prevSig = '';
  let stableSince = Date.now();
  let lastPage = null;
  let lastRefreshAt = 0;
  while (true) {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    const page = await getConversationProgress(session);
    lastPage = page;
    const hasNewAssistant = criteria.requireNewAssistant
      ? (page.assistantCount || 0) > criteria.assistantBefore
      : (page.assistantCount || 0) > 0;
    const images = page.lastAssistantImages || [];
    const imageCount = images.length;
    const imagesReady = hasNewAssistant &&
      imageCount >= criteria.requiredImages &&
      images.slice(0, criteria.requiredImages).every((img) => img.ready !== false);
    const generating = !!page.busy || (page.stopCount || 0) > 0;
    const sig = `${page.assistantCount || 0}:${page.lastAssistantImageSignature || ''}`;
    if (sig !== prevSig) {
      prevSig = sig;
      stableSince = Date.now();
    }
    const stableFor = Math.floor((Date.now() - stableSince) / 1000);

    const need = !hasNewAssistant
      ? 'new-assistant'
      : imageCount < criteria.requiredImages
        ? `images>=${criteria.requiredImages}`
        : !imagesReady
          ? 'images-loaded'
          : generating
            ? 'generation-stop'
            : `stable ${stableFor}/${criteria.stableSec}s`;
    emitWaitProgress(config, {
      status: 'waiting',
      elapsed,
      assistantCount: page.assistantCount || 0,
      imageCount,
      requiredImages: criteria.requiredImages,
      busy: generating,
      stableFor,
      need,
      last: summarizeImageProgress(lastPage, criteria),
    });

    if (elapsed - lastReport >= 30) {
      log(`[${elapsed}s] assistant=${page.assistantCount || 0} images=${imageCount} busy=${generating ? 1 : 0} copy=${page.copyCount || 0} need=${need}`);
      lastReport = elapsed;
    }

    if (page.looksLikeLogin && !page.hasInput) {
      return { status: 'login_required', elapsed };
    }
    if (page.looksRateLimited) {
      return { status: 'rate_limited', elapsed };
    }

    if (imagesReady && !generating && stableFor >= criteria.stableSec) {
      return {
        status: 'complete',
        elapsed,
        imageCount,
        images,
        assistantCount: page.assistantCount || 0,
        stableFor,
        url: page.url || '',
      };
    }

    if (elapsed >= maxWaitSec) break;
    lastRefreshAt = await maybeRefreshWaitPage(session, config, {
      elapsed,
      lastRefreshAt,
      kind: 'image',
      need,
      last: summarizeImageProgress(lastPage, criteria),
    });
    await sleep(Math.min(intervalSec, Math.max(1, maxWaitSec - elapsed)) * 1000);
  }
  return { status: 'timeout', elapsed: maxWaitSec, last: summarizeImageProgress(lastPage, criteria) };
}

async function extractLastAssistant(session, criteria = {}) {
  const minAssistantIndex = Number.isFinite(criteria.assistantBefore) ? criteria.assistantBefore : null;
  const code = `(() => {
    const msgs = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
    if (!msgs.length) {
      const alt = [...document.querySelectorAll('.markdown, .prose')];
      if (alt.length) {
        const t = alt[alt.length - 1].innerText || '';
        return JSON.stringify({ len: t.length, text: t, assistantCount: 0, fallback: true });
      }
      return JSON.stringify({ error: 'no_messages', assistantCount: 0 });
    }
    const minIndex = ${minAssistantIndex === null ? 'null' : JSON.stringify(minAssistantIndex)};
    if (minIndex !== null && msgs.length <= minIndex) {
      return JSON.stringify({ error: 'no_new_assistant', assistantCount: msgs.length, minIndex });
    }
    const last = msgs[msgs.length - 1];
    const t = last.innerText || '';
    return JSON.stringify({ len: t.length, text: t, assistantCount: msgs.length, index: msgs.length - 1 });
  })()`;
  const v = await evaluate(session, code);
  if (!v) return { text: '', error: 'no_value' };
  if (typeof v === 'string') return { text: v };
  return { text: v.text || '', len: v.len, error: v.error, assistantCount: v.assistantCount, index: v.index };
}

async function extractLastAssistantImages(session, criteria = {}, maxImages = DEFAULT_MAX_IMAGES) {
  const minAssistantIndex = Number.isFinite(criteria.assistantBefore) ? criteria.assistantBefore : null;
  const cappedMax = Math.max(1, Math.min(32, Number.isFinite(maxImages) ? maxImages : DEFAULT_MAX_IMAGES));
  const code = `(async () => {
    ${IMAGE_COLLECTOR_JS}
    const msgs = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
    const users = [...document.querySelectorAll('[data-message-author-role="user"]')];
    const imageRoots = [...document.querySelectorAll('[class*="group/imagegen-image"]')];
    const effectiveCount = msgs.length || (imageRoots.length ? Math.max(users.length, imageRoots.length) : 0);
    if (!msgs.length && !imageRoots.length) return JSON.stringify({ error: 'no_messages', assistantCount: 0, images: [] });
    const minIndex = ${minAssistantIndex === null ? 'null' : JSON.stringify(minAssistantIndex)};
    if (minIndex !== null && effectiveCount <= minIndex) {
      return JSON.stringify({ error: 'no_new_assistant', assistantCount: effectiveCount, minIndex, images: [] });
    }
    const last = msgs[msgs.length - 1] || imageRoots[imageRoots.length - 1];
    const nodes = [...last.querySelectorAll('img')];
    const candidates = collectMeaningfulImages(last).slice(0, ${JSON.stringify(cappedMax)});
    const bytesToBase64 = (bytes) => {
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    };
    const readImage = async (meta) => {
      const img = nodes[meta.index];
      const src = meta.src || (img && (img.currentSrc || img.src || img.getAttribute('src'))) || '';
      let dataUrl = '';
      let mimeType = '';
      let bytes = 0;
      let error = '';
      try {
        if (/^data:/i.test(src)) {
          dataUrl = src;
          const match = src.match(/^data:([^;,]+)/i);
          mimeType = match ? match[1] : '';
          bytes = Math.floor((src.length * 3) / 4);
        } else if (src) {
          const response = await fetch(src, { credentials: 'include', cache: 'force-cache' });
          if (!response.ok) throw new Error('fetch ' + response.status);
          const blob = await response.blob();
          const arrayBuffer = await blob.arrayBuffer();
          const byteArray = new Uint8Array(arrayBuffer);
          mimeType = blob.type || response.headers.get('content-type') || '';
          bytes = byteArray.byteLength;
          dataUrl = 'data:' + (mimeType || 'application/octet-stream') + ';base64,' + bytesToBase64(byteArray);
        }
      } catch (e) {
        error = e && e.message ? e.message : String(e);
      }
      return { ...meta, src, dataUrl, mimeType, bytes, error };
    };
    const images = [];
    for (const candidate of candidates) {
      images.push(await readImage(candidate));
    }
    return JSON.stringify({
      assistantCount: effectiveCount,
      assistantRoleCount: msgs.length,
      imageRootCount: imageRoots.length,
      index: effectiveCount - 1,
      url: location.href,
      images
    });
  })()`;
  const v = await evaluate(session, code);
  if (!v) return { images: [], error: 'no_value' };
  if (typeof v === 'string') return { images: [], error: v };
  return {
    images: Array.isArray(v.images) ? v.images : [],
    error: v.error,
    assistantCount: v.assistantCount,
    assistantRoleCount: v.assistantRoleCount,
    imageRootCount: v.imageRootCount,
    index: v.index,
    url: v.url,
  };
}

function sanitizeFileComponent(value, fallback) {
  const clean = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return clean || fallback;
}

function mimeToExt(mimeType, fallback = 'png') {
  const mime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/avif') return 'avif';
  if (mime === 'image/svg+xml') return 'svg';
  return fallback;
}

function compactSource(src) {
  const value = String(src || '');
  if (/^data:/i.test(value)) {
    const header = value.slice(0, Math.min(value.indexOf(',') + 1 || 80, 120));
    return `${header}...(${value.length} chars)`;
  }
  if (value.length > 500) return `${value.slice(0, 220)}...${value.slice(-220)}`;
  return value;
}

function parseDataUrl(dataUrl) {
  const raw = String(dataUrl || '');
  const b64 = raw.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/is);
  if (b64) {
    return {
      buffer: Buffer.from(b64[2], 'base64'),
      mimeType: b64[1] || '',
    };
  }
  const plain = raw.match(/^data:([^;,]+)?(?:;[^,]*)?,(.*)$/is);
  if (plain) {
    return {
      buffer: Buffer.from(decodeURIComponent(plain[2]), 'utf8'),
      mimeType: plain[1] || '',
    };
  }
  return null;
}

function uniquePath(dir, fileName) {
  const parsed = path.parse(fileName);
  let candidate = path.join(dir, fileName);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${parsed.name}-${n}${parsed.ext}`);
    n += 1;
  }
  return candidate;
}

async function downloadImageFromUrl(url) {
  if (typeof fetch !== 'function') throw new Error('Node fetch is unavailable');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const mimeType = response.headers.get('content-type') || '';
  return { buffer, mimeType };
}

async function saveExtractedImages(state, opts, extracted) {
  const dir = path.resolve(opts.imageDir || state.imageDir || DEFAULT_IMAGE_DIR);
  const prefix = sanitizeFileComponent(
    opts.imagePrefix || state.imagePrefix || `gpt-image-${state.createdAt || Date.now()}`,
    `gpt-image-${Date.now()}`
  );
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  const failed = [];
  const images = Array.isArray(extracted.images) ? extracted.images : [];

  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    try {
      let parsed = image.dataUrl ? parseDataUrl(image.dataUrl) : null;
      let mimeType = (parsed && parsed.mimeType) || image.mimeType || '';
      if (!parsed && /^https?:\/\//i.test(image.src || '')) {
        const downloaded = await downloadImageFromUrl(image.src);
        parsed = { buffer: downloaded.buffer, mimeType: downloaded.mimeType };
        mimeType = downloaded.mimeType || mimeType;
      }
      if (!parsed || !parsed.buffer || !parsed.buffer.length) {
        throw new Error(image.error || 'image bytes unavailable');
      }
      if (mimeType && !/^image\//i.test(mimeType)) {
        throw new Error(`non-image content-type: ${mimeType}`);
      }
      const ext = mimeToExt(mimeType || image.mimeType);
      const filePath = uniquePath(dir, `${prefix}-${String(saved.length + 1).padStart(2, '0')}.${ext}`);
      fs.writeFileSync(filePath, parsed.buffer);
      saved.push({
        path: filePath,
        bytes: parsed.buffer.length,
        mimeType: mimeType || image.mimeType || '',
        width: image.width || 0,
        height: image.height || 0,
        src: compactSource(image.src),
      });
      log(`saved image -> ${filePath}`);
    } catch (e) {
      failed.push({
        index: i,
        src: compactSource(image.src),
        width: image.width || 0,
        height: image.height || 0,
        error: e.message,
      });
    }
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    session: state.session,
    conversationUrl: extracted.url || state.conversationUrl || '',
    prompt: state.prompt || '',
    imageDir: dir,
    images: saved,
    failed,
  };
  const manifestPath = uniquePath(dir, `${prefix}-manifest.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  log(`image manifest -> ${manifestPath}`);
  return { dir, manifestPath, images: saved, failed };
}

function parseJsonOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new Error('child produced no stdout');
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.lastIndexOf('\n{');
  if (start >= 0) {
    try { return JSON.parse(text.slice(start + 1)); } catch {}
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch {}
  }
  throw new Error(`child stdout was not JSON: ${text.slice(0, 240)}`);
}

function prefixedChildLog(label, text) {
  const lines = String(text || '').split(/\r?\n/).filter(Boolean);
  for (const line of lines) log(`[${label}] ${line}`);
}

function buildImageChildArgs(opts, job, prompt) {
  const args = [
    __filename,
    '-s', job.session,
    'image',
    '--json',
    '--image-count', '1',
    '--max-images', '1',
    '--model', normalizeModelName(opts.model || DEFAULT_IMAGE_MODEL),
    '--image-prefix', job.prefix,
  ];
  if (opts.imageDir) args.push('--image-dir', opts.imageDir);
  if (opts.waitForever) args.push('--until-complete');
  else if (Number.isFinite(opts.wait)) args.push('--wait', String(opts.wait));
  if (Number.isFinite(opts.interval)) args.push('--interval', String(opts.interval));
  if (Number.isFinite(opts.refreshSec)) args.push('--refresh', String(opts.refreshSec));
  if (Number.isFinite(opts.stableSec)) args.push('--stable', String(opts.stableSec));
  if (opts.resume) args.push('--resume');
  if (opts.keepSession) args.push('--keep-session');
  if (opts.cleanupState) args.push('--cleanup-state');
  if (opts.toolExplicit) args.push('--tool', normalizeToolName(opts.tool));
  if (opts.uploadSelector && opts.uploadSelector !== DEFAULT_UPLOAD_SELECTOR) args.push('--upload-selector', opts.uploadSelector);
  if (Number.isFinite(opts.uploadWait)) args.push('--upload-wait', String(opts.uploadWait));
  for (const file of normalizeUploadFiles(opts.uploads || [])) args.push('--upload', file);
  args.push('--', prompt);
  return args;
}

function runImageChild(job, opts, prompt) {
  return new Promise((resolve) => {
    const args = buildImageChildArgs(opts, job, prompt);
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      prefixedChildLog(job.label, text);
    });
    child.on('error', (error) => {
      resolve({
        ok: false,
        index: job.index,
        session: job.session,
        prefix: job.prefix,
        error: error.message,
        stderr,
      });
    });
    child.on('close', (code) => {
      let data = null;
      let parseError = '';
      try { data = parseJsonOutput(stdout); } catch (e) { parseError = e.message; }
      const images = data && Array.isArray(data.images) ? data.images : [];
      const ok = code === 0 && data && data.ok !== false && images.length > 0;
      resolve({
        ok,
        index: job.index,
        session: job.session,
        prefix: job.prefix,
        exitCode: code,
        output: data && data.output || null,
        images,
        data,
        error: ok ? '' : (data && (data.message || data.error) || parseError || (images.length ? `child exited ${code}` : 'child returned no images')),
        stderr,
      });
    });
  });
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function loop() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, loop);
  await Promise.all(workers);
  return results;
}

async function runParallelImageGeneration(state, opts, prompt) {
  const requested = Math.max(1, Number.isFinite(opts.imageCount) ? opts.imageCount : DEFAULT_IMAGE_COUNT);
  const concurrency = Math.max(1, Math.min(3, Number.isFinite(opts.imageConcurrency) ? opts.imageConcurrency : DEFAULT_IMAGE_CONCURRENCY));
  const dir = path.resolve(opts.imageDir || state.imageDir || DEFAULT_IMAGE_DIR);
  const basePrefix = sanitizeFileComponent(
    opts.imagePrefix || state.imagePrefix || `gpt-image-${state.createdAt || Date.now()}`,
    `gpt-image-${Date.now()}`
  );
  fs.mkdirSync(dir, { recursive: true });

  const jobs = Array.from({ length: requested }, (_, i) => {
    const num = String(i + 1).padStart(2, '0');
    return {
      index: i,
      label: `image-${num}`,
      session: `${state.session}-image-${num}`,
      prefix: `${basePrefix}-${num}`,
    };
  });

  log(`parallel image generation: ${requested} image(s), concurrency=${concurrency}, one ChatGPT conversation per image`);
  const results = await runWithConcurrency(jobs, concurrency, async (job) => {
    log(`[${job.label}] starting session=${job.session}`);
    const result = await runImageChild(job, { ...opts, imageCount: 1, maxImages: 1 }, prompt);
    if (result.ok) log(`[${job.label}] done (${result.images.length} image)`);
    else log(`[${job.label}] failed: ${result.error}`);
    return result;
  });

  const images = [];
  const failed = [];
  const childManifests = [];
  for (const result of results) {
    if (result.output) childManifests.push({ session: result.session, path: result.output });
    if (result.ok) {
      for (const image of result.images || []) {
        images.push({
          ...image,
          session: result.session,
          jobIndex: result.index + 1,
        });
      }
    } else {
      failed.push({
        session: result.session,
        jobIndex: result.index + 1,
        exitCode: result.exitCode,
        error: result.error,
        output: result.output,
      });
    }
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    parallel: true,
    session: state.session,
    requestedImageCount: requested,
    imageConcurrency: concurrency,
    oneConversationPerImage: true,
    prompt,
    imageDir: dir,
    images,
    failed,
    childManifests,
    jobs: results.map((result) => ({
      session: result.session,
      jobIndex: result.index + 1,
      ok: result.ok,
      output: result.output,
      imageCount: (result.images || []).length,
      error: result.error || '',
    })),
  };
  const manifestPath = uniquePath(dir, `${basePrefix}-parallel-manifest.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  const data = {
    imageCount: images.length,
    requestedImageCount: requested,
    failedCount: failed.length,
    dir,
    manifestPath,
    images,
    failed,
    childManifests,
    imageConcurrency: concurrency,
  };
  state.output = manifestPath;
  state.images = images;
  state.parallelImages = data;
  saveState(state);
  if (opts.cleanupState) {
    const p = statePath(state.session);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  return {
    ok: failed.length === 0,
    parallel: true,
    session: state.session,
    output: manifestPath,
    imageCount: images.length,
    requestedImageCount: requested,
    failedCount: failed.length,
    imageConcurrency: concurrency,
    images,
    failed,
    childManifests,
  };
}

// --- Sub-command pipeline ---------------------------------------------------

const PIPELINE = ['open', 'loginCheck', 'ensureModel', 'ensureTool', 'upload', 'send', 'wait', 'extract'];
const IMAGE_PIPELINE = ['open', 'loginCheck', 'ensureModel', 'ensureTool', 'upload', 'send', 'wait', 'extractImages'];

async function runPipeline(state, opts, pipeline = PIPELINE) {
  const results = {};
  // dry-run stops after model selection unless a tool target was requested,
  // in which case it also verifies the ChatGPT tool selector.
  const dryRunStop = opts.toolExplicit ? 'ensureTool' : 'ensureModel';
  const stages = opts.dryRun ? pipeline.slice(0, pipeline.indexOf(dryRunStop) + 1) : pipeline;
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
  ensureTool: stageEnsureTool,
  upload: stageUpload,
  send: stageSend,
  wait: stageWait,
  extract: stageExtract,
  extractImages: stageExtractImages,
};

// Map kebab-case subcommand names to stage function keys.
const SUBCOMMAND_TO_STAGE = {
  open: 'open',
  'login-check': 'loginCheck',
  'ensure-model': 'ensureModel',
  'ensure-tool': 'ensureTool',
  upload: 'upload',
  send: 'send',
  wait: 'wait',
  extract: 'extract',
  'extract-images': 'extractImages',
};

// --- CLI --------------------------------------------------------------------

const RESEARCH_SUBCOMMANDS = new Set(['research', 'deep-research', 'deep-search']);
const SUBCOMMANDS = ['run', 'research', 'deep-research', 'deep-search', 'image', 'open', 'login-check', 'ensure-model', 'ensure-tool', 'upload', 'send', 'wait', 'extract', 'extract-images', 'latest', 'doctor', 'status', 'cleanup'];

function printHelp() {
  process.stdout.write(`search.js - drive ChatGPT Pro via kimi-webbridge (stateful, resumable)

Usage:
  search.js [global-flags] [SUBCOMMAND] [args...]

Sub-commands:
  run [prompt...]      All stages in order (default if no subcommand given)
  research [prompt...] Agent-safe Deep research: select tool, confirm plan,
                       wait until full report export, save + print it
  deep-research [...]  Alias for research
  deep-search [...]    Alias for research
  image [prompt...]    Generate image(s) in ChatGPT and save them locally
  open                 Open a ChatGPT tab (or reuse an existing one)
  login-check          Detect whether ChatGPT is logged in
  ensure-model [tgt]   Verify / switch model. tgt: auto|pro|extended|thinking|think|instant
  ensure-tool [tgt]    Verify / switch ChatGPT tool. tgt: auto|none|deep-research|web-search|create-image
  upload               Upload --upload file(s) into the composer
  send [prompt...]     Fill the input and click send
  wait                 Poll until response completes
  extract              Pull the last assistant message to --output
  extract-images       Save generated image(s) from the latest assistant message
  latest               Recover this --session, wait for the latest complete reply,
                       save it, print it, and close the tab unless --keep-session
  doctor               Verify WebBridge, ChatGPT login, and research tool selectors
                       (closes the tab on success unless --keep-session)
  status               Print session state and exit
  cleanup              Close the session tab

Global flags (can appear before or after the subcommand):
  -s, --session NAME   Session name (default: gpt-pro-<timestamp>)
  -o, --output PATH    Output file (default: ./gpt-pro-response-<ts>.md)
  -m, --model NAME     Target model: auto|pro|extended|extended-pro|thinking|think|instant
                       (default: auto; image defaults to ${DEFAULT_IMAGE_MODEL})
      --tool NAME      Target ChatGPT tool: auto|none|deep-research|deep-search|web-search|create-image
      --deep-research  Select ChatGPT's Deep research tool before sending
      --deep-search    Alias for --deep-research
      --web-search     Select ChatGPT's Web search tool before sending
  -w, --wait SECONDS   Max wait for response (default: ${DEFAULT_WAIT_SECONDS})
                       Deep research default: ${DEFAULT_DEEP_RESEARCH_WAIT_SECONDS}
      --until-complete Keep polling until the reply/report is complete; overrides
                       --wait and leaves progress in the state file
                       (aliases: --wait-forever, --hang)
  -i, --interval SEC   Poll interval (default: ${DEFAULT_INTERVAL_SECONDS})
      --refresh SEC    Refresh the same ChatGPT tab during wait (default: ${DEFAULT_WAIT_REFRESH_SECONDS}; 0 disables)
      --min-chars N    Min assistant chars before "complete" (default: ${DEFAULT_MIN_RESPONSE_CHARS}; use 0 for terse answers)
      --stable SEC     Assistant text must be unchanged this long (default: ${DEFAULT_STABLE_SECONDS})
      --upload PATH    Upload a local file before sending (repeatable)
      --upload-selector CSS
                       File input selector (default: ${DEFAULT_UPLOAD_SELECTOR})
      --upload-wait SEC
                       Seconds to wait for attachment chips (default: ${DEFAULT_UPLOAD_WAIT_SECONDS})
      --image          Image mode for run/latest/wait (alias for the image flow)
      --image-dir DIR  Directory for saved generated images (default: ./${DEFAULT_IMAGE_DIR})
      --image-prefix P Filename prefix for saved images (default: gpt-image-<createdAt>)
      --image-count N  Total images to generate. Uses one ChatGPT conversation
                       per image; default: ${DEFAULT_IMAGE_COUNT}
      --image-concurrency N
                       Parallel image conversations, capped at ${DEFAULT_IMAGE_CONCURRENCY}
      --max-images N   Max image candidates to extract/save (default: ${DEFAULT_MAX_IMAGES})
      --resume         Skip stages already marked done in state file
      --keep-session   Do not close the browser tab when finished
  -C, --continue       Send a follow-up turn in the same ChatGPT conversation
                        (reuses the tab, keeps session open, re-runs send/wait/extract,
                        saves to gpt-pro-response-<ts>-turn-<N>.md)
      --fresh          Skip auto-recovery from the conversation history sidebar
                        (start a brand new conversation, even if state has a prior URL)
      --cleanup-state  Delete the state file when finished
      --dry-run        Like run but stop after ensure-model
                       (or ensure-tool when a tool flag is passed);
                       closes the tab unless --keep-session
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
  - Optional uploads run before send and are not reused by a fresh non-resume prompt.
  - For 'send', the stage re-runs if the new prompt differs from the stored one
    (or always re-runs under --continue).
  - state.turns tracks the number of sent turns in the conversation.
  - state.tool records an explicit ChatGPT tool target when requested.

Examples:
  search.js research "Research current competitors and cite sources."
  search.js --until-complete "What is 2+2? Reply with just the number." --min-chars 0
  search.js --model extended --until-complete "Reason about X in deep mode."
  search.js --deep-research --until-complete "Research current competitors and cite sources."
  search.js --deep-search --until-complete "Do a deep market scan."
  search.js --web-search --until-complete "Find the latest release notes."
  search.js -f ./prompt.md -o ./answer.md --json
  search.js --status
  search.js --dry-run --model extended
  search.js open
  search.js ensure-model extended
  search.js ensure-tool deep-research
  search.js --upload ./brief.pdf --until-complete "Summarize this file."
  search.js --upload ./a.pdf --upload ./b.csv --until-complete "Compare these files."
  search.js send "now actually send it"
  search.js --resume --until-complete # pick up where a previous run left off
  search.js --resume --wait 1800    # resume with longer timeout
  search.js -s my-thread latest --until-complete # wait for and print latest complete reply
  search.js -s my-thread latest --wait 0 --stable 0 --json  # check current readiness only
  search.js image --until-complete "Create a square watercolor icon of a tiny robot reading."
  search.js image --model think --until-complete "Create a detailed isometric app icon."
  search.js image --until-complete --image-count 5 --image-concurrency 3 "Create five distinct app icon concepts."
  search.js --image --model instant --until-complete "Create a product hero image." --image-dir ./assets/generated
  search.js -s my-thread latest --image --until-complete --image-dir ./assets/generated

  # Multi-turn conversation (keeps context between prompts)
  search.js -s my-thread --until-complete "Explain quantum entanglement in one paragraph."
  search.js -s my-thread --continue --until-complete "Now give me a concrete example."
  search.js -s my-thread --continue --until-complete "How would you test this experimentally?"
`);
}

function parseArgs(argv) {
  const opts = {
    subcommand: 'run',
    subcommandArgs: [],
    session: `gpt-pro-${Date.now()}`,
    output: '',
    uploads: [],
    uploadSelector: DEFAULT_UPLOAD_SELECTOR,
    uploadWait: DEFAULT_UPLOAD_WAIT_SECONDS,
    model: 'auto',
    modelExplicit: false,
    tool: DEFAULT_TOOL,
    toolExplicit: false,
    wait: DEFAULT_WAIT_SECONDS,
    waitExplicit: false,
    waitForever: false,
    interval: DEFAULT_INTERVAL_SECONDS,
    refreshSec: DEFAULT_WAIT_REFRESH_SECONDS,
    minChars: DEFAULT_MIN_RESPONSE_CHARS,
    minCharsExplicit: false,
    stableSec: DEFAULT_STABLE_SECONDS,
    imageMode: false,
    imageDir: '',
    imagePrefix: '',
    imageCount: DEFAULT_IMAGE_COUNT,
    imageConcurrency: DEFAULT_IMAGE_CONCURRENCY,
    maxImages: DEFAULT_MAX_IMAGES,
    resume: false,
    keepSession: false,
    continueMode: false,
    fresh: false,
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
    else if (a === '--upload') { opts.uploads.push(argv[++i] || ''); }
    else if (a === '--upload-selector') { opts.uploadSelector = argv[++i] || DEFAULT_UPLOAD_SELECTOR; }
    else if (a === '--upload-wait') { const n = parseInt(argv[++i], 10); if (Number.isFinite(n)) opts.uploadWait = n; }
    else if (a === '--tool') { opts.tool = normalizeToolName(argv[++i] || DEFAULT_TOOL); opts.toolExplicit = true; }
    else if (a === '--deep-research' || a === '--deep-search') { opts.tool = 'deep-research'; opts.toolExplicit = true; }
    else if (a === '--web-search') { opts.tool = 'web-search'; opts.toolExplicit = true; }
    else if (a === '--until-complete' || a === '--wait-forever' || a === '--hang') opts.waitForever = true;
    else if (a === '--image') opts.imageMode = true;
    else if (a === '--continue' || a === '-C') opts.continueMode = true;
    else if (a === '--fresh') opts.fresh = true;
    else if (a === '--cleanup-state') opts.cleanupState = true;
    else if (a === '-f' || a === '--file') { opts.promptFile = argv[++i] || ''; opts.subcommandArgs.push('-f', opts.promptFile); }
    else if (a === '-s' || a === '--session') { opts.session = argv[++i] || opts.session; }
    else if (a === '-o' || a === '--output') { opts.output = argv[++i] || ''; }
    else if (a === '-m' || a === '--model') { opts.model = argv[++i] || 'auto'; opts.modelExplicit = true; }
    else if (a === '-w' || a === '--wait') { const n = parseInt(argv[++i], 10); if (Number.isFinite(n)) { opts.wait = n; opts.waitExplicit = true; } }
    else if (a === '-i' || a === '--interval') { const n = parseInt(argv[++i], 10); if (Number.isFinite(n)) opts.interval = n; }
    else if (a === '--refresh' || a === '--refresh-seconds') { const n = parseInt(argv[++i], 10); if (Number.isFinite(n)) opts.refreshSec = n; }
    else if (a === '--min-chars') { opts.minChars = parseInt(argv[++i], 10); opts.minCharsExplicit = true; if (!Number.isFinite(opts.minChars)) opts.minChars = DEFAULT_MIN_RESPONSE_CHARS; }
    else if (a === '--stable' || a === '--stable-seconds') { opts.stableSec = parseInt(argv[++i], 10); if (!Number.isFinite(opts.stableSec)) opts.stableSec = DEFAULT_STABLE_SECONDS; }
    else if (a === '--image-dir') { opts.imageDir = argv[++i] || ''; }
    else if (a === '--image-prefix') { opts.imagePrefix = argv[++i] || ''; }
    else if (a === '--image-count' || a === '--images') { const n = parseInt(argv[++i], 10); if (Number.isFinite(n)) opts.imageCount = n; }
    else if (a === '--image-concurrency') { const n = parseInt(argv[++i], 10); if (Number.isFinite(n)) opts.imageConcurrency = n; }
    else if (a === '--max-images') { const n = parseInt(argv[++i], 10); if (Number.isFinite(n)) opts.maxImages = n; }
    else if (a === '-') { opts.stdin = true; opts.subcommandArgs.push('-'); }
    else if (a === '--') { i++; while (i < argv.length) { positional.push(argv[i]); i++; } break; }
    else if (a.startsWith('--')) {
      const m = a.match(/^--([a-z-]+)=(.*)$/);
      if (m) {
        const k = m[1], v = m[2];
        if (k === 'file') { opts.promptFile = v; opts.subcommandArgs.push('--file=' + v); }
        else if (k === 'session') opts.session = v;
        else if (k === 'output') opts.output = v;
        else if (k === 'upload') opts.uploads.push(v);
        else if (k === 'upload-selector') opts.uploadSelector = v || DEFAULT_UPLOAD_SELECTOR;
        else if (k === 'upload-wait') { const n = parseInt(v, 10); if (Number.isFinite(n)) opts.uploadWait = n; }
        else if (k === 'tool') { opts.tool = normalizeToolName(v || DEFAULT_TOOL); opts.toolExplicit = true; }
        else if (k === 'deep-research' || k === 'deep-search') { opts.tool = /^(0|false|no)$/i.test(v) ? DEFAULT_TOOL : 'deep-research'; opts.toolExplicit = !/^(0|false|no)$/i.test(v); }
        else if (k === 'web-search') { opts.tool = /^(0|false|no)$/i.test(v) ? DEFAULT_TOOL : 'web-search'; opts.toolExplicit = !/^(0|false|no)$/i.test(v); }
        else if (k === 'until-complete' || k === 'wait-forever' || k === 'hang') opts.waitForever = !/^(0|false|no)$/i.test(v);
        else if (k === 'model') { opts.model = v; opts.modelExplicit = true; }
        else if (k === 'wait') { const n = parseInt(v, 10); if (Number.isFinite(n)) { opts.wait = n; opts.waitExplicit = true; } }
        else if (k === 'interval') { const n = parseInt(v, 10); if (Number.isFinite(n)) opts.interval = n; }
        else if (k === 'refresh' || k === 'refresh-seconds') { const n = parseInt(v, 10); if (Number.isFinite(n)) opts.refreshSec = n; }
        else if (k === 'min-chars') { opts.minChars = parseInt(v, 10); opts.minCharsExplicit = true; if (!Number.isFinite(opts.minChars)) opts.minChars = DEFAULT_MIN_RESPONSE_CHARS; }
        else if (k === 'stable' || k === 'stable-seconds') { opts.stableSec = parseInt(v, 10); if (!Number.isFinite(opts.stableSec)) opts.stableSec = DEFAULT_STABLE_SECONDS; }
        else if (k === 'image') opts.imageMode = !/^(0|false|no)$/i.test(v);
        else if (k === 'image-dir') opts.imageDir = v;
        else if (k === 'image-prefix') opts.imagePrefix = v;
        else if (k === 'image-count' || k === 'images') { const n = parseInt(v, 10); if (Number.isFinite(n)) opts.imageCount = n; }
        else if (k === 'image-concurrency') { const n = parseInt(v, 10); if (Number.isFinite(n)) opts.imageConcurrency = n; }
        else if (k === 'max-images') { const n = parseInt(v, 10); if (Number.isFinite(n)) opts.maxImages = n; }
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
        else if (ch === 'C') opts.continueMode = true;
        else if (ch === 'f') { opts.promptFile = argv[++i] || ''; opts.subcommandArgs.push('-f', opts.promptFile); consumed = true; break; }
        else if (ch === 's') { opts.session = argv[++i] || opts.session; consumed = true; break; }
        else if (ch === 'o') { opts.output = argv[++i] || ''; consumed = true; break; }
        else if (ch === 'm') { opts.model = argv[++i] || 'auto'; opts.modelExplicit = true; consumed = true; break; }
        else if (ch === 'w') { const n = parseInt(argv[++i], 10); if (Number.isFinite(n)) { opts.wait = n; opts.waitExplicit = true; } consumed = true; break; }
        else if (ch === 'i') { const n = parseInt(argv[++i], 10); if (Number.isFinite(n)) opts.interval = n; consumed = true; break; }
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
  if (RESEARCH_SUBCOMMANDS.has(opts.subcommand)) {
    opts.researchMode = true;
    opts.subcommand = 'run';
    opts.tool = 'deep-research';
    opts.toolExplicit = true;
    opts.waitForever = true;
  }
  if (opts.subcommand === 'image' || opts.subcommand === 'extract-images') opts.imageMode = true;
  if (opts.imageMode && opts.subcommand === 'run') opts.subcommand = 'image';
  if (opts.subcommand === 'image' && !opts.modelExplicit) opts.model = DEFAULT_IMAGE_MODEL;
  opts.tool = normalizeToolName(opts.tool);
  if (opts.tool === 'deep-research' && !opts.waitExplicit) opts.wait = DEFAULT_DEEP_RESEARCH_WAIT_SECONDS;
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
    state = newState(opts.session, {
      output: opts.output,
      uploads: opts.uploads,
      uploadSelector: opts.uploadSelector,
      imageDir: opts.imageDir,
      imagePrefix: opts.imagePrefix,
      model: normalizeModelName(opts.model),
      tool: opts.tool,
    });
  }
  if (!state.tool) state.tool = DEFAULT_TOOL;
  if (opts.output) state.output = opts.output;
  if (!opts.resume && ['send', 'run', 'image'].includes(opts.subcommand) && !opts.uploads.length && state.uploads && state.uploads.length) {
    state.uploads = [];
    clearStage(state, 'upload');
  }
  if (opts.uploads.length) {
    const nextUploads = normalizeUploadFiles(opts.uploads);
    if (uploadSignature(state.uploads || []) !== uploadSignature(nextUploads)) {
      clearStage(state, 'upload');
      clearStage(state, 'send');
      clearStage(state, 'wait');
      clearStage(state, 'extract');
      clearStage(state, 'extractImages');
    }
    state.uploads = nextUploads;
  }
  if (opts.uploadSelector && opts.uploadSelector !== DEFAULT_UPLOAD_SELECTOR) state.uploadSelector = opts.uploadSelector;
  if (opts.imageDir) state.imageDir = opts.imageDir;
  if (opts.imagePrefix) state.imagePrefix = opts.imagePrefix;
  if (opts.model && opts.model !== 'auto') state.model = normalizeModelName(opts.model);
  if (!opts.resume && ['send', 'run', 'image'].includes(opts.subcommand) && !opts.toolExplicit && state.tool && state.tool !== DEFAULT_TOOL) {
    state.tool = DEFAULT_TOOL;
    clearStage(state, 'ensureTool');
  }
  if (opts.toolExplicit) {
    const nextTool = normalizeToolName(opts.tool);
    if (normalizeToolName(state.tool) !== nextTool) {
      clearStage(state, 'ensureTool');
      clearStage(state, 'send');
      clearStage(state, 'wait');
      clearStage(state, 'extract');
      clearStage(state, 'extractImages');
    }
    state.tool = nextTool;
  }
  // Only save back if we actually have something to record (don't pollute state
  // for read-only sub-commands like status).
  if (opts.subcommand !== 'status' && opts.subcommand !== 'latest' && opts.subcommand !== 'doctor') saveState(state);

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
  if (['send', 'run', 'image'].includes(opts.subcommand) && !opts.dryRun) {
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
    state.model = normalizeModelName(opts.subcommandArgs[0]);
    saveState(state);
  }

  // For ensure-tool subcommand, override the target if first arg given
  if (opts.subcommand === 'ensure-tool' && opts.subcommandArgs.length) {
    const nextTool = normalizeToolName(opts.subcommandArgs[0]);
    if (normalizeToolName(state.tool) !== nextTool) {
      clearStage(state, 'ensureTool');
      clearStage(state, 'send');
      clearStage(state, 'wait');
      clearStage(state, 'extract');
      clearStage(state, 'extractImages');
    }
    state.tool = nextTool;
    opts.tool = nextTool;
    opts.toolExplicit = true;
    saveState(state);
  }

  if (opts.subcommand === 'image' && !opts.dryRun && Math.max(1, Number.isFinite(opts.imageCount) ? opts.imageCount : DEFAULT_IMAGE_COUNT) > 1) {
    if (
      opts.resume &&
      state.parallelImages &&
      state.parallelImages.failedCount === 0 &&
      state.parallelImages.requestedImageCount === opts.imageCount &&
      state.parallelImages.manifestPath &&
      fs.existsSync(state.parallelImages.manifestPath)
    ) {
      log(`resume: parallel image run already done, returning cached output`);
      console.log(JSON.stringify({
        ok: true,
        cached: true,
        parallel: true,
        session: state.session,
        output: state.parallelImages.manifestPath,
        imageCount: state.parallelImages.imageCount || 0,
        requestedImageCount: state.parallelImages.requestedImageCount,
        failedCount: state.parallelImages.failedCount || 0,
        imageConcurrency: state.parallelImages.imageConcurrency || DEFAULT_IMAGE_CONCURRENCY,
        images: state.parallelImages.images || [],
        childManifests: state.parallelImages.childManifests || [],
      }, null, 2));
      process.exit(0);
    }
    const parallelOut = await runParallelImageGeneration(state, opts, state.prompt);
    console.log(JSON.stringify(parallelOut, null, 2));
    process.exit(parallelOut.ok ? 0 : 4);
  }

  // --- Execute ---

  // Short-circuit before doing any work: if --resume and extract is done and
  // the output file exists, just return the cached response. This avoids
  // re-opening tabs and re-sending prompts when the user just wants the answer.
  if (opts.resume && ['run', 'image'].includes(opts.subcommand)) {
    const doneStage = opts.imageMode ? state.stages.extractImages : state.stages.extract;
    const cachedOut = doneStage && doneStage.data && (opts.imageMode ? doneStage.data.manifestPath : doneStage.data.path);
    if (cachedOut && fs.existsSync(cachedOut)) {
      log(`resume: all stages already done, returning cached output`);
      if (opts.imageMode) {
        const payload = {
          ok: true,
          cached: true,
          output: cachedOut,
          images: (doneStage.data && doneStage.data.images) || [],
        };
        console.log(JSON.stringify(payload, null, 2));
      } else if (!opts.json) {
        process.stdout.write(fs.readFileSync(cachedOut, 'utf8'));
      } else {
        console.log(JSON.stringify({ ok: true, cached: true, output: cachedOut, length: doneStage.data.length }, null, 2));
      }
      process.exit(0);
    }
  }

  const startTime = Date.now();
  let result;
  try {
    if (opts.subcommand === 'run') {
      result = await runPipeline(state, opts);
    } else if (opts.subcommand === 'image') {
      result = await runPipeline(state, { ...opts, imageMode: true }, IMAGE_PIPELINE);
    } else if (opts.subcommand === 'latest') {
      result = await runLatest(state, opts);
    } else if (opts.subcommand === 'doctor') {
      result = await runDoctor(state, opts, daemonStatus);
    } else if (SUBCOMMAND_TO_STAGE[opts.subcommand]) {
      const stageName = SUBCOMMAND_TO_STAGE[opts.subcommand];
      const fn = STAGE_FNS[stageName];
      result = { [stageName]: await fn(state, opts) };
    } else {
      die(2, `unknown subcommand: ${opts.subcommand}`);
    }
  } catch (e) {
    const code = e.code === 'wait_timeout' ? 3 : e.code === 'no_session_context' ? 2 : 4;
    const out = {
      ok: false,
      code: e.code || 'unknown',
      stage: e.stage || opts.subcommand,
      message: e.message,
      stageData: e.stageData,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      state: state.session,
      hint: code === 4 ? 'see references/intervention-points.md; fix the issue, then re-run with --resume --until-complete' : undefined,
    };
    if (opts.json) console.log(JSON.stringify(out, null, 2));
    else {
      log(`failed at stage=${out.stage} code=${out.code}: ${out.message}`);
      if (out.hint) log(out.hint);
    }
    process.exit(code);
  }

  // --- Success ---

  if (opts.continueMode) opts.keepSession = true;

  const waitData = (result.wait && result.wait.data) || (state.stages.wait && state.stages.wait.data) || {};
  const extractData = (result.extract && result.extract.data) || (state.stages.extract && state.stages.extract.data) || {};
  const imageData = (result.extractImages && result.extractImages.data) || (state.stages.extractImages && state.stages.extractImages.data) || {};
  const doctorData = result.doctor && result.doctor.data || null;

  const out = {
    ok: true,
    session: state.session,
    elapsed: Math.floor((Date.now() - startTime) / 1000),
    stages: Object.keys(state.stages),
    model: state.model,
    tool: state.tool || DEFAULT_TOOL,
    output: imageData.manifestPath || extractData.path || state.output || null,
    length: extractData.length || 0,
    imageCount: imageData.imageCount || 0,
    images: imageData.images || [],
    wait: waitData,
  };
  if (doctorData) out.doctor = doctorData;
  if (opts.json) {
    if (!opts.imageMode && extractData.path && fs.existsSync(extractData.path)) {
      out.response = fs.readFileSync(extractData.path, 'utf8');
    }
    console.log(JSON.stringify(out, null, 2));
  } else {
    if (opts.imageMode && imageData.manifestPath) {
      log(`image(s) saved to ${imageData.dir}`);
      console.log(JSON.stringify({
        ok: true,
        output: imageData.manifestPath,
        imageCount: imageData.imageCount || 0,
        images: (imageData.images || []).map((img) => img.path),
        failedCount: imageData.failedCount || 0,
      }, null, 2));
    } else if (opts.subcommand === 'run' && !opts.dryRun && extractData.path) {
      log(`response (${out.length} chars) saved to ${out.output}`);
      if (fs.existsSync(extractData.path)) {
        process.stdout.write(fs.readFileSync(extractData.path, 'utf8'));
      }
    } else if (doctorData) {
      console.log(JSON.stringify(doctorData, null, 2));
    } else if (extractData.path && fs.existsSync(extractData.path)) {
      process.stdout.write(fs.readFileSync(extractData.path, 'utf8'));
    } else if (opts.subcommand !== 'status' && opts.subcommand !== 'cleanup') {
      // For non-extract sub-commands, print a brief summary
      console.log(JSON.stringify(out, null, 2));
    }
  }

  // Final cleanup happens after stdout so the watching agent sees the result
  // as soon as it is extracted. Use --keep-session / --continue for follow-ups.
  if (['run', 'image', 'latest', 'doctor'].includes(opts.subcommand)) {
    try { await stageCleanup(state, opts); } catch (e) { log(`cleanup warning: ${e.message}`); }
  } else if (opts.subcommand !== 'cleanup' && !opts.keepSession && opts.subcommand !== 'status') {
    // For individual sub-commands, don't auto-cleanup unless it's the final stage
  }
  process.exit(0);
}

// --- Dry-run and main() integration ----------------------------------------

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, code: 'uncaught', message: e.message, stack: process.env.DEBUG ? e.stack : undefined }, null, 2));
  process.exit(1);
});

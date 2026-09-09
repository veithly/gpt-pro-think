'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function loadUploadSendLogic() {
  const searchPath = path.join(projectRoot, 'search.js');
  const source = fs.readFileSync(searchPath, 'utf8').replace(
    /\nmain\(\)\.catch\(\(e\) => \{[\s\S]*?\n\}\);\s*$/,
    ''
  );
  const context = {
    Buffer,
    URL,
    __dirname: projectRoot,
    __filename: searchPath,
    clearTimeout,
    console,
    module: { exports: {} },
    process,
    require,
    setTimeout,
  };
  context.exports = context.module.exports;
  context.globalThis = context;
  vm.runInNewContext(
    `${source}\nglobalThis.__uploadSendTest = { attachmentsAreReady, expectedFileNameCounts, promptSendWasAccepted, sendButtonIsReady, sendClickSelector };`,
    context,
    { filename: searchPath }
  );
  return context.__uploadSendTest;
}

test('does not treat aria-disabled send button as ready while a large upload is pending', () => {
  const logic = loadUploadSendLogic();
  assert.equal(logic.sendButtonIsReady({
    buttonFound: true,
    buttonVisible: true,
    buttonDisabled: false,
    buttonAriaDisabled: 'true',
    uploadPending: true,
    uploadFailed: false,
  }), false);
  assert.equal(logic.sendButtonIsReady({
    buttonFound: true,
    buttonVisible: true,
    buttonDisabled: false,
    buttonAriaDisabled: '',
    uploadPending: false,
    uploadFailed: false,
  }), true);
});

test('requires every duplicate-named attachment and no pending upload state', () => {
  const logic = loadUploadSendLogic();
  const expected = logic.expectedFileNameCounts(['/tmp/a/report.pdf', '/tmp/b/report.pdf', '/tmp/b/data.csv']);
  assert.equal(JSON.stringify(expected), JSON.stringify({ 'report.pdf': 2, 'data.csv': 1 }));
  assert.equal(logic.attachmentsAreReady({
    observedNameCounts: { 'report.pdf': 1, 'data.csv': 1 },
    uploadPending: false,
    uploadFailed: false,
  }, expected), false);
  assert.equal(logic.attachmentsAreReady({
    observedNameCounts: { 'report.pdf': 2, 'data.csv': 1 },
    uploadPending: true,
    uploadFailed: false,
  }, expected), false);
  assert.equal(logic.attachmentsAreReady({
    observedNameCounts: { 'report.pdf': 2, 'data.csv': 1 },
    uploadPending: false,
    uploadFailed: false,
  }, expected), true);
});

test('marks send complete only after a user turn appears or generation starts with an empty composer', () => {
  const logic = loadUploadSendLogic();
  const before = { userCount: 2, messageCount: 4 };
  assert.equal(logic.promptSendWasAccepted(before, { userCount: 2, messageCount: 4, busy: false }, { composerText: 'still here' }), false);
  assert.equal(logic.promptSendWasAccepted(before, { userCount: 3, messageCount: 5, busy: false }, { composerText: '' }), true);
  assert.equal(logic.promptSendWasAccepted(before, { userCount: 2, messageCount: 4, busy: true }, { composerText: '' }), true);
});

test('clicks the exact send element verified by readiness and keeps an aria fallback chain', () => {
  const logic = loadUploadSendLogic();
  assert.equal(
    logic.sendClickSelector({ buttonFound: true, buttonSelector: 'button[aria-label="Send prompt"]' }),
    'button[aria-label="Send prompt"]'
  );
  const fallback = logic.sendClickSelector({});
  assert.equal(fallback.split(',')[0].trim(), '[data-testid="send-button"]');
  assert.ok(fallback.includes('button[aria-label*="Send"]'));
  assert.ok(fallback.includes('button[aria-label*="发送"]'));
});

test('send gate requires removable attachment chips when files are expected', () => {
  const logic = loadUploadSendLogic();
  const base = {
    buttonFound: true,
    buttonVisible: true,
    buttonDisabled: false,
    buttonAriaDisabled: '',
    uploadPending: false,
    uploadFailed: false,
  };
  const expected = { 'report.pdf': 1 };
  // input.files alone (observedNameCounts empty) must NOT unlock sending.
  assert.equal(logic.sendButtonIsReady({ ...base, inputNameCounts: { 'report.pdf': 1 } }, expected), false);
  assert.equal(logic.sendButtonIsReady({ ...base, observedNameCounts: { 'report.pdf': 1 } }, expected), true);
  // Without uploads the button state alone decides.
  assert.equal(logic.sendButtonIsReady(base, {}), true);
});

test('a turn with expected files only counts as sent when the user turn carries them', () => {
  const logic = loadUploadSendLogic();
  const before = { userCount: 2, messageCount: 4 };
  const after = { userCount: 3, messageCount: 5, busy: false, lastUserAttachments: ['Remove file 1: brief.pdf', 'brief.pdf'] };
  const composer = { composerText: '' };
  assert.equal(logic.promptSendWasAccepted(before, after, composer, ['brief.pdf']), true);
  // The turn advanced but carries no attachment evidence: NOT accepted.
  assert.equal(
    logic.promptSendWasAccepted(
      before,
      { userCount: 3, messageCount: 5, busy: false, lastUserAttachments: ['How can I help?'] },
      composer,
      ['brief.pdf']
    ),
    false
  );
  // Without uploads there is no attachment requirement.
  assert.equal(logic.promptSendWasAccepted(before, { userCount: 3, messageCount: 5, busy: false }, composer), true);
});

test('send escalation ladder recovers when the trusted send click is swallowed', async () => {
  const searchPath = path.join(projectRoot, 'search.js');
  const source = fs.readFileSync(searchPath, 'utf8').replace(
    /\nmain\(\)\.catch\(\(e\) => \{[\s\S]*?\n\}\);\s*$/,
    ''
  );
  const context = {
    Buffer,
    URL,
    __dirname: projectRoot,
    __filename: searchPath,
    clearTimeout,
    console,
    module: { exports: {} },
    process,
    require,
    setTimeout,
  };
  context.exports = context.module.exports;
  context.globalThis = context;
  const overrides = `
;const __mockEval = async (session, code) => {
  if (code.includes("pickSendButton")) return true;
  if (code.includes("return true; })()") && code.includes("ce.focus")) return true;
  if (code.includes("insertText")) return { ok: true, len: 26 };
  if (code.includes("len: ce ?")) return { len: 26 };
  return { ok: true };
};
evaluate = __mockEval;
cmd = async (action, args) => ({ ok: true, data: true });
let __confirms = 0;
waitForPromptAccepted = async (session, before, prompt) => { __confirms += 1; return { ok: __confirms >= 2, promptLength: prompt.length }; };
waitForSendButtonReady = async () => ({ ok: true, buttonSelector: "[data-testid=send-button]" });
getConversationProgress = async () => ({ userCount: 1, messageCount: 2, assistantCount: 1, busy: true });
inspectComposerUploadState = async () => ({ composerText: "x" });
let __clicks = 0;
globalThis.__ladderTest = { layer2Fired: () => __clicks > 0 };
`;
  vm.runInNewContext(`${source}\n${overrides}\nglobalThis.__ladderTest.stageSend = stageSend;`, context, { filename: searchPath });
  const result = await context.__ladderTest.stageSend(
    { session: 'ladder-unit', prompt: 'unit prompt value', turns: 0, stages: {}, uploads: [] },
    { continueMode: false }
  );
  assert.equal(result.data.attempts.length, 1);
  assert.equal(result.data.confirmed, true);
  assert.equal(result.data.turn, 1);
});

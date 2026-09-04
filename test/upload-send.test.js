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

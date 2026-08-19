'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function loadModelRouting() {
  const searchPath = path.join(projectRoot, 'search.js');
  const source = fs.readFileSync(searchPath, 'utf8');
  const withoutMain = source.replace(/\nmain\(\)\.catch\(\(e\) => \{[\s\S]*?\n\}\);\s*$/, '');
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
    `${withoutMain}\n` +
      'globalThis.__modelRoutingTest = { DEFAULT_BROWSER_BACKEND, DEFAULT_TOOL, doctorBackendCheck, modelTargetFromInput, modelStateFromLabel, modelStateMatchesTarget, normalizeBrowserBackend, normalizeModelName, normalizeEffort, normalizeToolName };',
    context,
    { filename: searchPath }
  );
  return context.__modelRoutingTest;
}

test('defaults thinking targets to the extra-high slider', () => {
  const routing = loadModelRouting();
  assert.equal(JSON.stringify(routing.modelTargetFromInput(undefined)), JSON.stringify({ model: 'thinking', effort: 'extra-high' }));
  assert.equal(JSON.stringify(routing.modelTargetFromInput('极高')), JSON.stringify({ model: 'thinking', effort: 'extra-high' }));
  assert.equal(routing.modelStateMatchesTarget({ model: 'thinking', effort: 'extra-high' }, 'thinking'), true);
  assert.equal(routing.modelStateMatchesTarget({ model: 'thinking', effort: 'high' }, 'thinking'), false);
});

test('keeps Pro independent from thinking effort', () => {
  const routing = loadModelRouting();
  assert.equal(JSON.stringify(routing.modelTargetFromInput('pro')), JSON.stringify({ model: 'pro', effort: 'extra-high' }));
  assert.equal(JSON.stringify(routing.modelStateFromLabel('Pro')), JSON.stringify({ model: 'pro', effort: 'pro', label: 'Pro' }));
  assert.equal(routing.modelStateMatchesTarget({ model: 'pro', effort: 'pro' }, 'pro'), true);
  assert.equal(routing.modelStateMatchesTarget({ model: 'thinking', effort: 'extra-high' }, 'pro'), false);
});

test('recognizes current ChatGPT very-high and Chinese labels', () => {
  const routing = loadModelRouting();
  assert.equal(routing.modelStateFromLabel('Very High').effort, 'extra-high');
  assert.equal(routing.modelStateFromLabel('超高').effort, 'extra-high');
  assert.equal(routing.normalizeModelName('extended-pro'), 'pro');
  assert.equal(routing.normalizeEffort('极高'), 'extra-high');
});

test('defaults to OpenCLI and clears work modes for normal runs', () => {
  const routing = loadModelRouting();
  assert.equal(routing.DEFAULT_BROWSER_BACKEND, 'opencli');
  assert.equal(routing.DEFAULT_TOOL, 'none');
  assert.equal(routing.normalizeBrowserBackend('kimi'), 'webbridge');
  assert.equal(routing.normalizeBrowserBackend(), 'opencli');
  assert.equal(routing.normalizeToolName(), 'none');
  assert.equal(routing.normalizeToolName('auto'), 'auto');
});

test('doctor identifies the active OpenCLI backend instead of WebBridge', async () => {
  const routing = loadModelRouting();
  const check = routing.doctorBackendCheck(
    { session: 'doctor-test', browserBackend: 'opencli', conversationUrl: '' },
    { browserBackend: 'opencli', keepSession: true },
    { backend: 'opencli', tabs: 2 }
  );
  assert.equal(check.name, 'opencli');
  assert.equal(check.tabs, 2);
});

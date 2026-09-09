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
      'globalThis.__modelRoutingTest = { DEFAULT_BROWSER_BACKEND, DEFAULT_MODEL, DEFAULT_TOOL, doctorBackendCheck, imageCountFromOpts, labelShowsPro, modelTargetFromInput, modelStateFromLabel, modelStateMatchesTarget, normalizeBrowserBackend, normalizeModelName, normalizeEffort, normalizeToolName };',
    context,
    { filename: searchPath }
  );
  return context.__modelRoutingTest;
}

test('defaults normal runs to GPT-6 Pro while 极高 stays extra-high thinking', () => {
  const routing = loadModelRouting();
  assert.equal(routing.DEFAULT_MODEL, 'gpt-6-pro');
  assert.equal(routing.modelTargetFromInput(undefined).model, 'gpt-6-pro');
  assert.equal(JSON.stringify(routing.modelTargetFromInput('极高')), JSON.stringify({ model: 'thinking', effort: 'extra-high' }));
  assert.equal(routing.modelStateMatchesTarget({ model: 'thinking', effort: 'extra-high' }, 'thinking'), true);
  assert.equal(routing.modelStateMatchesTarget({ model: 'thinking', effort: 'high' }, 'thinking'), false);
});

test('maps Pro aliases onto the GPT-6 Pro canonical target', () => {
  const routing = loadModelRouting();
  assert.equal(JSON.stringify(routing.modelTargetFromInput('pro')), JSON.stringify({ model: 'gpt-6-pro', effort: 'extra-high' }));
  assert.equal(routing.normalizeModelName('6pro'), 'gpt-6-pro');
  assert.equal(routing.normalizeModelName('gpt-6-pro'), 'gpt-6-pro');
  assert.equal(JSON.stringify(routing.modelStateFromLabel('6Pro')), JSON.stringify({ model: 'gpt-6-pro', effort: 'pro', label: '6Pro' }));
  assert.equal(routing.modelStateMatchesTarget({ model: 'gpt-6-pro', effort: 'pro' }, 'pro'), true);
  assert.equal(routing.modelStateMatchesTarget({ model: 'thinking', effort: 'extra-high' }, 'pro'), false);
});

test('accepts the 6Pro pill without matching arbitrary pro-suffixed labels', () => {
  const routing = loadModelRouting();
  assert.equal(routing.labelShowsPro('6Pro'), true);
  assert.equal(routing.labelShowsPro('Pro'), true);
  assert.equal(routing.labelShowsPro('GPT-6 Pro'), true);
  assert.equal(routing.labelShowsPro('notpro'), false);
  assert.equal(routing.labelShowsPro('apro'), false);
});

test('clamps image counts to the hard 1-10 batch range', () => {
  const routing = loadModelRouting();
  assert.equal(routing.imageCountFromOpts({ imageCount: 3 }), 3);
  assert.equal(routing.imageCountFromOpts({ imageCount: 10 }), 10);
  assert.equal(routing.imageCountFromOpts({ imageCount: 99 }), 10);
  assert.equal(routing.imageCountFromOpts({ imageCount: 0 }), 1);
  assert.equal(routing.imageCountFromOpts({ imageCount: -5 }), 1);
  assert.equal(routing.imageCountFromOpts({}), 1);
  assert.equal(routing.imageCountFromOpts({ imageCount: Number.NaN }), 1);
});

test('recognizes current ChatGPT very-high, xhigh, and Chinese labels', () => {
  const routing = loadModelRouting();
  assert.equal(routing.modelStateFromLabel('Very High').effort, 'extra-high');
  assert.equal(routing.modelStateFromLabel('超高').effort, 'extra-high');
  assert.equal(routing.normalizeModelName('extended-pro'), 'gpt-6-pro');
  assert.equal(routing.normalizeEffort('极高'), 'extra-high');
  assert.equal(routing.normalizeEffort('xhigh'), 'extra-high');
  assert.equal(routing.normalizeEffort('x-high'), 'extra-high');
});

test('defaults to auto backend resolution and clears work modes for normal runs', () => {
  const routing = loadModelRouting();
  assert.equal(routing.DEFAULT_BROWSER_BACKEND, 'auto');
  assert.equal(routing.DEFAULT_TOOL, 'none');
  assert.equal(routing.normalizeBrowserBackend('kimi'), 'webbridge');
  assert.equal(routing.normalizeBrowserBackend(), 'auto');
  assert.equal(routing.normalizeBrowserBackend('ego'), 'ego');
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

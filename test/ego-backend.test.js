'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function loadSearchRuntime(envOverrides = {}, fsShadow = null) {
  const previousEnv = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    previousEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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
    require(name) {
      if (name === 'fs' && fsShadow) return fsShadow;
      return require(name);
    },
    setTimeout,
  };
  context.exports = context.module.exports;
  context.globalThis = context;
  vm.runInNewContext(
    `${source}\nglobalThis.__egoTest = { normalizeBrowserBackend, resolveBackendValue, resolveEgoBin, buildEgoProgram, parseEgoResult, classifyEgoError, egoSpaceName, egoJsonLiteral, runEgoProgram };`,
    context,
    { filename: searchPath }
  );
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return context.__egoTest;
}

test('normalizeBrowserBackend maps ego aliases and keeps auto for resolution', () => {
  const runtime = loadSearchRuntime();
  assert.equal(runtime.normalizeBrowserBackend('ego'), 'ego');
  assert.equal(runtime.normalizeBrowserBackend('ego-lite'), 'ego');
  assert.equal(runtime.normalizeBrowserBackend('EGO-Browser'), 'ego');
  assert.equal(runtime.normalizeBrowserBackend('auto'), 'auto');
  assert.equal(runtime.normalizeBrowserBackend(undefined), 'auto');
  assert.equal(runtime.normalizeBrowserBackend('kimi'), 'webbridge');
  assert.equal(runtime.normalizeBrowserBackend('webbridge'), 'webbridge');
  assert.equal(runtime.normalizeBrowserBackend('opencli'), 'opencli');
  assert.equal(runtime.normalizeBrowserBackend('nonsense'), 'opencli');
});

test('resolveBackendValue prefers ego, then opencli, and keeps opencli fallback', () => {
  const egoBin = path.join(os.tmpdir(), `ego-fake-bin-${process.pid}`);
  fs.writeFileSync(egoBin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(egoBin, 0o755);
  try {
    const egoFirst = loadSearchRuntime({ EGO_BROWSER_BIN: egoBin, OPENCLI_BIN: '' });
    assert.equal(egoFirst.resolveBackendValue('auto'), 'ego');
    assert.equal(egoFirst.resolveBackendValue('ego-lite'), 'ego');

    // Shadow fs so the machine's real ego/opencli installs cannot interfere:
    // only the fake ego bin is executable, nothing "exists".
    const invisibleFs = new Proxy(fs, {
      get(target, prop) {
        if (prop === 'accessSync') {
          return (candidate) => {
            if (String(candidate) === egoBin) return undefined;
            const e = new Error(`EACCES: permission denied, access '${candidate}'`);
            e.code = 'EACCES';
            throw e;
          };
        }
        if (prop === 'existsSync') return () => false;
        return target[prop];
      },
    });
    const noBackends = loadSearchRuntime({ EGO_BROWSER_BIN: '', OPENCLI_BIN: '' }, invisibleFs);
    assert.equal(noBackends.resolveBackendValue('auto'), 'opencli');
    assert.equal(noBackends.resolveBackendValue('kimi'), 'webbridge');
  } finally {
    fs.unlinkSync(egoBin);
  }
});

test('buildEgoProgram embeds the request and the action body', () => {
  const runtime = loadSearchRuntime();
  const program = runtime.buildEgoProgram('evaluate', {
    action: 'evaluate',
    args: { code: '1+1' },
    space: runtime.egoSpaceName('my-session'),
  });
  assert.match(program, /await taskSpace\(__req\.space\)/);
  assert.match(program, /"space":"gpt-pro-think my-session"/);
  assert.match(program, /__p\.evaluate\(__req\.args\.code\)/);
  assert.throws(() => runtime.buildEgoProgram('bogus_action', {}), /does not support daemon action/);
});

test('parseEgoResult reads the last marker from merged output', () => {
  const runtime = loadSearchRuntime();
  const output = [
    'some startup noise',
    '@@EGO_RESULT@@{"ok":true,"data":{"value":42}}',
    'more noise',
    '@@EGO_RESULT@@{"ok":true,"data":{"value":"final"}}',
  ].join('\n');
  assert.equal(runtime.parseEgoResult(output).data.value, 'final');
  assert.equal(runtime.parseEgoResult(output).ok, true);
  assert.equal(runtime.parseEgoResult('no marker here'), null);
  assert.throws(() => runtime.parseEgoResult('@@EGO_RESULT@@{broken'), /invalid result JSON/);
});

test('classifyEgoError maps takeover, missing binary, and task space problems', () => {
  const runtime = loadSearchRuntime();
  assert.equal(runtime.classifyEgoError('user is controlling the space').code, 'user_controlling');
  assert.equal(runtime.classifyEgoError('spawn ego-browser ENOENT').code, 'ego_not_found');
  assert.equal(runtime.classifyEgoError('Task space not selected').code, 'ego_task_space_unavailable');
  assert.equal(runtime.classifyEgoError('Element not found: div.x'), null);
});

test('egoJsonLiteral escapes line separators so JSON stays valid JS', () => {
  const runtime = loadSearchRuntime();
  const literal = runtime.egoJsonLiteral({ text: 'abc' });
  assert.equal(JSON.parse(literal).text, 'abc');
  assert.ok(!literal.includes('\u2028') && !literal.includes('\u2029'), 'line separators must be escaped');
});

test('runEgoProgram resolves result data from stderr and rejects typed errors', async () => {
  const okBin = path.join(os.tmpdir(), `ego-fake-ok-${process.pid}`);
  const errBin = path.join(os.tmpdir(), `ego-fake-err-${process.pid}`);
  fs.writeFileSync(okBin, '#!/bin/sh\necho \'noise\'\necho \'@@EGO_RESULT@@{"ok":true,"data":{"value":"ok"}}\' >&2\n');
  fs.chmodSync(okBin, 0o755);
  fs.writeFileSync(errBin, '#!/bin/sh\necho \'@@EGO_RESULT@@{"ok":false,"error":"user is controlling","code":"ego_failed"}\' >&2\n');
  fs.chmodSync(errBin, 0o755);
  try {
    const runtime = loadSearchRuntime({ EGO_BROWSER_BIN: okBin });
    const data = await runtime.runEgoProgram('cliLog("unused")', { label: 'test' });
    assert.equal(data.value, 'ok');

    const errRuntime = loadSearchRuntime({ EGO_BROWSER_BIN: errBin });
    await assert.rejects(
      () => errRuntime.runEgoProgram('cliLog("unused")', { label: 'test' }),
      (error) => error.code === 'user_controlling' && /user is controlling/.test(error.message)
    );
  } finally {
    fs.unlinkSync(okBin);
    fs.unlinkSync(errBin);
  }
});

test('egoSpaceName namespaces sessions into task spaces', () => {
  const runtime = loadSearchRuntime();
  assert.equal(runtime.egoSpaceName('gpt-pro-123'), 'gpt-pro-think gpt-pro-123');
});

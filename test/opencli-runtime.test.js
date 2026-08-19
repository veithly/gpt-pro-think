'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function loadOpencliRuntime(execFile) {
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
      if (name === 'child_process') return { execFile };
      return require(name);
    },
    setTimeout,
  };
  context.exports = context.module.exports;
  context.globalThis = context;
  vm.runInNewContext(`${source}\nglobalThis.__opencliRuntimeTest = { runOpencli };`, context, { filename: searchPath });
  return context.__opencliRuntimeTest;
}

test('OpenCLI evaluation allows authenticated image payloads larger than Node default buffer', async () => {
  let options;
  const runtime = loadOpencliRuntime((_command, _args, receivedOptions, callback) => {
    options = receivedOptions;
    callback(null, JSON.stringify({ value: 'ok' }), '');
  });

  await runtime.runOpencli(['browser', 'test', 'eval', '1'], 'browser evaluate');

  assert.equal(options.timeout, 30000);
  assert.equal(options.maxBuffer, 64 * 1024 * 1024);
});

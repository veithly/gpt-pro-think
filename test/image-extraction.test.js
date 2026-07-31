'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function loadImageExtractor() {
  const searchPath = path.join(projectRoot, 'search.js');
  const source = fs.readFileSync(searchPath, 'utf8');
  const withoutMain = source.replace(
    /\nmain\(\)\.catch\(\(e\) => \{[\s\S]*?\n\}\);\s*$/,
    ''
  );
  assert.notEqual(withoutMain, source, 'test harness must remove the CLI main() call');

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
      'globalThis.__imageExtractionTest = {\n' +
      '  extractLastAssistantImages,\n' +
      '  getConversationProgress,\n' +
      '  setEvaluateForTest(fn) { evaluate = fn; }\n' +
      '};',
    context,
    { filename: searchPath }
  );
  return context.__imageExtractionTest;
}

function generatedImage(src, size = 512) {
  return {
    alt: 'Generated image',
    className: 'group/imagegen-image',
    complete: true,
    currentSrc: src,
    naturalHeight: size,
    naturalWidth: size,
    src,
    getAttribute(name) {
      if (name === 'alt') return this.alt;
      if (name === 'src') return this.src;
      return '';
    },
    getBoundingClientRect() {
      return { height: size, width: size };
    },
  };
}

function imageRoot(image, order) {
  return {
    order,
    matches(selector) {
      return selector === '[class*="group/imagegen-image"]';
    },
    querySelectorAll(selector) {
      return selector === 'img' ? [image] : [];
    },
  };
}

test('extracts every sibling image root from the latest generated response', async () => {
  const extractor = loadImageExtractor();
  const roots = [
    imageRoot(generatedImage('data:image/png;base64,b2xk'), 1),
    imageRoot(generatedImage('data:image/png;base64,Zmlyc3Q=', 480), 3),
    imageRoot(generatedImage('data:image/png;base64,c2Vjb25k', 48), 4),
    imageRoot(generatedImage('data:image/png;base64,dGhpcmQ=', 48), 5),
    imageRoot(generatedImage('data:image/png;base64,Zm91cnRo', 48), 6),
  ];
  const latestUser = {
    order: 2,
    compareDocumentPosition(root) {
      return root.order > this.order ? 4 : 2;
    },
  };
  const avatar = generatedImage('data:image/png;base64,YXZhdGFy', 48);
  avatar.alt = 'profile avatar';
  avatar.className = 'avatar';
  const assistant = {
    innerText: '',
    querySelectorAll(selector) {
      return selector === 'img' ? [avatar] : [];
    },
  };
  const document = {
    body: { innerText: '' },
    title: 'Image regression fixture',
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[class*="group/imagegen-image"]') return roots;
      if (selector === '[data-message-author-role="assistant"]') return [assistant];
      if (selector === '[data-message-author-role="user"]') return [latestUser];
      if (selector === '[data-message-author-role]') return [latestUser, assistant];
      return [];
    },
  };

  extractor.setEvaluateForTest(async (_session, code) => {
    const value = await vm.runInNewContext(code, {
      btoa: (valueToEncode) => Buffer.from(valueToEncode, 'binary').toString('base64'),
      document,
      fetch: async () => { throw new Error('data URLs must not require fetch'); },
      location: { href: 'https://chatgpt.com/c/image-regression' },
      Uint8Array,
      window: {
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      },
    });
    return JSON.parse(value);
  });

  const result = await extractor.extractLastAssistantImages('test-session', {}, 10);
  const progress = await extractor.getConversationProgress('test-session');

  assert.equal(result.images.length, 4);
  assert.deepEqual(
    Array.from(result.images, (image) => image.src),
    roots.slice(1).map((root) => root.querySelectorAll('img')[0].src)
  );
  assert.equal(progress.lastAssistantImageCount, 4);
  assert.deepEqual(
    Array.from(progress.lastAssistantImages, (image) => image.src),
    roots.slice(1).map((root) => root.querySelectorAll('img')[0].src)
  );
});

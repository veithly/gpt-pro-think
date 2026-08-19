'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function loadProgressReader() {
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
    `${source}\nglobalThis.__deepResearchProgressTest = { getDeepResearchProgress, setEvaluateForTest(fn) { evaluate = fn; } };`,
    context,
    { filename: searchPath }
  );
  return context.__deepResearchProgressTest;
}

test('reads Deep Research plan state from current conversation-turn React fibers', async () => {
  const reader = loadProgressReader();
  const messages = [{
    id: 'tool-message',
    author: { name: 'api_tool.call_tool' },
    metadata: {
      chatgpt_sdk: {
        tool_response_metadata: {
          async_task_conversation_id: 'research-session-1',
          widgetSessionId: 'widget-session-1',
          venus_plan: { title: 'Research plan', steps: [{ id: 'source', text: 'Read primary sources' }] },
          venus_widget_state: { status: 'waiting_for_user_response_on_plan' },
        },
      },
    },
  }];
  const section = {
    __reactFiber$test: {
      memoizedProps: { children: { props: { turn: { messages } } } },
      child: null,
      sibling: null,
    },
  };
  const document = {
    body: { innerText: '' },
    title: 'Research',
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector.includes('conversation-turn-')) return [section];
      return [];
    },
  };
  reader.setEvaluateForTest(async (_session, code) => {
    const value = vm.runInNewContext(code, { document, location: { href: 'https://chatgpt.com/c/test' } });
    return JSON.parse(value);
  });

  const progress = await reader.getDeepResearchProgress('test-session');

  assert.equal(progress.status, 'waiting_for_user_response_on_plan');
  assert.equal(progress.sessionId, 'research-session-1');
  assert.equal(progress.widgetSessionId, 'widget-session-1');
  assert.equal(progress.plan.title, 'Research plan');
  assert.equal(progress.plan.steps[0].text, 'Read primary sources');
});

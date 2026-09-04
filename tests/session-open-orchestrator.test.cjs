const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose: () => undefined };
    };
  }
  fire(value) { this.listeners.forEach((listener) => listener(value)); }
  dispose() { this.listeners = []; }
}

const vscode = {
  EventEmitter,
  extensions: { all: [], getExtension: () => undefined },
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
};
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
require('ts-node/register/transpile-only');
const { SessionOrchestrator } = require('../src/sessions/sessionOrchestrator.ts');
Module._load = originalLoad;

function reference(id, provider = 'codex') {
  return {
    provider,
    sessionId: id,
    threadId: id,
    surface: provider === 'codex' ? 'app-server' : 'copilot-sdk',
    openUri: `vscode://chanterxiao.infinite-map/session/open?v=1&executionId=exec-${id}`,
  };
}

function providerRegistry(adapter) {
  return {
    load: async () => ({ createAdapter: async () => adapter }),
    discover: async () => [],
  };
}

test('historical opens pass each selected canonical session to the native resolver without active-session lookup', async () => {
  const opened = [];
  const resolver = {
    open: async (input) => {
      opened.push(input);
      return {
        opened: true,
        executionId: input.executionId,
        provider: input.session.provider,
        sessionId: input.session.threadId,
        target: 'provider-ide',
        method: 'provider-uri',
        capability: 'experimental',
        fallbackAvailable: true,
      };
    },
    dispose() {},
  };
  const orchestrator = new SessionOrchestrator(providerRegistry({}), resolver);
  for (const id of ['a', 'b', 'c']) {
    const result = await orchestrator.openHistoricalSession({
      executionId: `exec-${id}`,
      session: reference(`thread-${id}`),
    });
    assert.equal(result.sessionId, `thread-${id}`);
  }
  assert.deepEqual(opened.map((input) => input.session.threadId), ['thread-a', 'thread-b', 'thread-c']);
  orchestrator.dispose();
});

test('native failure falls back to CLI with the selected historical session, then to detail when unsupported', async () => {
  const adapterOpens = [];
  const adapter = {
    providerId: 'codex',
    detectCapabilities: async () => ({ openTargets: ['infinite-map', 'provider-cli'] }),
    open: async (input) => adapterOpens.push(input),
    onDidEvent: () => ({ dispose() {} }),
    dispose() {},
  };
  const resolver = {
    open: async () => { const error = new Error('client missing'); error.code = 'NATIVE_CLIENT_MISSING'; throw error; },
    dispose() {},
  };
  const orchestrator = new SessionOrchestrator(providerRegistry(adapter), resolver);
  const selected = reference('historical-thread');
  const cli = await orchestrator.openHistoricalSession({
    executionId: 'exec-historical', session: selected, fallbackPolicy: 'provider-cli',
  });
  assert.equal(cli.opened, true);
  assert.equal(cli.method, 'provider-cli');
  assert.equal(adapterOpens[0].session.threadId, 'historical-thread');

  adapter.detectCapabilities = async () => ({ openTargets: ['infinite-map'] });
  const detail = await orchestrator.openHistoricalSession({
    executionId: 'exec-historical', session: selected, fallbackPolicy: 'provider-cli',
  });
  assert.equal(detail.opened, false);
  assert.equal(detail.method, 'detail-fallback');
  assert.match(detail.warning, /client missing/);
  orchestrator.dispose();
});

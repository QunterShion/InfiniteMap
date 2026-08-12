const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const readline = require('node:readline');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const Module = require('node:module');

class MockEventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
  }
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}

require('ts-node/register/transpile-only');
const { CodexAppServerClient } = require('../src/providers/codex/CodexAppServerClient.ts');
const { CodexRuntimeManager } = require('../src/providers/codex/CodexRuntimeManager.ts');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return { EventEmitter: MockEventEmitter };
  return originalLoad.call(this, request, parent, isMain);
};
const { CodexAgentSessionAdapter } = require('../src/providers/codex/CodexAgentSessionAdapter.ts');
Module._load = originalLoad;

function createFakeAppServer() {
  const requests = [];
  const clientResponses = [];
  let process;

  function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  function spawnProcess(_executable, args) {
    assert.deepEqual(args, ['app-server']);
    process = new EventEmitter();
    process.stdin = new PassThrough();
    process.stdout = new PassThrough();
    process.stderr = new PassThrough();
    process.killed = false;
    process.kill = () => {
      process.killed = true;
      process.emit('exit', 0, null);
    };

    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const message = JSON.parse(line);
      if (message.id && !message.method) {
        clientResponses.push(message);
        return;
      }
      requests.push(message);
      if (message.method === 'initialize') {
        send({ id: message.id, result: { userAgent: 'fake' } });
      } else if (message.method === 'model/list' && !message.params.cursor) {
        send({ id: message.id, result: {
          data: [{
            id: 'one', model: 'one', displayName: 'One', hidden: false, isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }]
          }],
          nextCursor: 'page-2'
        } });
      } else if (message.method === 'model/list') {
        send({ id: message.id, result: {
          data: [{
            id: 'hidden', model: 'hidden', displayName: 'Hidden', hidden: true, isDefault: false,
            defaultReasoningEffort: 'low', supportedReasoningEfforts: []
          }, {
            id: 'two', model: 'two', displayName: 'Two', hidden: false, isDefault: false,
            defaultReasoningEffort: 'high',
            supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }]
          }],
          nextCursor: null
        } });
      }
    });
    return process;
  }

  return { spawnProcess, send, requests, clientResponses };
}

test('Codex app-server client handshakes, paginates models, and handles server requests', async () => {
  const fake = createFakeAppServer();
  const client = new CodexAppServerClient({
    executable: '/fake/codex',
    spawnProcess: fake.spawnProcess,
    requestTimeoutMs: 1000
  });
  const notifications = [];
  client.onNotification((notification) => notifications.push(notification));
  client.registerServerRequest('tool/requestUserInput', async (params) => ({ answers: params.questions.length }));

  await client.start();
  const models = await client.readModels();
  assert.deepEqual(models.map((model) => model.model), ['one', 'two']);
  assert.equal(fake.requests[0].params.clientInfo.name, 'infinite_map_vscode');
  assert.equal(fake.requests[1].method, 'initialized');
  assert.equal(fake.requests.filter((request) => request.method === 'model/list').length, 2);

  fake.send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
  fake.send({ id: 99, method: 'tool/requestUserInput', params: { questions: [{ id: 'q' }] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications[0].method, 'turn/started');
  assert.deepEqual(fake.clientResponses.find((response) => response.id === 99).result, { answers: 1 });
  client.dispose();
});

test('Codex runtime rejects private VS Code extension binaries discovered on PATH', () => {
  const runtime = new CodexRuntimeManager({ storagePath: '/tmp/unused' });
  assert.equal(
    runtime.isPrivateExtensionBinary('/Users/me/.vscode/extensions/openai.chatgpt-1/bin/codex'),
    true
  );
  assert.equal(runtime.isPrivateExtensionBinary('/opt/homebrew/bin/codex'), false);
});

test('Codex Server Request remains pending until InfiniteMap returns the user decision', async () => {
  const handlers = new Map();
  const client = {
    onNotification: () => () => undefined,
    onDisconnect: () => () => undefined,
    registerServerRequest: (method, handler) => handlers.set(method, handler),
    request: async (method) => {
      if (method === 'thread/start') {
        return { thread: { id: 'thread-approval' }, model: 'codex-test', reasoningEffort: 'medium' };
      }
      return {};
    }
  };
  const runtime = {
    probe: async () => ({
      client,
      authenticated: true,
      models: [{
        id: 'codex-test', model: 'codex-test', displayName: 'Codex Test', hidden: false,
        isDefault: true, defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }]
      }]
    })
  };
  const adapter = new CodexAgentSessionAdapter(runtime);
  const events = [];
  adapter.onDidEvent((event) => events.push(event));
  const session = await adapter.createSession({
    executionId: 'exec-approval', workingDirectory: '/workspace', modelId: 'codex-test', effort: 'medium',
    mcpServer: { command: '/usr/bin/node', args: ['/extension/dist/mcp/server.js'] }
  });
  const response = handlers.get('item/commandExecution/requestApproval')({
    threadId: session.sessionId,
    title: 'Run command'
  });
  await new Promise((resolve) => setImmediate(resolve));
  const input = events.find((event) => event.type === 'session.input.required');
  assert.ok(input.payload.requestId);
  await adapter.respondToInput({
    session,
    requestId: input.payload.requestId,
    decision: 'approve'
  });
  assert.deepEqual(await response, { decision: 'accept' });
  adapter.dispose();
});

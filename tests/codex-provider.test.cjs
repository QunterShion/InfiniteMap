const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
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
const { CodexAppServerClient, CodexRpcError } = require('../src/providers/codex/CodexAppServerClient.ts');
const { CodexRuntimeManager } = require('../src/providers/codex/CodexRuntimeManager.ts');
const {
  AGENT_EXECUTION_RECEIPT_SCHEMA,
  CODEX_METHODS,
  CODEX_PROTOCOL_SURFACE,
  assertCodexGeneratedProtocolSurface,
  assertCodexGeneratedServerResponses,
  assertStrictOutputSchema
} = require('../src/providers/codex/protocol.ts');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return { EventEmitter: MockEventEmitter };
  return originalLoad.call(this, request, parent, isMain);
};
const { CodexAgentSessionAdapter } = require('../src/providers/codex/CodexAgentSessionAdapter.ts');
Module._load = originalLoad;
const { codexThreadToTranscript } = require('../src/providers/codex/CodexTranscriptMapper.ts');

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
  client.registerServerRequest(CODEX_METHODS.requestUserInput, async (params) => ({ answers: params.questions.length }));

  await client.start();
  const models = await client.readModels();
  assert.deepEqual(models.map((model) => model.model), ['one', 'two']);
  assert.equal(fake.requests[0].params.clientInfo.name, 'infinite_map_vscode');
  assert.deepEqual(fake.requests[0].params.capabilities, { experimentalApi: true });
  assert.equal(fake.requests[1].method, 'initialized');
  assert.equal(fake.requests.filter((request) => request.method === 'model/list').length, 2);

  fake.send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
  fake.send({ id: 99, method: CODEX_METHODS.requestUserInput, params: { questions: [{ id: 'q' }] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications[0].method, 'turn/started');
  assert.deepEqual(fake.clientResponses.find((response) => response.id === 99).result, { answers: 1 });
  client.dispose();
});

test('Codex permission RPCs, handshake, and generated schema use one capability surface', () => {
  const clientSource = fs.readFileSync(path.join(__dirname, '../src/providers/codex/CodexAppServerClient.ts'), 'utf8');
  const runtimeSource = fs.readFileSync(path.join(__dirname, '../src/providers/codex/CodexRuntimeManager.ts'), 'utf8');
  const adapterSource = fs.readFileSync(path.join(__dirname, '../src/providers/codex/CodexAgentSessionAdapter.ts'), 'utf8');

  assert.match(clientSource, /capabilities:\s*\{\s*experimentalApi:\s*true\s*\}/);
  assert.doesNotMatch(clientSource, /capabilities:[^\n]*null/);
  assert.match(runtimeSource, /generate-json-schema', '--experimental', '--out'/);
  assert.match(adapterSource, /CODEX_METHODS\.permissionProfileList/);
  assert.match(adapterSource, /permissions:/);
  assert.match(adapterSource, /approvalsReviewer:/);
});

test('Codex protocol inventory covers 39 integrated methods and rejects missing generated capabilities', () => {
  assert.equal(CODEX_PROTOCOL_SURFACE.clientRequests.length, 14);
  assert.equal(CODEX_PROTOCOL_SURFACE.clientNotifications.length, 1);
  assert.equal(CODEX_PROTOCOL_SURFACE.serverRequests.length, 5);
  assert.equal(CODEX_PROTOCOL_SURFACE.serverNotifications.length, 19);
  assert.equal(
    Object.values(CODEX_PROTOCOL_SURFACE).reduce((total, methods) => total + methods.length, 0),
    39
  );
  const requiredParams = {
    [CODEX_METHODS.initialize]: ['capabilities'],
    [CODEX_METHODS.accountLoginStart]: ['type'],
    [CODEX_METHODS.threadStart]: ['approvalPolicy', 'approvalsReviewer', 'config', 'developerInstructions', 'permissions'],
    [CODEX_METHODS.threadResume]: ['approvalPolicy', 'approvalsReviewer', 'config', 'permissions'],
    [CODEX_METHODS.turnStart]: [
      'additionalContext', 'approvalPolicy', 'approvalsReviewer', 'clientUserMessageId',
      'effort', 'outputSchema', 'permissions'
    ],
    [CODEX_METHODS.turnSteer]: ['additionalContext', 'clientUserMessageId', 'expectedTurnId']
  };
  const schemaFor = (methods) => ({
    oneOf: methods.map((method) => ({
      properties: {
        method: { enum: [method] },
        params: {
          type: 'object',
          properties: Object.fromEntries((requiredParams[method] || []).map((field) => [field, {}]))
        }
      }
    }))
  });
  const schemas = {
    clientRequests: schemaFor(CODEX_PROTOCOL_SURFACE.clientRequests),
    clientNotifications: schemaFor(CODEX_PROTOCOL_SURFACE.clientNotifications),
    serverRequests: schemaFor(CODEX_PROTOCOL_SURFACE.serverRequests),
    serverNotifications: schemaFor(CODEX_PROTOCOL_SURFACE.serverNotifications)
  };
  assert.doesNotThrow(() => assertCodexGeneratedProtocolSurface(schemas));
  assert.throws(
    () => assertCodexGeneratedProtocolSurface({ ...schemas, clientRequests: schemaFor([CODEX_METHODS.initialize]) }),
    /schema is missing required methods/
  );
  const withoutPermissions = schemaFor(CODEX_PROTOCOL_SURFACE.clientRequests);
  delete withoutPermissions.oneOf.find((entry) => entry.properties.method.enum[0] === CODEX_METHODS.turnStart)
    .properties.params.properties.permissions;
  assert.throws(
    () => assertCodexGeneratedProtocolSurface({ ...schemas, clientRequests: withoutPermissions }),
    /turn\/start params schema is missing required integration fields: permissions/
  );

  const responseSchema = (properties, enums = []) => ({
    type: 'object',
    required: properties,
    properties: Object.fromEntries(properties.map((field) => [field, {}])),
    definitions: { values: { enum: enums } }
  });
  const responses = {
    commandApproval: responseSchema(['decision'], ['accept', 'decline', 'cancel']),
    fileChangeApproval: responseSchema(['decision'], ['accept', 'decline', 'cancel']),
    requestUserInput: responseSchema(['answers']),
    mcpElicitation: responseSchema(['action'], ['accept', 'decline', 'cancel']),
    permissionsApproval: responseSchema(['permissions', 'scope'], ['turn', 'session'])
  };
  assert.doesNotThrow(() => assertCodexGeneratedServerResponses(responses));
  assert.throws(
    () => assertCodexGeneratedServerResponses({ ...responses, requestUserInput: responseSchema([]) }),
    /requestUserInput response schema is missing fields: answers/
  );
});

test('Codex output schema is recursively strict and uses nullable required fields', () => {
  assert.doesNotThrow(() => assertStrictOutputSchema(AGENT_EXECUTION_RECEIPT_SCHEMA));
  assert.deepEqual(AGENT_EXECUTION_RECEIPT_SCHEMA.properties.validations.items.required,
    ['command', 'name', 'passed', 'evidence']);
  assert.deepEqual(AGENT_EXECUTION_RECEIPT_SCHEMA.properties.validations.items.properties.command.type,
    ['string', 'null']);
  assert.ok(AGENT_EXECUTION_RECEIPT_SCHEMA.required.includes('blocker'));
  assert.deepEqual(AGENT_EXECUTION_RECEIPT_SCHEMA.properties.blocker.type, ['string', 'null']);
  assert.throws(() => assertStrictOutputSchema({
    type: 'object', additionalProperties: false, properties: { missing: { type: 'string' } }, required: []
  }), /missing required fields: missing/);
});

test('Codex thread history maps responses, reasoning, commands, file diffs, and MCP results into transcript entries', () => {
  const transcript = codexThreadToTranscript({
    id: 'thread-history',
    turns: [{
      id: 'turn-history',
      status: 'completed',
      startedAt: 1_700_000_000,
      completedAt: 1_700_000_010,
      items: [{ id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '请完成任务' }] },
        { id: 'reasoning-1', type: 'reasoning', summary: ['先检查', '再验证'], content: ['模型开放的推理内容'] },
        { id: 'agent-1', type: 'agentMessage', phase: 'final_answer', text: '任务已完成' },
        {
          id: 'command-1', type: 'commandExecution', command: 'npm test', cwd: '/workspace', status: 'completed',
          aggregatedOutput: '19 passed', exitCode: 0, durationMs: 1200, commandActions: []
        },
        {
          id: 'file-1', type: 'fileChange', status: 'completed',
          changes: [{ path: 'src/app.ts', kind: { type: 'update' }, diff: '+fixed' }]
        },
        {
          id: 'mcp-1', type: 'mcpToolCall', server: 'infiniteMap', tool: 'km_validate', status: 'completed',
          arguments: { filePath: 'map.km' }, result: { content: [{ type: 'text', text: 'valid' }] }
        },
        {
          id: 'collab-1', type: 'collabToolCall', tool: 'spawn_agent', status: 'completed',
          senderThreadId: 'thread-history', receiverThreadId: 'child-thread', prompt: '检查测试'
        }]
    }]
  });

  assert.deepEqual(transcript.map((entry) => entry.kind),
    ['user', 'reasoning', 'assistant', 'command', 'file-change', 'mcp-tool', 'collaboration']);
  assert.equal(transcript.find((entry) => entry.kind === 'reasoning').summary, '先检查\n\n再验证');
  assert.equal(transcript.find((entry) => entry.kind === 'assistant').phase, 'final_answer');
  assert.equal(transcript.find((entry) => entry.kind === 'command').detail.output, '19 passed');
  assert.equal(transcript.find((entry) => entry.kind === 'file-change').detail.changes[0].diff, '+fixed');
  assert.deepEqual(transcript.find((entry) => entry.kind === 'mcp-tool').detail.arguments, { filePath: 'map.km' });
});

test('Codex thread history preserves an empty Provider reasoning summary without exposing encrypted content', () => {
  const transcript = codexThreadToTranscript({
    id: 'thread-empty-reasoning',
    turns: [{
      id: 'turn-empty-reasoning',
      status: 'completed',
      items: [{
        id: 'reasoning-empty', type: 'reasoning', summary: [], content: [],
        encrypted_content: 'provider-private-ciphertext'
      }]
    }]
  });

  assert.equal(transcript.length, 1);
  assert.equal(transcript[0].kind, 'reasoning');
  assert.equal(transcript[0].summary, undefined);
  assert.equal(transcript[0].text, undefined);
  assert.equal(JSON.stringify(transcript[0]).includes('provider-private-ciphertext'), false);
});

test('Codex live transcript merges reasoning and repeated response deltas before authoritative item completion', async () => {
  let notificationListener;
  const client = {
    onNotification(listener) {
      notificationListener = listener;
      return () => { notificationListener = undefined; };
    },
    onDisconnect: () => () => undefined,
    registerServerRequest: () => () => undefined,
    request: async (method) => {
      if (method === CODEX_METHODS.permissionProfileList) {
        return { data: [{ id: ':workspace', allowed: true }], nextCursor: null };
      }
      if (method === CODEX_METHODS.configRequirementsRead) {
        return { requirements: { allowedApprovalPolicies: ['on-request'], allowedApprovalsReviewers: ['user'] } };
      }
      if (method === CODEX_METHODS.threadStart) {
        return { thread: { id: 'thread-transcript' }, model: 'codex-test', reasoningEffort: 'medium' };
      }
      return {};
    }
  };
  const adapter = new CodexAgentSessionAdapter({
    probe: async () => ({
      client,
      authenticated: true,
      models: [{
        id: 'codex-test', model: 'codex-test', displayName: 'Codex Test', hidden: false,
        isDefault: true, defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }]
      }]
    })
  });
  const events = [];
  adapter.onDidEvent((event) => events.push(event));
  const session = await adapter.createSession({
    executionId: 'exec-transcript', workingDirectory: '/workspace', modelId: 'codex-test', effort: 'medium',
    mcpServer: { command: '/usr/bin/node', args: [] }
  });

  notificationListener({ method: CODEX_METHODS.reasoningSummaryTextDelta, params: {
    threadId: session.sessionId, turnId: 'turn-1', itemId: 'reasoning-1', summaryIndex: 0, delta: '检查'
  } });
  notificationListener({ method: CODEX_METHODS.reasoningTextDelta, params: {
    threadId: session.sessionId, turnId: 'turn-1', itemId: 'reasoning-1', contentIndex: 0, delta: '文件'
  } });
  notificationListener({ method: CODEX_METHODS.reasoningSummaryTextDelta, params: {
    threadId: session.sessionId, turnId: 'turn-1', itemId: 'reasoning-1', summaryIndex: 1, delta: '验证'
  } });
  notificationListener({ method: CODEX_METHODS.reasoningSummaryPartAdded, params: {
    threadId: session.sessionId, turnId: 'turn-1', itemId: 'reasoning-empty'
  } });
  notificationListener({ method: CODEX_METHODS.itemCompleted, params: {
    threadId: session.sessionId, turnId: 'turn-1', completedAtMs: Date.now(),
    item: { id: 'reasoning-empty', type: 'reasoning', summary: [], content: [] }
  } });
  notificationListener({ method: CODEX_METHODS.agentMessageDelta, params: {
    threadId: session.sessionId, turnId: 'turn-1', itemId: 'agent-1', delta: '好'
  } });
  notificationListener({ method: CODEX_METHODS.agentMessageDelta, params: {
    threadId: session.sessionId, turnId: 'turn-1', itemId: 'agent-1', delta: '好'
  } });
  notificationListener({ method: CODEX_METHODS.itemCompleted, params: {
    threadId: session.sessionId, turnId: 'turn-1', completedAtMs: Date.now(),
    item: { id: 'agent-1', type: 'agentMessage', phase: 'final_answer', text: '全部完成' }
  } });

  const updates = events.filter((event) => event.type === 'session.transcript.updated').map((event) => event.payload.entry);
  assert.equal(updates.findLast((entry) => entry.id === 'reasoning-1').summary, '检查\n\n验证');
  assert.equal(updates.findLast((entry) => entry.id === 'reasoning-1').text, '文件');
  const emptyReasoningUpdates = updates.filter((entry) => entry.id === 'reasoning-empty');
  assert.equal(emptyReasoningUpdates[0].status, 'inProgress');
  assert.equal(emptyReasoningUpdates.at(-1).status, undefined);
  assert.equal(emptyReasoningUpdates.at(-1).summary, undefined);
  const agentUpdates = updates.filter((entry) => entry.id === 'agent-1');
  assert.equal(agentUpdates.at(-2).text, '好好');
  assert.equal(agentUpdates.at(-1).text, '全部完成');
  assert.equal(agentUpdates.at(-1).phase, 'final_answer');
  adapter.dispose();
});

test('Codex permission discovery falls back only for an unavailable method and surfaces operational errors', async () => {
  const model = {
    id: 'codex-test', model: 'codex-test', displayName: 'Codex Test', hidden: false,
    isDefault: true, defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }]
  };
  const runtimeFor = (permissionError) => ({
    probe: async () => ({
      authenticated: true,
      models: [model],
      client: {
        onNotification: () => () => undefined,
        onDisconnect: () => () => undefined,
        registerServerRequest: () => () => undefined,
        request: async (method) => {
          if (method === CODEX_METHODS.permissionProfileList) throw permissionError;
          if (method === CODEX_METHODS.threadStart) {
            return { thread: { id: 'thread-discovery' }, model: 'codex-test', reasoningEffort: 'medium' };
          }
          return {};
        }
      }
    })
  });

  const legacyAdapter = new CodexAgentSessionAdapter(runtimeFor(
    new CodexRpcError(-32601, 'Method not found: permissionProfile/list')
  ));
  const legacySession = await legacyAdapter.createSession({
    executionId: 'exec-legacy', workingDirectory: '/workspace', modelId: 'codex-test', effort: 'medium',
    mcpServer: { command: '/usr/bin/node', args: [] }
  });
  assert.equal(legacySession.permissionModeId, 'codex:ask');
  legacyAdapter.dispose();

  const failedAdapter = new CodexAgentSessionAdapter(runtimeFor(new Error('permission service disconnected')));
  await assert.rejects(
    failedAdapter.createSession({
      executionId: 'exec-discovery-failed', workingDirectory: '/workspace', modelId: 'codex-test', effort: 'medium',
      mcpServer: { command: '/usr/bin/node', args: [] }
    }),
    /permission service disconnected/
  );
  failedAdapter.dispose();
});

test('Codex runtime rejects private VS Code extension binaries discovered on PATH', () => {
  const runtime = new CodexRuntimeManager({ storagePath: '/tmp/unused' });
  assert.equal(
    runtime.isPrivateExtensionBinary('/Users/me/.vscode/extensions/openai.chatgpt-1/bin/codex'),
    true
  );
  assert.equal(runtime.isPrivateExtensionBinary('/opt/homebrew/bin/codex'), false);
});

test('Codex authentication uses the app-server browser flow and waits for the matching completion', async () => {
  const listeners = new Set();
  const calls = [];
  const client = {
    onNotification(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onDisconnect: () => () => undefined,
    request: async (method, params) => {
      calls.push({ method, params });
      return {
        type: 'chatgpt',
        loginId: 'login-1',
        authUrl: 'https://chatgpt.com/auth/codex-test'
      };
    }
  };
  const runtime = new CodexRuntimeManager({ storagePath: '/tmp/unused-auth' });
  runtime.probe = async () => ({ authenticated: false, client });
  let invalidated = false;
  runtime.invalidate = () => { invalidated = true; };

  await runtime.authenticate(async (url) => {
    assert.equal(url, 'https://chatgpt.com/auth/codex-test');
    setImmediate(() => {
      for (const listener of listeners) {
        listener({
          method: CODEX_METHODS.accountLoginCompleted,
          params: { loginId: 'login-1', success: true, error: null }
        });
      }
    });
    return true;
  });

  assert.deepEqual(calls, [{
    method: CODEX_METHODS.accountLoginStart,
    params: { type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'codex' }
  }]);
  assert.equal(invalidated, true);
  assert.equal(listeners.size, 0);
});

test('Codex unauthenticated descriptor remains auth_required without calling protected RPCs', async () => {
  let requestCalls = 0;
  const adapter = new CodexAgentSessionAdapter({
    probe: async () => ({
      authenticated: false,
      models: [],
      client: {
        onNotification: () => () => undefined,
        onDisconnect: () => () => undefined,
        registerServerRequest: () => () => undefined,
        request: async () => {
          requestCalls += 1;
          throw new Error('protected RPC should not run');
        }
      }
    })
  });
  const descriptor = await adapter.getDescriptor();
  assert.equal(descriptor.installState, 'auth_required');
  assert.deepEqual(descriptor.permissionModes, []);
  assert.equal(requestCalls, 0);
  adapter.dispose();
});

test('Codex starts a fresh thread once and supplies full trace context on the first turn', async () => {
  const calls = [];
  const client = {
    onNotification: () => () => undefined,
    onDisconnect: () => () => undefined,
    registerServerRequest: () => () => undefined,
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === CODEX_METHODS.permissionProfileList) {
        return { data: [{ id: ':workspace', allowed: true }], nextCursor: null };
      }
      if (method === CODEX_METHODS.configRequirementsRead) {
        return { requirements: { allowedApprovalPolicies: ['on-request'], allowedApprovalsReviewers: ['user'] } };
      }
      if (method === 'thread/start') {
        return { thread: { id: 'thread-fresh' }, model: 'codex-test', reasoningEffort: 'medium' };
      }
      if (method === 'turn/start') {
        return { turn: { id: 'turn-fresh', status: 'inProgress' } };
      }
      if (method === CODEX_METHODS.turnSteer) {
        return { turnId: 'turn-fresh' };
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
  const session = await adapter.createSession({
    executionId: 'exec-fresh', workingDirectory: '/workspace', modelId: 'codex-test', effort: 'medium',
    mcpServer: { command: '/usr/bin/node', args: ['/extension/dist/mcp/server.js'] }
  });

  assert.equal(calls.filter((call) => call.method === 'thread/start').length, 1);
  assert.equal(calls.some((call) => call.method === 'thread/resume'), false);
  assert.match(calls.find((call) => call.method === 'thread/start').params.developerInstructions, /exec-fresh/);
  assert.equal(
    calls.find((call) => call.method === 'thread/start').params.config.model_reasoning_summary,
    'detailed'
  );

  await adapter.send({
    executionId: 'exec-fresh', session, message: 'Run the task', modelId: 'codex-test', effort: 'medium',
    idempotencyKey: 'submission-fresh'
  });
  const turnStart = calls.find((call) => call.method === 'turn/start');
  const trace = JSON.parse(turnStart.params.additionalContext['infinite-map/provider-trace-v1'].value);
  assert.equal(trace.executionId, 'exec-fresh');
  assert.equal(trace.session.sessionId, 'thread-fresh');
  assert.equal(trace.session.threadId, 'thread-fresh');

  await adapter.append({
    executionId: 'exec-fresh', session, message: 'Add context', modelId: 'codex-test', effort: 'medium',
    expectedTurnId: 'turn-fresh', idempotencyKey: 'submission-steer'
  });
  const turnSteer = calls.find((call) => call.method === CODEX_METHODS.turnSteer);
  const steerTrace = JSON.parse(turnSteer.params.additionalContext['infinite-map/provider-trace-v1'].value);
  assert.equal(steerTrace.executionId, 'exec-fresh');
  assert.equal(steerTrace.session.sessionId, 'thread-fresh');
  adapter.dispose();
});

test('Codex resumes restored threads with detailed reasoning summaries enabled', async () => {
  const calls = [];
  const client = {
    onNotification: () => () => undefined,
    onDisconnect: () => () => undefined,
    registerServerRequest: () => () => undefined,
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === CODEX_METHODS.permissionProfileList) {
        return { data: [{ id: ':workspace', allowed: true }], nextCursor: null };
      }
      if (method === CODEX_METHODS.configRequirementsRead) {
        return { requirements: { allowedApprovalPolicies: ['on-request'], allowedApprovalsReviewers: ['user'] } };
      }
      if (method === CODEX_METHODS.threadRead) {
        return { thread: { id: 'thread-restored', turns: [] } };
      }
      if (method === CODEX_METHODS.threadResume) {
        return { thread: { id: 'thread-restored' } };
      }
      if (method === CODEX_METHODS.turnStart) {
        return { turn: { id: 'turn-restored', status: 'inProgress' } };
      }
      return {};
    }
  };
  const adapter = new CodexAgentSessionAdapter({
    probe: async () => ({
      client,
      authenticated: true,
      models: [{
        id: 'codex-test', model: 'codex-test', displayName: 'Codex Test', hidden: false,
        isDefault: true, defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }]
      }]
    })
  });
  const session = {
    provider: 'codex', sessionId: 'thread-restored', threadId: 'thread-restored', surface: 'app-server',
    modelId: 'codex-test', effort: 'medium', permissionModeId: 'codex:ask', openUri: ''
  };

  await adapter.query({ executionId: 'exec-restored', session, workingDirectory: '/workspace' });
  await adapter.send({
    executionId: 'exec-restored', session, message: 'Continue', modelId: 'codex-test', effort: 'medium',
    idempotencyKey: 'submission-restored'
  });

  const resume = calls.find((call) => call.method === CODEX_METHODS.threadResume);
  assert.ok(resume);
  assert.equal(resume.params.config.model_reasoning_summary, 'detailed');
  adapter.dispose();
});

test('Codex preserves the original turn error when a fresh rollout cannot be reconciled', async () => {
  const client = {
    onNotification: () => () => undefined,
    onDisconnect: () => () => undefined,
    registerServerRequest: () => () => undefined,
    request: async (method) => {
      if (method === CODEX_METHODS.permissionProfileList) {
        return { data: [{ id: ':workspace', allowed: true }], nextCursor: null };
      }
      if (method === CODEX_METHODS.configRequirementsRead) {
        return { requirements: { allowedApprovalPolicies: ['on-request'], allowedApprovalsReviewers: ['user'] } };
      }
      if (method === 'thread/start') {
        return { thread: { id: 'thread-no-rollout' }, model: 'codex-test', reasoningEffort: 'medium' };
      }
      if (method === 'turn/start') throw new Error('original turn failure');
      if (method === 'thread/read') throw new Error('no rollout found for thread id thread-no-rollout');
      return {};
    }
  };
  const adapter = new CodexAgentSessionAdapter({
    probe: async () => ({
      client,
      authenticated: true,
      models: [{
        id: 'codex-test', model: 'codex-test', displayName: 'Codex Test', hidden: false,
        isDefault: true, defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }]
      }]
    })
  });
  const session = await adapter.createSession({
    executionId: 'exec-no-rollout', workingDirectory: '/workspace', modelId: 'codex-test', effort: 'medium',
    mcpServer: { command: '/usr/bin/node', args: [] }
  });
  await assert.rejects(
    adapter.send({
      executionId: 'exec-no-rollout', session, message: 'Run', modelId: 'codex-test', effort: 'medium',
      idempotencyKey: 'submission-no-rollout'
    }),
    /original turn failure/
  );
  adapter.dispose();
});

test('Codex Server Request remains pending until InfiniteMap returns the user decision', async () => {
  const handlers = new Map();
  let notificationListener;
  const client = {
    onNotification: (listener) => {
      notificationListener = listener;
      return () => { notificationListener = undefined; };
    },
    onDisconnect: () => () => undefined,
    registerServerRequest: (method, handler) => handlers.set(method, handler),
    request: async (method) => {
      if (method === CODEX_METHODS.permissionProfileList) {
        return { data: [{ id: ':workspace', allowed: true }], nextCursor: null };
      }
      if (method === CODEX_METHODS.configRequirementsRead) {
        return { requirements: { allowedApprovalPolicies: ['on-request'], allowedApprovalsReviewers: ['user'] } };
      }
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
  assert.equal(handlers.has(CODEX_METHODS.requestUserInput), true);
  assert.equal(handlers.has('tool/requestUserInput'), false);
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

  const fileChangeResponse = handlers.get(CODEX_METHODS.fileChangeApproval)({
    threadId: session.sessionId,
    turnId: 'turn-file-change',
    itemId: 'item-file-change',
    reason: 'Update generated files',
    availableDecisions: ['accept', 'decline']
  });
  await new Promise((resolve) => setImmediate(resolve));
  const fileChangeInput = events.filter((event) => event.type === 'session.input.required').at(-1);
  await adapter.respondToInput({
    session,
    requestId: fileChangeInput.payload.requestId,
    decision: 'approve'
  });
  assert.deepEqual(await fileChangeResponse, { decision: 'accept' });

  const questionResponse = handlers.get(CODEX_METHODS.requestUserInput)({
    threadId: session.sessionId,
    turnId: 'turn-question',
    itemId: 'item-question',
    questions: [{ id: 'target', header: 'Target', question: 'Which target?', options: [] }]
  });
  await new Promise((resolve) => setImmediate(resolve));
  const questionInput = events.filter((event) => event.type === 'session.input.required').at(-1);
  await adapter.respondToInput({
    session,
    requestId: questionInput.payload.requestId,
    decision: 'approve',
    value: 'workspace'
  });
  assert.deepEqual(await questionResponse, { answers: { target: { answers: ['workspace'] } } });

  const requestedPermissions = {
    network: { enabled: true },
    fileSystem: { write: ['/workspace/generated'] }
  };
  const permissionResponse = handlers.get(CODEX_METHODS.permissionsApproval)({
    threadId: session.sessionId,
    turnId: 'turn-permissions',
    itemId: 'item-permissions',
    cwd: '/workspace',
    startedAtMs: Date.now(),
    permissions: requestedPermissions
  });
  await new Promise((resolve) => setImmediate(resolve));
  const permissionInput = events.filter((event) => event.type === 'session.input.required').at(-1);
  await adapter.respondToInput({
    session,
    requestId: permissionInput.payload.requestId,
    decision: 'approve'
  });
  assert.deepEqual(await permissionResponse, { permissions: requestedPermissions, scope: 'turn' });

  const deniedPermissions = handlers.get(CODEX_METHODS.permissionsApproval)({
    threadId: session.sessionId,
    turnId: 'turn-permissions-denied',
    itemId: 'item-permissions-denied',
    cwd: '/workspace',
    startedAtMs: Date.now(),
    permissions: requestedPermissions
  });
  await new Promise((resolve) => setImmediate(resolve));
  const deniedInput = events.filter((event) => event.type === 'session.input.required').at(-1);
  await adapter.respondToInput({ session, requestId: deniedInput.payload.requestId, decision: 'deny' });
  assert.deepEqual(await deniedPermissions, { permissions: {}, scope: 'turn' });

  const elicitationResponse = handlers.get(CODEX_METHODS.mcpElicitation)({
    threadId: session.sessionId,
    mode: 'form',
    message: 'Enter a value',
    requestedSchema: { type: 'object' }
  });
  await new Promise((resolve) => setImmediate(resolve));
  const elicitationInput = events.filter((event) => event.type === 'session.input.required').at(-1);
  await adapter.respondToInput({ session, requestId: elicitationInput.payload.requestId, decision: 'deny' });
  assert.deepEqual(await elicitationResponse, { action: 'decline', content: null });

  const autoResolvedResponse = handlers.get(CODEX_METHODS.commandApproval)({
    threadId: session.sessionId,
    turnId: 'turn-auto-resolved',
    itemId: 'item-auto-resolved',
    startedAtMs: Date.now()
  }, 'rpc-auto-resolved');
  await new Promise((resolve) => setImmediate(resolve));
  notificationListener({
    method: CODEX_METHODS.serverRequestResolved,
    params: { threadId: session.sessionId, requestId: 'rpc-auto-resolved' }
  });
  assert.deepEqual(await autoResolvedResponse, { decision: 'decline' });
  assert.deepEqual(events.at(-1).payload, {
    requestId: 'rpc-auto-resolved',
    method: CODEX_METHODS.commandApproval
  });
  assert.equal(events.at(-1).type, 'session.input.resolved');

  notificationListener({
    method: CODEX_METHODS.threadStatusChanged,
    params: { threadId: session.sessionId, status: { type: 'active', activeFlags: [] } }
  });
  assert.equal(events.at(-1).payload.status, 'running');
  assert.deepEqual(events.at(-1).payload.providerThreadStatus, { type: 'active', activeFlags: [] });

  notificationListener({
    method: CODEX_METHODS.turnError,
    params: {
      threadId: session.sessionId,
      turnId: 'turn-failed',
      willRetry: false,
      error: { message: 'Structured output rejected' }
    }
  });
  assert.equal(events.at(-1).payload.status, 'failed');
  assert.equal(events.at(-1).payload.error, 'Structured output rejected');
  adapter.dispose();
});

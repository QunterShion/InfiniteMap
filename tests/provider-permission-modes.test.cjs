const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

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
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      EventEmitter: MockEventEmitter,
      window: {
        createTerminal: () => ({ show() {} })
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { CodexAgentSessionAdapter } = require('../src/providers/codex/CodexAgentSessionAdapter.ts');
const { ClaudeAgentSessionAdapter } = require('../src/providers/claude/ClaudeAgentSessionAdapter.ts');
const { CopilotAgentSessionAdapter } = require('../src/providers/copilot/CopilotAgentSessionAdapter.ts');
Module._load = originalLoad;

const codexModel = {
  id: 'codex-test',
  model: 'codex-test',
  displayName: 'Codex Test',
  hidden: false,
  isDefault: true,
  defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced reasoning with a longer explanatory label' }]
};

test('Codex exposes only policy-allowed profiles and applies the selected profile to thread and turn RPCs', async () => {
  const calls = [];
  const client = {
    onNotification: () => () => undefined,
    onDisconnect: () => () => undefined,
    registerServerRequest: () => () => undefined,
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'permissionProfile/list') {
        return {
          data: [
            { id: ':read-only', description: 'Inspect only', allowed: true },
            { id: ':workspace', description: 'Current workspace', allowed: true },
            { id: ':danger-full-access', description: 'All local files', allowed: true },
            { id: 'team-safe', description: 'Team profile', allowed: true },
            { id: 'blocked-profile', description: 'Blocked', allowed: false }
          ],
          nextCursor: null
        };
      }
      if (method === 'configRequirements/read') {
        return {
          requirements: {
            allowedApprovalPolicies: ['on-request', 'never'],
            allowedApprovalsReviewers: ['user'],
            defaultPermissions: ':workspace'
          }
        };
      }
      if (method === 'thread/start') {
        return { thread: { id: 'thread-permissions' }, model: 'codex-test', reasoningEffort: 'medium' };
      }
      if (method === 'turn/start') {
        return { turn: { id: 'turn-permissions', status: 'inProgress' } };
      }
      return {};
    }
  };
  const adapter = new CodexAgentSessionAdapter({
    probe: async () => ({ client, authenticated: true, models: [codexModel] })
  });

  const modes = await adapter.listPermissionModes({ workingDirectory: '/workspace' });
	const models = await adapter.listModels();
	assert.equal(models[0].effortOptions[0].label, 'Medium');
  assert.deepEqual(
    modes.map((mode) => mode.id),
    ['codex:read-only', 'codex:ask', 'codex:full-access', 'codex:profile:team-safe']
  );
  assert.equal(modes.find((mode) => mode.isDefault).id, 'codex:ask');
	assert.equal(modes.some((mode) => mode.label === ':danger-full-access'), false);
  assert.equal(modes.some((mode) => mode.id === 'codex:approve-for-me'), false);
  assert.equal(modes.some((mode) => mode.id.includes('blocked-profile')), false);

  const session = await adapter.createSession({
    executionId: 'exec-codex-permissions',
    workingDirectory: '/workspace',
    modelId: 'codex-test',
    effort: 'medium',
    permissionModeId: 'codex:full-access',
    mcpServer: { command: '/usr/bin/node', args: ['/extension/dist/mcp/server.js'] }
  });
  const threadStart = calls.find((call) => call.method === 'thread/start');
  assert.equal(threadStart.params.permissions, ':danger-full-access');
  assert.equal(threadStart.params.approvalPolicy, 'never');
  assert.equal(threadStart.params.approvalsReviewer, 'user');
  assert.equal(session.permissionModeId, 'codex:full-access');

  await adapter.send({
    executionId: 'exec-codex-permissions',
    session,
    message: 'continue',
    modelId: 'codex-test',
    effort: 'medium',
    permissionModeId: 'codex:ask',
    idempotencyKey: 'submission-permissions'
  });
  const turnStart = calls.find((call) => call.method === 'turn/start');
  assert.equal(turnStart.params.permissions, ':workspace');
  assert.equal(turnStart.params.approvalPolicy, 'on-request');
  assert.equal(turnStart.params.approvalsReviewer, 'user');
  assert.equal(session.permissionModeId, 'codex:ask');

  await assert.rejects(
    adapter.createSession({
      executionId: 'exec-unsupported',
      workingDirectory: '/workspace',
      modelId: 'codex-test',
      permissionModeId: 'codex:profile:blocked-profile',
      mcpServer: { command: '/usr/bin/node', args: [] }
    }),
    (error) => error.code === 'PERMISSION_MODE_UNAVAILABLE'
  );
  adapter.dispose();
});

test('Claude maps the opaque Provider option to SDK permissionMode and explicit bypass opt-in', async () => {
  let queryInput;
  const sdk = {
    query(input) {
      queryInput = input;
      return {
        close() {},
        async *[Symbol.asyncIterator]() {}
      };
    },
    renameSession: async () => undefined
  };
  const adapter = new ClaudeAgentSessionAdapter({
    executable: process.execPath,
    secretStorage: { get: async () => 'test-api-key' },
    sdkLoader: async () => sdk
  });
  const session = await adapter.createSession({
    executionId: 'exec-claude-permissions',
    workingDirectory: '/workspace',
    modelId: 'claude-sonnet-4-6',
    effort: 'high',
    permissionModeId: 'claude:bypass',
    mcpServer: { command: '/usr/bin/node', args: [] }
  });
  await adapter.send({
    executionId: 'exec-claude-permissions',
    session,
    message: 'continue',
    modelId: 'claude-sonnet-4-6',
    effort: 'high',
    permissionModeId: 'claude:bypass',
    idempotencyKey: 'claude-permissions'
  });
  assert.equal(queryInput.options.permissionMode, 'bypassPermissions');
  assert.equal(queryInput.options.allowDangerouslySkipPermissions, true);
  assert.equal(session.permissionModeId, 'claude:bypass');
  await assert.rejects(
    adapter.createSession({
      executionId: 'exec-claude-unsupported',
      workingDirectory: '/workspace',
      modelId: 'claude-sonnet-4-6',
      permissionModeId: 'codex:ask',
      mcpServer: { command: '/usr/bin/node', args: [] }
    }),
    (error) => error.code === 'PERMISSION_MODE_UNAVAILABLE'
  );
  adapter.dispose();
});

function copilotProbe(configs) {
  const sdkSession = {
    on: () => () => undefined,
    send: async () => 'copilot-turn',
    setModel: async () => undefined,
    abort: async () => undefined,
    disconnect: async () => undefined
  };
  return {
    authenticated: true,
    models: [{
      id: 'copilot-test',
      name: 'Copilot Test',
      policy: { state: 'enabled' },
      supportedReasoningEfforts: ['medium'],
      defaultReasoningEffort: 'medium'
    }],
    client: {
      createSession: async (config) => {
        configs.push(config);
        return { ...sdkSession, sessionId: config.sessionId };
      }
    }
  };
}

test('Copilot emulates approve-all, denies explicitly, and falls back to UI approval for managed policy', async () => {
  const configs = [];
  const probe = copilotProbe(configs);
  const adapter = new CopilotAgentSessionAdapter({ ensureProbe: async () => probe });
  const events = [];
  adapter.onDidEvent((event) => events.push(event));
  const session = await adapter.createSession({
    executionId: 'exec-copilot-permissions',
    workingDirectory: '/workspace',
    modelId: 'copilot-test',
    effort: 'medium',
    permissionModeId: 'copilot:approve-all',
    mcpServer: { command: '/usr/bin/node', args: [] }
  });
  assert.deepEqual(
    await configs[0].onPermissionRequest(
      { kind: 'shell', managedApprovalRequired: false },
      { sessionId: session.sessionId, managedSettingsEnabled: false }
    ),
    { kind: 'approve-once' }
  );

  const managedDecision = configs[0].onPermissionRequest(
    { kind: 'shell', managedApprovalRequired: true },
    { sessionId: session.sessionId, managedSettingsEnabled: true }
  );
  const managedEvent = events.find((event) => event.type === 'session.input.required');
  assert.equal(managedEvent.payload.fallback.requestedModeId, 'copilot:approve-all');
  assert.equal(managedEvent.payload.fallback.effectiveModeId, 'copilot:ask');
  await adapter.respondToInput({
    session,
    requestId: managedEvent.payload.requestId,
    decision: 'deny'
  });
  assert.deepEqual(await managedDecision, { kind: 'reject', feedback: 'Denied by the user.' });
  adapter.dispose();

  const denyConfigs = [];
  const denyProbe = copilotProbe(denyConfigs);
  const denyAdapter = new CopilotAgentSessionAdapter({ ensureProbe: async () => denyProbe });
  const denySession = await denyAdapter.createSession({
    executionId: 'exec-copilot-deny',
    workingDirectory: '/workspace',
    modelId: 'copilot-test',
    permissionModeId: 'copilot:deny',
    mcpServer: { command: '/usr/bin/node', args: [] }
  });
  assert.deepEqual(
    await denyConfigs[0].onPermissionRequest(
      { kind: 'write' },
      { sessionId: denySession.sessionId, managedSettingsEnabled: false }
    ),
    { kind: 'reject', feedback: 'Denied by the selected permission mode.' }
  );
  denyAdapter.dispose();
});

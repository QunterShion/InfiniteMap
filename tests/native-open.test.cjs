const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

function loadResolver({ extensions = [], commands = [], executeCommand, configuration = {} } = {}) {
  const executed = [];
  const vscode = {
    extensions: {
      all: extensions,
      getExtension: (id) => extensions.find((extension) => extension.id === id),
      onDidChange: () => ({ dispose() {} }),
    },
    workspace: {
      getConfiguration: () => ({ get: (key, fallback) => Object.prototype.hasOwnProperty.call(configuration, key) ? configuration[key] : fallback }),
    },
    Uri: {
      from: (components) => ({ ...components, toString: () => `${components.scheme}://${components.authority}${components.path}` }),
    },
    commands: {
      getCommands: async () => typeof commands === 'function' ? commands() : commands,
      executeCommand: async (...args) => {
        executed.push(args);
        return executeCommand ? executeCommand(...args) : undefined;
      },
    },
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve('../src/sessions/nativeOpenResolver.ts')];
  require('ts-node/register/transpile-only');
  const { NativeOpenResolver } = require('../src/sessions/nativeOpenResolver.ts');
  Module._load = originalLoad;
  return { NativeOpenResolver, executed };
}

function session(provider, id) {
  return {
    provider,
    sessionId: id,
    threadId: id,
    surface: provider === 'codex' ? 'app-server' : 'claude-agent-sdk',
    openUri: `vscode://chanterxiao.infinite-map/session/open?v=1&executionId=exec-1`,
  };
}

test('Codex native opener probes the declared private editor and encodes the thread URI', async () => {
  const { NativeOpenResolver, executed } = loadResolver({
    extensions: [{
      id: 'openai.chatgpt',
      packageJSON: {
        version: '26.5825.51511',
        contributes: { customEditors: [{ viewType: 'chatgpt.conversationEditor', selector: [{ filenamePattern: 'openai-codex:/**/*' }] }] },
      },
    }],
  });
  const resolver = new NativeOpenResolver({ log: () => undefined });
  const value = session('codex', 'thread:one');
  const result = await resolver.open({ executionId: 'exec-1', session: value });
  assert.equal(result.opened, true);
  assert.equal(result.method, 'provider-uri');
  assert.equal(executed[0][0], 'vscode.openWith');
  assert.equal(executed[0][1].scheme, 'openai-codex');
  assert.equal(executed[0][1].path, '/local/thread%3Aone');
  assert.equal(executed[0][2], 'chatgpt.conversationEditor');
  assert.equal(value.nativeOpen.contract, 'codex-vscode-private-uri-v1');
  resolver.dispose();
});

test('Claude native opener only runs the verified command and passes the canonical session ID', async () => {
  const { NativeOpenResolver, executed } = loadResolver({
    extensions: [{ id: 'anthropic.claude-code', packageJSON: { version: '2.1.259' } }],
    commands: ['claude-vscode.primaryEditor.open'],
  });
  const resolver = new NativeOpenResolver({ log: () => undefined });
  const result = await resolver.open({ executionId: 'exec-2', session: session('claudecode', 'claude-2') });
  assert.equal(result.opened, true);
  assert.equal(result.method, 'provider-command');
  assert.deepEqual(executed[0], ['claude-vscode.primaryEditor.open', 'claude-2']);
  resolver.dispose();
});

test('Copilot is explicitly unsupported and feature flag disables native probing', async () => {
  const loaded = loadResolver();
  const resolver = new loaded.NativeOpenResolver({ log: () => undefined });
  await assert.rejects(
    resolver.open({ executionId: 'exec-3', session: session('copilot', 'copilot-3') }),
    (error) => error.code === 'NATIVE_OPEN_UNSUPPORTED'
  );
  resolver.dispose();

  const disabled = loadResolver({ configuration: { nativeOpenEnabled: false } });
  const disabledResolver = new disabled.NativeOpenResolver({ log: () => undefined });
  const capability = await disabledResolver.probe({
    provider: 'codex',
    session: session('codex', 'thread-disabled'),
    requestedTarget: 'provider-ide',
  });
  assert.equal(capability.available, false);
  assert.equal(capability.errorCode, 'NATIVE_OPEN_UNSUPPORTED');
  disabledResolver.dispose();
});

test('native probes fail closed for missing clients, incompatible versions, and missing commands', async () => {
  const missing = loadResolver();
  const missingResolver = new missing.NativeOpenResolver({ log: () => undefined });
  await assert.rejects(
    missingResolver.open({ executionId: 'exec-missing', session: session('codex', 'thread-missing') }),
    (error) => error.code === 'NATIVE_CLIENT_MISSING' && error.retryable === false
  );
  missingResolver.dispose();

  const incompatible = loadResolver({
    extensions: [{
      id: 'openai.chatgpt',
      packageJSON: {
        version: '25.9.0',
        contributes: { customEditors: [{ viewType: 'chatgpt.conversationEditor', selector: [{ filenamePattern: 'openai-codex:/**/*' }] }] },
      },
    }],
  });
  const incompatibleResolver = new incompatible.NativeOpenResolver({ log: () => undefined });
  await assert.rejects(
    incompatibleResolver.open({ executionId: 'exec-incompatible', session: session('codex', 'thread-incompatible') }),
    (error) => error.code === 'NATIVE_CLIENT_INCOMPATIBLE' && error.retryable === false
  );
  incompatibleResolver.dispose();

  const commandMissing = loadResolver({
    extensions: [{ id: 'anthropic.claude-code', packageJSON: { version: '2.1.259' } }],
    commands: [],
  });
  const commandMissingResolver = new commandMissing.NativeOpenResolver({ log: () => undefined });
  await assert.rejects(
    commandMissingResolver.open({ executionId: 'exec-command-missing', session: session('claudecode', 'claude-command-missing') }),
    (error) => error.code === 'NATIVE_CLIENT_INCOMPATIBLE' && error.retryable === false
  );
  commandMissingResolver.dispose();
});

test('failed native execution invalidates the capability cache before retrying', async () => {
  let probeCalls = 0;
  let executeCalls = 0;
  const loaded = loadResolver({
    extensions: [{ id: 'anthropic.claude-code', packageJSON: { version: '2.1.259' } }],
    commands: () => {
      probeCalls += 1;
      return ['claude-vscode.primaryEditor.open'];
    },
    executeCommand: () => {
      executeCalls += 1;
      if (executeCalls === 1) throw new Error('command rejected');
    },
  });
  const resolver = new loaded.NativeOpenResolver({ log: () => undefined });
  const value = session('claudecode', 'claude-retry');
  await assert.rejects(
    resolver.open({ executionId: 'exec-retry', session: value }),
    (error) => error.code === 'NATIVE_OPEN_FAILED' && error.retryable === true
  );
  const result = await resolver.open({ executionId: 'exec-retry', session: value });
  assert.equal(result.opened, true);
  assert.equal(probeCalls, 2);
  assert.equal(executeCalls, 2);
  resolver.dispose();
});

test('native-open audit logs hash the canonical session ID instead of recording it', async () => {
  const entries = [];
  const { NativeOpenResolver } = loadResolver({
    extensions: [{ id: 'anthropic.claude-code', packageJSON: { version: '2.1.259' } }],
    commands: ['claude-vscode.primaryEditor.open'],
  });
  const resolver = new NativeOpenResolver({ log: (entry) => entries.push(entry) });
  await resolver.open({ executionId: 'exec-audit', session: session('claudecode', 'private-session-id') });
  assert.deepEqual(entries.map((entry) => entry.phase), ['attempted', 'accepted']);
  assert.ok(entries.every((entry) => /^[a-f0-9]{16}$/.test(entry.sessionIdHash)));
  assert.ok(entries.every((entry) => !JSON.stringify(entry).includes('private-session-id')));
  resolver.dispose();
});

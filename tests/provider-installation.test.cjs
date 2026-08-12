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

  fire(value) {
    for (const listener of this.listeners) listener(value);
  }

  dispose() {
    this.listeners.clear();
  }
}

const progressReports = [];
const vscode = {
  EventEmitter: MockEventEmitter,
  ProgressLocation: { Notification: 15 },
  window: {
    withProgress: async (options, task) => {
      assert.equal(options.location, 15);
      assert.equal(options.cancellable, false);
      assert.equal(options.title, 'InfiniteMap · Codex');
      return task({ report: (value) => progressReports.push(value) });
    },
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
require('ts-node/register/transpile-only');
const { ProviderComponentRegistry } = require('../src/providers/providerComponentRegistry.ts');
Module._load = originalLoad;

function readyDescriptor() {
  return {
    id: 'codex',
    displayName: 'Codex',
    componentExtensionId: 'chanterxiao.infinite-map',
    installState: 'ready',
    models: [],
    capabilities: { availability: 'ready' },
  };
}

function createHarness(initiallyInstalled) {
  let installed = initiallyInstalled;
  let installCalls = 0;
  const installer = {
    executablePath: '/managed/infinite-map/codex',
    isInstalled: async () => installed,
    install: async (onStage) => {
      installCalls += 1;
      onStage('downloading');
      onStage('installing');
      installed = true;
      return installer.executablePath;
    },
  };
  const component = {
    apiVersion: '1',
    getDescriptor: async () => readyDescriptor(),
    createAdapter: async () => ({}),
  };
  const registry = new ProviderComponentRegistry({
    storagePath: '/managed/infinite-map',
    installer,
    componentFactory: () => component,
  });
  return { registry, getInstallCalls: () => installCalls };
}

test.beforeEach(() => {
  progressReports.length = 0;
});

test('all three missing Providers are represented as built-in runtimes instead of Marketplace extensions', async () => {
  const { registry } = createHarness(false);
  const descriptors = await registry.discover();

  assert.deepEqual(descriptors.map((descriptor) => descriptor.id), ['codex', 'claudecode', 'copilot']);
  assert.ok(descriptors.every((descriptor) => descriptor.componentExtensionId === 'chanterxiao.infinite-map'));
  assert.ok(descriptors.every((descriptor) => descriptor.installState === 'missing'));
  registry.dispose();
});

test('provider install downloads, installs, and verifies Codex Server inside InfiniteMap', async () => {
  const { registry, getInstallCalls } = createHarness(false);
  const phases = [];
  const installation = await registry.openInstallation('codex', (phase) => phases.push(phase));

  assert.equal(getInstallCalls(), 1);
  assert.equal(installation.providerId, 'codex');
  assert.equal(installation.descriptor.installState, 'ready');
  assert.equal(installation.alreadyInstalled, false);
  assert.deepEqual(phases, ['opening', 'waiting', 'verifying']);
  assert.deepEqual(progressReports.map((report) => report.increment), [33, 33, 34]);
  registry.dispose();
});

test('an installed Codex Server is verified without downloading or opening Extensions', async () => {
  const { registry, getInstallCalls } = createHarness(true);
  const phases = [];
  const installation = await registry.openInstallation('codex', (phase) => phases.push(phase));

  assert.equal(getInstallCalls(), 0);
  assert.equal(installation.alreadyInstalled, true);
  assert.deepEqual(phases, ['verifying']);
  assert.deepEqual(progressReports, []);
  registry.dispose();
});

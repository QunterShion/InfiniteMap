const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('webview startup and refresh imports expose explicit protocol acknowledgements', async () => {
  const postedMessages = [];
  const windowListeners = new Map();
  let controllerFactory;
  const importedData = [];

  const moduleApi = {
    config(handler) {
      handler({ set: () => undefined });
      return moduleApi;
    },
    controller(_name, handler) {
      controllerFactory = handler;
      return moduleApi;
    },
  };

  const window = {
    crypto: { randomUUID: () => 'webview-session' },
    vscode: {
      getState: () => ({}),
      postMessage: (message) => postedMessages.push(message),
    },
    addEventListener: (name, handler) => windowListeners.set(name, handler),
    clearTimeout: () => undefined,
    setTimeout: (handler) => {
      handler();
      return 1;
    },
  };

  const jquery = () => ({ on: () => undefined });
  const source = fs.readFileSync(path.resolve(__dirname, '../webui/main.js'), 'utf8');
  vm.runInNewContext(source, {
    angular: { module: () => moduleApi },
    atob: () => '',
    console,
    document: {},
    Uint8Array,
    window,
    $: jquery,
  });

  assert.equal(typeof controllerFactory, 'function');
  const scope = {};
  controllerFactory(scope);
  scope.initEditor({}, {
    on: () => undefined,
    importJson(data) {
      if (data.fail) throw new Error('invalid map');
      importedData.push(data);
    },
  });

  assert.equal(windowListeners.has('message'), true);
  assert.equal(postedMessages.length, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(postedMessages[0])),
    {
      command: 'loaded',
      webviewSessionId: 'webview-session',
      timestamp: postedMessages[0].timestamp,
    }
  );
  assert.equal(window.mindmapSuppressDraft, false);
  assert.equal(Number.isNaN(Date.parse(postedMessages[0].timestamp)), false);

  const messageHandler = windowListeners.get('message');
  messageHandler({
    data: {
      command: 'import',
      extName: '.km',
      importData: '{"root":{"data":{"text":"refreshed"}}}',
      importRequestId: 'refresh-1',
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(importedData)), [{ root: { data: { text: 'refreshed' } } }]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(postedMessages.at(-1))),
    { command: 'importResult', importRequestId: 'refresh-1', ok: true }
  );

  messageHandler({
    data: {
      command: 'import',
      extName: '.km',
      importData: '{"fail":true}',
      importRequestId: 'refresh-2',
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(postedMessages.at(-1).command, 'importResult');
  assert.equal(postedMessages.at(-1).importRequestId, 'refresh-2');
  assert.equal(postedMessages.at(-1).ok, false);
  assert.equal(window.mindmapSuppressDraft, false);
});

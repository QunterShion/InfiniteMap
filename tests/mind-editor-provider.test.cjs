const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL, fileURLToPath } = require('node:url');

class MockUri {
  constructor(fsPath) {
    this.fsPath = fsPath;
    this.path = fsPath;
  }

  toString() {
    return pathToFileURL(this.fsPath).toString();
  }

  static file(fsPath) {
    return new MockUri(fsPath);
  }

  static parse(value) {
    return new MockUri(value.startsWith('file:') ? fileURLToPath(value) : value);
  }
}

class MockEventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose: () => undefined };
    };
  }

  fire(value) {
    for (const listener of this.listeners) listener(value);
  }
}

const vscode = {
  CancellationToken: { None: undefined },
  EventEmitter: MockEventEmitter,
  Uri: MockUri,
  commands: { executeCommand: async () => undefined },
  env: { language: 'en' },
  extensions: { all: [] },
  workspace: {
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
  },
  window: {
    registerCustomEditorProvider: () => ({ dispose: () => undefined }),
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
require('ts-node/register/transpile-only');
const { MindEditorProvider } = require('../src/mindEditor.ts');
Module._load = originalLoad;

function cancellationToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  };
}

function createPanel() {
  const sent = [];
  const disposeHandlers = [];
  let messageHandler;
  let saveDelivery = true;
  const webview = {
    cspSource: 'mock-csp',
    html: '',
    options: {},
    asWebviewUri: (uri) => uri,
    onDidReceiveMessage: (handler) => {
      messageHandler = handler;
      return { dispose: () => undefined };
    },
    postMessage: async (message) => {
      sent.push(message);
      return message.command === 'requestSave' ? saveDelivery : true;
    },
  };
  return {
    panel: {
      webview,
      dispose: () => disposeHandlers.forEach((handler) => handler()),
      onDidDispose: (handler) => {
        disposeHandlers.push(handler);
        return { dispose: () => undefined };
      },
    },
    sent,
    dispatch: (message) => messageHandler(message),
    setSaveDelivery: (value) => {
      saveDelivery = value;
    },
  };
}

test('custom document keeps drafts in memory and completes the save contract', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-provider-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const sourcePath = path.join(tempDir, 'source.km');
  const backupPath = path.join(tempDir, 'backup', 'source.km');
  const saveAsPath = path.join(tempDir, 'saved-as.km');
  const original = '{"root":{"data":{"text":"original"}}}';
  const firstDraft = '{"root":{"data":{"text":"draft"}}}';
  const secondDraft = '{"root":{"data":{"text":"second"}}}';
  fs.writeFileSync(sourcePath, original);

  const context = { extensionPath: path.resolve(__dirname, '..'), subscriptions: [] };
  const provider = new MindEditorProvider(context);
  const document = await provider.openCustomDocument(MockUri.file(sourcePath), {
    backupId: undefined,
    untitledDocumentData: undefined,
  });
  const panel = createPanel();
  t.after(() => panel.panel.dispose());
  await provider.resolveCustomEditor(document, panel.panel);

  let changeCount = 0;
  provider.onDidChangeCustomDocument(() => {
    changeCount += 1;
  });

  await panel.dispatch({ command: 'draft', exportData: firstDraft });
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), original);
  assert.equal(changeCount, 1);

  const save = provider.saveCustomDocument(document, cancellationToken());
  assert.equal(panel.sent.at(-1).command, 'requestSave');
  await panel.dispatch({ command: 'save', exportData: firstDraft });
  await save;
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), firstDraft);

  await panel.dispatch({ command: 'draft', exportData: secondDraft });
  await provider.backupCustomDocument(
    document,
    { destination: MockUri.file(backupPath) },
    cancellationToken()
  );
  assert.equal(fs.readFileSync(backupPath, 'utf8'), secondDraft);

  await provider.revertCustomDocument(document, cancellationToken());
  assert.equal(panel.sent.at(-1).command, 'import');
  assert.equal(panel.sent.at(-1).importData, firstDraft);

  await panel.dispatch({ command: 'draft', exportData: secondDraft });
  const saveAs = provider.saveCustomDocumentAs(document, MockUri.file(saveAsPath), cancellationToken());
  await panel.dispatch({ command: 'save', exportData: secondDraft });
  await saveAs;
  assert.equal(fs.readFileSync(saveAsPath, 'utf8'), secondDraft);

  panel.setSaveDelivery(false);
  await assert.rejects(
    provider.saveCustomDocument(document, cancellationToken()),
    /not delivered/
  );

  document.dispose();
});

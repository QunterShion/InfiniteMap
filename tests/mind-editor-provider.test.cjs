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
    this.scheme = 'file';
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

class MockRelativePattern {
  constructor(base, pattern) {
    this.base = base;
    this.pattern = pattern;
  }
}

class MockFileSystemWatcher {
  constructor() {
    this.changeHandlers = [];
    this.createHandlers = [];
    this.deleteHandlers = [];
    this.disposed = false;
  }

  onDidChange(handler) {
    this.changeHandlers.push(handler);
    return { dispose: () => undefined };
  }

  onDidCreate(handler) {
    this.createHandlers.push(handler);
    return { dispose: () => undefined };
  }

  onDidDelete(handler) {
    this.deleteHandlers.push(handler);
    return { dispose: () => undefined };
  }

  async fireChange(uri) {
    await Promise.all(this.changeHandlers.map((handler) => handler(uri)));
  }

  dispose() {
    this.disposed = true;
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

const fileSystemWatchers = [];
const warningMessages = [];
const errorMessages = [];
const vscode = {
  CancellationToken: { None: undefined },
  EventEmitter: MockEventEmitter,
  RelativePattern: MockRelativePattern,
  Uri: MockUri,
  commands: { executeCommand: async () => undefined },
  env: { language: 'en' },
  extensions: { all: [] },
  workspace: {
    createFileSystemWatcher: () => {
      const watcher = new MockFileSystemWatcher();
      fileSystemWatchers.push(watcher);
      return watcher;
    },
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
  },
  window: {
    registerCustomEditorProvider: () => ({ dispose: () => undefined }),
    showErrorMessage: async (message) => {
      errorMessages.push(message);
      return undefined;
    },
    showWarningMessage: async (message) => {
      warningMessages.push(message);
      return undefined;
    },
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

test('reloads clean documents after external edits and blocks conflicting saves', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-external-change-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const sourcePath = path.join(tempDir, 'source.km');
  const original = '{"root":{"data":{"text":"original"}}}';
  const externalClean = '{"root":{"data":{"text":"external-clean"}}}';
  const localDraft = '{"root":{"data":{"text":"local-draft"}}}';
  const externalConflict = '{"root":{"data":{"text":"external-conflict"}}}';
  const raceDraft = '{"root":{"data":{"text":"race-draft"}}}';
  const raceExternal = '{"root":{"data":{"text":"race-external"}}}';
  fs.writeFileSync(sourcePath, original);

  const watcherIndex = fileSystemWatchers.length;
  const context = { extensionPath: path.resolve(__dirname, '..'), subscriptions: [] };
  const provider = new MindEditorProvider(context);
  const document = await provider.openCustomDocument(MockUri.file(sourcePath), {
    backupId: undefined,
    untitledDocumentData: undefined,
  });
  const watcher = fileSystemWatchers[watcherIndex];
  const panel = createPanel();
  t.after(() => panel.panel.dispose());
  await provider.resolveCustomEditor(document, panel.panel);

  fs.writeFileSync(sourcePath, externalClean);
  await watcher.fireChange(MockUri.file(sourcePath));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(panel.sent.at(-1).command, 'import');
  assert.equal(panel.sent.at(-1).importData, externalClean);

  await panel.dispatch({ command: 'draft', exportData: localDraft });
  fs.writeFileSync(sourcePath, externalConflict);
  await watcher.fireChange(MockUri.file(sourcePath));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match(warningMessages.at(-1), /unsaved changes/);

  await assert.rejects(
    provider.saveCustomDocument(document, cancellationToken()),
    /changed on disk/
  );
  assert.match(errorMessages.at(-1), /changed on disk/);
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), externalConflict);

  await provider.revertCustomDocument(document, cancellationToken());
  assert.equal(panel.sent.at(-1).command, 'import');
  assert.equal(panel.sent.at(-1).importData, externalConflict);

  await panel.dispatch({ command: 'draft', exportData: raceDraft });
  fs.writeFileSync(sourcePath, raceExternal);
  const racedSave = provider.saveCustomDocument(document, cancellationToken());
  await panel.dispatch({ command: 'save', exportData: raceDraft });
  await assert.rejects(racedSave, /changed on disk/);
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), raceExternal);

  document.dispose();
  assert.equal(watcher.disposed, true);
});

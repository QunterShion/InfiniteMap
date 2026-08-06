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
const executedCommands = [];
const commandHandlers = new Map();
const tabChangeHandlers = new Set();
const tabGroups = {
  all: [],
  onDidChangeTabs: (handler) => {
    tabChangeHandlers.add(handler);
    return { dispose: () => tabChangeHandlers.delete(handler) };
  },
};
let nextWarningAction;
let nextSaveDialogUri;
const saveDialogOptions = [];
const vscode = {
  CancellationToken: { None: undefined },
  EventEmitter: MockEventEmitter,
  RelativePattern: MockRelativePattern,
  Uri: MockUri,
  commands: {
    executeCommand: async (...args) => {
      executedCommands.push(args);
      const handler = commandHandlers.get(args[0]);
      if (handler) return handler(...args.slice(1));
      return undefined;
    },
  },
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
    tabGroups,
    showErrorMessage: async (message) => {
      errorMessages.push(message);
      return undefined;
    },
    showSaveDialog: async (options) => {
      saveDialogOptions.push(options);
      const result = nextSaveDialogUri;
      nextSaveDialogUri = undefined;
      return result;
    },
    showWarningMessage: async (message) => {
      warningMessages.push(message);
      const action = nextWarningAction;
      nextWarningAction = undefined;
      return action;
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

async function waitForSentMessage(panel, predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const message = panel.sent.find(predicate);
    if (message) return message;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for a Webview message.');
}

function createPanel({ initialHtml = '', visible = true } = {}) {
  const sent = [];
  const disposeHandlers = new Set();
  const viewStateHandlers = new Set();
  const messageHandlers = new Set();
  const htmlAssignments = [];
  const messageDelivery = new Map();
  let saveDelivery = true;
  let html = initialHtml;
  const webview = {
    cspSource: 'mock-csp',
    options: {},
    asWebviewUri: (uri) => uri,
    onDidReceiveMessage: (handler) => {
      messageHandlers.add(handler);
      return { dispose: () => messageHandlers.delete(handler) };
    },
    postMessage: async (message) => {
      sent.push(message);
      if (messageDelivery.has(message.command)) {
        return messageDelivery.get(message.command);
      }
      return message.command === 'requestSave' ? saveDelivery : true;
    },
  };
  Object.defineProperty(webview, 'html', {
    get: () => html,
    set: (value) => {
      html = value;
      htmlAssignments.push(value);
    },
  });
  let disposeCount = 0;
  const panel = {
    webview,
    active: visible,
    visible,
    viewColumn: 1,
    dispose: () => {
      disposeCount += 1;
      disposeHandlers.forEach((handler) => handler());
    },
    onDidDispose: (handler) => {
      disposeHandlers.add(handler);
      return { dispose: () => disposeHandlers.delete(handler) };
    },
    onDidChangeViewState: (handler) => {
      viewStateHandlers.add(handler);
      return { dispose: () => viewStateHandlers.delete(handler) };
    },
  };
  return {
    panel,
    sent,
    htmlAssignments,
    dispatch: async (message) => Promise.all(Array.from(messageHandlers, (handler) => handler(message))),
    getMessageHandlerCount: () => messageHandlers.size,
    getDisposeCount: () => disposeCount,
    setMessageDelivery: (command, value) => {
      messageDelivery.set(command, value);
    },
    setSaveDelivery: (value) => {
      saveDelivery = value;
    },
    setVisible: async (value) => {
      panel.visible = value;
      panel.active = value;
      await Promise.all(Array.from(viewStateHandlers, (handler) => handler({ webviewPanel: panel })));
    },
  };
}

test('detects an unrebound custom editor without reopening or replacing its tab', async () => {
  const uri = MockUri.file('/workspace/recovery.km');
  tabGroups.all = [{
    tabs: [{
      input: { uri, viewType: 'infinite-map.editor' },
      isActive: true,
      isDirty: true,
      label: 'recovery.km',
    }],
  }];
  const provider = new MindEditorProvider({ extensionPath: path.resolve(__dirname, '..'), subscriptions: [] });
  const warnedUris = new Set();
  const warningCountBefore = warningMessages.length;
  const reloadCountBefore = executedCommands.filter(([command]) => command === 'workbench.action.reloadWindow').length;

  nextWarningAction = 'Reload Window';
  provider.scanForUnreboundEditors(tabGroups, 'test', warnedUris);
  provider.scanForUnreboundEditors(tabGroups, 'test-repeat', warnedUris);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(warningMessages.length, warningCountBefore + 1);
  assert.match(warningMessages.at(-1), /did not reattach/);
  assert.equal(
    executedCommands.filter(([command]) => command === 'workbench.action.reloadWindow').length,
    reloadCountBefore + 1
  );
  assert.equal(executedCommands.some(([command]) => command === 'vscode.openWith'), false);
  tabGroups.all = [];
});

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
  await panel.dispatch({ command: 'ready' });
  assert.equal(panel.sent.filter((message) => message.command === 'import').at(-1).command, 'import');

  let changeCount = 0;
  provider.onDidChangeCustomDocument(() => {
    changeCount += 1;
  });

  await panel.dispatch({ command: 'draft', exportData: firstDraft });
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), original);
  assert.equal(changeCount, 1);

  const save = provider.saveCustomDocument(document, cancellationToken());
  const firstSaveRequest = panel.sent.at(-1);
  assert.equal(firstSaveRequest.command, 'requestSave');
  await panel.dispatch({ command: 'save', requestId: firstSaveRequest.requestId, exportData: firstDraft });
  await save;
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), firstDraft);
  assert.equal(fs.existsSync(sourcePath), true, 'editing the root must keep the current KM filename');
  assert.equal(fs.existsSync(path.join(tempDir, 'draft.km')), false, 'saving a root edit must not rename the KM file');

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
  const saveAsRequest = panel.sent.at(-1);
  await panel.dispatch({ command: 'save', requestId: saveAsRequest.requestId, exportData: secondDraft });
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
  await panel.dispatch({ command: 'loaded' });

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
  const raceSaveRequest = panel.sent.at(-1);
  await panel.dispatch({ command: 'save', requestId: raceSaveRequest.requestId, exportData: raceDraft });
  await assert.rejects(racedSave, /changed on disk/);
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), raceExternal);

  document.dispose();
  assert.equal(watcher.disposed, true);
});

test('refreshes a clean document from disk through the custom document provider', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-refresh-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const sourcePath = path.join(tempDir, 'source.km');
  const original = '{"root":{"data":{"text":"original"}}}';
  const refreshed = '{"root":{"data":{"text":"refreshed"}}}';
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
  await panel.dispatch({ command: 'loaded' });
  const initialImport = panel.sent.filter((message) => message.command === 'import').at(-1);
  assert.equal(initialImport.command, 'import');
  assert.equal(initialImport.importData, original);
  fs.writeFileSync(sourcePath, refreshed);

  await panel.dispatch({ command: 'refresh' });

  assert.equal(panel.sent.at(-1).command, 'import');
  assert.equal(panel.sent.at(-1).importData, refreshed);
  assert.equal(executedCommands.some(([command]) => command === 'workbench.action.files.revert'), false);
  document.dispose();
});

test('coalesces concurrent refresh requests for the same document', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-refresh-concurrent-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const sourcePath = path.join(tempDir, 'source.km');
  const original = '{"root":{"data":{"text":"original"}}}';
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

  await Promise.all([
    panel.dispatch({ command: 'refresh' }),
    panel.dispatch({ command: 'refresh' }),
  ]);

  const imports = panel.sent.filter(({ command }) => command === 'import');
  assert.equal(imports.length, 1);
  assert.equal(imports[0].importData, original);
  document.dispose();
});

test('explicit refresh discards a dirty draft and waits for Webview import acknowledgement', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-refresh-dirty-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const sourcePath = path.join(tempDir, 'source.km');
  const original = '{"root":{"data":{"text":"original"}}}';
  const localDraft = '{"root":{"data":{"text":"local-draft"}}}';
  const diskContent = '{"root":{"data":{"text":"disk-wins"}}}';
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
  await panel.dispatch({ command: 'loaded' });
  await panel.dispatch({ command: 'draft', exportData: localDraft });
  fs.writeFileSync(sourcePath, diskContent);

  commandHandlers.set('workbench.action.files.revert', () =>
    provider.revertCustomDocument(document, cancellationToken())
  );
  t.after(() => commandHandlers.delete('workbench.action.files.revert'));

  const requestId = 'refresh-dirty-1';
  const refresh = panel.dispatch({ command: 'refresh', requestId });
  const imported = await waitForSentMessage(
    panel,
    (message) => message.command === 'import' && message.importRequestId === requestId
  );
  assert.equal(imported.importData, diskContent);
  assert.equal(provider.documentStates.get(document.uri.toString()).dirty, true);

  await panel.dispatch({ command: 'importResult', importRequestId: requestId, ok: true });
  await refresh;

  const result = panel.sent.find(
    (message) => message.command === 'refreshResult' && message.requestId === requestId
  );
  assert.equal(result.ok, true);
  assert.deepEqual(provider.documentStates.get(document.uri.toString()), {
    content: diskContent,
    dirty: false,
    externalConflict: false,
    lastDiskContent: diskContent,
  });
  document.dispose();
});

test('explicit refresh consumes watcher changes that arrive during a later import acknowledgement', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-refresh-watcher-race-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const sourcePath = path.join(tempDir, 'source.km');
  const original = '{"root":{"data":{"text":"original"}}}';
  const firstDiskContent = '{"root":{"data":{"text":"disk-one"}}}';
  const secondDiskContent = '{"root":{"data":{"text":"disk-two"}}}';
  const newestDiskContent = '{"root":{"data":{"text":"disk-three"}}}';
  fs.writeFileSync(sourcePath, original);

  const context = { extensionPath: path.resolve(__dirname, '..'), subscriptions: [] };
  const provider = new MindEditorProvider(context);
  const document = await provider.openCustomDocument(MockUri.file(sourcePath), {
    backupId: undefined,
    untitledDocumentData: undefined,
  });
  const watcher = fileSystemWatchers.at(-1);
  const panel = createPanel();
  t.after(() => panel.panel.dispose());
  await provider.resolveCustomEditor(document, panel.panel);
  await panel.dispatch({ command: 'loaded' });

  commandHandlers.set('workbench.action.files.revert', () =>
    provider.revertCustomDocument(document, cancellationToken())
  );
  t.after(() => commandHandlers.delete('workbench.action.files.revert'));

  fs.writeFileSync(sourcePath, firstDiskContent);
  const requestId = 'refresh-watcher-race-1';
  const refresh = panel.dispatch({ command: 'refresh', requestId });
  const firstImport = await waitForSentMessage(
    panel,
    (message) => message.command === 'import' && message.importRequestId === requestId
  );
  assert.equal(firstImport.importData, firstDiskContent);

  fs.writeFileSync(sourcePath, secondDiskContent);
  await watcher.fireChange(MockUri.file(sourcePath));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await panel.dispatch({ command: 'importResult', importRequestId: requestId, ok: true });

  const secondImport = await waitForSentMessage(
    panel,
    (message) => message.command === 'import' && message.importRequestId === `${requestId}:latest:1`
  );
  assert.equal(secondImport.importData, secondDiskContent);

  fs.writeFileSync(sourcePath, newestDiskContent);
  await watcher.fireChange(MockUri.file(sourcePath));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await panel.dispatch({
    command: 'importResult',
    importRequestId: secondImport.importRequestId,
    ok: true,
  });

  const thirdImport = await waitForSentMessage(
    panel,
    (message) => message.command === 'import' && message.importRequestId === `${requestId}:latest:2`
  );
  assert.equal(thirdImport.importData, newestDiskContent);
  await panel.dispatch({
    command: 'importResult',
    importRequestId: thirdImport.importRequestId,
    ok: true,
  });
  await refresh;

  assert.deepEqual(provider.documentStates.get(document.uri.toString()), {
    content: newestDiskContent,
    dirty: false,
    externalConflict: false,
    lastDiskContent: newestDiskContent,
  });
  document.dispose();
});

test('explicit refresh cancels a pending save and ignores its late response', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-refresh-save-race-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const sourcePath = path.join(tempDir, 'source.km');
  const original = '{"root":{"data":{"text":"original"}}}';
  const localDraft = '{"root":{"data":{"text":"late-save"}}}';
  const diskContent = '{"root":{"data":{"text":"disk-wins"}}}';
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
  await panel.dispatch({ command: 'loaded' });
  await panel.dispatch({ command: 'draft', exportData: localDraft });

  const save = provider.saveCustomDocument(document, cancellationToken());
  const saveRequest = panel.sent.at(-1);
  assert.equal(saveRequest.command, 'requestSave');
  const saveRejected = assert.rejects(save, /reloaded from disk/);

  fs.writeFileSync(sourcePath, diskContent);
  const requestId = 'refresh-save-race-1';
  const refresh = panel.dispatch({ command: 'refresh', requestId });
  const imported = await waitForSentMessage(
    panel,
    (message) => message.command === 'import' && message.importRequestId === requestId
  );
  assert.equal(imported.importData, diskContent);
  await saveRejected;

  await panel.dispatch({ command: 'importResult', importRequestId: requestId, ok: true });
  await refresh;
  await panel.dispatch({ command: 'save', requestId: saveRequest.requestId, exportData: localDraft });

  assert.equal(fs.readFileSync(sourcePath, 'utf8'), diskContent);
  assert.equal(provider.documentStates.get(document.uri.toString()).content, diskContent);
  document.dispose();
});

test('explicit refresh waits for an active write before reading the disk', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-refresh-active-write-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const sourcePath = path.join(tempDir, 'source.km');
  const original = '{"root":{"data":{"text":"original"}}}';
  const draft = '{"root":{"data":{"text":"draft"}}}';
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
  await panel.dispatch({ command: 'loaded' });
  await panel.dispatch({ command: 'draft', exportData: draft });

  const originalWriteFile = fs.promises.writeFile;
  let releaseWrite;
  let writeStarted;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const writeStartedPromise = new Promise((resolve) => { writeStarted = resolve; });
  fs.promises.writeFile = async (...args) => {
    if (args[0] === sourcePath && args[1] === draft) {
      writeStarted();
      await writeGate;
    }
    return originalWriteFile(...args);
  };
  t.after(() => { fs.promises.writeFile = originalWriteFile; });

  const save = provider.saveCustomDocument(document, cancellationToken());
  const saveRequest = panel.sent.at(-1);
  const saveResponse = panel.dispatch({
    command: 'save',
    requestId: saveRequest.requestId,
    exportData: draft,
  });
  await writeStartedPromise;

  const refresh = panel.dispatch({ command: 'refresh', requestId: 'active-write-refresh' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(panel.sent.some((message) => message.command === 'refreshResult'), false);
  releaseWrite();
  await saveResponse;
  await save;
  const imported = await waitForSentMessage(
    panel,
    (message) => message.command === 'import' && message.importRequestId === 'active-write-refresh'
  );
  assert.equal(imported.importData, draft);
  await panel.dispatch({ command: 'importResult', importRequestId: 'active-write-refresh', ok: true });
  await refresh;
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), draft);
  document.dispose();
});

test('stale save responses cannot complete a newer save request', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-refresh-save-id-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const sourcePath = path.join(tempDir, 'source.km');
  const original = '{"root":{"data":{"text":"original"}}}';
  const firstDraft = '{"root":{"data":{"text":"first"}}}';
  const secondDraft = '{"root":{"data":{"text":"second"}}}';
  fs.writeFileSync(sourcePath, original);
  const provider = new MindEditorProvider({ extensionPath: path.resolve(__dirname, '..'), subscriptions: [] });
  const document = await provider.openCustomDocument(MockUri.file(sourcePath), { backupId: undefined, untitledDocumentData: undefined });
  const panel = createPanel();
  t.after(() => panel.panel.dispose());
  await provider.resolveCustomEditor(document, panel.panel);
  await panel.dispatch({ command: 'loaded' });
  await panel.dispatch({ command: 'draft', exportData: firstDraft });
  const firstSave = provider.saveCustomDocument(document, cancellationToken());
  const firstRequest = panel.sent.at(-1);
  await panel.dispatch({ command: 'draft', exportData: secondDraft });
  const secondSave = provider.saveCustomDocument(document, cancellationToken());
  const secondRequest = panel.sent.at(-1);
  await assert.rejects(firstSave, /replaced/);
  await panel.dispatch({ command: 'save', requestId: firstRequest.requestId, exportData: firstDraft });
  await panel.dispatch({ command: 'save', exportData: firstDraft });
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), original);
  await panel.dispatch({ command: 'save', requestId: secondRequest.requestId, exportData: secondDraft });
  await secondSave;
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), secondDraft);
  document.dispose();
});

test('a disposed reload cannot update a newly opened document with the same URI', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-refresh-reopen-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const sourcePath = path.join(tempDir, 'source.km');
  const original = '{"root":{"data":{"text":"original"}}}';
  const reopenedContent = '{"root":{"data":{"text":"reopened"}}}';
  fs.writeFileSync(sourcePath, original);

  const context = { extensionPath: path.resolve(__dirname, '..'), subscriptions: [] };
  const provider = new MindEditorProvider(context);
  const firstDocument = await provider.openCustomDocument(MockUri.file(sourcePath), {
    backupId: undefined,
    untitledDocumentData: undefined,
  });
  const firstPanel = createPanel();
  t.after(() => firstPanel.panel.dispose());
  await provider.resolveCustomEditor(firstDocument, firstPanel.panel);

  const originalReadFile = fs.promises.readFile;
  let releaseRead;
  let markReadStarted;
  let blockNextRead = true;
  const readStarted = new Promise((resolve) => { markReadStarted = resolve; });
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  fs.promises.readFile = async (...args) => {
    if (blockNextRead && args[0] === sourcePath) {
      blockNextRead = false;
      markReadStarted();
      await readGate;
    }
    return originalReadFile(...args);
  };
  t.after(() => { fs.promises.readFile = originalReadFile; });

  const staleReload = provider.revertCustomDocument(firstDocument, cancellationToken());
  const staleReloadRejected = assert.rejects(staleReload, /Document closed/);
  await readStarted;
  firstDocument.dispose();
  fs.writeFileSync(sourcePath, reopenedContent);

  const secondDocument = await provider.openCustomDocument(MockUri.file(sourcePath), {
    backupId: undefined,
    untitledDocumentData: undefined,
  });
  const secondPanel = createPanel();
  t.after(() => secondPanel.panel.dispose());
  await provider.resolveCustomEditor(secondDocument, secondPanel.panel);

  releaseRead();
  await staleReloadRejected;
  assert.equal(provider.documentStates.get(secondDocument.uri.toString()).content, reopenedContent);
  assert.equal(secondPanel.sent.some(({ command }) => command === 'import'), false);
  secondDocument.dispose();
});

test('rebinds a retained webview without disposing or reopening its panel', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-reconnect-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const sourcePath = path.join(tempDir, 'source.km');
  const original = '{"root":{"data":{"text":"original"}}}';
  fs.writeFileSync(sourcePath, original);

  const context = { extensionPath: path.resolve(__dirname, '..'), subscriptions: [] };
  const provider = new MindEditorProvider(context);
  const document = await provider.openCustomDocument(MockUri.file(sourcePath), {
    backupId: undefined,
    untitledDocumentData: undefined,
  });
  const panel = createPanel({ initialHtml: '<html>retained</html>' });
  t.after(() => panel.panel.dispose());

  await provider.resolveCustomEditor(document, panel.panel);
  const reconnect = panel.sent.at(-1);
  assert.equal(reconnect.command, 'reconnect');
  assert.equal(panel.htmlAssignments.length, 0);

  await panel.dispatch({
    command: 'reconnected',
    reconnectId: reconnect.reconnectId,
    exportData: original,
  });

  assert.equal(panel.sent.at(-1).command, 'import');
  assert.equal(panel.getDisposeCount(), 0);
  assert.equal(executedCommands.some(([command]) => command === 'vscode.openWith'), false);
  document.dispose();
});

test('re-resolving the same panel replaces message and lifecycle bindings', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-rebind-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const sourcePath = path.join(tempDir, 'source.km');
  fs.writeFileSync(sourcePath, '{"root":{"data":{"text":"original"}}}');

  const context = { extensionPath: path.resolve(__dirname, '..'), subscriptions: [] };
  const provider = new MindEditorProvider(context);
  const document = await provider.openCustomDocument(MockUri.file(sourcePath), {
    backupId: undefined,
    untitledDocumentData: undefined,
  });
  const panel = createPanel();
  t.after(() => panel.panel.dispose());

  await provider.resolveCustomEditor(document, panel.panel);
  assert.equal(panel.getMessageHandlerCount(), 1);

  await provider.resolveCustomEditor(document, panel.panel);
  assert.equal(panel.getMessageHandlerCount(), 1);

  document.dispose();
});

test('reloads an unresponsive visible webview in place and ignores hidden panels', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-heartbeat-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const sourcePath = path.join(tempDir, 'source.km');
  fs.writeFileSync(sourcePath, '{"root":{"data":{"text":"original"}}}');

  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  let heartbeat;
  global.setInterval = (handler) => {
    heartbeat = handler;
    return { mockInterval: true };
  };
  global.clearInterval = () => undefined;
  t.after(() => {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  });

  const context = { extensionPath: path.resolve(__dirname, '..'), subscriptions: [] };
  const provider = new MindEditorProvider(context);
  const document = await provider.openCustomDocument(MockUri.file(sourcePath), {
    backupId: undefined,
    untitledDocumentData: undefined,
  });
  const panel = createPanel({ visible: false });
  t.after(() => panel.panel.dispose());
  await provider.resolveCustomEditor(document, panel.panel);
  assert.equal(panel.htmlAssignments.length, 1);

  await heartbeat();
  await heartbeat();
  await heartbeat();
  assert.equal(panel.sent.some(({ command }) => command === 'ping'), false);
  assert.equal(panel.htmlAssignments.length, 1);

  await panel.setVisible(true);
  const reconnect = panel.sent.at(-1);
  assert.equal(reconnect.command, 'reconnect');
  await panel.dispatch({
    command: 'reconnected',
    reconnectId: reconnect.reconnectId,
    exportData: '{"root":{"data":{"text":"original"}}}',
  });

  panel.setMessageDelivery('ping', false);
  const initialHtmlAssignments = panel.htmlAssignments.length;
  await heartbeat();
  await heartbeat();
  await heartbeat();

  assert.equal(panel.htmlAssignments.length, initialHtmlAssignments + 1);
  assert.equal(panel.getDisposeCount(), 0);
  assert.equal(executedCommands.some(([command]) => command === 'vscode.openWith'), false);
  document.dispose();
});

test('creates a split file before acknowledging removal and never overwrites the source', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-provider-split-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const sourcePath = path.join(tempDir, 'source.km');
  const destinationPath = path.join(tempDir, 'Child.km');
  const original = '{"root":{"data":{"text":"Root"}}}';
  const split = '{"root":{"data":{"id":"child","text":"Child"},"children":[{"data":{"text":"Leaf"}}]},"theme":"fresh-blue"}';
  fs.writeFileSync(sourcePath, original);

  const provider = new MindEditorProvider({ extensionPath: path.resolve(__dirname, '..'), subscriptions: [] });
  const document = await provider.openCustomDocument(MockUri.file(sourcePath), {
    backupId: undefined,
    untitledDocumentData: undefined,
  });
  const panel = createPanel();
  t.after(() => panel.panel.dispose());
  await provider.resolveCustomEditor(document, panel.panel);

  nextSaveDialogUri = MockUri.file(destinationPath);
  await panel.dispatch({
    command: 'splitNode',
    requestId: 'split-1',
    nodeText: 'Child',
    isRoot: false,
    content: split,
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(destinationPath, 'utf8')), JSON.parse(split));
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), original);
  assert.deepEqual(panel.sent.at(-1), { command: 'splitNodeResult', requestId: 'split-1', ok: true });
  assert.equal(saveDialogOptions.at(-1).defaultUri.fsPath, destinationPath);

  await panel.dispatch({
    command: 'splitNode',
    requestId: 'split-cancelled',
    nodeText: 'Child',
    isRoot: false,
    content: split,
  });
  assert.deepEqual(panel.sent.at(-1), {
    command: 'splitNodeResult',
    requestId: 'split-cancelled',
    ok: false,
    cancelled: true,
  });
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), original);

  nextSaveDialogUri = MockUri.file(path.join(tempDir, 'invalid.km'));
  await panel.dispatch({
    command: 'splitNode',
    requestId: 'split-invalid',
    nodeText: 'Child',
    isRoot: false,
    content: '{"theme":"missing-root"}',
  });
  assert.equal(panel.sent.at(-1).requestId, 'split-invalid');
  assert.equal(panel.sent.at(-1).ok, false);
  assert.equal(fs.existsSync(path.join(tempDir, 'invalid.km')), false);
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), original);

  nextSaveDialogUri = MockUri.file(sourcePath);
  await panel.dispatch({
    command: 'splitNode',
    requestId: 'split-2',
    nodeText: 'Root',
    isRoot: true,
    content: split,
  });
  assert.equal(panel.sent.at(-1).command, 'splitNodeResult');
  assert.equal(panel.sent.at(-1).requestId, 'split-2');
  assert.equal(panel.sent.at(-1).ok, false);
  assert.match(panel.sent.at(-1).error, /different file name/);
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), original);
  document.dispose();
});

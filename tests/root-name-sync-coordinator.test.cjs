const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

class MockUri {
  constructor(fsPath) {
    this.fsPath = path.resolve(fsPath);
    this.scheme = 'file';
  }

  static file(filePath) {
    return new MockUri(filePath);
  }
}

class MockWorkspaceEdit {
  renameFile(oldUri, newUri, options) {
    this.rename = { oldUri, newUri, options };
  }
}

const renameHandlers = new Set();
let applyEditResult = true;
const vscode = {
  Uri: MockUri,
  WorkspaceEdit: MockWorkspaceEdit,
  workspace: {
    applyEdit: async (edit) => {
      if (!applyEditResult) return false;
      assert.deepEqual(edit.rename.options, { overwrite: false, ignoreIfExists: false });
      fs.renameSync(edit.rename.oldUri.fsPath, edit.rename.newUri.fsPath);
      return true;
    },
    onDidRenameFiles: (handler) => {
      renameHandlers.add(handler);
      return { dispose: () => renameHandlers.delete(handler) };
    },
  },
  window: {
    showErrorMessage: async () => undefined,
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
require('ts-node/register/transpile-only');
const { RootNameSyncCoordinator } = require('../src/rootNameSyncCoordinator.ts');
Module._load = originalLoad;

function km(rootText) {
  return JSON.stringify({
    template: 'right',
    root: { data: { id: 'root', text: rootText }, children: [] },
  }, null, 2);
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for root/name synchronization.');
}

test('a saved root edit renames through a no-overwrite workspace edit', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-root-sync-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const oldPath = path.join(directory, 'Draft.km');
  const newPath = path.join(directory, 'Release plan.km');
  const content = km('Release plan');
  fs.writeFileSync(oldPath, content);

  const coordinator = new RootNameSyncCoordinator();
  t.after(() => coordinator.dispose());
  const plan = await coordinator.planSavedContent(MockUri.file(oldPath), content);

  assert.equal(plan.kind, 'rename-file');
  await coordinator.applySavedContentPlan(plan);
  assert.equal(fs.existsSync(oldPath), false);
  assert.equal(fs.readFileSync(newPath, 'utf8'), content);
  assert.equal(fs.existsSync(`${oldPath}.lock`), false);
});

test('a failed workspace rename restores the original root and leaves the source file', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-root-sync-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const oldPath = path.join(directory, 'Draft.km');
  const content = km('Blocked target');
  fs.writeFileSync(oldPath, content);

  const coordinator = new RootNameSyncCoordinator();
  t.after(() => coordinator.dispose());
  const plan = await coordinator.planSavedContent(MockUri.file(oldPath), content);
  applyEditResult = false;
  t.after(() => { applyEditResult = true; });

  await assert.rejects(coordinator.applySavedContentPlan(plan), /declined to rename/);
  assert.equal(JSON.parse(fs.readFileSync(oldPath, 'utf8')).root.data.text, 'Draft');
  assert.equal(fs.existsSync(`${oldPath}.lock`), false);
});

test('an Explorer rename updates only the root text under the shared KM lock', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-root-sync-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const oldPath = path.join(directory, 'Old.km');
  const newPath = path.join(directory, 'New.km');
  const coordinator = new RootNameSyncCoordinator();
  t.after(() => coordinator.dispose());
  fs.writeFileSync(oldPath, km('Old'));
  fs.renameSync(oldPath, newPath);

  for (const handler of renameHandlers) {
    handler({ files: [{ oldUri: MockUri.file(oldPath), newUri: MockUri.file(newPath) }] });
  }
  await waitFor(() => JSON.parse(fs.readFileSync(newPath, 'utf8')).root.data.text === 'New');

  const persisted = JSON.parse(fs.readFileSync(newPath, 'utf8'));
  assert.equal(persisted.root.data.text, 'New');
  assert.equal(persisted.template, 'right');
  assert.equal(fs.existsSync(`${newPath}.lock`), false);
});

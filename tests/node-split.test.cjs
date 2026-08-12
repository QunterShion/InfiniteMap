const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

require('ts-node/register/transpile-only');
const {
  assertDifferentSplitDestination,
  prepareSplitContent,
  suggestSplitPath,
  writeSplitFile,
} = require('../src/nodeSplit.ts');

const runtimePath = path.join(__dirname, '..', 'webui/src/runtime/node-split.js');

function node(id, text, children = [], root = false) {
  const data = { id, text };
  const value = {
    children,
    getData(key) { return data[key]; },
    getText() { return data.text; },
    isRoot() { return root; },
  };
  return value;
}

function createRuntime(root, selected) {
  let exportedRuntime;
  const posted = [];
  const messages = [];
  let hotboxButton;
  let removed;
  let timeoutHandler;
  const eventHandlers = {};
  const minder = {
    exportJson() {
      return { root: this.exportNode(root), template: 'right', theme: 'fresh-blue', version: '1.4.43' };
    },
    exportNode(current) {
      return {
        data: { id: current.getData('id'), text: current.getText() },
        children: current.children.map((child) => this.exportNode(child)),
      };
    },
    fire(name, payload) {
      if (eventHandlers[name]) eventHandlers[name](payload);
    },
    getNodeById(id) {
      let match;
      (function visit(current) {
        if (current.getData('id') === id) match = current;
        current.children.forEach(visit);
      })(root);
      return match;
    },
    getSelectedNode() { return selected; },
    getSelectedNodes() { return selected ? [selected] : []; },
    on(name, handler) { eventHandlers[name] = handler; },
    select(current) { selected = current; },
    execCommand(command) {
      if (command === 'RemoveNode') removed = selected;
    },
  };
  const window = {
    addEventListener(name, handler) { messages.push([name, handler]); },
    clearTimeout() { timeoutHandler = undefined; },
	infiniteMapProtocolVersion: 1,
    infiniteMapWebviewSessionId: 'session',
    setTimeout(handler) { timeoutHandler = handler; return 1; },
    vscode: { postMessage(message) { posted.push(message); } },
  };
  vm.runInNewContext(fs.readFileSync(runtimePath, 'utf8'), {
    define(factory) {
      const module = { exports: {} };
      exportedRuntime = factory(() => {}, module.exports, module) || module.exports;
    },
    window,
  }, { filename: runtimePath });
  const editor = {
    hotbox: { state() { return { button(value) { hotboxButton = value; } }; } },
    lang: { t(key) { return key; } },
    minder,
  };
  exportedRuntime.call(editor);
  return {
    editor,
    expireRequest() { timeoutHandler(); },
    getRemoved: () => removed,
    hotboxButton,
    minder,
    posted,
    respond(message) { messages.find(([name]) => name === 'message')[1]({ data: { protocolVersion: 1, ...message } }); },
  };
}

test('split file helpers validate content, sanitize names, and protect the source path', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-split-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const source = path.join(tempDir, 'source.km');
  fs.writeFileSync(source, '{"root":{"data":{"text":"source"}}}');
  const destination = suggestSplitPath(source, ' feature:/node. ');
  assert.equal(destination, path.join(tempDir, 'feature--node.km'));
  assert.throws(() => assertDifferentSplitDestination(source, path.join(tempDir, 'child.txt')), /ending in \.km/);
  assert.throws(() => assertDifferentSplitDestination(source, source), /different file name/);
  const sourceAlias = path.join(tempDir, 'source-alias.km');
  fs.symlinkSync(source, sourceAlias);
  assert.throws(() => assertDifferentSplitDestination(source, sourceAlias), /different file name/);
  assert.throws(() => prepareSplitContent('{"theme":"x"}'), /root node/);

  const existingDestination = path.join(tempDir, 'existing.km');
  fs.writeFileSync(existingDestination, 'keep me');
  await assert.rejects(writeSplitFile(existingDestination, '{"theme":"x"}'), /root node/);
  assert.equal(fs.readFileSync(existingDestination, 'utf8'), 'keep me');

  const blockedDestination = path.join(tempDir, 'blocked.km');
  fs.mkdirSync(blockedDestination);
  await assert.rejects(
    writeSplitFile(blockedDestination, '{"root":{"data":{"text":"child"}}}'),
  );
  assert.equal(fs.readdirSync(tempDir).some((name) => name.includes('infinite-map-tmp')), false);

  await writeSplitFile(destination, '{"root":{"data":{"text":"child"},"children":[]},"theme":"x"}');
  assert.deepEqual(JSON.parse(fs.readFileSync(destination, 'utf8')), {
    root: { data: { text: 'child' }, children: [] },
    theme: 'x',
  });
});

test('successful non-root split removes exactly the unchanged exported subtree', () => {
  const child = node('child', 'Child', [node('leaf', 'Leaf')]);
  const root = node('root', 'Root', [child], true);
  const runtime = createRuntime(root, child);

  assert.equal(runtime.hotboxButton.label, 'label');
  runtime.hotboxButton.action();
  runtime.minder.on('splitNodeRequest', ({ node: requested }) => runtime.editor.nodeSplit.request(requested));
  runtime.hotboxButton.action();
  const request = runtime.posted.find(({ command }) => command === 'splitNode');
	assert.equal(request.protocolVersion, 1);
  assert.equal(request.nodeText, 'Child');
  assert.equal(request.isRoot, false);
  assert.deepEqual(JSON.parse(request.content), {
    root: {
      data: { id: 'child', text: 'Child' },
      children: [{ data: { id: 'leaf', text: 'Leaf' }, children: [] }],
    },
    template: 'right',
    theme: 'fresh-blue',
    version: '1.4.43',
  });

  runtime.respond({ command: 'splitNodeResult', requestId: request.requestId, ok: true });
  assert.equal(runtime.getRemoved(), child);
});

test('cancel, stale response, source changes, and root copy never remove the source', () => {
  const child = node('child', 'Child');
  const root = node('root', 'Root', [child], true);
  const cancelled = createRuntime(root, child);
  cancelled.editor.nodeSplit.request(child);
  const cancelRequest = cancelled.posted.at(-1);
  cancelled.respond({ command: 'splitNodeResult', requestId: 'stale', ok: true });
  cancelled.respond({ command: 'splitNodeResult', requestId: cancelRequest.requestId, ok: false, cancelled: true });
  assert.equal(cancelled.getRemoved(), undefined);

  const timedOut = createRuntime(root, child);
  assert.equal(timedOut.editor.nodeSplit.request(child), true);
  timedOut.expireRequest();
  assert.equal(timedOut.posted.at(-1).command, 'errormsg');
  assert.equal(timedOut.editor.nodeSplit.request(child), true);

  const changed = createRuntime(root, child);
  changed.editor.nodeSplit.request(child);
  const changedRequest = changed.posted.at(-1);
  child.children.push(node('later', 'Later'));
  changed.respond({ command: 'splitNodeResult', requestId: changedRequest.requestId, ok: true });
  assert.equal(changed.getRemoved(), undefined);
  assert.equal(changed.posted.at(-1).command, 'errormsg');

  const rootCopy = createRuntime(root, root);
  rootCopy.editor.nodeSplit.request(root);
  const rootRequest = rootCopy.posted.at(-1);
  rootCopy.respond({ command: 'splitNodeResult', requestId: rootRequest.requestId, ok: true });
  assert.equal(rootCopy.getRemoved(), undefined);
});

test('split confirmation is an accessible custom dialog and every locale has split copy', () => {
  const template = fs.readFileSync(path.join(__dirname, '..', 'webui/ui/dialog/nodeSplit/nodeSplit.tpl.html'), 'utf8');
  const service = fs.readFileSync(path.join(__dirname, '..', 'webui/ui/service/nodeSplitDialog.service.js'), 'utf8');
  assert.match(template, /data-component="split-node-dialog"/);
  assert.match(template, /id="split-node-dialog-title"/);
  assert.match(template, /id="split-node-dialog-description"/);
  assert.match(template, /autofocus/);
  assert.doesNotMatch(template + service, /window\.confirm/);
  assert.match(service, /aria-modal/);

  for (const filename of fs.readdirSync(path.join(__dirname, '..', 'webui/l10n')).filter((name) => name.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'webui/l10n', filename), 'utf8');
    assert.equal((source.match(/nodeSplit/g) || []).length, 2, filename);
  }
});

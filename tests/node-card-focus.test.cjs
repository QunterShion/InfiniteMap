const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = join(__dirname, '..');
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');

class FakeCustomEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail || {};
  }
}

function createDocument() {
  const listeners = new Map();
  return {
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    },
  };
}

function createNode(id, text, children = [], expandState) {
  const renderContainer = createVisibilityTarget();
  const connection = createVisibilityTarget();
  const node = {
    children,
    connection,
    data: {
      created: Date.parse('2026-09-03T08:00:00.000Z'),
      id,
      resource: [],
      text,
    },
    parent: null,
    renderContainer,
    renderTreeCount: 0,
    collapse() {
      this.data.expandState = 'collapse';
      return this;
    },
    expand() {
      this.data.expandState = 'expand';
      return this;
    },
    getConnection() {
      return connection;
    },
    getData(key) {
      return key ? this.data[key] : this.data;
    },
    getLevel() {
      let level = 0;
      let ancestor = this.parent;
      while (ancestor) {
        level++;
        ancestor = ancestor.parent;
      }
      return level;
    },
    getParent() {
      return this.parent;
    },
    getRenderContainer() {
      return renderContainer;
    },
    contains(candidate) {
      return this === candidate || this.isAncestorOf(candidate);
    },
    isAncestorOf(candidate) {
      let ancestor = candidate && candidate.parent;
      while (ancestor) {
        if (ancestor === this) return true;
        ancestor = ancestor.parent;
      }
      return false;
    },
    isCollapsed() {
      return !this.isExpanded();
    },
    isExpanded() {
      return this.data.expandState !== 'collapse' && (!this.parent || this.parent.isExpanded());
    },
    isRoot() {
      return this.parent === null;
    },
    renderTree() {
      this.renderTreeCount++;
      return this;
    },
    setData(key, value) {
      this.data[key] = value;
      return this;
    },
    traverse(callback) {
      for (const child of this.children) child.traverse(callback);
      callback(this);
    },
  };
  if (expandState !== undefined) node.data.expandState = expandState;
  for (const child of children) child.parent = node;
  return node;
}

function createVisibilityTarget() {
  return {
    visible: true,
    setVisible(visible) {
      this.visible = visible;
      return this;
    },
  };
}

function createMinder(treeRoot, initiallySelected) {
  const events = new Map();
  const commands = [];
  const statusChanges = [];
  let selected = initiallySelected;
  const minder = {
    commands,
    contentChangeCount: 0,
    contentSnapshots: [],
    events,
    layoutCount: 0,
    statusChanges,
    execCommand(command, ...args) {
      commands.push([command, ...args]);
      if (command.toLowerCase() === 'text' && selected) {
        selected.data.text = args[0];
        this.emit('contentchange');
      }
    },
    emit(name) {
      if (name === 'contentchange') {
        this.contentChangeCount++;
        this.contentSnapshots.push(this.exportJson());
      }
      for (const listener of events.get(name) || []) listener({ type: name });
    },
    exportJson() {
      function exportNode(node) {
        return {
          data: JSON.parse(JSON.stringify(node.data)),
          children: node.children.map(exportNode),
        };
      }
      return { root: exportNode(treeRoot) };
    },
    getNodeById(id) {
      let found;
      treeRoot.traverse((node) => {
        if (node.data.id === id) found = node;
      });
      return found;
    },
    getRoot() {
      return treeRoot;
    },
    getSelectedNode() {
      return selected;
    },
    getSelectedNodes() {
      return selected ? [selected] : [];
    },
    getStatus() {
      return statusChanges.length ? statusChanges.at(-1) : 'normal';
    },
    layout() {
      this.layoutCount++;
    },
    on(name, listener) {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(listener);
    },
    off(name, listener) {
      events.set(name, (events.get(name) || []).filter((candidate) => candidate !== listener));
    },
    select(node) {
      selected = node;
      this.emit('selectionchange');
    },
    setStatus(status) {
      statusChanges.push(status);
    },
    updateConnect(node) {
      if (!node.parent || !node.connection) return;
      node.connection.setVisible(!node.parent.isCollapsed());
    },
  };
  return minder;
}

function loadNodeCard(minder) {
  let directiveDefinition;
  const angularModule = {
    directive(name, definition) {
      if (name === 'nodeCard') directiveDefinition = definition;
      return angularModule;
    },
  };
  const document = createDocument();
  const context = {
    angular: { module: () => angularModule },
    CustomEvent: FakeCustomEvent,
    Date,
    document,
    window: {
      clearTimeout,
      setTimeout,
    },
  };
  vm.runInNewContext(
    read('webui/ui/directive/nodeCard/nodeCard.directive.js'),
    context,
    { filename: 'webui/ui/directive/nodeCard/nodeCard.directive.js' },
  );
  assert.ok(directiveDefinition, 'nodeCard directive should be registered');
  const factory = Array.isArray(directiveDefinition)
    ? directiveDefinition.at(-1)
    : directiveDefinition;
  const scope = {
    $$phase: false,
    $apply() {},
    $on() {},
    $root: { $$phase: false },
    minder,
  };
  const i18n = { t: (key) => key };
  factory(i18n).link(scope);
  minder.emit('selectionchange');
  return { document, scope };
}

function createTreeHarness() {
  const focusedLeaf = createNode('focused-leaf', 'Focused leaf', [], 'collapse');
  const focusedChild = createNode('focused-child', 'Focused child', [focusedLeaf]);
  const focusTarget = createNode('focus-target', 'Focus target', [focusedChild], 'collapse');
  const branch = createNode('branch', 'Branch', [focusTarget]);
  const sibling = createNode('sibling', 'Sibling');
  const treeRoot = createNode('root', 'Root', [branch, sibling]);
  const minder = createMinder(treeRoot, focusTarget);
  const loaded = loadNodeCard(minder);
  return {
    ...loaded,
    branch,
    focusTarget,
    focusedChild,
    focusedLeaf,
    minder,
    sibling,
    treeRoot,
  };
}

test('node card replaces level with a root breadcrumb and a plain-text focus action', () => {
  const template = read('webui/ui/directive/nodeCard/nodeCard.html');
  const directive = read('webui/ui/directive/nodeCard/nodeCard.directive.js');
	const editorStyles = read('webui/less/editor.less');
	const cardStyles = read('webui/less/nodeCard.less');

  assert.doesNotMatch(template, /\{\{\s*'level'\s*\|/);
  assert.doesNotMatch(template, /card\.level/);
  assert.doesNotMatch(directive, /\blevel\s*:/);
  assert.match(template, /data-slot="node-breadcrumbs"/);
  assert.match(template, /data-slot="breadcrumb-link"/);
  assert.match(template, /centerBreadcrumb\(breadcrumb\.nodeId\)/);
  assert.match(template, /data-slot="focus-action"/);
  assert.match(template, /ng-click="focusNode\(\)"/);
  assert.match(template, /data-component="node-focus-return"/);
  assert.match(template, /ng-click="exitFocus\(\)"/);
  assert.match(template, /ng-if="card\.canFocus && !card\.isCurrentFocus"/);
	assert.match(editorStyles, /--minder-canvas-top:\s*112px/);
	assert.match(editorStyles, /top:\s*var\(--minder-canvas-top\)/);
	assert.match(cardStyles, /top:\s*~"calc\(var\(--minder-canvas-top\) \+ var\(--spacing\) \* 3\)"/);
	assert.match(read('webui/ui/directive/kityminderEditor/kityminderEditor.directive.js'), /ResizeObserver\(syncCanvasBoundary\)/);

  const focusAction = template.match(/<button\b[^>]*data-slot="focus-action"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(focusAction, 'focus action should be a text button');
  assert.doesNotMatch(focusAction[1], /<(?:img|svg|i)\b/i);
});

test('node card builds the full root breadcrumb and centers a clicked parent node', () => {
  const { branch, focusTarget, minder, scope } = createTreeHarness();

  assert.deepEqual(
    Array.from(scope.card.breadcrumbs, (item) => ({
      isCurrent: item.isCurrent,
      nodeId: item.nodeId,
      text: item.text,
    })),
    [
      { isCurrent: false, nodeId: 'root', text: 'Root' },
      { isCurrent: false, nodeId: 'branch', text: 'Branch' },
      { isCurrent: true, nodeId: 'focus-target', text: 'Focus ta...' },
    ],
  );
  assert.equal(Object.hasOwn(scope.card, 'level'), false);
  assert.equal(scope.card.childCount, 1);

  scope.centerBreadcrumb('branch');

  assert.equal(minder.getSelectedNode(), branch);
  assert.deepEqual(minder.commands.at(-1), ['camera', branch]);
  assert.equal(scope.card.nodeId, branch.data.id);
  assert.notEqual(minder.getSelectedNode(), focusTarget);
});

test('focus renders only the selected subtree, expands it fully, and keeps editing available', async () => {
  const {
    branch,
    focusTarget,
    focusedChild,
    focusedLeaf,
    minder,
    sibling,
    scope,
    treeRoot,
  } = createTreeHarness();

  scope.focusNode();

  assert.equal(scope.focused, true);
  assert.equal(scope.card.isFocused, true);
  assert.equal(treeRoot.renderContainer.visible, false);
  assert.equal(branch.renderContainer.visible, false);
  assert.equal(sibling.renderContainer.visible, false);
  assert.equal(focusTarget.renderContainer.visible, true);
  assert.equal(focusedChild.renderContainer.visible, false, 'collapsed focus roots should hide descendants');
  assert.equal(focusedLeaf.renderContainer.visible, false, 'collapsed descendants should stay hidden');
  assert.equal(focusTarget.isExpanded(), false);
  assert.equal(focusedChild.isExpanded(), false);
  assert.equal(focusedLeaf.isExpanded(), false);
  assert.equal(focusTarget.data.expandState, 'collapse');
  assert.equal(focusedChild.data.expandState, undefined);
  assert.equal(focusedLeaf.data.expandState, 'collapse');
  assert.equal(focusTarget.connection.visible, false, 'focused root incoming edge should be hidden');
  assert.equal(focusedChild.connection.visible, false);
  assert.equal(focusedLeaf.connection.visible, false);
  assert.equal(sibling.connection.visible, false);
  assert.equal(treeRoot.renderTreeCount, 1);
  assert.equal(minder.layoutCount, 1);

	minder.emit('layoutallfinish');
	await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(minder.commands.at(-1), ['camera', focusTarget]);
  assert.equal(minder.getStatus(), 'normal');
  assert.deepEqual(minder.statusChanges, []);

  minder.execCommand('text', 'Edited while focused');

  assert.equal(focusTarget.data.text, 'Edited while focused');
  assert.equal(scope.card.text, 'Edited while focused');
  assert.equal(scope.card.isFocused, true);
  assert.equal(minder.contentChangeCount, 1);
  assert.equal(minder.contentSnapshots[0].root.children[0].children[0].data.expandState, 'collapse');

});

test('focus is view-only: root identity and complete exported data stay unchanged', () => {
  const {
    branch,
    focusTarget,
    focusedChild,
    focusedLeaf,
    minder,
    sibling,
    scope,
    treeRoot,
  } = createTreeHarness();
  const originalRoot = minder.getRoot();
  const beforeFocus = minder.exportJson();

  scope.focusNode();

  assert.equal(minder.getRoot(), originalRoot);
  assert.deepEqual(minder.exportJson(), beforeFocus);
  assert.equal(minder.contentChangeCount, 0);
  const exportedIds = [];
  (function collect(node) {
    exportedIds.push(node.data.id);
    node.children.forEach(collect);
  }(minder.exportJson().root));
  assert.deepEqual(exportedIds.sort(), [
    branch.data.id,
    focusTarget.data.id,
    focusedChild.data.id,
    focusedLeaf.data.id,
    sibling.data.id,
    treeRoot.data.id,
  ].sort());

  scope.exitFocus();

  assert.equal(minder.getRoot(), originalRoot);
  assert.deepEqual(minder.exportJson(), beforeFocus);
  assert.equal(minder.contentChangeCount, 0);
});

test('return restores the full map, original expansion state, and root camera', async () => {
  const {
    branch,
    focusTarget,
    focusedChild,
    focusedLeaf,
    minder,
    sibling,
    scope,
    treeRoot,
  } = createTreeHarness();
  scope.focusNode();

  scope.exitFocus();

  assert.equal(scope.focused, false);
  assert.equal(scope.card.isFocused, false);
  for (const node of [treeRoot, branch, focusTarget, sibling]) {
    assert.equal(node.renderContainer.visible, true, `${node.data.id} should return to the full view`);
  }
  for (const node of [focusedChild, focusedLeaf]) {
    assert.equal(node.renderContainer.visible, false, `${node.data.id} should remain hidden by the restored collapse state`);
    assert.equal(node.connection.visible, false, `${node.data.id} connection should remain hidden by the restored collapse state`);
  }
  assert.equal(focusTarget.connection.visible, true);
  assert.equal(focusTarget.data.expandState, 'collapse');
  assert.equal(focusedChild.data.expandState, undefined);
  assert.equal(focusedLeaf.data.expandState, 'collapse');
	minder.emit('layoutallfinish');
	await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(minder.commands.at(-1), ['camera', treeRoot]);
  assert.equal(minder.layoutCount, 2);
});

test('nested focus pushes a level and return pops one level at a time', async () => {
  const {
    branch,
    focusTarget,
    focusedChild,
    focusedLeaf,
    minder,
    sibling,
    scope,
    treeRoot,
  } = createTreeHarness();

  scope.focusNode();
  minder.select(focusedChild, true);
  assert.equal(scope.card.isFocused, true);
  assert.equal(scope.card.isCurrentFocus, false);
  assert.equal(scope.card.canFocus, true);

  scope.focusNode();

  assert.equal(scope.focused, true);
  assert.equal(scope.card.focusDepth, 2);
  assert.equal(scope.card.isCurrentFocus, true);
  assert.equal(focusTarget.renderContainer.visible, false);
  assert.equal(focusedChild.renderContainer.visible, true);
  assert.equal(focusedLeaf.renderContainer.visible, true);
	minder.emit('layoutallfinish');
	await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(minder.commands.at(-1)[0], 'camera');
  assert.equal(minder.commands.at(-1)[1], focusedChild);

  scope.exitFocus();

  assert.equal(scope.focused, true);
  assert.equal(scope.card.focusDepth, 1);
  assert.equal(scope.card.isCurrentFocus, false);
  assert.equal(scope.card.nodeId, focusedChild.data.id);
  assert.equal(focusTarget.renderContainer.visible, true);
  assert.equal(focusedChild.renderContainer.visible, false);
  assert.equal(sibling.renderContainer.visible, false);
	minder.emit('layoutallfinish');
	await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(minder.commands.at(-1), ['camera', focusTarget]);

  scope.exitFocus();

  assert.equal(scope.focused, false);
  assert.equal(scope.card.focusDepth, 0);
  for (const node of [treeRoot, branch, focusTarget, sibling]) {
    assert.equal(node.renderContainer.visible, true, `${node.data.id} should return to the full view`);
  }
  for (const node of [focusedChild, focusedLeaf]) {
    assert.equal(node.renderContainer.visible, false, `${node.data.id} should remain hidden by the restored collapse state`);
  }
	minder.emit('layoutallfinish');
	await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(minder.commands.at(-1), ['camera', treeRoot]);
});

test('clicking a breadcrumb while focused restores the map before selecting its parent', async () => {
  const { branch, minder, scope, treeRoot } = createTreeHarness();
  scope.focusNode();

  scope.centerBreadcrumb('branch');

  assert.equal(scope.focused, false);
  assert.equal(scope.card.isFocused, false);
  assert.equal(minder.getSelectedNode(), branch);
  assert.equal(treeRoot.renderContainer.visible, true);
	minder.emit('layoutallfinish');
	await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(minder.commands.at(-1), ['camera', branch]);
});

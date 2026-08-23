const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

function createDocument() {
  const listeners = new Map();
  const events = [];
  return {
    events,
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
    },
    dispatchEvent(event) {
      events.push(event);
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    },
    getElementById() {
      return { focus() {} };
    },
    querySelector() {
      return { focus() {} };
    },
    removeEventListener(name, listener) {
      listeners.set(name, (listeners.get(name) || []).filter((candidate) => candidate !== listener));
    },
  };
}

class FakeCustomEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail || {};
  }
}

function loadDirective(relativePath, directiveName, contextOverrides = {}) {
  let factory;
  const angularModule = {
    directive(name, candidate) {
      if (name === directiveName) factory = candidate;
      return angularModule;
    },
  };
  const context = {
    angular: { module: () => angularModule },
    CustomEvent: FakeCustomEvent,
    document: createDocument(),
    window: { setTimeout: (callback) => callback() },
    ...contextOverrides,
  };
  vm.runInNewContext(read(relativePath), context, { filename: relativePath });
  assert.ok(factory, `${directiveName} should be registered`);
  return { context, factory: Array.isArray(factory) ? factory.at(-1) : factory };
}

function createScope() {
  const destroyListeners = [];
  return {
    $$phase: false,
    $root: { $$phase: false },
    $apply() {},
    $on(name, listener) {
      if (name === '$destroy') destroyListeners.push(listener);
      return () => {};
    },
    destroy() {
      for (const listener of destroyListeners) listener();
    },
  };
}

test('session dock exposes activity and history as accessible right-edge tabs with unified live detail', () => {
  const dockTemplate = read('webui/ui/directive/agentSessionDock/agentSessionDock.html');
  const dockDirective = read('webui/ui/directive/agentSessionDock/agentSessionDock.directive.js');
  const editorTemplate = read('webui/ui/directive/kityminderEditor/kityminderEditor.html');
	const detailDirective = read('webui/ui/directive/agentSessionDetail/agentSessionDetail.directive.js');
  const activityTemplate = read('webui/ui/directive/agentActivityOverview/agentActivityOverview.html');
  const historyTemplate = read('webui/ui/directive/agentSessionHistory/agentSessionHistory.html');
  const sessionLess = read('webui/less/agentSession.less');
  const editorLess = read('webui/less/editor.less');
  const dockLess = read('webui/less/agentSessionDock.less');
	const detailTemplate = read('webui/ui/directive/agentSessionDetail/agentSessionDetail.html');

  assert.match(dockTemplate, /role="tablist"/);
  assert.equal((dockTemplate.match(/role="tab"/g) || []).length, 2);
  assert.match(dockTemplate, /aria-controls="agent-activity-drawer"/);
  assert.match(dockTemplate, /aria-controls="agent-session-history-drawer"/);
  assert.match(dockDirective, /agent-activity-open/);
  assert.match(dockDirective, /agent-session-history-open/);
  assert.match(dockDirective, /ArrowUp|ArrowDown/);
	assert.doesNotMatch(editorTemplate, /agent-session-log/);
  assert.match(editorTemplate, /agent-session-dock/);
	assert.match(editorTemplate, /agent-session-detail/);
	assert.match(detailDirective, /agent-session-live-detail/);
	for (const template of [dockTemplate, activityTemplate, historyTemplate, detailTemplate]) {
		assert.match(template, /data-agent-control-surface/);
	}
	assert.match(activityTemplate, /activity\.visible && !sessionDetail\.visible/);
	assert.match(historyTemplate, /history\.visible && !sessionDetail\.visible/);
	assert.match(sessionLess, /\[data-component="agent-session-detail"\][\s\S]*?width: ~"min\(42ch,/);
	assert.match(sessionLess, /\[data-component="agent-session-detail"\][\s\S]*?left:\s*50%/);
	assert.match(sessionLess, /\[data-component="agent-session-detail"\][\s\S]*?transform:\s*translate\(-50%, -50%\)/);
	assert.match(sessionLess, /\[data-component="agent-session-detail"\][\s\S]*?height: ~"min\(calc\(var\(--spacing\) \* 88\)/);
	assert.match(sessionLess, /\[data-slot="session-detail-body"\][\s\S]*?overflow-y:\s*auto/);
	assert.match(detailTemplate, /data-slot="session-detail-body" role="region" tabindex="0"/);
	assert.doesNotMatch(editorLess, /agentSessionLog\.less/);
  assert.match(editorLess, /agentSessionDock\.less/);
  assert.match(dockLess, /right:\s*0/);
	assert.match(dockLess, /flex-direction:\s*column/);
	assert.match(dockLess, /writing-mode:\s*vertical-rl/);
	assert.doesNotMatch(dockLess, /flex-direction:\s*row/);
	assert.match(dockTemplate, /\{\{ 'activityOverview' \| agentSessionText \}\}/);
	assert.match(dockLess, /history-icon[\s\S]*?border-radius:\s*50%/);
});

test('session detail opens from either list and hydrates live agent events', () => {
	const document = createDocument();
	const service = {
		getLiveSessionDetail(executionId) {
			return {
				executionId,
				status: 'running',
				events: [{ id: 1, type: 'session.delta', text: '实时内容', updatedAt: '2026-08-22T10:00:00.000Z' }]
			};
		}
	};
	const { factory } = loadDirective(
		'webui/ui/directive/agentSessionDetail/agentSessionDetail.directive.js',
		'agentSessionDetail',
		{ document, window: { setTimeout: (callback) => callback() } },
	);
	const scope = createScope();
	factory(service).link(scope);

	document.dispatchEvent(new FakeCustomEvent('agent-session-detail-open', {
		detail: {
			source: 'activity',
			session: {
				executionId: 'execution-live',
				status: 'starting',
				session: { provider: 'codex', modelId: 'gpt-5.6-sol' },
			}
		}
	}));

	assert.equal(scope.sessionDetail.visible, true);
	assert.equal(scope.sessionDetail.live, true);
	assert.equal(scope.sessionDetail.events[0].text, '实时内容');
	assert.equal(scope.sessionDetail.session.session.provider, 'codex');
	scope.closeSessionDetail();
	assert.equal(scope.sessionDetail.visible, false);
	scope.destroy();
});

test('session dock opens, toggles, and keyboard-switches the shared drawers', () => {
  const document = createDocument();
  const { factory } = loadDirective(
    'webui/ui/directive/agentSessionDock/agentSessionDock.directive.js',
    'agentSessionDock',
    { document, window: { setTimeout: (callback) => callback() } },
  );
  const scope = createScope();
  factory().link(scope);

  scope.toggleSessionDrawer('activity');
  assert.equal(document.events.at(-1).type, 'agent-activity-open');

  document.dispatchEvent(new FakeCustomEvent('agent-session-drawer-state', {
    detail: { drawer: 'activity', open: true },
  }));
  assert.equal(scope.sessionDock.activeDrawer, 'activity');

  scope.toggleSessionDrawer('activity');
  assert.equal(document.events.at(-1).type, 'agent-activity-close');
  assert.equal(document.events.at(-1).detail.restoreFocus, true);

  let prevented = false;
  scope.handleSessionDockKeydown({ key: 'ArrowDown', preventDefault: () => { prevented = true; } }, 'activity');
  assert.equal(prevented, true);
  assert.equal(document.events.at(-1).type, 'agent-session-history-open');
  scope.destroy();
});

test('history tab queries real file-level session history when no node is supplied', () => {
  const document = createDocument();
  const queriedNodeIds = [];
  const service = {
    queryHistory(nodeId) {
      queriedNodeIds.push(nodeId);
      return {
        then(resolve) {
          resolve({
            sessions: [{
              nodeId: 'node-1',
              executionId: 'execution-1',
              status: 'completed',
              session: { provider: 'codex', modelId: 'gpt-5' },
            }],
            total: 1,
          });
        },
      };
    },
  };
  const window = {
    setTimeout: (callback) => callback(),
    minder: {
      getRoot() {
        return {
          traverse(callback) {
            callback({ getData: () => 'node-1', getText: () => '真实节点' });
          },
        };
      },
    },
  };
  const { factory } = loadDirective(
    'webui/ui/directive/agentSessionHistory/agentSessionHistory.directive.js',
    'agentSessionHistory',
    { document, window },
  );
  const scope = createScope();
  factory(service).link(scope);

  document.dispatchEvent(new FakeCustomEvent('agent-session-history-open', {
    detail: { source: 'session-dock' },
  }));

  assert.deepEqual(queriedNodeIds, [null]);
  assert.equal(scope.history.visible, true);
  assert.equal(scope.history.total, 1);
  assert.equal(scope.history.sessions[0].nodeTitle, '真实节点');
  assert.ok(document.events.some((event) => event.type === 'agent-activity-close'));
  assert.ok(document.events.some((event) => event.type === 'agent-session-drawer-state' && event.detail.open));
  scope.destroy();
});

test('activity and history drawers use mutually exclusive state events and labelled regions', () => {
  const activityDirective = read('webui/ui/directive/agentActivityOverview/agentActivityOverview.directive.js');
  const activityTemplate = read('webui/ui/directive/agentActivityOverview/agentActivityOverview.html');
  const historyDirective = read('webui/ui/directive/agentSessionHistory/agentSessionHistory.directive.js');
	const historyTemplate = read('webui/ui/directive/agentSessionHistory/agentSessionHistory.html');
	const detailTemplate = read('webui/ui/directive/agentSessionDetail/agentSessionDetail.html');
  const drawerLess = read('webui/less/agentSession.less');

  assert.match(activityDirective, /agent-session-history-close/);
  assert.match(historyDirective, /agent-activity-close/);
  assert.doesNotMatch(historyDirective, /!scope\.history\.nodeId/);
  assert.match(activityTemplate, /id="agent-activity-drawer"/);
  assert.match(activityTemplate, /aria-labelledby="agent-activity-drawer-title"/);
  assert.match(historyTemplate, /id="agent-session-history-drawer"/);
  assert.match(historyTemplate, /data-slot="history-node"/);
	assert.match(detailTemplate, /data-component="agent-session-detail"/);
	assert.match(detailTemplate, /data-slot="session-event-list"/);
	assert.match(drawerLess, /right:\s*~"calc\(var\(--spacing\) \* 13\)"/);
	assert.match(drawerLess, /top:\s*50%/);
	assert.match(drawerLess, /bottom:\s*auto/);
	assert.match(drawerLess, /agent-session-drawer-in/);
});

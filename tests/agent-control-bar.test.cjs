const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

test('agent controls live only in the bottom control bar', () => {
  const control = fs.readFileSync(
    path.join(root, 'webui/ui/directive/agentControlBar/agentControlBar.html'),
    'utf8'
  );
  const card = fs.readFileSync(path.join(root, 'webui/ui/directive/nodeCard/nodeCard.html'), 'utf8');
	assert.match(control, /data-component="agent-control-bar"/);
	assert.match(control, /data-component="agent-control-bar" data-agent-control-surface/);
	for (const slot of ['composer-shell', 'provider-trigger', 'provider-menu', 'permission-trigger', 'permission-menu', 'config-trigger', 'config-menu', 'instruction-input', 'primary-action-button', 'collapsed-primary-action', 'agent-action-feedback', 'retry-agent-action', 'toggle-collapse-button', 'collapsed-status']) {
		assert.match(control, new RegExp(slot));
	}
	assert.match(control, /permissionModeDescription\(mode\)/);
	assert.equal((control.match(/data-survives-collapse/g) || []).length, 2);
	assert.match(control, /collapsed-primary-action[\s\S]*?ng-click="handlePrimaryAction\(\)"/);
	assert.match(control, /collapsed-primary-action[\s\S]*?data-action-state="\{\{ getPrimaryActionState\(\) \}\}"/);
	assert.doesNotMatch(control, /activity-button|openAgentActivity/);
	assert.doesNotMatch(control, /data-slot="button (?:send|append|interrupt)-button"/);
	assert.doesNotMatch(control, /<select\b/i);
	assert.match(control, /<textarea[\s\S]*?handleComposerKeydown/);
	assert.match(control, /data-action-state="\{\{ getPrimaryActionState\(\) \}\}"/);
	assert.match(control, /'switchProvider' \| agentSessionText/);
	for (const slot of ['install-progress', 'install-status', 'install-status-indicator', 'retry-install-button']) {
		assert.match(control, new RegExp(slot));
	}
	for (const slot of ['mcp-connection', 'mcp-status-indicator']) {
		assert.match(control, new RegExp(slot));
	}
	assert.doesNotMatch(control, /mcp-status-label|reconnect-mcp-button/);
	assert.match(control, /data-slot="button mcp-connection"[\s\S]*?aria-label="\{\{ mcpConnectionLabel\(\) \}\}"/);
	assert.match(control, /aria-live="polite"/);
	assert.match(control, /role="progressbar"/);
	assert.doesNotMatch(control, /<progress\b/i);
  assert.doesNotMatch(card, /<button|<select|<textarea|<input/i);
});

test('KM MCP connection state exposes localized recovery status and a manual reconnect action', () => {
  const service = fs.readFileSync(path.join(root, 'webui/ui/service/agentSession.service.js'), 'utf8');
  const directive = fs.readFileSync(
    path.join(root, 'webui/ui/directive/agentControlBar/agentControlBar.directive.js'),
    'utf8'
  );
  const i18n = fs.readFileSync(path.join(root, 'webui/ui/service/agentSessionI18n.service.js'), 'utf8');
  assert.match(service, /message\.command === 'mcpConnectionState'/);
  assert.match(service, /request\('reconnectMcp'\)/);
  assert.match(service, /mcpOperationFailed/);
  assert.match(directive, /scope\.reconnectMcp/);
  assert.match(directive, /agentSessionService\.reconnectMcp\(\)/);
  assert.match(i18n, /正在重连 KM MCP/);
  assert.match(i18n, /请重连后重试刚才的操作/);
  assert.match(i18n, /KM MCP 已恢复，请重试刚才的操作/);
});

test('a default-selected missing Codex runtime keeps an explicit install entry point', () => {
  let directiveFactory;
  const moduleApi = {
    directive(name, definition) {
      if (name === 'agentControlBar') directiveFactory = definition.at(-1);
      return moduleApi;
    }
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(root, 'webui/ui/directive/agentControlBar/agentControlBar.directive.js'), 'utf8'),
    {
      angular: { module: () => moduleApi },
      CustomEvent: function CustomEvent() {},
      document: { dispatchEvent() {} },
      window: {}
    }
  );
  const missingCodex = {
    id: 'codex',
    displayName: 'Codex',
    installState: 'missing',
    models: []
  };
  const resolved = (value) => ({ then: (success) => success(value) });
  const sessionService = {
    getSnapshot: () => ({ providers: [missingCodex], session: null, document: {} }),
    discoverProviders: () => resolved({ providers: [missingCodex], session: null, document: {} }),
    normalizeSession: (value) => value
  };
  const scope = { $on() {} };
  directiveFactory(sessionService, { t: (key) => key }).link(scope);

  assert.equal(scope.agentControl.providerId, 'codex');
  assert.equal(scope.selectedProviderNeedsInstall(), true);
  scope.requestSelectedProviderInstall();
  assert.equal(scope.agentControl.installCandidate, missingCodex);
  scope.cancelProviderInstall();
  assert.equal(scope.agentControl.installCandidate, null);
  assert.equal(scope.selectedProviderNeedsInstall(), true);
});

test('a default-selected installed Provider loads models and enables send for a clean document', () => {
  let directiveFactory;
  const moduleApi = {
    directive(name, definition) {
      if (name === 'agentControlBar') directiveFactory = definition.at(-1);
      return moduleApi;
    }
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(root, 'webui/ui/directive/agentControlBar/agentControlBar.directive.js'), 'utf8'),
    {
      angular: { module: () => moduleApi },
      CustomEvent: function CustomEvent() {},
      document: { dispatchEvent() {} },
      window: {}
    }
  );
  const installedCodex = {
    id: 'codex',
    displayName: 'Codex',
    installState: 'installed_inactive',
    models: []
  };
  const readyCodex = {
    ...installedCodex,
    installState: 'ready',
    models: [{ id: 'gpt-5.6-codex', label: 'GPT-5.6 Codex', effortOptions: [] }],
    permissionModes: [{
      id: 'codex:ask', label: 'Ask for approval', support: 'native', risk: 'standard', isDefault: true
    }]
  };
  const resolved = (value) => ({ then: (success) => success(value) });
  const listCalls = [];
  const sessionService = {
    getSnapshot: () => ({ providers: [], session: null, document: {} }),
    discoverProviders: () => resolved({ providers: [installedCodex], session: null, document: { dirty: false, conflict: false } }),
    listModels: (providerId) => {
      listCalls.push(providerId);
      return resolved({ descriptor: readyCodex, models: readyCodex.models });
    },
    normalizeSession: (value) => value
  };
  const scope = { $on() {} };
  directiveFactory(sessionService, { t: (key) => key }).link(scope);

  assert.deepEqual(listCalls, ['codex']);
  assert.equal(scope.agentControl.providerId, 'codex');
  assert.equal(scope.agentControl.modelId, 'gpt-5.6-codex');
  assert.equal(scope.canSendAgentSession(), true);
  assert.equal(scope.providerOptionLabel(readyCodex), 'Codex');
  assert.equal(scope.providerOptionLabel(installedCodex), 'Codex · installed_inactive');
});

test('primary action and collapse controls follow the current session state', () => {
  let directiveFactory;
  const moduleApi = {
    directive(name, definition) {
      if (name === 'agentControlBar') directiveFactory = definition.at(-1);
      return moduleApi;
    }
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(root, 'webui/ui/directive/agentControlBar/agentControlBar.directive.js'), 'utf8'),
    {
      angular: { module: () => moduleApi },
      CustomEvent: function CustomEvent() {},
      document: { dispatchEvent() {} },
      window: {}
    }
  );
  const resolved = (value) => ({ then: (success) => success(value) });
  const sessionService = {
    getSnapshot: () => ({ providers: [], session: null, document: { dirty: false, conflict: false } }),
    discoverProviders: () => resolved({ providers: [], session: null, document: { dirty: false, conflict: false } }),
    normalizeSession: (value) => value
  };
  const scope = { $on() {} };
  directiveFactory(sessionService, { t: (key) => key }).link(scope);
  scope.agentControl.busy = false;
  const providers = [
    {
      id: 'codex', displayName: 'Codex', installState: 'ready',
      models: [{ id: 'gpt-5.6-codex', label: 'GPT-5.6 Codex', defaultEffort: 'high', effortOptions: [
        { id: 'medium', label: '中' }, { id: 'high', label: '高' }
      ] }],
      permissionModes: [
        { id: 'codex:ask', label: 'Ask for approval', support: 'native', risk: 'standard', isDefault: true,
          semantics: { approvals: 'interactive', workspaceAccess: 'workspace-write' } },
        { id: 'codex:full-access', label: 'Full access', support: 'native', risk: 'elevated', requiresConfirmation: true,
          semantics: { approvals: 'non-interactive', workspaceAccess: 'full-access' } }
      ]
    },
    {
      id: 'claudecode', displayName: 'Claude Code', installState: 'ready',
      models: [{ id: 'claude-opus-4-1', label: 'Claude Opus 4.1', effortOptions: [] }],
      permissionModes: [{ id: 'claude:default', label: 'Default', support: 'native', risk: 'standard', isDefault: true }]
    }
  ];
  scope.agentControl.providers = providers;
  scope.agentControl.providerId = 'codex';
  scope.providerChanged();

  assert.equal(scope.selectedProviderLabel(), 'Codex');
  assert.equal(scope.configurationLabel(), 'GPT-5.6 Codex · 高');
  assert.equal(scope.selectedPermissionModeLabel(), 'Ask for approval');
  assert.equal(scope.permissionModeDescription(providers[0].permissionModes[0]), 'permissionAskDescription');
  assert.equal(scope.permissionModeDescription(providers[0].permissionModes[1]), 'permissionFullAccessDescription');
  scope.togglePermissionMenu();
  assert.equal(scope.agentControl.permissionMenuOpen, true);
  scope.selectPermissionFromMenu(providers[0].permissionModes[1]);
  assert.equal(scope.agentControl.permissionModeId, 'codex:ask');
  assert.equal(scope.agentControl.permissionModeCandidate.id, 'codex:full-access');
  scope.cancelPermissionMode();
  scope.selectPermissionFromMenu(providers[0].permissionModes[1]);
  scope.confirmPermissionMode();
  assert.equal(scope.agentControl.permissionModeId, 'codex:full-access');
  scope.toggleProviderMenu();
  assert.equal(scope.agentControl.providerMenuOpen, true);
  scope.toggleConfigMenu();
  assert.equal(scope.agentControl.providerMenuOpen, false);
  assert.equal(scope.agentControl.configMenuOpen, true);
  scope.selectEffortFromMenu({ id: 'medium', label: '中' });
  assert.equal(scope.agentControl.effort, 'medium');
  assert.equal(scope.agentControl.configMenuOpen, false);
  scope.selectProviderFromMenu(providers[1]);
  assert.equal(scope.agentControl.providerId, 'claudecode');
  assert.equal(scope.agentControl.modelId, 'claude-opus-4-1');
  assert.equal(scope.selectedProviderLabel(), 'Claude Code');
  scope.selectProviderFromMenu(providers[0]);

  assert.equal(scope.agentControl.collapsed, false);
  scope.toggleProviderMenu();
  scope.toggleCollapse();
  assert.equal(scope.agentControl.collapsed, true);
  assert.equal(scope.agentControl.providerMenuOpen, false);
  assert.equal(scope.getPrimaryActionState(), 'send');
  assert.equal(scope.canPerformPrimaryAction(), true);
  scope.toggleCollapse();
  assert.equal(scope.agentControl.collapsed, false);

  const calls = [];
  scope.sendAgentSession = () => calls.push('send');
  scope.appendAgentSession = () => calls.push('append');
  scope.interruptAgentSession = () => calls.push('interrupt');

  assert.equal(scope.getPrimaryActionState(), 'send');
  assert.equal(scope.canPerformPrimaryAction(), true);
  scope.handlePrimaryAction();

  scope.agentControl.session = { activeTurnId: null, session: { provider: 'codex' } };
  assert.equal(scope.getPrimaryActionState(), 'append');
  assert.equal(scope.canPerformPrimaryAction(), true);
  scope.handlePrimaryAction();

	// Switching Provider on an idle session starts a new session instead of
	// sending an invalid append request to the previous Provider.
	scope.agentControl.providerId = 'claudecode';
	scope.agentControl.modelId = 'claude-opus-4-1';
	scope.agentControl.permissionModeId = 'claude:default';
	assert.equal(scope.getPrimaryActionState(), 'send');
	assert.equal(scope.canAppendAgentSession(), false);
	assert.equal(scope.canPerformPrimaryAction(), true);
	scope.handlePrimaryAction();
	scope.agentControl.providerId = 'codex';

  scope.agentControl.session.activeTurnId = 'turn-1';
  assert.equal(scope.getPrimaryActionState(), 'interrupt');
  assert.equal(scope.canPerformPrimaryAction(), true);
  scope.handlePrimaryAction();

  assert.deepEqual(calls, ['send', 'append', 'send', 'interrupt']);
});

test('agent actions provide immediate feedback, suppress duplicates, and recover with the same idempotency key', () => {
  let directiveFactory;
  const moduleApi = {
    directive(name, definition) {
      if (name === 'agentControlBar') directiveFactory = definition.at(-1);
      return moduleApi;
    }
  };
  const timers = [];
  const fakeSetTimeout = (callback, milliseconds) => {
    const timer = { callback, milliseconds, cancelled: false };
    timers.push(timer);
    return timer;
  };
  const fakeClearTimeout = (timer) => { timer.cancelled = true; };
  vm.runInNewContext(
    fs.readFileSync(path.join(root, 'webui/ui/directive/agentControlBar/agentControlBar.directive.js'), 'utf8'),
    {
      angular: { module: () => moduleApi },
      CustomEvent: function CustomEvent() {},
      document: { dispatchEvent() {} },
      window: { crypto: { randomUUID: (() => { let id = 0; return () => `request-${++id}`; })() } },
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout
    }
  );
  const resolved = (value) => ({ then: (success) => success(value) });
  const deferredCall = (payload) => {
    const call = { payload };
    call.promise = {
      then(success, failure) {
        call.resolve = success;
        call.reject = failure;
      }
    };
    return call;
  };
  const sendCalls = [];
  const appendCalls = [];
  const interruptCalls = [];
  const sessionService = {
    getSnapshot: () => ({ providers: [], session: null, document: { dirty: false, conflict: false } }),
    discoverProviders: () => resolved({ providers: [], session: null, document: { dirty: false, conflict: false } }),
    normalizeSession: (value) => value,
    send(payload) {
      const call = deferredCall(payload);
      sendCalls.push(call);
      return call.promise;
    },
    append(payload) {
      const call = deferredCall(payload);
      appendCalls.push(call);
      return call.promise;
    },
    interrupt(turnId) {
      const call = deferredCall(turnId);
      interruptCalls.push(call);
      return call.promise;
    }
  };
  const scope = { $on() {}, $evalAsync() {} };
  directiveFactory(sessionService, { t: (key) => key }).link(scope);
  Object.assign(scope.agentControl, {
    busy: false,
    providerId: 'codex',
    modelId: 'gpt-5.6-codex',
    permissionModeId: 'codex:ask',
    input: 'Run the task'
  });

  scope.handlePrimaryAction();
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].payload.permissionModeId, 'codex:ask');
  assert.equal(scope.agentControl.action.phase, 'sending');
  assert.equal(scope.agentActionStatusLabel(), 'sending');
  assert.equal(scope.primaryActionLabel(), 'sending');
  assert.equal(scope.canPerformPrimaryAction(), false);
  scope.handlePrimaryAction();
  assert.equal(sendCalls.length, 1, 'a second click while pending must not submit again');

  assert.equal(timers[0].milliseconds, 30000);
  timers[0].callback();
  assert.equal(scope.agentControl.action.phase, 'timed_out');
  assert.equal(scope.agentControl.busy, false);
  assert.equal(scope.agentControl.error, 'requestTimedOut');
  assert.equal(scope.canRetryAgentAction(), true);
  sendCalls[0].resolve({ session: { activeTurnId: 'late-turn' } });
  assert.equal(scope.agentControl.session, null, 'a response arriving after timeout must not overwrite newer UI state');
  assert.equal(scope.agentControl.input, 'Run the task');

  scope.retryAgentAction();
  assert.equal(sendCalls.length, 2);
  assert.equal(sendCalls[1].payload.idempotencyKey, sendCalls[0].payload.idempotencyKey);
  sendCalls[1].resolve({ session: { executionId: 'execution-1', activeTurnId: 'turn-1', session: { provider: 'codex' } } });
  assert.equal(scope.agentControl.action.phase, 'idle');
  assert.equal(scope.agentControl.input, '');
  assert.equal(scope.getPrimaryActionState(), 'interrupt');
  assert.equal(scope.agentActionFeedbackState(), 'running');
  assert.equal(scope.agentActionStatusLabel(), 'active');

  scope.handlePrimaryAction();
  assert.equal(interruptCalls.length, 1);
  assert.equal(interruptCalls[0].payload, 'turn-1');
  assert.equal(scope.agentControl.action.phase, 'interrupting');
  assert.equal(scope.primaryActionLabel(), 'interrupting');
  scope.handlePrimaryAction();
  assert.equal(interruptCalls.length, 1, 'interrupt is also single-flight');
  interruptCalls[0].resolve({ session: { executionId: 'execution-1', activeTurnId: null, session: { provider: 'codex' } } });

  scope.agentControl.input = 'Follow up';
  scope.handlePrimaryAction();
  assert.equal(appendCalls.length, 1);
	assert.equal(appendCalls[0].payload.providerId, 'codex');
  assert.equal(scope.agentControl.action.phase, 'sending');
  assert.equal(scope.primaryActionLabel(), 'sending');
  appendCalls[0].reject(new Error('Provider unavailable'));
  assert.equal(scope.agentControl.action.phase, 'failed');
  assert.equal(scope.agentControl.error, 'Provider unavailable');
  assert.equal(scope.canRetryAgentAction(), true);
  scope.retryAgentAction();
  assert.equal(appendCalls.length, 2);
  assert.equal(appendCalls[1].payload.idempotencyKey, appendCalls[0].payload.idempotencyKey);
});

test('outside clicks collapse the bar, dismiss transient menus, and preserve collapsed runtime interactions', () => {
  let directiveFactory;
  const moduleApi = {
    directive(name, definition) {
      if (name === 'agentControlBar') directiveFactory = definition.at(-1);
      return moduleApi;
    }
  };
  const documentListeners = new Map();
  const fakeDocument = {
    addEventListener(name, listener) { documentListeners.set(name, listener); },
    removeEventListener(name, listener) {
      if (documentListeners.get(name) === listener) documentListeners.delete(name);
    },
    dispatchEvent() {}
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(root, 'webui/ui/directive/agentControlBar/agentControlBar.directive.js'), 'utf8'),
    {
      angular: { module: () => moduleApi },
      CustomEvent: function CustomEvent() {},
      document: fakeDocument,
      window: {}
    }
  );
  const resolved = (value) => ({ then: (success) => success(value) });
  const resolvedInputs = [];
  const sessionService = {
    getSnapshot: () => ({ providers: [], session: null, document: { dirty: false, conflict: false } }),
    discoverProviders: () => resolved({ providers: [], session: null, document: { dirty: false, conflict: false } }),
    normalizeSession: (value) => value,
    resolveInput(requestId, decision, value) {
      resolvedInputs.push({ requestId, decision, value });
      return resolved();
    }
  };
  const scopeListeners = new Map();
  const scope = {
    $evalAsync(callback) { callback(); },
    $on(name, listener) {
      if (!scopeListeners.has(name)) scopeListeners.set(name, []);
      scopeListeners.get(name).push(listener);
    }
  };
  const rootElement = {
    contains(target) { return target && target.insideControlBar === true; }
  };
  directiveFactory(sessionService, { t: (key) => key }).link(scope, [rootElement]);

  scope.agentControl.providerMenuOpen = true;
  scope.agentControl.permissionMenuOpen = true;
  documentListeners.get('click')({
    target: { nodeType: 1, getAttribute: () => null, parentNode: fakeDocument }
  });
  assert.equal(scope.agentControl.collapsed, true);
  assert.equal(scope.agentControl.providerMenuOpen, false);
  assert.equal(scope.agentControl.permissionMenuOpen, false);

  scope.agentControl.collapsed = false;
  scope.agentControl.configMenuOpen = true;
  const derivedSurface = {
    nodeType: 1,
    getAttribute(name) { return name === 'data-agent-control-surface' ? '' : null; },
    parentNode: fakeDocument
  };
  documentListeners.get('click')({ target: derivedSurface });
  assert.equal(scope.agentControl.collapsed, false);
  assert.equal(scope.agentControl.configMenuOpen, true);

	// Angular can remove a clicked menu item before the event reaches document.
	// The original propagation path still identifies it as a control-bar action.
	scope.agentControl.configMenuOpen = false;
	const detachedMenuAction = {
		nodeType: 1,
		getAttribute: () => null,
		parentNode: null
	};
	documentListeners.get('click')({
		target: detachedMenuAction,
		composedPath: () => [detachedMenuAction, rootElement, fakeDocument]
	});
	assert.equal(scope.agentControl.collapsed, false);

  scope.agentControl.collapsed = true;
  scope.agentControl.session = {
    executionId: 'execution-collapsed',
    status: 'running',
    activeTurnId: 'turn-1',
    session: { provider: 'codex' }
  };
  const emitSessionEvent = (value) => {
    for (const listener of scopeListeners.get('agent-session-event') || []) listener({}, value);
  };
  emitSessionEvent({
    executionId: 'execution-collapsed',
    type: 'session.input.required',
    payload: { requestId: 'approval-1', title: 'Run command', description: 'npm test' }
  });
  assert.equal(scope.agentControl.inputRequest.requestId, 'approval-1');
  assert.equal(scope.agentControl.collapsed, true);
  scope.resolveAgentInput('approve');
  assert.deepEqual(resolvedInputs, [{ requestId: 'approval-1', decision: 'approve', value: '' }]);
  assert.equal(scope.agentControl.inputRequest, null);

  emitSessionEvent({
    executionId: 'execution-collapsed',
    type: 'session.state.changed',
    payload: { status: 'failed', activeTurnId: null, error: 'Runtime failed' }
  });
  assert.equal(scope.agentControl.error, 'Runtime failed');
  assert.equal(scope.agentControl.session.status, 'failed');
  emitSessionEvent({
    executionId: 'execution-collapsed',
    type: 'session.completed',
    payload: { status: 'failed' }
  });
  assert.equal(scope.agentControl.session.status, 'failed');
	assert.equal(scope.agentControl.error, 'Runtime failed');
  assert.equal(scope.agentControl.collapsed, true);

  for (const listener of scopeListeners.get('$destroy') || []) listener();
  assert.equal(documentListeners.has('click'), false);
});

test('agent-session UI uses semantic tokens and ships the 21-language union', () => {
  const styles = fs.readFileSync(path.join(root, 'webui/less/agentSession.less'), 'utf8');
  const composerStyles = fs.readFileSync(path.join(root, 'webui/less/agentComposer.less'), 'utf8');
  const nodeStyles = fs.readFileSync(path.join(root, 'webui/less/nodeCard.less'), 'utf8');
  const i18n = fs.readFileSync(path.join(root, 'webui/ui/service/agentSessionI18n.service.js'), 'utf8');
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}|rgba?\(|hsla?\(|\d+(?:\.\d+)?(?:px|rem)/i);
  assert.doesNotMatch(styles, /transition-all/);
  assert.doesNotMatch(composerStyles, /#[0-9a-f]{3,8}|rgba?\(|hsla?\(|\d+(?:\.\d+)?(?:px|rem)/i);
  assert.doesNotMatch(composerStyles, /transition-all/);
	for (const slot of ['composer-shell', 'instruction-input', 'provider-trigger', 'permission-trigger', 'config-trigger', 'menu-item', 'primary-action-button']) {
		assert.match(composerStyles, new RegExp(`data-slot(?:~)?=["']${slot}["']`));
	}
	assert.match(composerStyles, /\[data-slot="permission-description"\][\s\S]*?text-overflow: ellipsis;[\s\S]*?white-space: nowrap;/);
	assert.match(composerStyles, /\[data-slot~="menu-item"\][\s\S]*?height: auto;/);
	assert.match(composerStyles, /&\.is-collapsed \[data-slot="status"\][\s\S]*?max-width:/);
	assert.match(composerStyles, /&\.is-collapsed \[data-component="agent-input-dialog"\][\s\S]*?transform: translateX\(-50%\)/);
	assert.match(composerStyles, /\[data-slot="status"\],[\s\S]*?animation-name: agent-session-fade-in;/);
	assert.match(composerStyles, /@keyframes agent-session-fade-in[\s\S]*?opacity: 0;[\s\S]*?opacity: 1;/);
	assert.match(styles, /@container \(max-width: 100ch\)[\s\S]*?bottom: ~"calc\(var\(--spacing\) \* 80\)";[\s\S]*?\.node-card \{ bottom: ~"calc\(var\(--spacing\) \* 108\)"; \}/);
	assert.match(styles, /\[data-component="agent-session-history"\][\s\S]*?bottom: auto;/);
	assert.match(styles, /\[data-component="agent-activity-overview"\][\s\S]*?bottom: auto;/);
	for (const slot of ['instruction-field', 'effort-field', 'model-field']) {
		assert.match(styles, new RegExp(`data-slot~=["']${slot}["']`));
	}
	assert.match(styles, /\[data-component="agent-session-history"\][\s\S]*?\[data-slot~="button"\][\s\S]*?background: var\(--surface-raised-base\)/);
  assert.doesNotMatch(nodeStyles, /#[0-9a-f]{3,8}|rgba?\(|hsla?\(|\d+(?:\.\d+)?(?:px|rem)/i);
  assert.doesNotMatch(
	fs.readFileSync(path.join(root, 'webui/ui/directive/nodeCard/nodeCard.html'), 'utf8'),
	/ng-style|style=/i
  );
  for (const token of ['--background-base', '--surface-raised-stronger-non-alpha', '--text-strong', '--border-weak-base', '--radius-md', '--shadow-md']) {
    assert.match(styles, new RegExp(token));
  }
  const languages = ['en', 'de', 'es', 'fr', 'it', 'cs', 'hu', 'ja', 'ko', 'pl', 'pt', 'ru', 'zh-cn', 'zh-tw', 'no', 'br', 'th', 'da', 'bs', 'tr', 'ar'];
  for (const language of languages) {
    assert.match(i18n, new RegExp(`(?:^|\\s|[,{])['\"]?${language.replace('-', '\\-')}['\"]?\\s*:`));
  }
});

test('main VSIX owns all Provider runtimes and has no companion packaging command', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const registry = fs.readFileSync(path.join(root, 'src/providers/providerComponentRegistry.ts'), 'utf8');
  const installer = fs.readFileSync(path.join(root, 'src/providers/codexRuntimeInstaller.ts'), 'utf8');
  assert.equal(packageJson.scripts['package:companions'], undefined);
  assert.equal(packageJson.scripts['typecheck:companions'], undefined);
  assert.equal(fs.existsSync(path.join(root, 'companions')), false);
  assert.match(registry, /CodexRuntimeInstaller/);
  assert.match(registry, /ManagedNpmRuntimeInstaller/);
  assert.match(installer, /github\.com\/openai\/codex\/releases/);
  assert.equal(packageJson.dependencies['@anthropic-ai/claude-agent-sdk'], '0.3.227');
  assert.equal(packageJson.dependencies['@github/copilot-sdk'], '1.0.9');
});

test('node, activity, and approval copy is localized in every non-English locale', () => {
  let factory;
  const moduleApi = {
    factory(name, definition) {
      if (name === 'agentSessionI18n') factory = definition.at(-1);
      return moduleApi;
    },
    filter() { return moduleApi; }
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(root, 'webui/ui/service/agentSessionI18n.service.js'), 'utf8'),
    { angular: { module: () => moduleApi }, Object }
  );
  const english = factory({ get: () => 'en' });
  const keys = ['taskStatus', 'noSessionRecord', 'activityOverview', 'approvalTitle', 'installWaiting', 'installCompleted', 'installFailed', 'retry'];
  for (const language of english.languages.filter((value) => value !== 'en')) {
    const localized = factory({ get: () => language });
    for (const key of keys) {
      assert.notEqual(localized.t(key), english.t(key), `${language}.${key} must not fall back to English`);
    }
  }
});

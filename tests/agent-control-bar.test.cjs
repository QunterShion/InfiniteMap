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
  for (const slot of ['provider-select', 'provider-install-button', 'model-select', 'instruction-input', 'send-button', 'append-button', 'interrupt-button']) {
    assert.match(control, new RegExp(slot));
  }
	for (const slot of ['install-progress', 'install-status', 'install-status-indicator', 'retry-install-button']) {
		assert.match(control, new RegExp(slot));
	}
	for (const slot of ['mcp-connection', 'mcp-status-indicator', 'mcp-status-label', 'reconnect-mcp-button']) {
		assert.match(control, new RegExp(slot));
	}
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
    models: [{ id: 'gpt-5.6-codex', label: 'GPT-5.6 Codex', effortOptions: [] }]
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
});

test('agent-session UI uses semantic tokens and ships the 21-language union', () => {
  const styles = fs.readFileSync(path.join(root, 'webui/less/agentSession.less'), 'utf8');
  const nodeStyles = fs.readFileSync(path.join(root, 'webui/less/nodeCard.less'), 'utf8');
  const i18n = fs.readFileSync(path.join(root, 'webui/ui/service/agentSessionI18n.service.js'), 'utf8');
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}|rgba?\(|hsla?\(|\d+(?:\.\d+)?(?:px|rem)/i);
  assert.doesNotMatch(styles, /transition-all/);
	assert.match(styles, /@container \(max-width: 100ch\)[\s\S]*?bottom: ~"calc\(var\(--spacing\) \* 80\)";[\s\S]*?\.node-card \{ bottom: ~"calc\(var\(--spacing\) \* 108\)"; \}/);
	assert.match(styles, /\[data-component="agent-session-history"\][\s\S]*?bottom: ~"calc\(var\(--spacing\) \* 28\)";/);
	assert.match(styles, /\[data-component="agent-activity-overview"\][\s\S]*?bottom: ~"calc\(var\(--spacing\) \* 28\)";/);
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

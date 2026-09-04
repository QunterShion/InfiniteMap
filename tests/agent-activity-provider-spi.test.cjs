const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('activity and history expose agent sessions without MCP lease state', () => {
  const coordinator = read('src/sessions/agentControlBarCoordinator.ts');
  const service = read('webui/ui/service/agentSession.service.js');
  const directive = read('webui/ui/directive/agentActivityOverview/agentActivityOverview.directive.js');
	const historyDirective = read('webui/ui/directive/agentSessionHistory/agentSessionHistory.directive.js');
	const detailDirective = read('webui/ui/directive/agentSessionDetail/agentSessionDetail.directive.js');
  const editor = read('webui/ui/directive/kityminderEditor/kityminderEditor.html');

  assert.match(coordinator, /\.\.\.\(request\.nodeId \? \{ nodeId: request\.nodeId \} : \{\}\)/);
  assert.match(coordinator, /preflightKm\(document\)/);
  assert.match(coordinator, /queueSessionPersistence\(documentKey, snapshot\)/);
  assert.match(coordinator, /km_record_session/);
	assert.match(coordinator, /findSessionRecord\(document, request\.executionId, request\.nodeId\)/);
	assert.match(coordinator, /openHistoricalSession\(\{[\s\S]*?executionId: record\.executionId,[\s\S]*?session: record\.session/);
	assert.doesNotMatch(coordinator, /case 'openSession':[\s\S]*?orchestrator\.open\(documentKey/);
	assert.match(service, /queryActivityPage/);
	assert.match(service, /fallbackPolicy/);
	assert.match(service, /mode: mode/);
	assert.match(service, /listLiveAgentSessions/);
	assert.match(service, /getLiveSessionDetail/);
  assert.match(directive, /queryActivityPage\(cursor, 100\)/);
	assert.match(directive, /listLiveAgentSessions/);
	assert.match(directive, /openActivitySession/);
	assert.match(directive, /openActivitySessionFallback/);
  assert.doesNotMatch(directive, /window\.kmExecState|leaseUntil|workerId|taskKind/);
  assert.match(directive, /setTimeout\(function\(\) \{[\s\S]*?\}, 60\)/);
	assert.match(historyDirective, /listLiveAgentSessions/);
	assert.match(historyDirective, /openNative/);
	assert.match(historyDirective, /openSessionFallback/);
	assert.match(detailDirective, /agent-session-live-detail/);
	assert.doesNotMatch(directive, /replace:\s*true/);
	assert.doesNotMatch(historyDirective, /replace:\s*true/);
  assert.match(editor, /agent-activity-overview/);
	assert.match(editor, /agent-session-detail/);
});

test('Provider API v1 documents the internal single-VSIX runtime and security boundary', () => {
  const docs = read('docs/provider-component-api-v1.md');

  for (const phrase of [
    'additive compatibility', 'catalog.json', 'globalStorage', 'SHA-256',
    'same InfiniteMap VSIX', 'session.input.required', 'fails closed', 'zero-install'
  ]) {
    assert.match(docs, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
  assert.match(docs, /never `infinite-map-provider-\*\.vsix`/);
});

test('the three built-in adapters implement the versioned session surface', () => {
  const sources = [
    read('src/providers/codex/CodexAgentSessionAdapter.ts'),
    read('src/providers/claude/ClaudeAgentSessionAdapter.ts'),
    read('src/providers/copilot/CopilotAgentSessionAdapter.ts')
  ];
  const requiredMethods = [
    'getDescriptor', 'detectCapabilities', 'listModels', 'createSession', 'send', 'append',
    'query', 'mutate', 'interrupt', 'open', 'onDidEvent', 'dispose'
  ];
  for (const source of sources) {
    assert.match(source, /implements AgentSessionAdapter/);
    assert.match(source, /from '\.\.\/\.\.\/sessions\/types'/);
    for (const method of requiredMethods) {
      assert.match(source, new RegExp(`(?:async )?${method}\\s*\\(`));
    }
  }
  for (const instructions of [read('src/providers/codex/protocol.ts')]) {
    assert.match(instructions, /claimed nodeId before calling km_record_session/);
  }
});

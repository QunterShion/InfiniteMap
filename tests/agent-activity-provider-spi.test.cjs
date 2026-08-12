const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('activity overview combines file-level session history with debounced exec-state leases', () => {
  const coordinator = read('src/sessions/agentControlBarCoordinator.ts');
  const service = read('webui/ui/service/agentSession.service.js');
  const directive = read('webui/ui/directive/agentActivityOverview/agentActivityOverview.directive.js');
	const historyDirective = read('webui/ui/directive/agentSessionHistory/agentSessionHistory.directive.js');
  const editor = read('webui/ui/directive/kityminderEditor/kityminderEditor.html');

  assert.match(coordinator, /\.\.\.\(request\.nodeId \? \{ nodeId: request\.nodeId \} : \{\}\)/);
  assert.match(service, /queryActivityPage/);
  assert.match(directive, /queryActivityPage\(cursor, 100\)/);
  assert.match(directive, /window\.kmExecState/);
  assert.match(directive, /Date\.parse\(lease\.leaseUntil\)/);
  assert.match(directive, /setTimeout\(function\(\) \{[\s\S]*?\}, 60\)/);
	assert.doesNotMatch(directive, /replace:\s*true/);
	assert.doesNotMatch(historyDirective, /replace:\s*true/);
  assert.match(editor, /agent-activity-overview/);
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

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

require('ts-node/register/transpile-only');
const { buildUserTurn } = require('../src/sessions/buildUserTurn.ts');

const repoRoot = path.resolve(__dirname, '..');
const kmPath = path.join(repoRoot, 'fixtures', 'tasks.km');

test('buildUserTurn preserves the trusted KM path semantics', () => {
  assert.equal(buildUserTurn('', kmPath), path.resolve(kmPath));
  assert.equal(buildUserTurn('   ', kmPath), path.resolve(kmPath));
  assert.equal(
    buildUserTurn('继续处理', kmPath),
    `继续处理\n\n${path.resolve(kmPath)}`
  );
  assert.throws(() => buildUserTurn('', path.join(repoRoot, 'not-a-map.txt')), /local \.km/);
});

test('provider catalog exposes all three runtimes managed by the InfiniteMap extension', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src/providers/catalog.json'), 'utf8'));
  const registry = fs.readFileSync(path.join(repoRoot, 'src/providers/providerComponentRegistry.ts'), 'utf8');
  const installer = fs.readFileSync(path.join(repoRoot, 'src/providers/codexRuntimeInstaller.ts'), 'utf8');
  assert.equal(catalog.schemaVersion, 1);
  assert.deepEqual(catalog.providers.map((provider) => provider.id), ['codex', 'claudecode', 'copilot']);
  assert.ok(catalog.providers.every((provider) => provider.extensionId === 'chanterxiao.infinite-map'));
  assert.match(registry, /new CodexRuntimeInstaller/);
  assert.match(registry, /new ManagedNpmRuntimeInstaller/);
  assert.match(registry, /new CodexAgentSessionAdapter/);
  assert.match(registry, /new ClaudeAgentSessionAdapter/);
  assert.match(registry, /new CopilotAgentSessionAdapter/);
  assert.match(installer, /globalStorage|storagePath/);
  assert.doesNotMatch(registry, /extension\.open|infinite-map-provider-codex/);
});

test('node card omits task status and session trace panels', () => {
  const template = fs.readFileSync(
    path.join(repoRoot, 'webui/ui/directive/nodeCard/nodeCard.html'),
    'utf8'
  );
  assert.doesNotMatch(template, /data-component="node-card-task-status"/);
  assert.doesNotMatch(template, /data-component="node-card-session-trace"/);
	assert.doesNotMatch(template, /<select|<textarea|<input/i);
});

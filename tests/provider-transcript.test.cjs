const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
	if (request === 'vscode') {
		return { EventEmitter: class { constructor() {} dispose() {} } };
	}
	return originalLoad.call(this, request, parent, isMain);
};

require('ts-node/register/transpile-only');
const { CopilotCustomEndpointReader } = require('../src/providers/copilot/CopilotCustomEndpointReader.ts');
const { copilotEventsToTranscript } = require('../src/providers/copilot/CopilotTranscriptMapper.ts');
const { claudeMessagesToTranscript } = require('../src/providers/claude/ClaudeTranscriptMapper.ts');
const { CopilotAgentSessionAdapter } = require('../src/providers/copilot/CopilotAgentSessionAdapter.ts');
Module._load = originalLoad;

test('Copilot reads VS Code customendpoint models without exposing secret values', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-copilot-'));
	const filePath = path.join(directory, 'chatLanguageModels.json');
	fs.writeFileSync(filePath, JSON.stringify([{
		name: 'Gateway',
		vendor: 'customendpoint',
		apiType: 'chat-completions',
		apiKey: '${input:chat.lm.secret.example}',
		models: [{ id: 'gpt-local', name: 'Local GPT', url: 'https://example.test/v1/chat/completions', toolCalling: true }],
	}, { name: 'Copilot', vendor: 'copilot', models: [{ id: 'ignored', url: 'https://ignored.test' }] }]));
	const [model] = CopilotCustomEndpointReader.read(filePath);
	assert.equal(model.selectionId, 'customendpoint/Gateway/gpt-local');
	assert.equal(model.baseUrl, 'https://example.test/v1');
	assert.equal(model.apiKey, undefined);
	assert.equal(model.apiKeyReference, '${input:chat.lm.secret.example}');
});

test('Copilot event history maps reasoning, responses, and tool results', () => {
	const transcript = copilotEventsToTranscript([
		{ id: 'u', timestamp: '2026-01-01T00:00:00Z', type: 'user.message', data: { content: 'inspect' } },
		{ id: 'a', timestamp: '2026-01-01T00:00:01Z', type: 'assistant.message', data: { messageId: 'm', content: 'done', reasoningText: 'checked files' } },
		{ id: 't', timestamp: '2026-01-01T00:00:02Z', type: 'tool.execution_complete', data: { toolCallId: 'tool-1', result: { textResultForLlm: 'ok' }, success: true } },
	]);
	assert.deepEqual(transcript.map((entry) => entry.kind), ['user', 'reasoning', 'assistant', 'tool']);
	assert.equal(transcript[1].text, 'checked files');
	assert.equal(transcript[3].text, 'ok');
});

test('Copilot creates a BYOK session with the selected custom endpoint', async () => {
	let capturedConfig;
	const customModel = {
		selectionId: 'customendpoint/Gateway/gpt-local', endpointName: 'Gateway', modelId: 'gpt-local',
		label: 'Gateway · gpt-local', baseUrl: 'https://example.test/v1', wireApi: 'completions', apiKey: 'secret'
	};
	const sdkSession = {
		sessionId: 'copilot-custom-session',
		on: () => () => undefined,
		disconnect: async () => undefined,
	};
	const runtime = {
		ensureProbe: async () => ({ authenticated: false, models: [], customEndpointModels: [customModel], client: {
			createSession: async (config) => { capturedConfig = config; return sdkSession; }
		} })
	};
	const adapter = new CopilotAgentSessionAdapter(runtime);
	await adapter.createSession({
		executionId: 'exec-custom', workingDirectory: '/workspace', modelId: customModel.selectionId,
		permissionModeId: 'copilot:ask', mcpServer: { command: 'mcp', args: [] }
	});
	assert.equal(capturedConfig.model, 'gpt-local');
	assert.deepEqual(capturedConfig.provider, {
		type: 'openai', baseUrl: 'https://example.test/v1', wireApi: 'completions',
		apiKey: 'secret', modelId: 'gpt-local', wireModel: 'gpt-local'
	});
	adapter.dispose();
});

test('Claude session messages map assistant thinking, tools, and results', () => {
	const transcript = claudeMessagesToTranscript([
		{ type: 'user', uuid: 'u', message: { role: 'user', content: 'run it' } },
		{ type: 'assistant', uuid: 'a', message: { role: 'assistant', content: [
			{ type: 'thinking', thinking: 'plan it' },
			{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
			{ type: 'text', text: 'finished' },
		] } },
		{ type: 'user', uuid: 'r', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } },
	]);
	assert.deepEqual(transcript.map((entry) => entry.kind), ['user', 'reasoning', 'tool', 'assistant', 'tool']);
	assert.equal(transcript[1].summary, 'plan it');
	assert.equal(transcript[4].status, 'completed');
});

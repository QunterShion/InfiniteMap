import { SessionTranscriptEntry, SessionTranscriptKind } from '../../sessions/types';
import { CodexThread, CodexThreadItem } from './protocol';

interface TranscriptContext {
	turnId?: string;
	startedAt?: string;
	completedAt?: string;
	updatedAt?: string;
}

const KIND_BY_ITEM_TYPE: Record<string, SessionTranscriptKind> = {
	userMessage: 'user',
	agentMessage: 'assistant',
	reasoning: 'reasoning',
	plan: 'plan',
	commandExecution: 'command',
	fileChange: 'file-change',
	mcpToolCall: 'mcp-tool',
	dynamicToolCall: 'tool',
	collabToolCall: 'collaboration',
	collabAgentToolCall: 'collaboration',
	subAgentActivity: 'collaboration',
	webSearch: 'web-search',
	imageView: 'image',
	imageGeneration: 'image',
};

export function codexThreadToTranscript(thread: CodexThread): SessionTranscriptEntry[] {
	const entries: SessionTranscriptEntry[] = [];
	for (const turn of thread.turns || []) {
		const startedAt = epochSecondsToIso(turn.startedAt);
		const completedAt = epochSecondsToIso(turn.completedAt);
		for (const item of turn.items || []) {
			entries.push(codexItemToTranscript(item, {
				turnId: turn.id,
				startedAt,
				completedAt,
				updatedAt: completedAt || startedAt,
			}));
		}
		if (turn.error?.message) {
			entries.push({
				id: `${turn.id}:error`,
				turnId: turn.id,
				kind: 'error',
				title: 'Turn failed',
				text: turn.error.message,
				status: 'failed',
				startedAt,
				completedAt,
				updatedAt: completedAt || startedAt || new Date().toISOString(),
			});
		}
	}
	return entries;
}

export function codexItemToTranscript(
	item: CodexThreadItem,
	context: TranscriptContext = {}
): SessionTranscriptEntry {
	const now = context.updatedAt || context.completedAt || context.startedAt || new Date().toISOString();
	const kind = KIND_BY_ITEM_TYPE[item.type] || 'tool';
	const entry: SessionTranscriptEntry = {
		id: item.id,
		itemId: item.id,
		turnId: context.turnId,
		kind,
		status: textValue(item.status),
		startedAt: context.startedAt,
		completedAt: context.completedAt,
		updatedAt: now,
	};

	switch (item.type) {
		case 'userMessage':
			entry.text = userInputText(item.content);
			break;
		case 'agentMessage':
			entry.text = textValue(item.text);
			entry.phase = item.phase === 'commentary' || item.phase === 'final_answer'
				? item.phase
				: undefined;
			break;
		case 'reasoning':
			entry.summary = stringArrayText(item.summary);
			entry.text = stringArrayText(item.content);
			break;
		case 'plan':
			entry.text = textValue(item.text);
			break;
		case 'commandExecution':
			entry.title = textValue(item.command) || 'Command';
			entry.text = textValue(item.command);
			entry.detail = {
				cwd: item.cwd,
				output: item.aggregatedOutput,
				exitCode: item.exitCode,
				durationMs: item.durationMs,
				actions: item.commandActions,
				source: item.source,
			};
			break;
		case 'fileChange':
			entry.title = fileChangeTitle(item.changes);
			entry.detail = { changes: Array.isArray(item.changes) ? item.changes : [] };
			break;
		case 'mcpToolCall':
			entry.title = [textValue(item.server), textValue(item.tool)].filter(Boolean).join(' · ');
			entry.detail = {
				arguments: item.arguments,
				result: item.result,
				error: item.error,
				durationMs: item.durationMs,
				progress: '',
			};
			break;
		case 'dynamicToolCall':
			entry.title = [textValue(item.namespace), textValue(item.tool)].filter(Boolean).join(' · ');
			entry.detail = {
				arguments: item.arguments,
				contentItems: item.contentItems,
				success: item.success,
				durationMs: item.durationMs,
			};
			break;
		case 'collabToolCall':
		case 'collabAgentToolCall':
			entry.title = textValue(item.tool) || 'Collaboration';
			entry.text = textValue(item.prompt);
			entry.detail = withoutIdentity(item);
			break;
		case 'subAgentActivity':
			entry.title = textValue(item.kind) || 'Sub-agent';
			entry.text = [textValue(item.agentPath), textValue(item.agentThreadId)].filter(Boolean).join(' · ');
			break;
		case 'webSearch':
			entry.title = 'Web search';
			entry.text = textValue(item.query);
			entry.detail = { action: item.action, results: item.results };
			break;
		case 'imageView':
			entry.title = 'Image viewed';
			entry.text = textValue(item.path);
			break;
		case 'imageGeneration':
			entry.title = 'Image generated';
			entry.text = textValue(item.savedPath) || textValue(item.result);
			entry.detail = withoutIdentity(item);
			break;
		default:
			entry.title = humanizeItemType(item.type);
			entry.text = genericItemText(item);
			entry.detail = withoutIdentity(item);
			break;
	}
	return entry;
}

export function transcriptDetail(value: unknown): Record<string, any> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, any>
		: {};
}

export function isoFromMillis(value: unknown): string | undefined {
	return typeof value === 'number' && Number.isFinite(value)
		? new Date(value).toISOString()
		: undefined;
}

function epochSecondsToIso(value: unknown): string | undefined {
	return typeof value === 'number' && Number.isFinite(value)
		? new Date(value * 1000).toISOString()
		: undefined;
}

function textValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArrayText(value: unknown): string | undefined {
	if (!Array.isArray(value)) {
		return textValue(value);
	}
	const text = value.filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n\n');
	return text || undefined;
}

function userInputText(value: unknown): string | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const parts = value.map((input) => {
		const record = transcriptDetail(input);
		if (typeof record.text === 'string') {
			return record.text;
		}
		if (typeof record.path === 'string') {
			return record.path;
		}
		if (typeof record.url === 'string') {
			return record.url;
		}
		return '';
	}).filter(Boolean);
	return parts.join('\n') || undefined;
}

function fileChangeTitle(value: unknown): string {
	if (!Array.isArray(value)) {
		return 'File changes';
	}
	const paths = value.map((change) => textValue(transcriptDetail(change).path)).filter(Boolean);
	return paths.length === 1 ? paths[0] as string : `${paths.length} file changes`;
}

function genericItemText(item: CodexThreadItem): string | undefined {
	for (const field of ['text', 'message', 'query', 'path', 'review', 'result']) {
		const value = textValue(item[field]);
		if (value) {
			return value;
		}
	}
	return undefined;
}

function withoutIdentity(item: CodexThreadItem): Record<string, unknown> {
	const detail: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(item)) {
		if (key !== 'id' && key !== 'type' && key !== 'text') {
			detail[key] = value;
		}
	}
	return detail;
}

function humanizeItemType(value: string): string {
	return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (character) => character.toUpperCase());
}

import { SessionTranscriptEntry } from '../../sessions/types';

export function copilotEventsToTranscript(events: readonly any[]): SessionTranscriptEntry[] {
	const entries: SessionTranscriptEntry[] = [];
	const byKey = new Map<string, SessionTranscriptEntry>();
	for (const event of events) {
		const entry = eventToTranscript(event);
		if (!entry) {
			continue;
		}
		const key = entry.id;
		const previous = byKey.get(key);
		if (previous) {
			Object.assign(previous, mergeEntry(previous, entry));
		} else {
			byKey.set(key, entry);
			entries.push(entry);
		}
		if (event.type === 'assistant.message' && typeof event.data?.reasoningText === 'string' && event.data.reasoningText.length > 0) {
			const reasoning = entryFromReasoning(event, entry);
			byKey.set(reasoning.id, reasoning);
			entries.splice(Math.max(0, entries.indexOf(entry)), 0, reasoning);
		}
	}
	return entries;
}

function entryFromReasoning(event: any, assistant: SessionTranscriptEntry): SessionTranscriptEntry {
	return {
		id: `${assistant.id}:reasoning`,
		turnId: assistant.turnId,
		kind: 'reasoning',
		title: 'Provider reasoning summary',
		text: event.data.reasoningText,
		summary: event.data.reasoningText,
		updatedAt: assistant.updatedAt,
		detail: { apiCallId: event.data.apiCallId, reasoningWireField: event.data.reasoningWireField },
	};
}

function eventToTranscript(event: any): SessionTranscriptEntry | undefined {
	if (!event || typeof event.type !== 'string') {
		return undefined;
	}
	const data = event.data && typeof event.data === 'object' ? event.data : {};
	const updatedAt = typeof event.timestamp === 'string' ? event.timestamp : new Date().toISOString();
	const turnId = typeof data.interactionId === 'string' ? data.interactionId : undefined;
	switch (event.type) {
		case 'user.message':
			return entry(`${event.id || updatedAt}:user`, 'user', data.content, undefined, data, updatedAt, turnId);
		case 'assistant.reasoning':
			return entry(`reasoning:${data.reasoningId || event.id}`, 'reasoning', data.content, undefined, data, updatedAt, turnId);
		case 'assistant.reasoning_delta':
			return entry(`reasoning:${data.reasoningId || event.id}`, 'reasoning', data.deltaContent || data.content, undefined, data, updatedAt, turnId);
		case 'assistant.message':
			return entry(`assistant:${data.messageId || data.apiCallId || event.id}`, 'assistant', data.content, data.reasoningText,
				data, updatedAt, turnId, data.phase);
		case 'assistant.message_delta':
			return entry(`assistant:${data.apiCallId || data.messageId || event.id}`, 'assistant', data.deltaContent || data.content,
				undefined, data, updatedAt, turnId, undefined, true);
		case 'tool.execution_start':
			return entry(`tool:${data.toolCallId || event.id}`, data.mcpServerName ? 'mcp-tool' : 'tool',
				undefined, data.toolDescription?.description,
				{ arguments: data.arguments, ...withoutIdentity(data) }, updatedAt, turnId, undefined, false, data.toolCallId);
		case 'tool.execution_partial_result':
		case 'tool.execution_progress':
			return entry(`tool:${data.toolCallId || event.id}`, data.mcpServerName ? 'mcp-tool' : 'tool',
				data.partialOutput || data.result || data.progressMessage || data.message, undefined, { ...data, deltaContent: data.partialOutput }, updatedAt, turnId, undefined, true, data.toolCallId);
		case 'tool.execution_complete':
			return entry(`tool:${data.toolCallId || event.id}`, data.mcpServerName ? 'mcp-tool' : 'tool',
				toolResultText(data), undefined, withoutIdentity(data), updatedAt, turnId, undefined, false, data.toolCallId,
				data.success === false || Boolean(data.error) ? 'failed' : 'completed');
		case 'session.error':
			return entry(`error:${event.id || updatedAt}`, 'error', data.message || data.error, undefined, data, updatedAt, turnId, undefined, false, undefined, 'failed');
		case 'permission.requested':
		case 'user_input.requested':
			return entry(`approval:${event.id || updatedAt}`, 'approval', data.question || data.title || data.kind, undefined, data, updatedAt, turnId);
		case 'assistant.intent':
			return entry(`intent:${event.id || updatedAt}`, 'plan', data.intent || data.content, undefined, data, updatedAt, turnId);
		default:
			return undefined;
	}
}

function entry(
	id: string,
	kind: SessionTranscriptEntry['kind'],
	text: unknown,
	summary: unknown,
	detail: unknown,
	updatedAt: string,
	turnId?: string,
	phase?: unknown,
	partial = false,
	itemId?: string,
	status?: string
): SessionTranscriptEntry {
	return {
		id,
		itemId: itemId || id,
		turnId,
		kind,
		text: typeof text === 'string' && text.length > 0 ? text : undefined,
		summary: typeof summary === 'string' && summary.length > 0 ? summary : undefined,
		phase: phase === 'commentary' || phase === 'final_answer' ? phase : undefined,
		detail,
		status,
		updatedAt,
		...(partial ? { startedAt: updatedAt } : {}),
	};
}

function mergeEntry(previous: SessionTranscriptEntry, next: SessionTranscriptEntry): Partial<SessionTranscriptEntry> {
	const append = next.detail && typeof next.detail === 'object' && (next.detail as any).deltaContent;
	const text = append && previous.text ? `${previous.text}${(next.detail as any).deltaContent}` : next.text || previous.text;
	return {
		...next,
		text,
		startedAt: previous.startedAt || next.startedAt,
		completedAt: next.status === 'completed' || next.status === 'failed' ? next.updatedAt : previous.completedAt,
	};
}

function toolResultText(data: any): string | undefined {
	if (typeof data.result === 'string') {
		return data.result;
	}
	if (data.result && typeof data.result.textResultForLlm === 'string') {
		return data.result.textResultForLlm;
	}
	if (typeof data.error?.message === 'string') {
		return data.error.message;
	}
	return undefined;
}

function withoutIdentity(value: Record<string, unknown>): Record<string, unknown> {
	const detail: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (!['id', 'toolCallId', 'apiCallId', 'content', 'deltaContent'].includes(key)) {
			detail[key] = item;
		}
	}
	return detail;
}

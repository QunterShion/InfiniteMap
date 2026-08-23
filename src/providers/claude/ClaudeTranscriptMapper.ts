import { SessionTranscriptEntry } from '../../sessions/types';

export function claudeMessagesToTranscript(messages: readonly any[]): SessionTranscriptEntry[] {
	const entries: SessionTranscriptEntry[] = [];
	for (const message of messages) {
		if (!message || typeof message !== 'object') {
			continue;
		}
		const timestamp = typeof message.timestamp === 'string' ? message.timestamp : new Date().toISOString();
		const messageId = typeof message.uuid === 'string' ? message.uuid : `claude-${entries.length}`;
		const content = message.message?.content;
		if (message.type === 'user') {
			const text = contentText(content);
			const blocks = contentBlocks(content);
			const isToolResultMessage = blocks.some((block) => block.type === 'tool_result');
			if (text && !isToolResultMessage) {
				entries.push({ id: messageId, kind: 'user', text, detail: safeDetail(message), updatedAt: timestamp });
			}
			for (const block of blocks) {
				if (block.type === 'tool_result') {
					entries.push({
						id: `${messageId}:tool-result:${block.tool_use_id || entries.length}`,
						itemId: block.tool_use_id,
						kind: 'tool',
						title: 'Tool result',
						text: contentText(block.content),
						status: block.is_error ? 'failed' : 'completed',
						detail: safeDetail(block),
						updatedAt: timestamp,
					});
				}
			}
		} else if (message.type === 'assistant') {
			for (const [index, block] of contentBlocks(content).entries()) {
				const id = `${messageId}:${index}`;
				if (block.type === 'text') {
					entries.push({ id, kind: 'assistant', text: block.text, phase: 'final_answer', detail: safeDetail(block), updatedAt: timestamp });
				} else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
					entries.push({ id, kind: 'reasoning', summary: block.thinking || 'Reasoning summary unavailable', detail: safeDetail(block), updatedAt: timestamp });
				} else if (block.type === 'tool_use') {
					entries.push({ id: block.id || id, itemId: block.id, kind: 'tool', title: block.name || 'Tool', detail: safeDetail(block), text: stringify(block.input), status: 'requested', updatedAt: timestamp });
				}
			}
		} else if (message.type === 'system') {
			const text = contentText(content) || contentText(message.message);
			if (text) {
				entries.push({ id: messageId, kind: 'status', title: 'System', text, detail: safeDetail(message), updatedAt: timestamp });
			}
		}
	}
	return entries;
}

function contentBlocks(value: unknown): any[] {
	return Array.isArray(value) ? value.filter((block) => block && typeof block === 'object') : [];
}

function contentText(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value;
	}
	if (Array.isArray(value)) {
		const text = value.map((item) => contentText(typeof item === 'object' && item ? (item as any).text || (item as any).content : item)).filter(Boolean).join('\n');
		return text || undefined;
	}
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		return typeof record.text === 'string' ? record.text : typeof record.content === 'string' ? record.content : undefined;
	}
	return undefined;
}

function safeDetail(value: unknown): unknown {
	if (!value || typeof value !== 'object') {
		return value;
	}
	const detail = { ...(value as Record<string, unknown>) };
	delete (detail as any).message;
	return detail;
}

function stringify(value: unknown): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value === 'string') {
		return value;
	}
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

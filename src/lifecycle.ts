import { randomBytes } from 'crypto';

/** One identifier per Extension Host module lifetime. */
export const extensionHostSessionId = randomBytes(16).toString('hex');

let outputChannel: { appendLine(value: string): void } | undefined;

export function setLifecycleOutputChannel(channel: { appendLine(value: string): void }): void {
	outputChannel = channel;
}

export function logLifecycle(callback: string, details: Record<string, unknown> = {}): void {
	if (process.env.INFINITEMAP_LIFECYCLE_DEBUG === '0') {
		return;
	}

	const entry = JSON.stringify({
		timestamp: new Date().toISOString(),
		extensionHostSessionId,
		callback,
		...details,
	});
	console.info('[InfiniteMap][lifecycle]', entry);
	outputChannel?.appendLine(entry);
}

logLifecycle('module.loaded');

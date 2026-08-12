import * as vscode from 'vscode';

export interface PendingSessionDeepLink {
	documentUri: string;
	executionId: string;
	nodeId: string;
}

class SessionDeepLinkStore implements vscode.Disposable {
	private readonly pending = new Map<string, PendingSessionDeepLink>();
	private readonly emitter = new vscode.EventEmitter<PendingSessionDeepLink>();
	public readonly onDidSet = this.emitter.event;

	public set(value: PendingSessionDeepLink): void {
		this.pending.set(value.documentUri, value);
		this.emitter.fire(value);
	}

	public peek(documentUri: string): PendingSessionDeepLink | undefined {
		return this.pending.get(documentUri);
	}

	public consume(documentUri: string, executionId: string): void {
		const value = this.pending.get(documentUri);
		if (value?.executionId === executionId) {
			this.pending.delete(documentUri);
		}
	}

	public dispose(): void {
		this.pending.clear();
		this.emitter.dispose();
	}
}

export const sessionDeepLinkStore = new SessionDeepLinkStore();

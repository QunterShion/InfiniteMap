import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AGENT_SESSION_PROTOCOL_VERSION } from '../sessions/types';

const TRAILING_DELAY_MS = 60;
const MAX_WAIT_MS = 300;

export class ExecStateWatcher implements vscode.Disposable {
	private watcher: vscode.FileSystemWatcher | undefined;
	private trailingTimer: NodeJS.Timeout | undefined;
	private maxTimer: NodeJS.Timeout | undefined;
	private burstActive = false;

	constructor(
		private readonly document: vscode.CustomDocument,
		private readonly getPanel: () => vscode.WebviewPanel | undefined
	) {}

	public start(): void {
		if (this.document.uri.scheme !== 'file' || this.watcher) {
			return;
		}
		this.watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(
				path.dirname(this.document.uri.fsPath),
				path.basename(this.document.uri.fsPath) + '.exec.json'
			)
		);
		this.watcher.onDidChange(() => this.scheduleBroadcast());
		this.watcher.onDidCreate(() => this.scheduleBroadcast());
		this.watcher.onDidDelete(() => this.scheduleBroadcast());
	}

	public broadcast(): void {
		const panel = this.getPanel();
		if (!panel) {
			return;
		}
		let tasks: Record<string, unknown> = {};
		try {
			const execPath = this.document.uri.fsPath + '.exec.json';
			if (fs.existsSync(execPath)) {
				const state = JSON.parse(fs.readFileSync(execPath, 'utf8'));
				if (state && typeof state.tasks === 'object' && state.tasks) {
					tasks = state.tasks;
				}
			}
		} catch {
			// A following watcher event will retry after an incomplete or damaged write.
		}
		void panel.webview.postMessage({
			command: 'execState',
			protocolVersion: AGENT_SESSION_PROTOCOL_VERSION,
			tasks,
		}).then(() => undefined, () => undefined);
	}

	public dispose(): void {
		this.watcher?.dispose();
		this.watcher = undefined;
		if (this.trailingTimer) {
			clearTimeout(this.trailingTimer);
		}
		if (this.maxTimer) {
			clearTimeout(this.maxTimer);
		}
		this.trailingTimer = undefined;
		this.maxTimer = undefined;
		this.burstActive = false;
	}

	private scheduleBroadcast(): void {
		if (!this.burstActive) {
			this.burstActive = true;
			this.broadcast();
			this.maxTimer = setTimeout(() => this.finishBurst(), MAX_WAIT_MS);
		}
		if (this.trailingTimer) {
			clearTimeout(this.trailingTimer);
		}
		this.trailingTimer = setTimeout(() => this.finishBurst(), TRAILING_DELAY_MS);
	}

	private finishBurst(): void {
		if (!this.burstActive) {
			return;
		}
		this.burstActive = false;
		if (this.trailingTimer) {
			clearTimeout(this.trailingTimer);
		}
		if (this.maxTimer) {
			clearTimeout(this.maxTimer);
		}
		this.trailingTimer = undefined;
		this.maxTimer = undefined;
		this.broadcast();
	}
}


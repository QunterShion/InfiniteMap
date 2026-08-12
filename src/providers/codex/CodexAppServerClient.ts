import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as readline from 'readline';
import { AppServerMessage, CodexModel, RpcNotification, RpcRequest, RpcResponse } from './protocol';

interface PendingRequest {
	resolve(value: any): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

export interface CodexAppServerClientOptions {
	executable: string;
	experimentalApi?: boolean;
	requestTimeoutMs?: number;
	spawnProcess?: typeof spawn;
}

export class CodexRpcError extends Error {
	constructor(public readonly code: number, message: string, public readonly data?: unknown) {
		super(message);
		this.name = 'CodexRpcError';
	}
}

export class CodexAppServerClient {
	private readonly emitter = new EventEmitter();
	private readonly pending = new Map<number, PendingRequest>();
	private readonly serverRequestHandlers = new Map<string, (params: any) => Promise<unknown>>();
	private process: ChildProcessWithoutNullStreams | undefined;
	private nextId = 1;
	private disposed = false;
	private initialized = false;
	private readonly pendingInitNotifications: RpcNotification[] = []; // Codex-P1-01：初始化期间的通知缓冲区

	constructor(private readonly options: CodexAppServerClientOptions) {}

	public onNotification(listener: (notification: RpcNotification) => void): () => void {
		this.emitter.on('notification', listener);
		return () => this.emitter.off('notification', listener);
	}

	public onDisconnect(listener: (error: Error) => void): () => void {
		this.emitter.on('disconnect', listener);
		return () => this.emitter.off('disconnect', listener);
	}

	public registerServerRequest(
		method: string,
		handler: (params: any) => Promise<unknown>
	): () => void {
		this.serverRequestHandlers.set(method, handler);
		return () => this.serverRequestHandlers.delete(method);
	}

	public async start(): Promise<void> {
		if (this.process && this.initialized) {
			return;
		}
		this.disposed = false;
		const spawnProcess = this.options.spawnProcess || spawn;
		const child = spawnProcess(this.options.executable, ['app-server'], {
			stdio: ['pipe', 'pipe', 'pipe'],
		}) as ChildProcessWithoutNullStreams;
		this.process = child;
		readline.createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line));
		child.stderr.on('data', (chunk) => this.emitter.emit('stderr', String(chunk)));
		child.once('error', (error) => this.handleDisconnect(error));
		child.once('exit', (code, signal) => {
			this.handleDisconnect(new Error(`Codex app-server exited (${code ?? signal ?? 'unknown'}).`));
		});

		await this.request('initialize', {
			clientInfo: {
				name: 'infinite_map_vscode',
				title: 'InfiniteMap Codex Provider',
				version: '1.0.0',
			},
			capabilities: this.options.experimentalApi ? { experimentalApi: true } : null,
		});
		this.notify('initialized', {});
		this.initialized = true;
		// Codex-P1-01：排空初始化期间缓冲的通知，确保 handler 已注册后再派发
		for (const notification of this.pendingInitNotifications.splice(0)) {
			this.emitter.emit('notification', notification);
		}
	}

	public async request<T = any>(method: string, params?: unknown): Promise<T> {
		if (!this.process || this.process.killed) {
			throw new Error('Codex app-server is not connected.');
		}
		const id = this.nextId++;
		const timeoutMs = this.options.requestTimeoutMs || 30_000;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Codex app-server request timed out: ${method}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.write({ id, method, params });
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	public notify(method: string, params?: unknown): void {
		this.write({ method, params });
	}

	public async readModels(): Promise<CodexModel[]> {
		const models: CodexModel[] = [];
		let cursor: string | null = null;
		do {
			const page: { data: CodexModel[]; nextCursor: string | null } = await this.request('model/list', {
				cursor,
				includeHidden: false,
			});
			for (const model of page.data || []) {
				if (!model.hidden) {
					models.push(model);
				}
			}
			cursor = page.nextCursor || null;
		} while (cursor);
		return models;
	}

	public dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.initialized = false;
		const process = this.process;
		this.process = undefined;
		if (process && !process.killed) {
			process.kill();
		}
		this.rejectPending(new Error('Codex app-server client was disposed.'));
		this.serverRequestHandlers.clear(); // Codex-P1-02：释放 server 请求处理器，防止 dispose 后仍持有引用
		this.pendingInitNotifications.length = 0; // Codex-P1-01：清空初始化通知缓冲区
		this.emitter.removeAllListeners();
	}

	private write(message: RpcRequest | RpcNotification | RpcResponse): void {
		if (!this.process || !this.process.stdin.writable) {
			throw new Error('Codex app-server stdin is unavailable.');
		}
		this.process.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private handleLine(line: string): void {
		let message: AppServerMessage;
		try {
			message = JSON.parse(line) as AppServerMessage;
		} catch {
			this.emitter.emit('protocolWarning', { code: 'INVALID_JSON', lineLength: line.length });
			return;
		}
		if ('id' in message && ('result' in message || 'error' in message) && !('method' in message)) {
			this.handleResponse(message as RpcResponse);
			return;
		}
		if ('id' in message && 'method' in message) {
			void this.handleServerRequest(message as RpcRequest);
			return;
		}
		if ('method' in message) {
			if (!this.initialized) {
				// Codex-P1-01：初始化完成前缓冲通知，避免 handler 尚未注册时丢失事件
				this.pendingInitNotifications.push(message as RpcNotification);
			} else {
				this.emitter.emit('notification', message as RpcNotification);
			}
		}
	}

	private handleResponse(response: RpcResponse): void {
		const pending = this.pending.get(response.id);
		if (!pending) {
			return;
		}
		clearTimeout(pending.timer);
		this.pending.delete(response.id);
		if (response.error) {
			pending.reject(new CodexRpcError(response.error.code, response.error.message, response.error.data));
		} else {
			pending.resolve(response.result);
		}
	}

	private async handleServerRequest(request: RpcRequest): Promise<void> {
		const handler = this.serverRequestHandlers.get(request.method);
		if (!handler) {
			this.write({
				id: request.id,
				error: { code: -32601, message: `Unsupported server request: ${request.method}` },
			});
			return;
		}
		try {
			this.write({ id: request.id, result: await handler(request.params) });
		} catch (error) {
			this.write({
				id: request.id,
				error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
			});
		}
	}

	private handleDisconnect(error: Error): void {
		if (this.disposed || !this.process) {
			return;
		}
		this.process = undefined;
		this.initialized = false;
		this.rejectPending(error);
		this.emitter.emit('disconnect', error);
	}

	private rejectPending(error: Error): void {
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		this.pending.clear();
	}
}

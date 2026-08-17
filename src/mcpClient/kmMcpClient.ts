import * as path from 'path';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { REQUIRED_KM_TOOL_NAMES, KmMcpToolCall } from './kmToolContracts';

export type KmMcpClientState = 'idle' | 'connecting' | 'reconnecting' | 'ready' | 'unavailable' | 'disposed';

export interface KmMcpClientStatus {
	state: KmMcpClientState;
	attempt: number;
	nextRetryMs?: number;
	lastError?: string;
}

export interface KmMcpClientOptions {
	extensionPath: string;
	nodeExecutable?: string;
	reconnectDelaysMs?: number[];
}

interface JsonRpcResponse {
	jsonrpc: '2.0';
	id: number;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export class KmMcpClient {
	private static readonly instances = new Map<string, KmMcpClient>();

	public static forWorkspace(workspaceKey: string, options: KmMcpClientOptions): KmMcpClient {
		const key = `${workspaceKey}:${path.resolve(options.extensionPath)}`;
		const existing = this.instances.get(key);
		if (existing) {
			return existing;
		}
		const client = new KmMcpClient(key, options);
		this.instances.set(key, client);
		return client;
	}

	public static async disposeAll(): Promise<void> {
		await Promise.all([...this.instances.values()].map((client) => client.dispose()));
	}

	private stateValue: KmMcpClientState = 'idle';
	private process: ChildProcessWithoutNullStreams | undefined;
	private connection: Promise<void> | undefined;
	private reconnectAttempt = 0;
	private reconnectTimer: NodeJS.Timeout | undefined;
	private lastError: string | undefined;
	private nextRetryMs: number | undefined;
	private stdoutBuffer = '';
	private nextRequestId = 1;
	private readonly pendingRequests = new Map<number, PendingRequest>();
	private readonly stateListeners = new Set<(status: KmMcpClientStatus) => void>();

	private constructor(
		private readonly instanceKey: string,
		private readonly options: KmMcpClientOptions
	) {}

	public get state(): KmMcpClientState {
		return this.stateValue;
	}

	public get status(): KmMcpClientStatus {
		return {
			state: this.stateValue,
			attempt: this.reconnectAttempt,
			...(this.nextRetryMs === undefined ? {} : { nextRetryMs: this.nextRetryMs }),
			...(this.lastError === undefined ? {} : { lastError: this.lastError }),
		};
	}

	public onDidChangeState(listener: (status: KmMcpClientStatus) => void): { dispose(): void } {
		this.stateListeners.add(listener);
		return { dispose: () => this.stateListeners.delete(listener) };
	}

	public async connect(): Promise<void> {
		if (this.stateValue === 'disposed') {
			throw new Error('KM MCP client is disposed.');
		}
		if (this.stateValue === 'ready') {
			return;
		}
		if (this.connection) {
			return this.connection;
		}
		this.clearReconnectTimer();
		this.connection = this.connectNow();
		try {
			await this.connection;
		} finally {
			this.connection = undefined;
		}
	}

	public async reconnect(): Promise<void> {
		if (this.stateValue === 'disposed') {
			throw new Error('KM MCP client is disposed.');
		}
		this.clearReconnectTimer();
		if (this.stateValue === 'ready') {
			const child = this.process;
			this.process = undefined;
			this.stdoutBuffer = '';
			this.rejectAllPending(new Error('KM MCP connection was restarted by the user.'));
			if (child && !child.killed) {
				child.kill();
			}
			this.publishState('reconnecting', 'Manual reconnect requested.');
		}
		await this.connect();
	}

	public async callTool(call: KmMcpToolCall, timeoutMs: number = 30_000): Promise<unknown> {
		await this.connect();
		if (!this.process || this.stateValue !== 'ready') {
			throw new Error('KM MCP server is unavailable.');
		}
		return this.request('tools/call', { name: call.name, arguments: call.arguments }, timeoutMs);
	}

	public async dispose(): Promise<void> {
		this.publishState('disposed');
		this.clearReconnectTimer();
		KmMcpClient.instances.delete(this.instanceKey);
		const child = this.process;
		this.process = undefined;
		this.rejectAllPending(new Error('KM MCP client was disposed.'));
		if (child && !child.killed) {
			child.kill();
		}
		this.stateListeners.clear();
	}

	private async connectNow(): Promise<void> {
		this.publishState(this.lastError ? 'reconnecting' : 'connecting', this.lastError);
		const child = spawn(
			this.options.nodeExecutable || process.execPath,
			[path.join(this.options.extensionPath, 'dist', 'mcp', 'server.js')],
			{
				cwd: this.options.extensionPath,
				stdio: ['pipe', 'pipe', 'pipe'],
			}
		);
		this.process = child;
		child.stdout.on('data', (chunk: Buffer) => this.handleStdout(child, chunk));
		// 必须消费 stderr，否则缓冲区满后进程会被阻塞
		child.stderr.on('data', (chunk: Buffer) => {
			// 可选：记录 stderr 到控制台以便调试
			// console.error('[KM MCP stderr]', chunk.toString('utf8'));
		});
		child.on('error', (error) => this.handleDisconnect(child, error));
		child.on('exit', (code, signal) => this.handleDisconnect(
			child,
			new Error(`KM MCP process exited${code === null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}.`)
		));
		try {
			await this.request('initialize', {
				protocolVersion: '2024-11-05',
				capabilities: {},
				clientInfo: { name: 'infinite-map-vscode', version: '1.0.0' },
			}, 10_000);
			this.notify('notifications/initialized', {});
			const response = await this.request('tools/list', {}, 10_000) as {
				tools?: Array<{ name: string }>;
			};
			const names = new Set((response.tools || []).map((tool) => tool.name));
			const missing = REQUIRED_KM_TOOL_NAMES.filter((name) => !names.has(name));
			if (missing.length > 0) {
				throw new Error(`KM MCP server is missing required tools: ${missing.join(', ')}`);
			}
			this.reconnectAttempt = 0;
			this.publishState('ready');
		} catch (error) {
			const connectionError = error instanceof Error ? error : new Error(String(error));
			if (!child.killed) {
				child.kill();
			}
			if (this.process === child) {
				this.process = undefined;
			}
			this.scheduleReconnect(connectionError);
			throw connectionError;
		}
	}

	private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
		const child = this.process;
		if (!child || child.killed || !child.stdin.writable) {
			return Promise.reject(new Error('KM MCP process is not writable.'));
		}
		const id = this.nextRequestId++;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`KM MCP request timed out: ${method}`));
			}, timeoutMs);
			this.pendingRequests.set(id, { resolve, reject, timer });
			child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
				if (error) {
					const pending = this.pendingRequests.get(id);
					if (pending) {
						clearTimeout(pending.timer);
						this.pendingRequests.delete(id);
						pending.reject(error);
					}
				}
			});
		});
	}

	private notify(method: string, params: Record<string, unknown>): void {
		const child = this.process;
		if (child && !child.killed && child.stdin.writable) {
			child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
		}
	}

	private handleStdout(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
		if (this.process !== child) {
			return;
		}
		this.stdoutBuffer += chunk.toString('utf8');
		for (;;) {
			const newline = this.stdoutBuffer.indexOf('\n');
			if (newline < 0) {
				return;
			}
			const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '');
			this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
			if (!line) {
				continue;
			}
			let response: JsonRpcResponse;
			try {
				response = JSON.parse(line) as JsonRpcResponse;
			} catch {
				continue;
			}
			if (typeof response.id !== 'number') {
				continue;
			}
			const pending = this.pendingRequests.get(response.id);
			if (!pending) {
				continue;
			}
			clearTimeout(pending.timer);
			this.pendingRequests.delete(response.id);
			if (response.error) {
				pending.reject(new Error(`KM MCP ${response.error.code}: ${response.error.message}`));
			} else {
				pending.resolve(response.result);
			}
		}
	}

	private rejectAllPending(error: Error): void {
		for (const pending of this.pendingRequests.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}

	private handleDisconnect(child: ChildProcessWithoutNullStreams, error: Error): void {
		if (this.process !== child) {
			return;
		}
		if (this.stateValue === 'disposed') {
			return;
		}
		this.process = undefined;
		this.stdoutBuffer = '';
		this.rejectAllPending(new Error('KM MCP process disconnected.'));
		this.scheduleReconnect(error);
	}

	private scheduleReconnect(error: Error): void {
		if (this.stateValue === 'disposed' || this.reconnectTimer) {
			return;
		}
		const delays = this.options.reconnectDelaysMs || [250, 1000, 3000, 5000, 10_000];
		if (delays.length === 0) {
			this.publishState('unavailable', error.message);
			return;
		}
		const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)];
		this.reconnectAttempt += 1;
		this.publishState('reconnecting', error.message, delay);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.connect().catch(() => undefined);
		}, delay);
	}

	private clearReconnectTimer(): void {
		if (!this.reconnectTimer) {
			return;
		}
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		this.nextRetryMs = undefined;
	}

	private publishState(state: KmMcpClientState, lastError?: string, nextRetryMs?: number): void {
		this.stateValue = state;
		this.lastError = lastError;
		this.nextRetryMs = nextRetryMs;
		const status = this.status;
		for (const listener of this.stateListeners) {
			try {
				listener(status);
			} catch {
				// Connection recovery must not be blocked by a UI listener.
			}
		}
	}
}

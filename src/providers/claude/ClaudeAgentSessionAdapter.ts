import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as vscode from 'vscode';
import {
	AgentSessionAdapter,
	AgentSessionEventPayload,
	AgentSessionRef,
	AppendSessionInput,
	CreateSessionInput,
	InterruptTurnInput,
	OpenSessionInput,
	PermissionModeQueryInput,
	ProviderDescriptor,
	ProviderModelOption,
	ProviderPermissionModeOption,
	QuerySessionInput,
	RespondToInputInput,
	SendSessionInput,
	SessionCapabilities,
	SessionMutationInput,
	SessionSnapshot,
} from '../../sessions/types';
import { INFINITE_MAP_CONTROL_INSTRUCTIONS } from '../codex/protocol';
import { ClaudeConfigReader, ClaudeUserConfig } from './ClaudeConfigReader';

const PROVIDER_ID = 'claudecode';
const EXTENSION_ID = 'chanterxiao.infinite-map';
export const CLAUDE_API_KEY_SECRET = 'infiniteMap.claudeApiKey';

type ClaudeSdk = typeof import('@anthropic-ai/claude-agent-sdk');

interface ClaudeSessionState {
	executionId: string;
	session: AgentSessionRef;
	workingDirectory: string;
	mcpServer: { command: string; args: string[] };
	status: SessionSnapshot['status'];
	sequence: number;
	updatedAt: string;
	activeTurnId?: string;
	abortController?: AbortController;
	query?: { close(): void };
}

interface PendingPermission {
	sessionId: string;
	resolve(value: unknown): void;
	timer: NodeJS.Timeout;
	approveValue: unknown;
	denyValue: unknown;
}

export interface ClaudeAgentSessionAdapterOptions {
	executable: string;
	secretStorage?: vscode.SecretStorage;
	sdkLoader?: () => Promise<ClaudeSdk>;
}

export class ClaudeAgentSessionAdapter implements AgentSessionAdapter {
	public readonly providerId = PROVIDER_ID;
	private readonly eventEmitter = new vscode.EventEmitter<AgentSessionEventPayload>();
	private readonly sessions = new Map<string, ClaudeSessionState>();
	private readonly pendingPermissions = new Map<string, PendingPermission>();
	private sdk: Promise<ClaudeSdk> | undefined;
	private readonly userConfig: ClaudeUserConfig;

	constructor(private readonly options: ClaudeAgentSessionAdapterOptions) {
		this.userConfig = ClaudeConfigReader.readConfig();
	}

	public async getDescriptor(): Promise<ProviderDescriptor> {
		const authenticated = await this.isAuthenticated();
		return {
			id: PROVIDER_ID,
			displayName: 'Claude Agent',
			componentExtensionId: EXTENSION_ID,
			installState: authenticated ? 'ready' : 'auth_required',
			models: this.models(),
			permissionModes: await this.listPermissionModes(),
			capabilities: this.capabilities(authenticated ? 'ready' : 'auth_required'),
		};
	}

	public async detectCapabilities(): Promise<SessionCapabilities> {
		return this.capabilities(await this.isAuthenticated() ? 'ready' : 'auth_required');
	}

	public async listModels(): Promise<ProviderModelOption[]> {
		return this.models();
	}

	public async listPermissionModes(
		_input: PermissionModeQueryInput = {}
	): Promise<ProviderPermissionModeOption[]> {
		return [
			this.permissionOption(
				'claude:default',
				'Ask for approval',
				'interactive',
				'provider-defined',
				'standard',
				true
			),
			this.permissionOption(
				'claude:accept-edits',
				'Accept edits',
				'interactive',
				'workspace-write',
				'standard'
			),
			this.permissionOption(
				'claude:auto',
				'Automatic approval review',
				'provider-reviewed',
				'provider-defined',
				'standard'
			),
			this.permissionOption(
				'claude:dont-ask',
				'Do not ask',
				'non-interactive',
				'provider-defined',
				'restricted'
			),
			this.permissionOption(
				'claude:bypass',
				'Bypass permissions',
				'non-interactive',
				'provider-defined',
				'elevated',
				false,
				true
			),
		];
	}

	public async createSession(input: CreateSessionInput): Promise<AgentSessionRef> {
		if (!(await this.isAuthenticated())) {
			throw this.withCode('AUTH_REQUIRED', 'Claude Agent requires an Anthropic API key.');
		}
		this.assertModel(input.modelId, input.effort);
		const permissionMode = await this.resolvePermissionMode(input.permissionModeId);
		const sessionId = randomUUID();
		const session: AgentSessionRef = {
			provider: PROVIDER_ID,
			sessionId,
			surface: 'claude-agent-sdk',
			modelId: input.modelId,
			effort: input.effort,
			permissionModeId: permissionMode.id,
			openUri: input.traceOpenUri || `vscode://${EXTENSION_ID}/session/open?v=1&executionId=${encodeURIComponent(input.executionId)}`,
		};
		this.sessions.set(sessionId, {
			executionId: input.executionId,
			session,
			workingDirectory: input.workingDirectory,
			mcpServer: input.mcpServer,
			status: 'idle',
			sequence: 0,
			updatedAt: new Date().toISOString(),
		});
		return session;
	}

	public async send(input: SendSessionInput): Promise<{ turnId?: string; submissionId: string }> {
		return this.startTurn(input, false);
	}

	public async append(input: AppendSessionInput): Promise<{ turnId?: string; submissionId: string }> {
		const state = this.requireSession(input.session);
		if (state.activeTurnId) {
			throw this.withCode('CAPABILITY_UNAVAILABLE', 'Claude Agent queues the next message after the active turn.');
		}
		return this.startTurn(input, true);
	}

	public async query(input: QuerySessionInput): Promise<SessionSnapshot> {
		let state = this.sessions.get(input.session.sessionId);
		if (!state) {
			if (!input.executionId || !input.workingDirectory || !input.mcpServer) {
				throw this.withCode('NO_ACTIVE_SESSION', 'Claude Agent session recovery needs its workspace context.');
			}
			state = {
				executionId: input.executionId,
				session: {
					...input.session,
					permissionModeId: input.session.permissionModeId || 'claude:default',
				},
				workingDirectory: input.workingDirectory,
				mcpServer: input.mcpServer,
				status: 'idle',
				sequence: 0,
				updatedAt: new Date().toISOString(),
			};
			this.sessions.set(input.session.sessionId, state);
		}
		return this.snapshot(state);
	}

	public async mutate(input: SessionMutationInput): Promise<SessionSnapshot> {
		const state = this.requireSession(input.session);
		if (input.operation === 'rename') {
			if (!input.value?.trim()) {
				throw this.withCode('CAPABILITY_UNAVAILABLE', 'Claude session title cannot be empty.');
			}
			await (await this.loadSdk()).renameSession(input.session.sessionId, input.value.trim(), {
				dir: state.workingDirectory,
			});
		} else if (input.operation === 'setModel') {
			this.assertModel(input.value || '', undefined);
			state.session.modelId = input.value;
		} else {
			throw this.withCode('CAPABILITY_UNAVAILABLE', 'Claude session archiving is not exposed by InfiniteMap.');
		}
		state.updatedAt = new Date().toISOString();
		return this.snapshot(state);
	}

	public async interrupt(input: InterruptTurnInput): Promise<void> {
		const state = this.requireSession(input.session);
		if (!state.activeTurnId) {
			throw this.withCode('NO_ACTIVE_TURN', 'Claude Agent has no active turn.');
		}
		if (input.expectedTurnId && input.expectedTurnId !== state.activeTurnId) {
			throw this.withCode('STALE_TURN', 'The active Claude turn changed before interrupt.');
		}
		state.abortController?.abort();
		state.query?.close();
		state.activeTurnId = undefined;
		state.session.turnId = undefined;
		this.updateState(state, 'interrupted');
		this.emit(state, 'session.completed', { status: 'interrupted' });
	}

	public async open(input: OpenSessionInput): Promise<void> {
		if (input.target !== 'provider-cli') {
			return;
		}
		const terminal = vscode.window.createTerminal({
			name: 'InfiniteMap · Claude Agent',
			shellPath: this.options.executable,
			shellArgs: ['--resume', input.session.sessionId],
		});
		terminal.show();
	}

	public async respondToInput(input: RespondToInputInput): Promise<void> {
		const pending = this.pendingPermissions.get(input.requestId);
		if (!pending || pending.sessionId !== input.session.sessionId) {
			throw this.withCode('CAPABILITY_UNAVAILABLE', 'Claude permission request is no longer pending.');
		}
		clearTimeout(pending.timer);
		this.pendingPermissions.delete(input.requestId);
		pending.resolve(input.decision === 'approve' ? pending.approveValue : pending.denyValue);
	}

	public onDidEvent(listener: (event: AgentSessionEventPayload) => void): vscode.Disposable {
		return this.eventEmitter.event(listener);
	}

	public dispose(): void {
		for (const state of this.sessions.values()) {
			state.abortController?.abort();
			state.query?.close();
		}
		for (const pending of this.pendingPermissions.values()) {
			clearTimeout(pending.timer);
			pending.resolve(pending.denyValue);
		}
		this.pendingPermissions.clear();
		this.sessions.clear();
		this.eventEmitter.dispose();
	}

	private async startTurn(
		input: SendSessionInput,
		resume: boolean
	): Promise<{ turnId?: string; submissionId: string }> {
		if (!(await this.isAuthenticated())) {
			throw this.withCode('AUTH_REQUIRED', 'Claude Agent requires an Anthropic API key.');
		}
		this.assertModel(input.modelId, input.effort);
		const permissionMode = await this.resolvePermissionMode(input.permissionModeId);
		this.validateExecutable();
		const state = this.requireSession(input.session);
		if (state.activeTurnId) {
			throw this.withCode('CAPABILITY_UNAVAILABLE', 'Claude Agent already has an active turn.');
		}
		const submissionId = input.idempotencyKey || randomUUID();
		const turnId = submissionId;
		const abortController = new AbortController();
		state.abortController = abortController;
		state.activeTurnId = turnId;
		state.session.turnId = turnId;
		state.session.modelId = input.modelId;
		state.session.effort = input.effort;
		state.session.permissionModeId = permissionMode.id;
		this.updateState(state, 'running');

		const sdk = await this.loadSdk();
		const apiKey = await this.apiKey();
		const query = sdk.query({
			prompt: input.message,
			options: {
				abortController,
				cwd: state.workingDirectory,
				model: input.modelId,
					effort: input.effort as any,
					permissionMode: this.claudePermissionMode(permissionMode.id),
					allowDangerouslySkipPermissions: permissionMode.id === 'claude:bypass',
				pathToClaudeCodeExecutable: this.options.executable,
				sessionId: resume ? undefined : state.session.sessionId,
				resume: resume ? state.session.sessionId : undefined,
				includePartialMessages: true,
				systemPrompt: {
					type: 'preset',
					preset: 'claude_code',
					append: INFINITE_MAP_CONTROL_INSTRUCTIONS,
				},
				mcpServers: {
					infiniteMap: {
						command: state.mcpServer.command,
						args: state.mcpServer.args,
					},
				},
				env: {
					...process.env,
					...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
					...(this.userConfig.baseUrl ? { ANTHROPIC_BASE_URL: this.userConfig.baseUrl } : {}),
					CLAUDE_AGENT_SDK_CLIENT_APP: 'InfiniteMap/1.0.0',
				},
				canUseTool: (toolName, toolInput, options) => this.requestPermission(
					state,
					options.requestId || options.toolUseID || randomUUID(),
					options.title || options.displayName || toolName,
					options.description,
					{ behavior: 'allow', updatedInput: toolInput },
					{ behavior: 'deny', message: 'Denied by the user.' }
				) as any,
			},
		});
		state.query = query;
		void this.consume(state, query).catch((error) => {
			this.failTurn(state, error);
		});
		return { submissionId, turnId };
	}

	private async consume(state: ClaudeSessionState, query: AsyncIterable<any>): Promise<void> {
		for await (const message of query) {
			if (message.type === 'stream_event'
				&& message.event?.type === 'content_block_delta'
				&& message.event.delta?.type === 'text_delta') {
				this.emit(state, 'session.delta', { delta: message.event.delta.text });
			} else if (message.type === 'assistant') {
				for (const block of message.message?.content || []) {
					if (block.type === 'tool_use') {
						this.emit(state, 'session.tool.started', { name: block.name, toolUseId: block.id });
					}
				}
			} else if (message.type === 'result') {
				if (message.subtype !== 'success') {
					throw new Error((message.errors || []).join('; ') || `Claude turn failed: ${message.subtype}`);
				}
				state.activeTurnId = undefined;
				state.session.turnId = undefined;
				state.query = undefined;
				state.abortController = undefined;
				this.updateState(state, 'idle');
				this.emit(state, 'session.completed', { status: 'idle', receipt: message.structured_output });
			}
		}
	}

	private failTurn(state: ClaudeSessionState, error: unknown): void {
		state.activeTurnId = undefined;
		state.session.turnId = undefined;
		state.query = undefined;
		state.abortController = undefined;
		this.updateState(state, 'failed', {
			error: error instanceof Error ? error.message : String(error),
		});
		this.emit(state, 'session.completed', { status: 'failed' });
	}

	private requestPermission(
		state: ClaudeSessionState,
		requestId: string,
		title: string,
		description: string | undefined,
		approveValue: unknown,
		denyValue: unknown
	): Promise<any> {
		if (state.session.permissionModeId === 'claude:bypass') {
			return Promise.resolve(approveValue);
		}
		if (state.session.permissionModeId === 'claude:dont-ask') {
			return Promise.resolve(denyValue);
		}
		this.emit(state, 'session.input.required', {
			kind: 'approval',
			requestId,
			title,
			description,
		});
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pendingPermissions.delete(requestId);
				resolve(denyValue);
			}, 300_000);
			this.pendingPermissions.set(requestId, {
				sessionId: state.session.sessionId,
				resolve,
				timer,
				approveValue,
				denyValue,
			});
		});
	}

	private async loadSdk(): Promise<ClaudeSdk> {
		if (!this.sdk) {
			const bundledSdk = pathToFileURL(path.join(
				__dirname,
				'..',
				'resources',
				'provider-sdks',
				'claude-agent-sdk.mjs'
			)).href;
			this.sdk = this.options.sdkLoader
				? this.options.sdkLoader()
				: (new Function('specifier', 'return import(specifier)')(bundledSdk) as Promise<ClaudeSdk>);
		}
		return this.sdk;
	}

	private validateExecutable(): void {
		// CLI 不可用时快速失败（fail-closed），避免错误在 SDK 层以不可读形式抛出
		try {
			fs.accessSync(this.options.executable, fs.constants.X_OK);
		} catch {
			throw this.withCode(
				'PROVIDER_UNAVAILABLE',
				`Claude Code CLI 不可用: ${this.options.executable}。请确认已安装 Claude Code CLI 并完成登录。`
			);
		}
	}

	private async isAuthenticated(): Promise<boolean> {
		return !!(await this.apiKey())
			|| process.env.CLAUDE_CODE_USE_BEDROCK === '1'
			|| process.env.CLAUDE_CODE_USE_VERTEX === '1'
			|| process.env.CLAUDE_CODE_USE_FOUNDRY === '1';
	}

	private async apiKey(): Promise<string | undefined> {
		return (await this.options.secretStorage?.get(CLAUDE_API_KEY_SECRET))
			|| this.userConfig.authToken
			|| process.env.ANTHROPIC_API_KEY;
	}

	private models(): ProviderModelOption[] {
		const efforts = ['low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({ id, label: id }));
		const defaultEffort = (this.userConfig.effortLevel || 'high') as 'low' | 'medium' | 'high' | 'xhigh' | 'max';

		// 基础模型列表
		const baseModels: ProviderModelOption[] = [
			{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', effortOptions: efforts, defaultEffort },
			{ id: 'claude-opus-4-6', label: 'Claude Opus 4.6', effortOptions: efforts, defaultEffort },
			{ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', effortOptions: [], defaultEffort: undefined },
			// 支持 Claude 5 系列
			{ id: 'claude-sonnet-5[1m]', label: 'Claude Sonnet 5 (1M)', effortOptions: efforts, defaultEffort },
			{ id: 'claude-opus-5[1m]', label: 'Claude Opus 5 (1M)', effortOptions: efforts, defaultEffort },
			{ id: 'claude-fable-5', label: 'Claude Fable 5', effortOptions: efforts, defaultEffort },
		];

		// 如果用户配置了模型且不在基础列表中，动态添加
		if (this.userConfig.model) {
			const normalizedModel = ClaudeConfigReader.normalizeModelId(this.userConfig.model);
			const exists = baseModels.some((m) => m.id === normalizedModel);
			if (!exists && normalizedModel) {
				baseModels.unshift({
					id: normalizedModel,
					label: ClaudeConfigReader.formatModelLabel(normalizedModel, true),
					effortOptions: efforts,
					defaultEffort,
				});
			}
		}

		return baseModels;
	}

	private capabilities(availability: SessionCapabilities['availability']): SessionCapabilities {
		return {
			availability,
			lifecycle: {
				create: 'native',
				resume: 'native',
				list: 'native',
				read: 'native',
				interrupt: 'native',
			},
			inputMode: 'enqueue',
			mutations: {
				rename: 'native',
				setModel: 'emulated',
				archive: 'unsupported',
			},
			toolPermissionModes: {
				select: 'native',
				switching: 'next-turn',
			},
			canStream: true,
			kmTaskExecution: true,
			receiptMode: 'native-json-schema',
			openTargets: ['infinite-map', 'provider-cli'],
			sessionOwnership: 'provider',
		};
	}

	private assertModel(modelId: string, effort?: string): void {
		const model = this.models().find((candidate) => candidate.id === modelId);
		if (!model) {
			const availableModels = this.models().map((m) => m.id).join(', ');
			throw this.withCode(
				'MODEL_UNAVAILABLE',
				`模型 "${modelId}" 不可用。可用模型：${availableModels}。` +
				`提示：请检查 ~/.claude/config.json 中的模型配置。`
			);
		}
		if (effort && !model.effortOptions.some((candidate) => candidate.id === effort)) {
			const availableEfforts = model.effortOptions.map((e) => e.id).join(', ');
			throw this.withCode(
				'EFFORT_UNAVAILABLE',
				`推理等级 "${effort}" 不适用于模型 "${modelId}"。` +
				`可用等级：${availableEfforts || '无'}`
			);
		}
	}

	private requireSession(session: AgentSessionRef): ClaudeSessionState {
		const state = this.sessions.get(session.sessionId);
		if (!state) {
			throw this.withCode('NO_ACTIVE_SESSION', `Claude session is not loaded: ${session.sessionId}`);
		}
		return state;
	}

	private permissionOption(
		id: string,
		label: string,
		approvals: ProviderPermissionModeOption['semantics']['approvals'],
		workspaceAccess: ProviderPermissionModeOption['semantics']['workspaceAccess'],
		risk: ProviderPermissionModeOption['risk'],
		isDefault = false,
		requiresConfirmation = false
	): ProviderPermissionModeOption {
		return {
			id,
			label,
			source: 'provider',
			support: 'native',
			risk,
			isDefault,
			requiresConfirmation,
			semantics: { approvals, workspaceAccess },
		};
	}

	private async resolvePermissionMode(permissionModeId?: string): Promise<ProviderPermissionModeOption> {
		const modes = await this.listPermissionModes();
		const mode = permissionModeId
			? modes.find((candidate) => candidate.id === permissionModeId)
			: modes.find((candidate) => candidate.isDefault);
		if (!mode) {
			throw this.withCode(
				'PERMISSION_MODE_UNAVAILABLE',
				`Claude permission mode is unavailable: ${permissionModeId || '(default)'}`
			);
		}
		return mode;
	}

	private claudePermissionMode(
		permissionModeId: string
	): 'default' | 'acceptEdits' | 'auto' | 'dontAsk' | 'bypassPermissions' {
		switch (permissionModeId) {
			case 'claude:default': return 'default';
			case 'claude:accept-edits': return 'acceptEdits';
			case 'claude:auto': return 'auto';
			case 'claude:dont-ask': return 'dontAsk';
			case 'claude:bypass': return 'bypassPermissions';
			default:
				throw this.withCode('PERMISSION_MODE_UNAVAILABLE', `Unknown Claude permission mode: ${permissionModeId}`);
		}
	}

	private snapshot(state: ClaudeSessionState): SessionSnapshot {
		return {
			executionId: state.executionId,
			status: state.status,
			session: { ...state.session },
			sequence: state.sequence,
			updatedAt: state.updatedAt,
			activeTurnId: state.activeTurnId,
			effectiveConfig: {
				modelId: state.session.modelId,
				effort: state.session.effort,
				permissionModeId: state.session.permissionModeId,
			},
		};
	}

	private updateState(
		state: ClaudeSessionState,
		status: SessionSnapshot['status'],
		extra: Record<string, unknown> = {}
	): void {
		state.status = status;
		state.updatedAt = new Date().toISOString();
		this.emit(state, 'session.state.changed', {
			status,
			activeTurnId: state.activeTurnId,
			session: state.session,
			...extra,
		});
	}

	private emit(
		state: ClaudeSessionState,
		type: AgentSessionEventPayload['type'],
		payload: unknown
	): void {
		state.sequence += 1;
		this.eventEmitter.fire({
			executionId: state.executionId,
			sequence: state.sequence,
			type,
			payload,
		});
	}

	private withCode(code: string, message: string): Error {
		const error = new Error(message) as Error & { code?: string };
		error.code = code;
		return error;
	}
}

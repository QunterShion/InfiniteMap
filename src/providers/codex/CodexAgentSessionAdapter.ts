import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import {
	AgentSessionAdapter,
	AgentSessionEventPayload,
	AgentSessionRef,
	AppendSessionInput,
	CreateSessionInput,
	InterruptTurnInput,
	OpenSessionInput,
	ProviderDescriptor,
	ProviderModelOption,
	QuerySessionInput,
	RespondToInputInput,
	SendSessionInput,
	SessionCapabilities,
	SessionMutationInput,
	SessionSnapshot,
} from '../../sessions/types';
import { CodexAppServerClient, CodexRpcError } from './CodexAppServerClient';
import { CodexRuntimeManager, CodexRuntimeProbe } from './CodexRuntimeManager';
import {
	AGENT_EXECUTION_RECEIPT_SCHEMA,
	CODEX_CONTROL_INSTRUCTIONS,
	CodexModel,
	CodexThread,
	CodexTurn,
	RpcNotification,
} from './protocol';

const PROVIDER_ID = 'codex';
const EXTENSION_ID = 'chanterxiao.infinite-map';

interface SessionState {
	executionId: string;
	session: AgentSessionRef;
	status: SessionSnapshot['status'];
	sequence: number;
	updatedAt: string;
	activeTurnId?: string;
	requestedModel?: string;
	effectiveModel?: string;
	loaded: boolean;
}

interface SubmissionState {
	submissionId: string;
	threadId: string;
	expectedTurnId?: string;
	rpcMethod: 'turn/start' | 'turn/steer';
	acceptedTurnId?: string;
	requestSentAt: string;
	firstObservedEventAt?: string;
}

interface PendingServerRequest {
	sessionId: string;
	method: string;
	params: any;
	resolve(value: unknown): void;
	timer: NodeJS.Timeout;
}

export class CodexAgentSessionAdapter implements AgentSessionAdapter {
	public readonly providerId = PROVIDER_ID;
	private readonly eventEmitter = new vscode.EventEmitter<AgentSessionEventPayload>();
	private readonly sessions = new Map<string, SessionState>();
	private readonly submissions = new Map<string, SubmissionState>();
	private readonly eventIds = new Set<string>();
	private readonly pendingServerRequests = new Map<string, PendingServerRequest>();
	private probe: CodexRuntimeProbe | undefined;
	private removeNotificationListener: (() => void) | undefined;
	private removeDisconnectListener: (() => void) | undefined;

	constructor(private readonly runtime: CodexRuntimeManager) {}

	public async getDescriptor(): Promise<ProviderDescriptor> {
		try {
			const probe = await this.ensureProbe();
			const capabilities = this.capabilities(probe.authenticated ? 'ready' : 'auth_required');
			return {
				id: PROVIDER_ID,
				displayName: 'Codex',
				componentExtensionId: EXTENSION_ID,
				installState: probe.authenticated ? 'ready' : 'auth_required',
				models: this.toModelOptions(probe.models),
				capabilities,
			};
		} catch {
			return {
				id: PROVIDER_ID,
				displayName: 'Codex',
				componentExtensionId: EXTENSION_ID,
				installState: 'failed',
				models: [],
				capabilities: this.capabilities('incompatible'),
			};
		}
	}

	public async detectCapabilities(): Promise<SessionCapabilities> {
		const probe = await this.ensureProbe();
		return this.capabilities(probe.authenticated ? 'ready' : 'auth_required');
	}

	public async listModels(): Promise<ProviderModelOption[]> {
		return this.toModelOptions((await this.ensureProbe()).models);
	}

	public async createSession(input: CreateSessionInput): Promise<AgentSessionRef> {
		const probe = await this.ensureReady();
		this.assertModel(probe.models, input.modelId, input.effort);
		const response = await probe.client.request<{
			thread: CodexThread;
			model: string;
			reasoningEffort?: string | null;
		}>('thread/start', {
			model: input.modelId,
			cwd: input.workingDirectory,
			developerInstructions: CODEX_CONTROL_INSTRUCTIONS,
			config: {
				mcp_servers: {
					infiniteMap: {
						command: input.mcpServer.command,
						args: input.mcpServer.args,
					},
				},
			},
		});
		if (!response?.thread?.id) {
			throw new Error('Codex thread/start response is missing thread.id.');
		}
		const session: AgentSessionRef = {
			provider: PROVIDER_ID,
			sessionId: response.thread.id,
			threadId: response.thread.id,
			surface: 'app-server',
			modelId: response.model || input.modelId,
			effort: response.reasoningEffort || input.effort,
			openUri: input.traceOpenUri || `vscode://chanterxiao.infinite-map/session/open?v=1&executionId=${encodeURIComponent(input.executionId)}`,
		};
		await probe.client.request('thread/resume', {
			threadId: response.thread.id,
			model: input.modelId,
			cwd: input.workingDirectory,
			developerInstructions: [
				CODEX_CONTROL_INSTRUCTIONS,
				'Provider trace context (protocolVersion 1):',
				JSON.stringify({ executionId: input.executionId, session, protocolVersion: 1 }),
			].join('\n'),
			config: {
				mcp_servers: {
					infiniteMap: {
						command: input.mcpServer.command,
						args: input.mcpServer.args,
					},
				},
			},
		});
		this.sessions.set(session.sessionId, {
			executionId: input.executionId,
			session,
			status: 'idle',
			sequence: 0,
			updatedAt: new Date().toISOString(),
			requestedModel: input.modelId,
			effectiveModel: response.model || input.modelId,
			loaded: true,
		});
		return session;
	}

	public async send(input: SendSessionInput): Promise<{ turnId?: string; submissionId: string }> {
		const probe = await this.ensureReady();
		this.assertModel(probe.models, input.modelId, input.effort);
		const state = this.requireSession(input.session);
		if (!state.loaded) {
			await probe.client.request('thread/resume', {
				threadId: input.session.sessionId,
				model: input.modelId,
			});
			state.loaded = true;
		}
		if (state.activeTurnId) {
			throw new Error('A Codex turn is already active; use append with expectedTurnId.');
		}
		const submissionId = input.idempotencyKey || randomUUID();
		const previous = this.submissions.get(submissionId);
		if (previous?.acceptedTurnId) {
			return { submissionId, turnId: previous.acceptedTurnId };
		}
		this.submissions.set(submissionId, {
			submissionId,
			threadId: input.session.sessionId,
			rpcMethod: 'turn/start',
			requestSentAt: new Date().toISOString(),
		});
		this.updateState(state, 'starting');
		try {
			const response = await probe.client.request<{ turn: CodexTurn }>('turn/start', {
				threadId: input.session.sessionId,
				clientUserMessageId: submissionId,
				input: [{ type: 'text', text: input.message, text_elements: [] }],
				model: input.modelId,
				effort: input.effort || null,
				cwd: undefined,
				outputSchema: AGENT_EXECUTION_RECEIPT_SCHEMA,
			});
			if (!response?.turn?.id) {
				throw new Error('Codex turn/start response is missing turn.id.');
			}
			this.acceptSubmission(submissionId, response.turn.id);
			state.activeTurnId = response.turn.id;
			state.session.turnId = response.turn.id;
			this.updateState(state, 'running');
			return { submissionId, turnId: response.turn.id };
		} catch (error) {
			await this.reconcileSubmission(input.session.sessionId, submissionId);
			const reconciled = this.submissions.get(submissionId);
			if (reconciled?.acceptedTurnId) {
				return { submissionId, turnId: reconciled.acceptedTurnId };
			}
			this.updateState(state, 'failed');
			throw error;
		}
	}

	public async append(input: AppendSessionInput): Promise<{ turnId?: string; submissionId: string }> {
		const state = this.requireSession(input.session);
		if (!state.activeTurnId) {
			return this.send(input);
		}
		if (!input.expectedTurnId || input.expectedTurnId !== state.activeTurnId) {
			await this.reconcileThread(input.session.sessionId);
			const error = new Error('The active Codex turn changed before append.') as Error & { code?: string };
			error.code = 'STALE_TURN';
			throw error;
		}
		const submissionId = input.idempotencyKey || randomUUID();
		const previous = this.submissions.get(submissionId);
		if (previous?.acceptedTurnId) {
			return { submissionId, turnId: previous.acceptedTurnId };
		}
		this.submissions.set(submissionId, {
			submissionId,
			threadId: input.session.sessionId,
			expectedTurnId: input.expectedTurnId,
			rpcMethod: 'turn/steer',
			requestSentAt: new Date().toISOString(),
		});
		try {
			const response = await (await this.ensureReady()).client.request<{ turnId: string }>('turn/steer', {
				threadId: input.session.sessionId,
				clientUserMessageId: submissionId,
				input: [{ type: 'text', text: input.message, text_elements: [] }],
				expectedTurnId: input.expectedTurnId,
			});
			this.acceptSubmission(submissionId, response.turnId);
			return { submissionId, turnId: response.turnId };
		} catch (error) {
			if (this.isStaleTurn(error)) {
				await this.reconcileThread(input.session.sessionId);
				const stale = new Error('The active Codex turn changed before append.') as Error & { code?: string };
				stale.code = 'STALE_TURN';
				throw stale;
			}
			throw error;
		}
	}

	public async query(input: QuerySessionInput): Promise<SessionSnapshot> {
		const state = this.sessions.get(input.session.sessionId);
		if (!state) {
			await this.restoreSession(input.session, input.executionId || 'unknown');
		}
		await this.reconcileThread(input.session.sessionId);
		return this.snapshot(this.requireSession(input.session));
	}

	public async mutate(input: SessionMutationInput): Promise<SessionSnapshot> {
		const client = (await this.ensureReady()).client;
		if (input.operation === 'rename') {
			// Best-effort: 命名不是核心功能，失败不应阻塞任务执行
			const state = this.sessions.get(input.session.sessionId);
			if (!state || (!state.session.turnId && !state.activeTurnId)) {
				// 防护：确保至少有一个 Turn 已启动，避免 "no rollout found" 错误
				console.warn('Codex: skipping thread/name/set before first turn starts (best-effort)');
			} else {
				try {
					await client.request('thread/name/set', { threadId: input.session.sessionId, name: input.value || null });
				} catch (error) {
					// Best-effort: 命名失败不应阻塞任务执行
					console.error('Codex thread/name/set failed (best-effort):', (error as Error).message || error);
				}
			}
		} else if (input.operation === 'archive') {
			await client.request('thread/archive', { threadId: input.session.sessionId });
		} else {
			throw new Error('Codex model changes are applied explicitly on the next turn.');
		}
		return this.query({ session: input.session });
	}

	public async interrupt(input: InterruptTurnInput): Promise<void> {
		const state = this.requireSession(input.session);
		const turnId = input.expectedTurnId || state.activeTurnId;
		if (!turnId || (state.activeTurnId && turnId !== state.activeTurnId)) {
			throw new Error('There is no matching active Codex turn to interrupt.');
		}
		this.updateState(state, 'interrupting');
		try {
			await (await this.ensureReady()).client.request('turn/interrupt', {
				threadId: input.session.sessionId,
				turnId,
			});
		} catch (error) {
			await this.reconcileThread(input.session.sessionId);
			throw error;
		}
	}

	public async open(_input: OpenSessionInput): Promise<void> {
		throw new Error('Codex does not expose a stable API for opening a specific thread in its IDE UI.');
	}

	public async respondToInput(input: RespondToInputInput): Promise<void> {
		const pending = this.pendingServerRequests.get(input.requestId);
		if (!pending || pending.sessionId !== input.session.sessionId) {
			throw new Error(`Codex input request is no longer pending: ${input.requestId}`);
		}
		clearTimeout(pending.timer);
		this.pendingServerRequests.delete(input.requestId);
		pending.resolve(this.serverRequestResult(pending.method, pending.params, input.decision, input.value));
	}

	public onDidEvent(listener: (event: AgentSessionEventPayload) => void): vscode.Disposable {
		return this.eventEmitter.event(listener);
	}

	public dispose(): void {
		this.removeNotificationListener?.();
		this.removeDisconnectListener?.();
		this.eventEmitter.dispose();
		this.sessions.clear();
		this.submissions.clear();
		this.eventIds.clear();
		for (const [requestId, pending] of this.pendingServerRequests) {
			clearTimeout(pending.timer);
			pending.resolve(this.serverRequestResult(pending.method, pending.params, 'deny'));
			this.pendingServerRequests.delete(requestId);
		}
	}

	private async ensureProbe(): Promise<CodexRuntimeProbe> {
		if (!this.probe) {
			this.bindProbe(await this.runtime.probe());
		}
		return this.probe as CodexRuntimeProbe;
	}

	private async ensureReady(): Promise<CodexRuntimeProbe> {
		const probe = await this.ensureProbe();
		if (!probe.authenticated) {
			const error = new Error('Codex authentication is required.') as Error & { code?: string };
			error.code = 'AUTH_REQUIRED';
			throw error;
		}
		return probe;
	}

	private bindProbe(probe: CodexRuntimeProbe): void {
		this.removeNotificationListener?.();
		this.removeDisconnectListener?.();
		this.probe = probe;
		this.removeNotificationListener = probe.client.onNotification((notification) => this.handleNotification(notification));
		this.removeDisconnectListener = probe.client.onDisconnect((error) => {
			for (const state of this.sessions.values()) {
				state.loaded = false;
				this.updateState(state, 'disconnected', { error: error.message });
			}
			this.probe = undefined;
		});
		for (const method of [
			'item/commandExecution/requestApproval',
			'item/fileChange/requestApproval',
			'tool/requestUserInput',
			'mcpServer/elicitation/request',
			'item/permissions/requestApproval',
		]) {
			probe.client.registerServerRequest(method, async (params) => {
				const state = this.findState(params?.threadId);
				if (!state) {
					return this.serverRequestResult(method, params, 'deny');
				}
				const requestId = typeof params?.requestId === 'string' && params.requestId
					? params.requestId
					: randomUUID();
				this.emit(state, 'session.input.required', {
					kind: method.includes('requestUserInput') || method.includes('elicitation') ? 'question' : 'approval',
					requestId,
					method,
					title: params?.title || params?.reason || method,
					description: params?.description,
					params,
				});
				return new Promise((resolve) => {
					const timer = setTimeout(() => {
						const pending = this.pendingServerRequests.get(requestId);
						if (!pending) {
							return;
						}
						this.pendingServerRequests.delete(requestId);
						resolve(this.serverRequestResult(method, params, 'deny'));
					}, 300_000);
					this.pendingServerRequests.set(requestId, {
						sessionId: state.session.sessionId,
						method,
						params,
						resolve,
						timer,
					});
				});
			});
		}
	}

	private serverRequestResult(
		method: string,
		params: any,
		decision: 'approve' | 'deny',
		value?: string
	): unknown {
		if (method === 'tool/requestUserInput') {
			const answers: Record<string, { answers: string[] }> = {};
			for (const question of params?.questions || []) {
				if (question?.id) {
					answers[question.id] = { answers: decision === 'approve' && value ? [value] : [] };
				}
			}
			return { answers };
		}
		if (method === 'mcpServer/elicitation/request') {
			let content: unknown = value ? { value } : {};
			if (value) {
				try { content = JSON.parse(value); } catch { /* Plain text is wrapped above. */ }
			}
			return decision === 'approve' ? { action: 'accept', content } : { action: 'decline' };
		}
		return { decision: decision === 'approve' ? 'accept' : 'decline' };
	}

	private handleNotification(notification: RpcNotification): void {
		const params = notification.params || {};
		const threadId = params.threadId || params.thread?.id;
		const state = this.findState(threadId);
		if (!state) {
			return;
		}
		const turnId = params.turn?.id || params.turnId || state.activeTurnId || '';
		const itemId = params.item?.id || params.itemId || '';
		const eventId = [notification.method, threadId || '', turnId, itemId, params.delta || ''].join(':');
		if (this.eventIds.has(eventId)) {
			return;
		}
		this.eventIds.add(eventId);
		if (this.eventIds.size > 10_000) {
			this.eventIds.clear();
			this.eventIds.add(eventId);
		}

		switch (notification.method) {
			case 'turn/started':
				state.activeTurnId = turnId;
				state.session.turnId = turnId;
				this.observeSubmission(threadId, turnId);
				this.updateState(state, 'running');
				break;
			case 'thread/status/changed':
				this.emit(state, 'session.state.changed', params);
				break;
			case 'item/agentMessage/delta':
			case 'item/commandExecution/outputDelta':
				this.emit(state, 'session.delta', { method: notification.method, ...params });
				break;
			case 'item/started':
				this.emit(state, 'session.tool.started', params);
				break;
			case 'item/completed':
			case 'turn/diff/updated':
				this.emit(state, 'session.tool.completed', { method: notification.method, ...params });
				break;
			case 'model/rerouted':
				state.effectiveModel = params.toModel;
				state.session.modelId = params.toModel;
				this.emit(state, 'session.state.changed', { requestedModel: params.fromModel, effectiveModel: params.toModel });
				break;
			case 'turn/completed': {
				const status = params.turn?.status;
				state.activeTurnId = undefined;
				state.session.turnId = turnId || state.session.turnId;
				const mapped = status === 'interrupted' ? 'interrupted' : status === 'failed' ? 'failed' : 'idle';
				this.updateState(state, mapped);
				this.emit(state, 'session.completed', params);
				break;
			}
			default:
				// Tolerant reader: unknown additive notifications are intentionally ignored.
				break;
		}
	}

	private async reconcileSubmission(threadId: string, submissionId: string): Promise<void> {
		await this.reconcileThread(threadId);
		const state = this.findState(threadId);
		if (state?.activeTurnId) {
			this.acceptSubmission(submissionId, state.activeTurnId);
		}
	}

	private async reconcileThread(threadId: string): Promise<void> {
		const response = await (await this.ensureProbe()).client.request<{ thread: CodexThread }>('thread/read', {
			threadId,
			includeTurns: true,
		});
		if (!response?.thread?.id) {
			throw new Error('Codex thread/read response is missing thread.id.');
		}
		let state = this.findState(threadId);
		if (!state) {
			const session: AgentSessionRef = {
				provider: PROVIDER_ID,
				sessionId: threadId,
				threadId,
				surface: 'app-server',
				openUri: '',
			};
			state = {
				executionId: 'unknown',
				session,
				status: 'disconnected',
				sequence: 0,
				updatedAt: new Date().toISOString(),
				loaded: false,
			};
			this.sessions.set(threadId, state);
		}
		const turns = response.thread.turns || [];
		const active = [...turns].reverse().find((turn) => turn.status === 'inProgress');
		state.activeTurnId = active?.id;
		const last = turns[turns.length - 1];
		const status = active ? 'running' : last?.status === 'interrupted' ? 'interrupted' : last?.status === 'failed' ? 'failed' : 'idle';
		this.updateState(state, status);
	}

	private async restoreSession(session: AgentSessionRef, executionId: string): Promise<void> {
		this.sessions.set(session.sessionId, {
			executionId,
			session: { ...session, threadId: session.threadId || session.sessionId },
			status: 'disconnected',
			sequence: 0,
			updatedAt: new Date().toISOString(),
			loaded: false,
		});
	}

	private acceptSubmission(submissionId: string, turnId: string): void {
		const submission = this.submissions.get(submissionId);
		if (submission) {
			submission.acceptedTurnId = turnId;
		}
	}

	private observeSubmission(threadId: string, turnId: string): void {
		for (const submission of this.submissions.values()) {
			if (submission.threadId === threadId && !submission.acceptedTurnId) {
				submission.acceptedTurnId = turnId;
				submission.firstObservedEventAt = new Date().toISOString();
				return;
			}
		}
	}

	private findState(threadId: string | undefined): SessionState | undefined {
		return threadId ? this.sessions.get(threadId) : undefined;
	}

	private requireSession(session: AgentSessionRef): SessionState {
		const state = this.sessions.get(session.sessionId);
		if (!state) {
			throw new Error(`Codex session is not loaded: ${session.sessionId}`);
		}
		return state;
	}

	private updateState(state: SessionState, status: SessionSnapshot['status'], payload?: unknown): void {
		state.status = status;
		state.updatedAt = new Date().toISOString();
		this.emit(state, 'session.state.changed', payload || this.snapshot(state));
	}

	private emit(state: SessionState, type: AgentSessionEventPayload['type'], payload: unknown): void {
		state.sequence += 1;
		this.eventEmitter.fire({
			executionId: state.executionId,
			sequence: state.sequence,
			type,
			payload,
		});
	}

	private snapshot(state: SessionState): SessionSnapshot {
		return {
			executionId: state.executionId,
			status: state.status,
			session: { ...state.session },
			sequence: state.sequence,
			updatedAt: state.updatedAt,
			activeTurnId: state.activeTurnId,
		};
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
			inputMode: 'immediate-steer',
			mutations: {
				rename: 'native',
				setModel: 'emulated',
				archive: 'native',
			},
			canStream: true,
			kmTaskExecution: availability === 'ready',
			receiptMode: 'native-json-schema',
			openTargets: ['infinite-map'],
			sessionOwnership: 'provider',
		};
	}

	private toModelOptions(models: CodexModel[]): ProviderModelOption[] {
		return models.map((model) => ({
			id: model.model || model.id,
			label: model.displayName || model.model || model.id,
			effortOptions: (model.supportedReasoningEfforts || []).map((effort) => ({
				id: effort.reasoningEffort,
				label: effort.description || effort.reasoningEffort,
			})),
			defaultEffort: model.defaultReasoningEffort,
		}));
	}

	private assertModel(models: CodexModel[], modelId: string, effort?: string): void {
		const model = models.find((candidate) => candidate.model === modelId || candidate.id === modelId);
		if (!model) {
			const error = new Error(`Codex model is no longer available: ${modelId}`) as Error & { code?: string };
			error.code = 'MODEL_UNAVAILABLE';
			throw error;
		}
		if (effort && !model.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort)) {
			const error = new Error(`Codex effort is no longer available: ${effort}`) as Error & { code?: string };
			error.code = 'EFFORT_UNAVAILABLE';
			throw error;
		}
	}

	private isStaleTurn(error: unknown): boolean {
		return error instanceof CodexRpcError && /expected.*turn|active.*turn|stale/i.test(error.message);
	}
}

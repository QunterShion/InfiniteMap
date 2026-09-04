import { randomUUID } from 'crypto';
import { CopilotSession, ModelInfo, PermissionRequest, SessionConfig } from '@github/copilot-sdk';
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
	SessionTranscriptEntry,
} from '../../sessions/types';
import { INFINITE_MAP_CONTROL_INSTRUCTIONS } from '../codex/protocol';
import { CopilotCustomEndpointModel } from './CopilotCustomEndpointReader';
import { CopilotRuntimeManager, CopilotRuntimeProbe } from './CopilotRuntimeManager';
import { copilotEventsToTranscript } from './CopilotTranscriptMapper';

const PROVIDER_ID = 'copilot';
const EXTENSION_ID = 'chanterxiao.infinite-map';
export const COPILOT_GITHUB_TOKEN_SECRET = 'infiniteMap.copilotGithubToken';

interface CopilotSessionState {
	executionId: string;
	session: AgentSessionRef;
	sdkSession: CopilotSession;
	workingDirectory: string;
	mcpServer: { command: string; args: string[] };
	status: SessionSnapshot['status'];
	sequence: number;
	updatedAt: string;
	activeTurnId?: string;
	unsubscribers: Array<() => void>;
	events: any[];
	transcript: SessionTranscriptEntry[];
	customEndpointName?: string;
}

interface PendingInput {
	sessionId: string;
	kind: 'approval' | 'question';
	resolve(value: unknown): void;
	timer: NodeJS.Timeout;
}

export class CopilotAgentSessionAdapter implements AgentSessionAdapter {
	public readonly providerId = PROVIDER_ID;
	private readonly eventEmitter = new vscode.EventEmitter<AgentSessionEventPayload>();
	private readonly sessions = new Map<string, CopilotSessionState>();
	private readonly pendingInputs = new Map<string, PendingInput>();

	constructor(private readonly runtime: CopilotRuntimeManager) {}

	public async getDescriptor(): Promise<ProviderDescriptor> {
		try {
			const probe = await this.runtime.ensureProbe();
			return {
				id: PROVIDER_ID,
				displayName: 'Copilot',
				componentExtensionId: EXTENSION_ID,
					installState: probe.authenticated || this.customModels(probe).length > 0 ? 'ready' : 'auth_required',
					models: this.toModelOptions(probe.models, this.customModels(probe)),
					permissionModes: await this.listPermissionModes(),
				capabilities: this.capabilities(probe.authenticated || this.customModels(probe).length > 0 ? 'ready' : 'auth_required'),
			};
		} catch {
			return {
				id: PROVIDER_ID,
				displayName: 'Copilot',
				componentExtensionId: EXTENSION_ID,
					installState: 'failed',
					models: [],
					permissionModes: [],
				capabilities: this.capabilities('incompatible'),
			};
		}
	}

	public async detectCapabilities(): Promise<SessionCapabilities> {
		const probe = await this.runtime.ensureProbe();
		return this.capabilities(probe.authenticated || this.customModels(probe).length > 0 ? 'ready' : 'auth_required');
	}

	public async listModels(): Promise<ProviderModelOption[]> {
		const probe = await this.runtime.ensureProbe();
		return this.toModelOptions(probe.models, this.customModels(probe));
	}

	public async listPermissionModes(
		_input: PermissionModeQueryInput = {}
	): Promise<ProviderPermissionModeOption[]> {
		return [
			this.permissionOption(
				'copilot:ask',
				'Ask for approval',
				'interactive',
				'provider-defined',
				'standard',
				true
			),
			this.permissionOption(
				'copilot:deny',
				'Deny protected tools',
				'non-interactive',
				'provider-defined',
				'restricted'
			),
			this.permissionOption(
				'copilot:approve-all',
				'Approve all',
				'non-interactive',
				'provider-defined',
				'elevated',
				false,
				true
			),
		];
	}

	public async createSession(input: CreateSessionInput): Promise<AgentSessionRef> {
		const probe = await this.ensureReadyForModel(input.modelId);
		const model = this.resolveModel(probe, input.modelId, input.effort);
		const permissionMode = await this.resolvePermissionMode(input.permissionModeId);
		const requestedSessionId = randomUUID();
		const sdkSession = await probe.client.createSession(this.sessionConfig({
			...input,
			permissionModeId: permissionMode.id,
			}, requestedSessionId, model));
		const session: AgentSessionRef = {
			provider: PROVIDER_ID,
			sessionId: sdkSession.sessionId,
			surface: 'copilot-sdk',
			modelId: input.modelId,
			effort: input.effort,
			permissionModeId: permissionMode.id,
			openUri: input.traceOpenUri || `vscode://${EXTENSION_ID}/session/open?v=1&executionId=${encodeURIComponent(input.executionId)}`,
		};
		const state: CopilotSessionState = {
			executionId: input.executionId,
			session,
			sdkSession,
			workingDirectory: input.workingDirectory,
			mcpServer: input.mcpServer,
			status: 'idle',
			sequence: 0,
			updatedAt: new Date().toISOString(),
			unsubscribers: [],
			events: [],
			transcript: [],
			...(model ? { customEndpointName: model.endpointName } : {}),
		};
		this.sessions.set(session.sessionId, state);
		this.bindEvents(state);
		return session;
	}

	public async send(input: SendSessionInput): Promise<{ turnId?: string; submissionId: string }> {
		const state = this.requireSession(input.session);
		if (state.activeTurnId) {
			throw this.withCode('CAPABILITY_UNAVAILABLE', 'Copilot already has an active turn; use append.');
		}
		return this.submit(state, input, 'enqueue');
	}

	public async append(input: AppendSessionInput): Promise<{ turnId?: string; submissionId: string }> {
		const state = this.requireSession(input.session);
		if (state.activeTurnId
			&& input.permissionModeId
			&& input.permissionModeId !== state.session.permissionModeId) {
			throw this.withCode(
				'PERMISSION_MODE_UNAVAILABLE',
				'Copilot permission mode changes apply to the next turn.'
			);
		}
		if (state.activeTurnId && input.expectedTurnId !== state.activeTurnId) {
			throw this.withCode('STALE_TURN', 'The active Copilot turn changed before append.');
		}
		return this.submit(state, input, state.activeTurnId ? 'immediate' : 'enqueue');
	}

	public async query(input: QuerySessionInput): Promise<SessionSnapshot> {
		let state = this.sessions.get(input.session.sessionId);
		if (!state) {
			if (!input.executionId || !input.workingDirectory || !input.mcpServer) {
				throw this.withCode('NO_ACTIVE_SESSION', 'Copilot session recovery needs its workspace context.');
			}
			const probe = await this.ensureReadyForModel(input.session.modelId || '');
			const model = this.resolveModel(probe, input.session.modelId || '', input.session.effort);
			const sdkSession = await probe.client.resumeSession(input.session.sessionId, this.sessionConfig({
				executionId: input.executionId,
				workingDirectory: input.workingDirectory,
				mcpServer: input.mcpServer,
				modelId: input.session.modelId || '',
					effort: input.session.effort,
					permissionModeId: input.session.permissionModeId || 'copilot:ask',
			}, input.session.sessionId, model));
			state = {
				executionId: input.executionId,
					session: {
						...input.session,
						permissionModeId: input.session.permissionModeId || 'copilot:ask',
					},
				sdkSession,
				workingDirectory: input.workingDirectory,
				mcpServer: input.mcpServer,
				status: 'idle',
				sequence: 0,
				updatedAt: new Date().toISOString(),
				unsubscribers: [],
				events: [],
				transcript: [],
					...(model ? { customEndpointName: model.endpointName } : {}),
			};
			this.sessions.set(input.session.sessionId, state);
			this.bindEvents(state);
		}
		await this.refreshTranscript(state);
		return this.snapshot(state);
	}

	public async mutate(input: SessionMutationInput): Promise<SessionSnapshot> {
		const state = this.requireSession(input.session);
		if (input.operation !== 'setModel' || !input.value) {
			throw this.withCode('CAPABILITY_UNAVAILABLE', `Copilot does not support ${input.operation}.`);
		}
		const probe = await this.ensureReadyForModel(input.value);
		const model = this.resolveModel(probe, input.value);
		if ((model?.endpointName || undefined) !== state.customEndpointName) {
			throw this.withCode('CAPABILITY_UNAVAILABLE', 'Copilot provider changes require a new session.');
		}
		await state.sdkSession.setModel(model?.modelId || input.value);
		state.session.modelId = input.value;
		state.updatedAt = new Date().toISOString();
		return this.snapshot(state);
	}

	public async interrupt(input: InterruptTurnInput): Promise<void> {
		const state = this.requireSession(input.session);
		if (!state.activeTurnId) {
			throw this.withCode('NO_ACTIVE_TURN', 'Copilot has no active turn.');
		}
		if (input.expectedTurnId && input.expectedTurnId !== state.activeTurnId) {
			throw this.withCode('STALE_TURN', 'The active Copilot turn changed before interrupt.');
		}
		await state.sdkSession.abort();
		state.activeTurnId = undefined;
		state.session.turnId = undefined;
		this.updateState(state, 'interrupted');
		this.emit(state, 'session.completed', { status: 'interrupted' });
	}

	public async open(_input: OpenSessionInput): Promise<void> {
		throw this.withCode(
			'NATIVE_OPEN_UNSUPPORTED',
			'Copilot SDK sessions are not proven to be discoverable by the VS Code Copilot UI.'
		);
	}

	public async respondToInput(input: RespondToInputInput): Promise<void> {
		const pending = this.pendingInputs.get(input.requestId);
		// Copilot-P1-02：幂等返回——请求已被超时或 dispose 路径提前解决时，静默成功而非抛出
		if (!pending || pending.sessionId !== input.session.sessionId) {
			return;
		}
		clearTimeout(pending.timer);
		this.pendingInputs.delete(input.requestId);
		if (pending.kind === 'question') {
			pending.resolve({ answer: input.decision === 'approve' ? input.value || '' : '', wasFreeform: true });
		} else {
			pending.resolve(input.decision === 'approve'
				? { kind: 'approve-once', approvedInteractively: true }
				: { kind: 'reject', feedback: 'Denied by the user.' });
		}
	}

	public onDidEvent(listener: (event: AgentSessionEventPayload) => void): vscode.Disposable {
		return this.eventEmitter.event(listener);
	}

	public dispose(): void {
		for (const pending of this.pendingInputs.values()) {
			clearTimeout(pending.timer);
			pending.resolve(pending.kind === 'question'
				? { answer: '', wasFreeform: true }
				: { kind: 'reject', feedback: 'Provider disposed.' });
		}
		this.pendingInputs.clear();
		for (const state of this.sessions.values()) {
			for (const unsubscribe of state.unsubscribers) {
				unsubscribe();
			}
			void state.sdkSession.disconnect().catch(() => undefined);
		}
		this.sessions.clear();
		this.eventEmitter.dispose();
	}

	private async submit(
		state: CopilotSessionState,
		input: SendSessionInput,
		mode: 'enqueue' | 'immediate'
	): Promise<{ turnId?: string; submissionId: string }> {
		const probe = await this.ensureReadyForModel(input.modelId);
		const model = this.resolveModel(probe, input.modelId, input.effort);
		if ((model?.endpointName || undefined) !== state.customEndpointName) {
			throw this.withCode('CAPABILITY_UNAVAILABLE', 'Switching between Copilot API and custom endpoint providers requires a new session.');
		}
		const permissionMode = await this.resolvePermissionMode(input.permissionModeId);
		if (state.session.modelId !== input.modelId || state.session.effort !== input.effort) {
			await state.sdkSession.setModel(model?.modelId || input.modelId, { reasoningEffort: input.effort as any });
			state.session.modelId = input.modelId;
			state.session.effort = input.effort;
		}
		state.session.permissionModeId = permissionMode.id;
		const messageId = await state.sdkSession.send({ prompt: input.message, mode });
		const submissionId = input.idempotencyKey || messageId || randomUUID();
		state.activeTurnId = messageId || submissionId;
		state.session.turnId = state.activeTurnId;
		this.updateState(state, 'running');
		return { submissionId, turnId: state.activeTurnId };
	}

	private sessionConfig(
		input: Pick<
			CreateSessionInput,
			'executionId' | 'workingDirectory' | 'mcpServer' | 'modelId' | 'effort' | 'permissionModeId'
		>,
		sessionId: string,
		model?: CopilotCustomEndpointModel
	): SessionConfig {
		return {
			sessionId,
			model: model?.modelId || input.modelId,
			...(model ? {
				provider: {
					type: 'openai' as const,
					baseUrl: model.baseUrl,
					wireApi: model.wireApi,
					...(model.apiKey ? { apiKey: model.apiKey } : {}),
					modelId: model.modelId,
					wireModel: model.modelId,
					...(model.maxInputTokens ? { maxPromptTokens: model.maxInputTokens } : {}),
				},
			} : {}),
			reasoningEffort: input.effort as any,
			workingDirectory: input.workingDirectory,
			streaming: true,
			systemMessage: {
				mode: 'append',
				content: [
					INFINITE_MAP_CONTROL_INSTRUCTIONS,
					'Provider trace context (protocolVersion 1):',
					JSON.stringify({ executionId: input.executionId, provider: PROVIDER_ID, sessionId }),
				].join('\n'),
			},
			mcpServers: {
				infiniteMap: {
					type: 'stdio',
					command: input.mcpServer.command,
					args: input.mcpServer.args,
				},
			},
				onPermissionRequest: (request, invocation) => this.requestPermission(sessionId, request, invocation),
			onUserInputRequest: (request) => this.requestQuestion(sessionId, request.question),
		};
	}

	private bindEvents(state: CopilotSessionState): void {
		state.unsubscribers.push(state.sdkSession.on((event: any) => {
		state.events.push(event);
		state.transcript = copilotEventsToTranscript(state.events);
		const latestTranscriptEntry = state.transcript[state.transcript.length - 1];
		if (latestTranscriptEntry) {
			this.emit(state, 'session.transcript.updated', { entry: latestTranscriptEntry });
		}
			switch (event.type) {
				case 'assistant.message_delta':
					this.emit(state, 'session.delta', { delta: event.data?.deltaContent || '' });
					break;
				case 'tool.execution_start':
					this.emit(state, 'session.tool.started', event.data || {});
					break;
				case 'tool.execution_complete':
					this.emit(state, 'session.tool.completed', event.data || {});
					break;
				case 'session.idle':
					state.activeTurnId = undefined;
					state.session.turnId = undefined;
					this.updateState(state, 'idle');
					this.emit(state, 'session.completed', { status: 'idle' });
					break;
				case 'session.error':
					state.activeTurnId = undefined;
					state.session.turnId = undefined;
					this.updateState(state, 'failed', { error: event.data?.message || 'Copilot session failed.' });
					this.emit(state, 'session.completed', { status: 'failed' });
					break;
				default:
					break;
			}
		}));
	}

	private requestPermission(
		sessionId: string,
		request: PermissionRequest,
		invocation: { managedSettingsEnabled?: boolean }
	): Promise<any> {
		const state = this.sessions.get(sessionId);
		const mode = state?.session.permissionModeId || 'copilot:ask';
		if (mode === 'copilot:deny') {
			return Promise.resolve({ kind: 'reject', feedback: 'Denied by the selected permission mode.' });
		}
		const managedApprovalRequired = request.managedApprovalRequired === true
			|| invocation.managedSettingsEnabled === true;
		if (mode === 'copilot:approve-all' && !managedApprovalRequired) {
			return Promise.resolve({ kind: 'approve-once' });
		}
		const requestId = randomUUID();
		// Copilot-P1-02：先注册 pending input，再 emit 事件——防止同步事件处理器在
		// pendingInputs 尚未写入时就调用 respondToInput() 造成找不到记录的竞争条件
		const promise = this.createPendingInput(sessionId, requestId, 'approval');
		if (state) {
			this.emit(state, 'session.input.required', {
				kind: 'approval',
				requestId,
				title: `Copilot permission · ${request.kind}`,
					params: request,
					...(mode === 'copilot:approve-all' && managedApprovalRequired ? {
						fallback: {
							requestedModeId: mode,
							effectiveModeId: 'copilot:ask',
							reason: 'Managed policy requires an explicit approval.',
						},
					} : {}),
			});
		}
		return promise;
	}

	private requestQuestion(sessionId: string, question: string): Promise<any> {
		const state = this.sessions.get(sessionId);
		const requestId = randomUUID();
		// Copilot-P1-02：先注册 pending input，再 emit 事件（同 requestPermission）
		const promise = this.createPendingInput(sessionId, requestId, 'question');
		if (state) {
			this.emit(state, 'session.input.required', {
				kind: 'question',
				requestId,
				title: question,
			});
		}
		return promise;
	}

	private createPendingInput(
		sessionId: string,
		requestId: string,
		kind: 'approval' | 'question'
	): Promise<any> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pendingInputs.delete(requestId);
				resolve(kind === 'question'
					? { answer: '', wasFreeform: true }
					: { kind: 'user-not-available' });
			}, 300_000);
			this.pendingInputs.set(requestId, { sessionId, kind, resolve, timer });
		});
	}

	private async ensureReadyForModel(modelId?: string): Promise<CopilotRuntimeProbe> {
		const probe = await this.runtime.ensureProbe();
		if (!probe.authenticated && !this.customModels(probe).some((model) => model.selectionId === modelId)) {
			throw this.withCode('AUTH_REQUIRED', 'Copilot authentication is required.');
		}
		return probe;
	}

	private toModelOptions(models: ModelInfo[], customModels: CopilotCustomEndpointModel[] = []): ProviderModelOption[] {
		const sdkModels = models
			.filter((model) => model.policy?.state !== 'disabled')
			.map((model) => ({
				id: model.id,
				label: model.name || model.id,
				effortOptions: (model.supportedReasoningEfforts || []).map((effort) => ({
					id: effort,
					label: effort,
				})),
				defaultEffort: model.defaultReasoningEffort,
			}));
		const custom = customModels.map((model) => ({
			id: model.selectionId,
			label: model.label,
			effortOptions: [],
			defaultEffort: undefined,
		}));
		return [...sdkModels, ...custom.filter((model) => !sdkModels.some((candidate) => candidate.id === model.id))];
	}

	private resolveModel(probe: CopilotRuntimeProbe, modelId: string, effort?: string): CopilotCustomEndpointModel | undefined {
		const custom = this.customModels(probe).find((candidate) => candidate.selectionId === modelId);
		if (custom) {
			if (effort) {
				throw this.withCode('EFFORT_UNAVAILABLE', `Selected Copilot custom endpoint model does not expose reasoning effort: ${modelId}`);
			}
			return custom;
		}
		const model = probe.models.find((candidate) => candidate.id === modelId);
		if (!model) {
			throw this.withCode('MODEL_UNAVAILABLE', `Selected Copilot model is unavailable: ${modelId}`);
		}
		if (effort && !(model.supportedReasoningEfforts || []).includes(effort as any)) {
			throw this.withCode('EFFORT_UNAVAILABLE', `Selected Copilot effort is unavailable: ${effort}`);
		}
		return undefined;
	}

	private customModels(probe: CopilotRuntimeProbe): CopilotCustomEndpointModel[] {
		return probe.customEndpointModels || [];
	}

	private async refreshTranscript(state: CopilotSessionState): Promise<void> {
		try {
			state.events = await state.sdkSession.getEvents();
			state.transcript = copilotEventsToTranscript(state.events);
		} catch {
			// A session can be readable even when the runtime has no persisted event log.
			state.events = state.events || [];
			state.transcript = copilotEventsToTranscript(state.events);
		}
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
				rename: 'unsupported',
				setModel: 'native',
				archive: 'unsupported',
			},
			toolPermissionModes: {
				select: 'emulated',
				switching: 'next-turn',
			},
			canStream: true,
			kmTaskExecution: true,
			receiptMode: 'schema-tool',
			openTargets: ['infinite-map'],
			sessionOwnership: 'provider',
		};
	}

	private requireSession(session: AgentSessionRef): CopilotSessionState {
		const state = this.sessions.get(session.sessionId);
		if (!state) {
			throw this.withCode('NO_ACTIVE_SESSION', `Copilot session is not loaded: ${session.sessionId}`);
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
			support: 'emulated',
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
				`Copilot permission mode is unavailable: ${permissionModeId || '(default)'}`
			);
		}
		return mode;
	}

	private snapshot(state: CopilotSessionState): SessionSnapshot {
		return {
			executionId: state.executionId,
			status: state.status,
			session: { ...state.session },
			sequence: state.sequence,
			updatedAt: state.updatedAt,
			activeTurnId: state.activeTurnId,
			transcript: state.transcript,
			effectiveConfig: {
				modelId: state.session.modelId,
				effort: state.session.effort,
				permissionModeId: state.session.permissionModeId,
			},
		};
	}

	private updateState(
		state: CopilotSessionState,
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
		state: CopilotSessionState,
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

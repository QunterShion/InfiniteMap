import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { ProviderComponentRegistry } from '../providers/providerComponentRegistry';
import {
	AgentSessionAdapter,
	AgentSessionEventPayload,
	AgentSessionRef,
	NodeExecutionStatus,
	ProviderDescriptor,
	ProviderModelOption,
	ProviderPermissionModeOption,
	SessionConfiguration,
	SessionMutationInput,
	SessionSnapshot,
	SessionTranscriptEntry,
} from './types';

export interface SessionOrchestratorEvent extends AgentSessionEventPayload {
	documentKey: string;
}

interface ActiveDocumentSession {
	documentKey: string;
	executionId: string;
	providerId: string;
	adapter: AgentSessionAdapter;
	session: AgentSessionRef;
	requestedConfig: SessionConfiguration & { modelId: string };
	effectiveConfig: SessionConfiguration;
	activeTurnId?: string;
	status: SessionSnapshot['status'];
	updatedAt: string;
	transcript: SessionTranscriptEntry[];
}

export interface StartOrSendInput {
	documentKey: string;
	providerId: string;
	workingDirectory: string;
	mapPath: string;
	nodeId?: string;
	mcpServer: { command: string; args: string[] };
	message: string;
	modelId: string;
	effort?: string;
	permissionModeId?: string;
	idempotencyKey: string;
}

export interface AppendInput extends StartOrSendInput {
	expectedTurnId?: string;
}

export interface RecoverSessionInput {
	documentKey: string;
	executionId: string;
	status: SessionSnapshot['status'];
	session: AgentSessionRef;
	requestedConfig?: SessionConfiguration;
	effectiveConfig?: SessionConfiguration;
	updatedAt: string;
	workingDirectory: string;
	mcpServer: { command: string; args: string[] };
}

export class SessionOrchestrator implements vscode.Disposable {
	private readonly adapterOperations = new Map<string, Promise<AgentSessionAdapter>>();
	private readonly adapters = new Map<string, AgentSessionAdapter>();
	private readonly adapterSubscriptions = new Map<string, vscode.Disposable>();
	private readonly sessions = new Map<string, ActiveDocumentSession>();
	private readonly idempotentResults = new Map<string, unknown>();
	private readonly eventEmitter = new vscode.EventEmitter<SessionOrchestratorEvent>();
	private readonly hostSequences = new Map<string, number>();
	public readonly onDidEvent = this.eventEmitter.event;

	constructor(private readonly providers: ProviderComponentRegistry) {}

	public discover(): Promise<ProviderDescriptor[]> {
		return this.providers.discover();
	}

	public async listModels(providerId: string): Promise<ProviderModelOption[]> {
		return (await this.getAdapter(providerId)).listModels();
	}

	public async listPermissionModes(providerId: string, workingDirectory?: string): Promise<ProviderPermissionModeOption[]> {
		return (await this.getAdapter(providerId)).listPermissionModes({ workingDirectory });
	}

	public getSnapshot(documentKey: string): SessionSnapshot | undefined {
		const active = this.sessions.get(documentKey);
		return active ? this.toSnapshot(active) : undefined;
	}

	public async recover(input: RecoverSessionInput): Promise<SessionSnapshot | undefined> {
		if (this.sessions.has(input.documentKey)) {
			return this.getSnapshot(input.documentKey);
		}
		try {
			const adapter = await this.getAdapter(input.session.provider);
			const permissionMode = await this.resolvePermissionMode(
				adapter,
				input.requestedConfig?.permissionModeId
					|| input.effectiveConfig?.permissionModeId
					|| input.session.permissionModeId,
				input.workingDirectory
			);
			const providerSnapshot = await adapter.query({
				session: { ...input.session, permissionModeId: permissionMode.id },
				executionId: input.executionId,
				workingDirectory: input.workingDirectory,
				mcpServer: input.mcpServer,
			});
			const active: ActiveDocumentSession = {
				documentKey: input.documentKey,
				executionId: input.executionId,
				providerId: input.session.provider,
				adapter,
				session: { ...providerSnapshot.session },
				requestedConfig: {
					modelId: input.requestedConfig?.modelId || input.session.modelId || '',
					effort: input.requestedConfig?.effort || input.session.effort,
					permissionModeId: input.requestedConfig?.permissionModeId || permissionMode.id,
				},
				effectiveConfig: {
					modelId: input.effectiveConfig?.modelId
						|| providerSnapshot.session.modelId
						|| input.session.modelId,
					effort: input.effectiveConfig?.effort
						|| providerSnapshot.session.effort
						|| input.session.effort,
					permissionModeId: input.effectiveConfig?.permissionModeId
						|| providerSnapshot.session.permissionModeId
						|| permissionMode.id,
				},
				activeTurnId: providerSnapshot.activeTurnId,
				status: providerSnapshot.status,
				updatedAt: providerSnapshot.updatedAt || input.updatedAt,
				transcript: providerSnapshot.transcript || [],
			};
			this.sessions.set(input.documentKey, active);
			return this.toSnapshot(active);
		} catch (error) {
			// Main-P1-01：区分网络断连与其他错误，返回带状态标记的快照，避免 recover 永久无结果
			const isNetworkError = error instanceof Error &&
				/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE/.test(error.message);
			return {
				executionId: input.executionId,
				status: (isNetworkError ? 'disconnected' : 'failed') satisfies NodeExecutionStatus,
				session: { ...input.session },
				sequence: 0,
				updatedAt: new Date().toISOString(),
				requestedConfig: input.requestedConfig || { modelId: input.session.modelId || '' },
				effectiveConfig: input.effectiveConfig || { modelId: input.session.modelId || '' },
			};
		}
	}

	public async send(input: StartOrSendInput): Promise<SessionSnapshot> {
		const cacheKey = `send:${input.documentKey}:${input.idempotencyKey}`;
		const cached = this.idempotentResults.get(cacheKey) as SessionSnapshot | undefined;
		if (cached) {
			return cached;
		}
		const adapter = await this.getAdapter(input.providerId);
		let active = this.sessions.get(input.documentKey);
		if (active && active.providerId !== input.providerId) {
			if (active.status === 'running' || active.status === 'starting' || active.status === 'interrupting') {
				throw this.withCode('CAPABILITY_UNAVAILABLE', 'Provider cannot change while a turn is active.');
			}
			active = undefined;
		}
		const selection = await this.validateSelection(
			adapter,
			input.modelId,
			input.effort,
			input.permissionModeId || active?.effectiveConfig.permissionModeId || active?.session.permissionModeId,
			input.workingDirectory
		);
		if (!active) {
			const executionId = randomUUID();
			const traceOpenUri = this.buildOpenUri(executionId, input.mapPath, input.nodeId);
			const session = await adapter.createSession({
				executionId,
				workingDirectory: input.workingDirectory,
				modelId: input.modelId,
				effort: input.effort,
				permissionModeId: selection.permissionMode.id,
				traceOpenUri,
				mcpServer: input.mcpServer,
			});
			session.openUri = traceOpenUri;
			active = {
				documentKey: input.documentKey,
				executionId,
				providerId: input.providerId,
				adapter,
				session,
				requestedConfig: {
					modelId: input.modelId,
					effort: input.effort,
					permissionModeId: selection.permissionMode.id,
				},
				effectiveConfig: {
					modelId: session.modelId || selection.model.id,
					effort: session.effort || input.effort,
					permissionModeId: session.permissionModeId || selection.permissionMode.id,
				},
				status: 'idle',
				updatedAt: new Date().toISOString(),
				transcript: [],
			};
			this.sessions.set(input.documentKey, active);
		}
		if (active.activeTurnId) {
			throw this.withCode('CAPABILITY_UNAVAILABLE', 'A turn is active; use append instead.');
		}
		active.requestedConfig = {
			modelId: input.modelId,
			effort: input.effort,
			permissionModeId: selection.permissionMode.id,
		};
		active.status = 'starting';
		active.updatedAt = new Date().toISOString();
		const submission = await adapter.send({
			executionId: active.executionId,
			session: active.session,
			message: input.message,
			modelId: input.modelId,
			effort: input.effort,
			permissionModeId: selection.permissionMode.id,
			idempotencyKey: input.idempotencyKey,
		});
		active.activeTurnId = submission.turnId;
		active.session.turnId = submission.turnId;
		active.effectiveConfig = {
			modelId: active.session.modelId || selection.model.id,
			effort: active.session.effort || input.effort,
			permissionModeId: active.session.permissionModeId || selection.permissionMode.id,
		};
		active.status = submission.turnId ? 'running' : 'starting';
		active.updatedAt = new Date().toISOString();
		const result = this.toSnapshot(active);
		this.remember(cacheKey, result);
		return result;
	}

	public async append(input: AppendInput): Promise<SessionSnapshot> {
		const cacheKey = `append:${input.documentKey}:${input.idempotencyKey}`;
		const cached = this.idempotentResults.get(cacheKey) as SessionSnapshot | undefined;
		if (cached) {
			return cached;
		}
		const active = this.requireSession(input.documentKey);
		if (active.providerId !== input.providerId) {
			throw this.withCode('CAPABILITY_UNAVAILABLE', 'Append must use the active session Provider.');
		}
		const selection = await this.validateSelection(
			active.adapter,
			input.modelId,
			input.effort,
			input.permissionModeId || active.effectiveConfig.permissionModeId || active.session.permissionModeId,
			input.workingDirectory
		);
		if (active.activeTurnId
			&& selection.permissionMode.id !== (active.effectiveConfig.permissionModeId || active.session.permissionModeId)) {
			throw this.withCode(
				'PERMISSION_MODE_UNAVAILABLE',
				'Permission mode changes apply to the next turn and cannot change an active turn.'
			);
		}
		if (active.activeTurnId && input.expectedTurnId !== active.activeTurnId) {
			await this.reconcile(active);
			throw this.withCode('STALE_TURN', 'The active turn changed before append.');
		}
		const submission = await active.adapter.append({
			executionId: active.executionId,
			session: active.session,
			message: input.message,
			modelId: input.modelId,
			effort: input.effort,
			permissionModeId: selection.permissionMode.id,
			idempotencyKey: input.idempotencyKey,
			expectedTurnId: input.expectedTurnId,
		});
		active.activeTurnId = submission.turnId || active.activeTurnId;
		active.session.turnId = active.activeTurnId;
		active.requestedConfig = {
			modelId: input.modelId,
			effort: input.effort,
			permissionModeId: selection.permissionMode.id,
		};
		active.effectiveConfig = {
			modelId: active.session.modelId || selection.model.id,
			effort: active.session.effort || input.effort,
			permissionModeId: active.session.permissionModeId || selection.permissionMode.id,
		};
		active.status = active.activeTurnId ? 'running' : active.status;
		active.updatedAt = new Date().toISOString();
		const result = this.toSnapshot(active);
		this.remember(cacheKey, result);
		return result;
	}

	public async interrupt(documentKey: string, expectedTurnId?: string): Promise<SessionSnapshot> {
		const active = this.requireSession(documentKey);
		if (!active.activeTurnId) {
			throw this.withCode('NO_ACTIVE_TURN', 'There is no active turn to interrupt.');
		}
		if (expectedTurnId && expectedTurnId !== active.activeTurnId) {
			await this.reconcile(active);
			throw this.withCode('STALE_TURN', 'The active turn changed before interrupt.');
		}
		active.status = 'interrupting';
		await active.adapter.interrupt({
			session: active.session,
			expectedTurnId: active.activeTurnId,
		});
		return this.toSnapshot(active);
	}

	public async resolveInput(
		documentKey: string,
		requestId: string,
		decision: 'approve' | 'deny',
		value?: string
	): Promise<void> {
		const active = this.requireSession(documentKey);
		if (!active.adapter.respondToInput) {
			throw this.withCode('CAPABILITY_UNAVAILABLE', 'The active Provider cannot resolve interactive input.');
		}
		await active.adapter.respondToInput({
			session: active.session,
			requestId,
			decision,
			value,
		});
	}

	public async query(documentKey: string): Promise<SessionSnapshot> {
		const active = this.requireSession(documentKey);
		await this.reconcile(active);
		return this.toSnapshot(active);
	}

	public async readSessionDetail(input: {
		executionId: string;
		session: AgentSessionRef;
		workingDirectory: string;
		mcpServer: { command: string; args: string[] };
	}): Promise<SessionSnapshot> {
		const adapter = await this.getAdapter(input.session.provider);
		return adapter.query({
			session: input.session,
			executionId: input.executionId,
			workingDirectory: input.workingDirectory,
			mcpServer: input.mcpServer,
		});
	}

	public async mutate(
		documentKey: string,
		operation: SessionMutationInput['operation'],
		value?: string
	): Promise<SessionSnapshot> {
		const active = this.requireSession(documentKey);
		const capabilities = await active.adapter.detectCapabilities();
		if (capabilities.mutations[operation] === 'unsupported') {
			throw this.withCode('CAPABILITY_UNAVAILABLE', `Provider does not support ${operation}.`);
		}
		const snapshot = await active.adapter.mutate({ session: active.session, operation, value });
		this.applySnapshot(active, snapshot);
		return this.toSnapshot(active);
	}

	public async open(documentKey: string, target?: 'infinite-map' | 'provider-cli' | 'provider-tui' | 'provider-ide'): Promise<void> {
		const active = this.requireSession(documentKey);
		const capabilities = await active.adapter.detectCapabilities();
		const requestedTarget = target || 'infinite-map';
		if (!capabilities.openTargets.includes(requestedTarget)) {
			throw this.withCode('CAPABILITY_UNAVAILABLE', `Provider cannot open target: ${requestedTarget}`);
		}
		if (requestedTarget !== 'infinite-map') {
			await active.adapter.open({ session: active.session, target: requestedTarget });
		}
	}

	public dispose(): void {
		for (const subscription of this.adapterSubscriptions.values()) {
			subscription.dispose();
		}
		for (const adapter of this.adapters.values()) {
			adapter.dispose();
		}
		this.adapterSubscriptions.clear();
		this.adapters.clear();
		this.adapterOperations.clear();
		this.sessions.clear();
		this.idempotentResults.clear();
		this.eventEmitter.dispose();
	}

	private async getAdapter(providerId: string): Promise<AgentSessionAdapter> {
		const cached = this.adapters.get(providerId);
		if (cached) {
			return cached;
		}
		let operation = this.adapterOperations.get(providerId);
		if (!operation) {
			operation = this.providers.load(providerId).then((component) => component.createAdapter());
			this.adapterOperations.set(providerId, operation);
		}
		try {
			const adapter = await operation;
			if (adapter.providerId !== providerId) {
				adapter.dispose();
				throw this.withCode('PROVIDER_INCOMPATIBLE', 'Provider adapter identity does not match the catalog.');
			}
			this.adapters.set(providerId, adapter);
			if (!this.adapterSubscriptions.has(providerId)) {
				this.adapterSubscriptions.set(providerId, adapter.onDidEvent((event) => this.forwardEvent(providerId, event)));
			}
			return adapter;
		} finally {
			this.adapterOperations.delete(providerId);
		}
	}

	private forwardEvent(providerId: string, event: AgentSessionEventPayload): void {
		const active = [...this.sessions.values()].find((candidate) =>
			candidate.providerId === providerId && candidate.executionId === event.executionId
		);
		if (!active) {
			return;
		}
		const payload = event.payload as Partial<SessionSnapshot> | undefined;
		if (event.type === 'session.state.changed' && payload) {
			if (payload.status) {
				active.status = payload.status;
			}
			if (Object.prototype.hasOwnProperty.call(payload, 'activeTurnId')) {
				active.activeTurnId = payload.activeTurnId;
			}
			if (payload.session?.modelId) {
				active.effectiveConfig.modelId = payload.session.modelId;
			}
			if (payload.session?.permissionModeId) {
				active.effectiveConfig.permissionModeId = payload.session.permissionModeId;
			}
		}
		if (event.type === 'session.completed') {
			active.activeTurnId = undefined;
			if (active.status === 'running' || active.status === 'starting' || active.status === 'interrupting') {
				active.status = 'idle';
			}
		}
		if (event.type === 'session.transcript.updated') {
			const transcriptPayload = event.payload as { entry?: SessionTranscriptEntry; transcript?: SessionTranscriptEntry[] } | undefined;
			const entries = transcriptPayload?.transcript || (transcriptPayload?.entry ? [transcriptPayload.entry] : []);
			for (const entry of entries) {
				const index = active.transcript.findIndex((candidate) => candidate.id === entry.id);
				if (index >= 0) {
					active.transcript[index] = { ...entry };
				} else {
					active.transcript.push({ ...entry });
				}
			}
		}
		active.updatedAt = new Date().toISOString();
		const sequence = (this.hostSequences.get(active.documentKey) || 0) + 1;
		this.hostSequences.set(active.documentKey, sequence);
		this.eventEmitter.fire({
			documentKey: active.documentKey,
			executionId: active.executionId,
			sequence,
			type: event.type,
			payload: event.payload,
		});
	}

	private async validateSelection(
		adapter: AgentSessionAdapter,
		modelId: string,
		effort?: string,
		permissionModeId?: string,
		workingDirectory?: string
	): Promise<{ model: ProviderModelOption; permissionMode: ProviderPermissionModeOption }> {
		const capabilities = await adapter.detectCapabilities();
		if (capabilities.availability === 'auth_required') {
			throw this.withCode('AUTH_REQUIRED', 'Provider authentication is required.');
		}
		if (capabilities.availability !== 'ready' && capabilities.availability !== 'degraded') {
			throw this.withCode('PROVIDER_LOAD_FAILED', `Provider is not ready: ${capabilities.availability}`);
		}
		const models = await adapter.listModels();
		const model = models.find((option) => option.id === modelId);
		if (!model) {
			throw this.withCode('MODEL_UNAVAILABLE', `Selected model is unavailable: ${modelId}`);
		}
		if (effort && !model.effortOptions.some((option) => option.id === effort)) {
			throw this.withCode('EFFORT_UNAVAILABLE', `Selected effort is unavailable: ${effort}`);
		}
		return { model, permissionMode: await this.resolvePermissionMode(adapter, permissionModeId, workingDirectory) };
	}

	private async resolvePermissionMode(
		adapter: AgentSessionAdapter,
		permissionModeId?: string,
		workingDirectory?: string
	): Promise<ProviderPermissionModeOption> {
		const modes = await adapter.listPermissionModes({ workingDirectory });
		const selected = permissionModeId
			? modes.find((option) => option.id === permissionModeId)
			: modes.find((option) => option.isDefault) || modes[0];
		if (!selected) {
			throw this.withCode(
				'PERMISSION_MODE_UNAVAILABLE',
				permissionModeId
					? `Selected permission mode is unavailable: ${permissionModeId}`
					: 'Provider does not expose an allowed permission mode.'
			);
		}
		return selected;
	}

	private async reconcile(active: ActiveDocumentSession): Promise<void> {
		const snapshot = await active.adapter.query({ session: active.session });
		this.applySnapshot(active, snapshot);
	}

	private applySnapshot(active: ActiveDocumentSession, snapshot: SessionSnapshot): void {
		active.status = snapshot.status;
		active.activeTurnId = snapshot.activeTurnId;
		active.session = { ...snapshot.session };
		active.updatedAt = snapshot.updatedAt;
		active.transcript = (snapshot.transcript || []).map((entry) => ({ ...entry }));
		active.effectiveConfig = snapshot.effectiveConfig || {
			modelId: snapshot.session.modelId,
			effort: snapshot.session.effort,
			permissionModeId: snapshot.session.permissionModeId,
		};
	}

	private requireSession(documentKey: string): ActiveDocumentSession {
		const active = this.sessions.get(documentKey);
		if (!active) {
			throw this.withCode('NO_ACTIVE_SESSION', 'There is no active session for this document.');
		}
		return active;
	}

	private toSnapshot(active: ActiveDocumentSession): SessionSnapshot {
		return {
			executionId: active.executionId,
			status: active.status,
			session: { ...active.session },
			sequence: this.hostSequences.get(active.documentKey) || 0,
			updatedAt: active.updatedAt,
			activeTurnId: active.activeTurnId,
			transcript: active.transcript.map((entry) => ({ ...entry })),
			requestedConfig: { ...active.requestedConfig },
			effectiveConfig: { ...active.effectiveConfig },
		};
	}

	private remember(key: string, value: unknown): void {
		this.idempotentResults.set(key, value);
		if (this.idempotentResults.size > 500) {
			const oldest = this.idempotentResults.keys().next().value as string | undefined;
			if (oldest) {
				this.idempotentResults.delete(oldest);
			}
		}
	}

	private withCode(code: string, message: string): Error {
		const error = new Error(message) as Error & { code?: string };
		error.code = code;
		return error;
	}

	private buildOpenUri(executionId: string, mapPath: string, nodeId?: string): string {
		const query = [
			'v=1',
			`executionId=${encodeURIComponent(executionId)}`,
			`map=${encodeURIComponent(mapPath.replace(/\\/g, '/'))}`,
		];
		if (nodeId) {
			query.push(`nodeId=${encodeURIComponent(nodeId)}`);
		}
		return `vscode://chanterxiao.infinite-map/session/open?${query.join('&')}`;
	}
}

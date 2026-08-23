import * as vscode from 'vscode';

export const AGENT_SESSION_PROTOCOL_VERSION = 1 as const;

export type ProviderId = string;
export type CapabilityLevel = 'native' | 'emulated' | 'experimental' | 'unsupported';
export type ProviderInstallState =
	| 'missing'
	| 'installed_inactive'
	| 'loading'
	| 'ready'
	| 'auth_required'
	| 'degraded'
	| 'incompatible'
	| 'failed';

export type ProviderInstallPhase =
	| 'opening'
	| 'waiting'
	| 'verifying'
	| 'completed'
	| 'failed';

export interface ProviderInstallationResult {
	providerId: ProviderId;
	displayName: string;
	alreadyInstalled: boolean;
	descriptor: ProviderDescriptor;
}

export type NodeExecutionStatus =
	| 'allocated'
	| 'starting'
	| 'running'
	| 'idle'
	| 'interrupting'
	| 'interrupted'
	| 'completed'
	| 'failed'
	| 'cancelled'
	| 'conflict'
	| 'disconnected';

export interface ProviderModelOption {
	id: string;
	label: string;
	effortOptions: Array<{ id: string; label: string }>;
	defaultEffort?: string;
}

export type PermissionModeSource = 'builtin' | 'custom-profile' | 'provider';
export type PermissionModeRisk = 'restricted' | 'standard' | 'elevated';

/**
 * Provider-owned permission/profile option. The id is intentionally opaque:
 * approval behavior and execution boundaries are separate dimensions and are
 * not interchangeable across Providers.
 */
export interface ProviderPermissionModeOption {
	id: string;
	label: string;
	description?: string;
	source: PermissionModeSource;
	support: CapabilityLevel;
	risk: PermissionModeRisk;
	requiresConfirmation?: boolean;
	isDefault?: boolean;
	semantics: {
		approvals: 'interactive' | 'provider-reviewed' | 'non-interactive' | 'profile-defined';
		workspaceAccess: 'read-only' | 'workspace-write' | 'full-access' | 'profile-defined' | 'provider-defined';
	};
}

export interface PermissionModeQueryInput {
	workingDirectory?: string;
}

export interface SessionCapabilities {
	availability: 'missing' | 'starting' | 'auth_required' | 'ready' | 'incompatible' | 'degraded';
	lifecycle: {
		create: CapabilityLevel;
		resume: CapabilityLevel;
		list: CapabilityLevel;
		read: CapabilityLevel;
		interrupt: CapabilityLevel;
	};
	inputMode: 'immediate-steer' | 'enqueue' | 'next-turn-only';
	mutations: {
		rename: CapabilityLevel;
		setModel: CapabilityLevel;
		archive: CapabilityLevel;
	};
	toolPermissionModes: {
		select: CapabilityLevel;
		switching: 'next-turn' | 'active-turn' | 'new-session-only' | 'unsupported';
	};
	canStream: boolean;
	kmTaskExecution: boolean;
	receiptMode: 'native-json-schema' | 'schema-tool' | 'prompt-only';
	openTargets: Array<'infinite-map' | 'provider-cli' | 'provider-tui' | 'provider-ide'>;
	sessionOwnership: 'provider' | 'infinite-map';
}

export interface ProviderDescriptor {
	id: ProviderId;
	displayName: string;
	componentExtensionId: string;
	installState: ProviderInstallState;
	models: ProviderModelOption[];
	permissionModes: ProviderPermissionModeOption[];
	capabilities: SessionCapabilities;
}

export interface AgentSessionRef {
	provider: ProviderId;
	sessionId: string;
	threadId?: string;
	turnId?: string;
	surface: 'app-server' | 'copilot-sdk' | 'claude-agent-sdk' | 'language-model' | 'provider-pack';
	modelId?: string;
	effort?: string;
	permissionModeId?: string;
	openUri: string;
}

export interface SessionConfiguration {
	modelId?: string;
	effort?: string;
	permissionModeId?: string;
}

export type SessionTranscriptKind =
	| 'user'
	| 'assistant'
	| 'reasoning'
	| 'plan'
	| 'command'
	| 'file-change'
	| 'mcp-tool'
	| 'tool'
	| 'collaboration'
	| 'web-search'
	| 'image'
	| 'approval'
	| 'status'
	| 'error';

/**
 * Provider-neutral, JSON-safe session content used by both live updates and
 * restored history. `summary` is Provider-exposed reasoning/result summary;
 * it must not be presented as a hidden chain of thought.
 */
export interface SessionTranscriptEntry {
	id: string;
	turnId?: string;
	itemId?: string;
	kind: SessionTranscriptKind;
	title?: string;
	summary?: string;
	text?: string;
	status?: string;
	phase?: 'commentary' | 'final_answer';
	detail?: unknown;
	startedAt?: string;
	completedAt?: string;
	updatedAt: string;
}

export interface SessionSnapshot {
	executionId: string;
	status: NodeExecutionStatus;
	session: AgentSessionRef;
	sequence: number;
	updatedAt: string;
	title?: string;
	activeTurnId?: string;
	requestedConfig?: SessionConfiguration;
	effectiveConfig?: SessionConfiguration;
	transcript?: SessionTranscriptEntry[];
	degradations?: Array<{
		field: string;
		action: 'dropped' | 'substituted' | 'blocked';
		reason: string;
	}>;
}

export interface CreateSessionInput {
	executionId: string;
	workingDirectory: string;
	modelId: string;
	effort?: string;
	permissionModeId?: string;
	traceOpenUri?: string;
	mcpServer: { command: string; args: string[] };
}

export interface SendSessionInput {
	executionId: string;
	session: AgentSessionRef;
	message: string;
	modelId: string;
	effort?: string;
	permissionModeId?: string;
	idempotencyKey: string;
}

export interface AppendSessionInput extends SendSessionInput {
	expectedTurnId?: string;
}

export interface QuerySessionInput {
	session: AgentSessionRef;
	executionId?: string;
	workingDirectory?: string;
	mcpServer?: { command: string; args: string[] };
}

export interface SessionMutationInput {
	session: AgentSessionRef;
	operation: 'rename' | 'setModel' | 'archive';
	value?: string;
}

export interface InterruptTurnInput {
	session: AgentSessionRef;
	expectedTurnId?: string;
}

export interface OpenSessionInput {
	session: AgentSessionRef;
	target?: 'infinite-map' | 'provider-cli' | 'provider-tui' | 'provider-ide';
}

export interface RespondToInputInput {
	session: AgentSessionRef;
	requestId: string;
	decision: 'approve' | 'deny';
	value?: string;
}

export interface AgentSessionEventPayload {
	executionId: string;
	sequence: number;
	type:
		| 'provider.changed'
		| 'models.changed'
		| 'session.state.changed'
		| 'session.delta'
		| 'session.transcript.updated'
		| 'session.tool.started'
		| 'session.tool.completed'
		| 'session.input.required'
		| 'session.input.resolved'
		| 'session.completed'
		| 'taskState.changed'
		| 'history.changed';
	payload: unknown;
}

export interface AgentSessionAdapter {
	readonly providerId: ProviderId;
	getDescriptor(): Promise<ProviderDescriptor>;
	detectCapabilities(): Promise<SessionCapabilities>;
	listModels(): Promise<ProviderModelOption[]>;
	listPermissionModes(input?: PermissionModeQueryInput): Promise<ProviderPermissionModeOption[]>;
	createSession(input: CreateSessionInput): Promise<AgentSessionRef>;
	send(input: SendSessionInput): Promise<{ turnId?: string; submissionId: string }>;
	append(input: AppendSessionInput): Promise<{ turnId?: string; submissionId: string }>;
	query(input: QuerySessionInput): Promise<SessionSnapshot>;
	mutate(input: SessionMutationInput): Promise<SessionSnapshot>;
	interrupt(input: InterruptTurnInput): Promise<void>;
	open(input: OpenSessionInput): Promise<void>;
	respondToInput?(input: RespondToInputInput): Promise<void>;
	onDidEvent(listener: (event: AgentSessionEventPayload) => void): vscode.Disposable;
	dispose(): void;
}

export interface ProviderComponentApiV1 {
	apiVersion: '1';
	getDescriptor(): Promise<ProviderDescriptor>;
	createAdapter(): Promise<AgentSessionAdapter>;
	authenticate?(): Promise<void>;
}

export const AGENT_SESSION_ERROR_CODES = [
	'MCP_UNAVAILABLE',
	'DOCUMENT_DIRTY',
	'PROVIDER_COMPONENT_MISSING',
	'PROVIDER_INSTALL_FAILED',
	'PROVIDER_LOAD_FAILED',
	'PROVIDER_INCOMPATIBLE',
	'AUTH_REQUIRED',
	'CAPABILITY_UNAVAILABLE',
	'MODEL_UNAVAILABLE',
	'EFFORT_UNAVAILABLE',
	'PERMISSION_MODE_UNAVAILABLE',
	'NO_ACTIVE_SESSION',
	'NO_ACTIVE_TURN',
	'STALE_TURN',
	'TIMEOUT',
	'INTERNAL_ERROR',
] as const;

export type AgentSessionErrorCode = typeof AGENT_SESSION_ERROR_CODES[number];

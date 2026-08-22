import {
	AGENT_SESSION_PROTOCOL_VERSION,
	AgentSessionErrorCode,
	AgentSessionEventPayload,
	ProviderId,
	ProviderInstallPhase,
} from './types';

export type AgentSessionOperation =
	| 'discoverProviders'
	| 'installProvider'
	| 'authenticateProvider'
	| 'loadProvider'
	| 'listModels'
	| 'send'
	| 'append'
	| 'interrupt'
	| 'querySession'
	| 'updateSession'
	| 'queryHistory'
	| 'reconnectMcp'
	| 'resolveInput'
	| 'openSession';

export interface AgentSessionRequest {
	command: 'agentSession';
	protocolVersion: typeof AGENT_SESSION_PROTOCOL_VERSION;
	requestId: string;
	operation: AgentSessionOperation;
	documentUri: string;
	nodeId?: string;
	executionId?: string;
	providerId?: ProviderId;
	modelId?: string;
	effort?: string;
	permissionModeId?: string;
	input?: string;
	idempotencyKey?: string;
	expectedTurnId?: string;
	mutation?: 'rename' | 'setModel' | 'archive';
	value?: string;
	target?: 'infinite-map' | 'provider-cli' | 'provider-tui' | 'provider-ide';
	cursor?: string;
	limit?: number;
	inputRequestId?: string;
	decision?: 'approve' | 'deny';
	inputValue?: string;
}

export interface AgentSessionResult {
	command: 'agentSessionResult';
	protocolVersion: typeof AGENT_SESSION_PROTOCOL_VERSION;
	requestId: string;
	ok: boolean;
	result?: unknown;
	error?: {
		code: AgentSessionErrorCode;
		message: string;
		retryable: boolean;
	};
}

export interface AgentSessionEvent extends AgentSessionEventPayload {
	command: 'agentSessionEvent';
	protocolVersion: typeof AGENT_SESSION_PROTOCOL_VERSION;
}

export interface AgentProviderInstallProgress {
	command: 'agentProviderInstallProgress';
	protocolVersion: typeof AGENT_SESSION_PROTOCOL_VERSION;
	requestId: string;
	providerId: ProviderId;
	phase: ProviderInstallPhase;
	error?: {
		code: AgentSessionErrorCode;
		message: string;
		retryable: boolean;
	};
}

export function isAgentSessionRequest(value: unknown): value is AgentSessionRequest {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const request = value as Partial<AgentSessionRequest>;
	return request.command === 'agentSession'
		&& request.protocolVersion === AGENT_SESSION_PROTOCOL_VERSION
		&& typeof request.requestId === 'string'
		&& request.requestId.length > 0
		&& typeof request.operation === 'string'
		&& typeof request.documentUri === 'string';
}

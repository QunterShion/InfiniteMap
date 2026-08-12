export type RpcId = number;

export interface RpcRequest {
	id: RpcId;
	method: string;
	params?: unknown;
}

export interface RpcNotification {
	method: string;
	params?: any;
}

export interface RpcResponse {
	id: RpcId;
	result?: any;
	error?: { code: number; message: string; data?: unknown };
}

export type AppServerMessage = RpcRequest | RpcNotification | RpcResponse;

export interface CodexModel {
	id: string;
	model: string;
	displayName: string;
	hidden: boolean;
	isDefault: boolean;
	defaultReasoningEffort: string;
	supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
}

export interface CodexThread {
	id: string;
	sessionId?: string;
	name?: string | null;
	status?: { type?: string };
	turns?: CodexTurn[];
}

export interface CodexTurn {
	id: string;
	status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
	error?: { message?: string } | null;
}

export const AGENT_EXECUTION_RECEIPT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['executionId', 'status', 'summary', 'artifacts', 'validations', 'collaborationChildren'],
	properties: {
		executionId: { type: 'string' },
		status: { enum: ['succeeded', 'failed', 'blocked'] },
		summary: { type: 'string' },
		artifacts: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['path', 'kind'],
				properties: {
					path: { type: 'string' },
					kind: { enum: ['created', 'modified', 'report'] },
				},
			},
		},
		validations: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['name', 'passed'],
				properties: {
					command: { type: 'string' },
					name: { type: 'string' },
					passed: { type: 'boolean' },
					evidence: { type: 'string' },
				},
			},
		},
		collaborationChildren: { type: 'array', items: { type: 'string' } },
		blocker: { type: 'string' },
	},
} as const;

export const INFINITE_MAP_CONTROL_INSTRUCTIONS = [
	'Apply the InfiniteMap KM requirement breakdown and collaboration rules to the supplied .km path.',
	'Use only the InfiniteMap MCP tools for every .km read, search, validation, claim, and write.',
	'Discover both breakdown and collaboration tasks using the latest revisions and lease protocol.',
	'Dry-run every write, perform it, then validate and list both task kinds again.',
	'Only associate session trace metadata with the supplied executionId; it does not change task semantics.',
	'After a real claim, replace or append the openUri nodeId query parameter with the claimed nodeId before calling km_record_session.',
	'If completion is impossible, leave the KM task pending and never report it as completed.',
].join('\n');

export const CODEX_CONTROL_INSTRUCTIONS = INFINITE_MAP_CONTROL_INSTRUCTIONS;

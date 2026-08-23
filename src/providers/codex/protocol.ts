export type RpcId = number | string;

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

export const CODEX_METHODS = {
	initialize: 'initialize',
	initialized: 'initialized',
	accountRead: 'account/read',
	accountLoginStart: 'account/login/start',
	modelList: 'model/list',
	permissionProfileList: 'permissionProfile/list',
	configRequirementsRead: 'configRequirements/read',
	threadStart: 'thread/start',
	threadResume: 'thread/resume',
	threadRead: 'thread/read',
	threadNameSet: 'thread/name/set',
	threadArchive: 'thread/archive',
	turnStart: 'turn/start',
	turnSteer: 'turn/steer',
	turnInterrupt: 'turn/interrupt',
	commandApproval: 'item/commandExecution/requestApproval',
	fileChangeApproval: 'item/fileChange/requestApproval',
	requestUserInput: 'item/tool/requestUserInput',
	mcpElicitation: 'mcpServer/elicitation/request',
	permissionsApproval: 'item/permissions/requestApproval',
	turnStarted: 'turn/started',
	threadStatusChanged: 'thread/status/changed',
	agentMessageDelta: 'item/agentMessage/delta',
	commandOutputDelta: 'item/commandExecution/outputDelta',
	fileChangeOutputDelta: 'item/fileChange/outputDelta',
	fileChangePatchUpdated: 'item/fileChange/patchUpdated',
	mcpToolCallProgress: 'item/mcpToolCall/progress',
	reasoningSummaryTextDelta: 'item/reasoning/summaryTextDelta',
	reasoningSummaryPartAdded: 'item/reasoning/summaryPartAdded',
	reasoningTextDelta: 'item/reasoning/textDelta',
	itemStarted: 'item/started',
	itemCompleted: 'item/completed',
	turnDiffUpdated: 'turn/diff/updated',
	turnPlanUpdated: 'turn/plan/updated',
	modelRerouted: 'model/rerouted',
	turnCompleted: 'turn/completed',
	turnError: 'error',
	serverRequestResolved: 'serverRequest/resolved',
	accountLoginCompleted: 'account/login/completed',
} as const;

export const CODEX_PROTOCOL_SURFACE = {
	clientRequests: [
		CODEX_METHODS.initialize,
		CODEX_METHODS.accountRead,
		CODEX_METHODS.accountLoginStart,
		CODEX_METHODS.modelList,
		CODEX_METHODS.permissionProfileList,
		CODEX_METHODS.configRequirementsRead,
		CODEX_METHODS.threadStart,
		CODEX_METHODS.threadResume,
		CODEX_METHODS.threadRead,
		CODEX_METHODS.threadNameSet,
		CODEX_METHODS.threadArchive,
		CODEX_METHODS.turnStart,
		CODEX_METHODS.turnSteer,
		CODEX_METHODS.turnInterrupt,
	],
	clientNotifications: [CODEX_METHODS.initialized],
	serverRequests: [
		CODEX_METHODS.commandApproval,
		CODEX_METHODS.fileChangeApproval,
		CODEX_METHODS.requestUserInput,
		CODEX_METHODS.mcpElicitation,
		CODEX_METHODS.permissionsApproval,
	],
	serverNotifications: [
		CODEX_METHODS.turnStarted,
		CODEX_METHODS.threadStatusChanged,
		CODEX_METHODS.agentMessageDelta,
		CODEX_METHODS.commandOutputDelta,
		CODEX_METHODS.fileChangeOutputDelta,
		CODEX_METHODS.fileChangePatchUpdated,
		CODEX_METHODS.mcpToolCallProgress,
		CODEX_METHODS.reasoningSummaryTextDelta,
		CODEX_METHODS.reasoningSummaryPartAdded,
		CODEX_METHODS.reasoningTextDelta,
		CODEX_METHODS.itemStarted,
		CODEX_METHODS.itemCompleted,
		CODEX_METHODS.turnDiffUpdated,
		CODEX_METHODS.turnPlanUpdated,
		CODEX_METHODS.modelRerouted,
		CODEX_METHODS.turnCompleted,
		CODEX_METHODS.turnError,
		CODEX_METHODS.serverRequestResolved,
		CODEX_METHODS.accountLoginCompleted,
	],
} as const;

export function assertCodexGeneratedProtocolSurface(schemas: {
	clientRequests: unknown;
	clientNotifications: unknown;
	serverRequests: unknown;
	serverNotifications: unknown;
}): void {
	for (const category of Object.keys(CODEX_PROTOCOL_SURFACE) as Array<keyof typeof CODEX_PROTOCOL_SURFACE>) {
		const available = collectMethodEnumStrings(schemas[category]);
		const missing = CODEX_PROTOCOL_SURFACE[category].filter((method) => !available.has(method));
		if (missing.length) {
			throw new Error(`Codex ${category} schema is missing required methods: ${missing.join(', ')}`);
		}
	}
	const requiredClientRequestFields: Record<string, string[]> = {
		[CODEX_METHODS.initialize]: ['capabilities'],
		[CODEX_METHODS.accountLoginStart]: ['type'],
		[CODEX_METHODS.threadStart]: ['approvalPolicy', 'approvalsReviewer', 'config', 'developerInstructions', 'permissions'],
		[CODEX_METHODS.threadResume]: ['approvalPolicy', 'approvalsReviewer', 'permissions'],
		[CODEX_METHODS.turnStart]: [
			'additionalContext',
			'approvalPolicy',
			'approvalsReviewer',
			'clientUserMessageId',
			'effort',
			'outputSchema',
			'permissions',
		],
		[CODEX_METHODS.turnSteer]: ['additionalContext', 'clientUserMessageId', 'expectedTurnId'],
	};
	for (const [method, fields] of Object.entries(requiredClientRequestFields)) {
		const paramsSchema = findMethodParamsSchema(schemas.clientRequests, method);
		if (!paramsSchema) {
			throw new Error(`Codex client request schema is missing params for ${method}.`);
		}
		const availableFields = collectSchemaPropertyNames(paramsSchema, schemas.clientRequests);
		const missing = fields.filter((field) => !availableFields.has(field));
		if (missing.length) {
			throw new Error(`Codex ${method} params schema is missing required integration fields: ${missing.join(', ')}`);
		}
	}
}

export function assertCodexGeneratedServerResponses(schemas: {
	commandApproval: unknown;
	fileChangeApproval: unknown;
	requestUserInput: unknown;
	mcpElicitation: unknown;
	permissionsApproval: unknown;
}): void {
	const contracts: Array<{
		name: keyof typeof schemas;
		required: string[];
		enums?: string[];
	}> = [
		{ name: 'commandApproval', required: ['decision'], enums: ['accept', 'decline', 'cancel'] },
		{ name: 'fileChangeApproval', required: ['decision'], enums: ['accept', 'decline', 'cancel'] },
		{ name: 'requestUserInput', required: ['answers'] },
		{ name: 'mcpElicitation', required: ['action'], enums: ['accept', 'decline', 'cancel'] },
		{ name: 'permissionsApproval', required: ['permissions'], enums: ['turn'] },
	];
	for (const contract of contracts) {
		const schema = asRecord(schemas[contract.name]);
		const fields = new Set(Object.keys(asRecord(schema?.properties) || {}));
		const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
		const missingFields = contract.required.filter((field) => !fields.has(field) || !required.has(field));
		if (missingFields.length) {
			throw new Error(`Codex ${contract.name} response schema is missing fields: ${missingFields.join(', ')}`);
		}
		const enumValues = collectEnumStrings(schemas[contract.name]);
		const missingEnums = (contract.enums || []).filter((value) => !enumValues.has(value));
		if (missingEnums.length) {
			throw new Error(`Codex ${contract.name} response schema is missing enum values: ${missingEnums.join(', ')}`);
		}
	}
}

function collectMethodEnumStrings(value: unknown, result = new Set<string>()): Set<string> {
	if (Array.isArray(value)) {
		for (const item of value) {
			collectMethodEnumStrings(item, result);
		}
		return result;
	}
	if (!value || typeof value !== 'object') {
		return result;
	}
	const node = value as Record<string, unknown>;
	const properties = asRecord(node.properties);
	const method = asRecord(properties?.method);
	if (Array.isArray(method?.enum)) {
		for (const candidate of method.enum) {
			if (typeof candidate === 'string') {
				result.add(candidate);
			}
		}
	}
	for (const item of Object.values(node)) {
		collectMethodEnumStrings(item, result);
	}
	return result;
}

function collectEnumStrings(value: unknown, result = new Set<string>()): Set<string> {
	if (Array.isArray(value)) {
		for (const item of value) {
			collectEnumStrings(item, result);
		}
		return result;
	}
	if (!value || typeof value !== 'object') {
		return result;
	}
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (key === 'enum' && Array.isArray(item)) {
			for (const candidate of item) {
				if (typeof candidate === 'string') {
					result.add(candidate);
				}
			}
		}
		collectEnumStrings(item, result);
	}
	return result;
}

function findMethodParamsSchema(value: unknown, methodName: string): unknown {
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findMethodParamsSchema(item, methodName);
			if (found) {
				return found;
			}
		}
		return undefined;
	}
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const node = value as Record<string, unknown>;
	const properties = asRecord(node.properties);
	const method = asRecord(properties?.method);
	if (Array.isArray(method?.enum) && method.enum.includes(methodName)) {
		return properties?.params;
	}
	for (const item of Object.values(node)) {
		const found = findMethodParamsSchema(item, methodName);
		if (found) {
			return found;
		}
	}
	return undefined;
}

function collectSchemaPropertyNames(
	value: unknown,
	root: unknown,
	result = new Set<string>(),
	visitedRefs = new Set<string>()
): Set<string> {
	if (Array.isArray(value)) {
		for (const item of value) {
			collectSchemaPropertyNames(item, root, result, visitedRefs);
		}
		return result;
	}
	if (!value || typeof value !== 'object') {
		return result;
	}
	const node = value as Record<string, unknown>;
	if (typeof node.$ref === 'string' && !visitedRefs.has(node.$ref)) {
		visitedRefs.add(node.$ref);
		collectSchemaPropertyNames(resolveJsonPointer(root, node.$ref), root, result, visitedRefs);
	}
	const properties = asRecord(node.properties);
	if (properties) {
		for (const name of Object.keys(properties)) {
			result.add(name);
		}
	}
	for (const key of ['allOf', 'anyOf', 'oneOf']) {
		collectSchemaPropertyNames(node[key], root, result, visitedRefs);
	}
	return result;
}

function resolveJsonPointer(root: unknown, reference: string): unknown {
	if (!reference.startsWith('#/')) {
		return undefined;
	}
	let current: unknown = root;
	for (const rawSegment of reference.slice(2).split('/')) {
		const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
		current = asRecord(current)?.[segment];
		if (current === undefined) {
			return undefined;
		}
	}
	return current;
}

function asRecord(value: unknown): Record<string, any> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, any>
		: undefined;
}

export function assertStrictOutputSchema(schema: unknown, path = '$'): void {
	if (Array.isArray(schema)) {
		schema.forEach((item, index) => assertStrictOutputSchema(item, `${path}[${index}]`));
		return;
	}
	if (!schema || typeof schema !== 'object') {
		return;
	}
	const node = schema as Record<string, unknown>;
	const types = Array.isArray(node.type) ? node.type : [node.type];
	const properties = node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)
		? node.properties as Record<string, unknown>
		: undefined;
	if (types.includes('object') || properties) {
		if (node.additionalProperties !== false) {
			throw new Error(`Strict output schema object at ${path} must set additionalProperties=false.`);
		}
		const propertyNames = Object.keys(properties || {});
		const required = Array.isArray(node.required) ? node.required.filter((item): item is string => typeof item === 'string') : [];
		const missing = propertyNames.filter((name) => !required.includes(name));
		if (missing.length) {
			throw new Error(`Strict output schema object at ${path} is missing required fields: ${missing.join(', ')}`);
		}
		const unknown = required.filter((name) => !propertyNames.includes(name));
		if (unknown.length) {
			throw new Error(`Strict output schema object at ${path} requires unknown fields: ${unknown.join(', ')}`);
		}
	}
	for (const [key, value] of Object.entries(node)) {
		if (key === 'properties' && properties) {
			for (const [name, property] of Object.entries(properties)) {
				assertStrictOutputSchema(property, `${path}.properties.${name}`);
			}
		} else if (['items', 'anyOf', 'oneOf', 'allOf', '$defs', 'definitions'].includes(key)) {
			assertStrictOutputSchema(value, `${path}.${key}`);
		}
	}
}

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

export interface CodexThreadItem {
	id: string;
	type: string;
	[key: string]: unknown;
}

export interface CodexTurn {
	id: string;
	status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
	error?: { message?: string } | null;
	items?: CodexThreadItem[];
	startedAt?: number | null;
	completedAt?: number | null;
	durationMs?: number | null;
}

export const AGENT_EXECUTION_RECEIPT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['executionId', 'status', 'summary', 'artifacts', 'validations', 'collaborationChildren', 'blocker'],
	properties: {
		executionId: { type: 'string' },
		status: { type: 'string', enum: ['succeeded', 'failed', 'blocked'] },
		summary: { type: 'string' },
		artifacts: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['path', 'kind'],
				properties: {
					path: { type: 'string' },
					kind: { type: 'string', enum: ['created', 'modified', 'report'] },
				},
			},
		},
		validations: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['command', 'name', 'passed', 'evidence'],
				properties: {
					command: { type: ['string', 'null'] },
					name: { type: 'string' },
					passed: { type: 'boolean' },
					evidence: { type: ['string', 'null'] },
				},
			},
		},
		collaborationChildren: { type: 'array', items: { type: 'string' } },
		blocker: { type: ['string', 'null'] },
	},
} as const;

assertStrictOutputSchema(AGENT_EXECUTION_RECEIPT_SCHEMA);

export const INFINITE_MAP_CONTROL_INSTRUCTIONS = [
	'Apply the InfiniteMap KM requirement breakdown and collaboration rules to the supplied .km path.',
	'Use only the InfiniteMap MCP tools for every .km read, search, validation, claim, and write.',
	'Discover both breakdown and collaboration tasks using the latest revisions and lease protocol.',
	'Dry-run every write, perform it, then validate and list both task kinds again.',
	'Only associate session trace metadata with the supplied executionId; it does not change task semantics.',
	'After a real claim, replace or append the openUri nodeId query parameter with the claimed nodeId before calling km_record_session.',
	'If completion is impossible, leave the KM task pending and never report it as completed.',
	'In the structured receipt, set command, evidence, and blocker to null when they do not apply; never omit them.',
].join('\n');

export const CODEX_CONTROL_INSTRUCTIONS = INFINITE_MAP_CONTROL_INSTRUCTIONS;

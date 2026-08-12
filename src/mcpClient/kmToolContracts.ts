export const REQUIRED_KM_TOOL_NAMES = [
	'km_validate',
	'km_read',
	'km_list_todos',
	'km_get_node',
	'km_mark_done',
	'km_list_collaboration_tasks',
	'km_get_collaboration_context',
	'km_expand_collaboration',
	'km_claim_todos',
	'km_renew_claim',
	'km_complete_claim',
	'km_release_claim',
	'km_claim_collaboration_tasks',
	'km_complete_collaboration_claim',
	'km_record_session',
	'km_list_node_sessions',
] as const;

export type RequiredKmToolName = typeof REQUIRED_KM_TOOL_NAMES[number];

export interface KmMcpToolCall<TArguments extends Record<string, unknown> = Record<string, unknown>> {
	name: RequiredKmToolName | string;
	arguments: TArguments;
}

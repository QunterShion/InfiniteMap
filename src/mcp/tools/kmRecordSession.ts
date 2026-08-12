import { recordSession, RecordSessionInput } from '../services/kmSessionState';

export const kmRecordSessionTool = {
  name: 'km_record_session',
  description:
    '把 Provider execution/session 幂等绑定到 KM 节点，更新节点最近会话和完整会话旁车；不根据会话状态修改任务标签。写入前应先 dryRun',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'KM 文件绝对路径' },
      nodeId: { type: 'string', description: '实际发现或认领的任务节点 ID' },
      executionId: { type: 'string', description: '控制条内部 trace context 提供的 executionId' },
      taskKind: { type: 'string', enum: ['breakdown', 'collaboration'] },
      status: {
        type: 'string',
        enum: [
          'allocated', 'starting', 'running', 'idle', 'interrupting', 'interrupted',
          'completed', 'failed', 'cancelled', 'conflict', 'disconnected',
        ],
      },
      session: {
        type: 'object',
        properties: {
          provider: { type: 'string' },
          sessionId: { type: 'string' },
          threadId: { type: 'string' },
          turnId: { type: 'string' },
          surface: {
            type: 'string',
            enum: ['app-server', 'copilot-sdk', 'claude-agent-sdk', 'language-model', 'provider-pack'],
          },
          modelId: { type: 'string' },
          effort: { type: 'string' },
          openUri: { type: 'string' },
        },
        required: ['provider', 'sessionId', 'surface', 'openUri'],
      },
      workerId: { type: 'string' },
      claimId: { type: 'string' },
      expectedRevision: { type: 'string' },
      inputRevision: { type: 'string' },
      resultRevision: { type: 'string' },
      requestedConfig: {
        type: 'object',
        properties: { modelId: { type: 'string' }, effort: { type: 'string' } },
      },
      effectiveConfig: {
        type: 'object',
        properties: { modelId: { type: 'string' }, effort: { type: 'string' } },
      },
      degradations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            field: { type: 'string' },
            action: { type: 'string', enum: ['dropped', 'substituted', 'blocked'] },
            reason: { type: 'string' },
          },
          required: ['field', 'action', 'reason'],
        },
      },
      startedAt: { type: 'string' },
      summary: { type: 'string', maxLength: 4096 },
      artifacts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            kind: { type: 'string', enum: ['file', 'report', 'validation'] },
          },
          required: ['path', 'kind'],
        },
      },
      generatedNodeIds: { type: 'array', items: { type: 'string' } },
      error: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          retryable: { type: 'boolean' },
        },
        required: ['code', 'message', 'retryable'],
      },
      dryRun: { type: 'boolean', description: '只校验和预览，不写文件' },
    },
    required: [
      'filePath', 'nodeId', 'executionId', 'taskKind', 'status', 'session', 'workerId',
    ],
  },
};

export async function handleKmRecordSession(args: RecordSessionInput) {
  const result = await recordSession(args);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}

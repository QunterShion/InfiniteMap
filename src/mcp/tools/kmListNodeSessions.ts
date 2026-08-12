import { listFileSessions, listNodeSessions } from '../services/kmSessionState';

export const kmListNodeSessionsTool = {
  name: 'km_list_node_sessions',
  description:
    '按节点分页查询 InfiniteMap 本地会话历史；Provider 缺失时仍可读取，并标注已删除节点的 orphan 历史',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'KM 文件绝对路径' },
      nodeId: { type: 'string', description: '可选节点 ID；省略时按文件分页返回全部会话' },
      cursor: { type: 'string', description: '上一页返回的 nextCursor' },
      limit: { type: 'number', minimum: 1, maximum: 100, description: '每页数量，默认 20' },
    },
	required: ['filePath'],
  },
};

export async function handleKmListNodeSessions(args: {
  filePath: string;
  nodeId?: string;
  cursor?: string;
  limit?: number;
}) {
  const result = args.nodeId
	? await listNodeSessions(args.filePath, args.nodeId, args.cursor, args.limit)
	: await listFileSessions(args.filePath, args.cursor, args.limit);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}

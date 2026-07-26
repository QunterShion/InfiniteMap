/**
 * km_claim_todos 工具：为执行者认领一批叶子待办并写入租约
 */
import { claimTodos } from '../services/kmExecState';

export const kmClaimTodosTool = {
  name: 'km_claim_todos',
  description:
    '认领一批"待拆解"叶子节点：在旁车执行状态中写入租约并返回 claimId 与节点快照哈希。只认领叶子待办（子树中不再有待拆解），已被有效租约认领的节点不会重复分派',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'KM 文件的绝对路径',
      },
      workerId: {
        type: 'string',
        description: '执行者标识，续租与冲突提示都会使用该标识',
      },
      limit: {
        type: 'number',
        minimum: 1,
        description: '未指定 nodeIds 时最多认领的叶子待办数量，默认 5',
      },
      nodeIds: {
        type: 'array',
        items: { type: 'string' },
        description: '可选，指定要认领的节点 ID；任一节点不可认领时整体失败',
      },
      leaseSeconds: {
        type: 'number',
        minimum: 1,
        description: '租约时长（秒），默认 600；过期后任务自动回到待认领状态',
      },
      expectedKmRevision: {
        type: 'string',
        description: '可选，km_list_todos 返回的 kmRevision；版本不一致时拒绝认领',
      },
    },
    required: ['filePath', 'workerId'],
  },
};

export function handleKmClaimTodos(args: {
  filePath: string;
  workerId: string;
  limit?: number;
  nodeIds?: string[];
  leaseSeconds?: number;
  expectedKmRevision?: string;
}) {
  const result = claimTodos(args.filePath, args.workerId, {
    limit: args.limit,
    nodeIds: args.nodeIds,
    leaseSeconds: args.leaseSeconds,
    expectedKmRevision: args.expectedKmRevision,
  });
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

/** km_claim_collaboration_tasks：为多个独立执行者认领待协同节点。 */
import { claimCollaborationTasks } from '../services/kmCollaborationClaims';

export const kmClaimCollaborationTasksTool = {
  name: 'km_claim_collaboration_tasks',
  description:
    '认领一批"待协同"节点并写入租约，返回 claimId、节点路径和目标子树哈希；已被有效租约认领的节点不会重复分派',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'KM 文件的绝对路径',
      },
      workerId: {
        type: 'string',
        description: '执行者标识，续租、完成与冲突提示使用该标识',
      },
      limit: {
        type: 'number',
        minimum: 1,
        description: '未指定 nodeIds 时最多认领的待协同节点数量，默认 5',
      },
      nodeIds: {
        type: 'array',
        items: { type: 'string' },
        description: '可选，指定要认领的待协同节点；任一节点不可认领时整体失败',
      },
      leaseSeconds: {
        type: 'number',
        minimum: 1,
        description: '租约时长（秒），默认 600；过期后任务自动可重新认领',
      },
      expectedFileRevision: {
        type: 'string',
        description: '可选，km_list_collaboration_tasks 返回的 fileRevision；版本不一致时拒绝认领',
      },
    },
    required: ['filePath', 'workerId'],
  },
};

export async function handleKmClaimCollaborationTasks(args: {
  filePath: string;
  workerId: string;
  limit?: number;
  nodeIds?: string[];
  leaseSeconds?: number;
  expectedFileRevision?: string;
}) {
  const result = await claimCollaborationTasks(args.filePath, args.workerId, {
    limit: args.limit,
    nodeIds: args.nodeIds,
    leaseSeconds: args.leaseSeconds,
    expectedFileRevision: args.expectedFileRevision,
  });
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}

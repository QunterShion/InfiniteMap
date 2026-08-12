/** km_complete_collaboration_claim：原子完成已认领的待协同任务。 */
import { completeCollaborationClaim } from '../services/kmCollaborationClaims';

export const kmCompleteCollaborationClaimTool = {
  name: 'km_complete_collaboration_claim',
  description:
    '完成已认领的待协同任务：锁内校验租约、目标子树哈希和待协同标签，为每个节点追加无标签直接子节点并将父节点标记为"已完成"；支持部分完成和 dry-run',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'KM 文件的绝对路径',
      },
      claimId: {
        type: 'string',
        description: 'km_claim_collaboration_tasks 返回的认领标识',
      },
      tasks: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            nodeId: {
              type: 'string',
              description: '该 claim 中的待协同节点 ID',
            },
            childTexts: {
              type: 'array',
              minItems: 1,
              items: { type: 'string' },
              description: '为该节点生成的无标签直接子节点文本',
            },
          },
          required: ['nodeId', 'childTexts'],
        },
      },
      dryRun: {
        type: 'boolean',
        description: '是否只校验和预览、不写入文件，默认 false',
      },
      executionId: {
        type: 'string',
        description: '可选，已绑定到本批次某一节点的 executionId；提供时原子写入会话终态和 generatedNodeIds',
      },
      summary: { type: 'string', maxLength: 4096 },
    },
    required: ['filePath', 'claimId', 'tasks'],
  },
};

export async function handleKmCompleteCollaborationClaim(args: {
  filePath: string;
  claimId: string;
  tasks: Array<{ nodeId: string; childTexts: string[] }>;
  dryRun?: boolean;
  executionId?: string;
  summary?: string;
}) {
  const result = await completeCollaborationClaim(
    args.filePath,
    args.claimId,
    args.tasks,
    args.dryRun ?? false,
    args.executionId ? { executionId: args.executionId, summary: args.summary } : undefined
  );
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}

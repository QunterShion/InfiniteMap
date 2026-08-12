/**
 * km_release_claim 工具：释放认领或记录失败原因，任务回到待认领状态
 */
import { releaseClaim } from '../services/kmExecState';

export const kmReleaseClaimTool = {
  name: 'km_release_claim',
  description:
    '释放待拆解或待协同认领：不带 failReason 记为 released，带 failReason 记为 failed；两种情况下 KM 节点标签都保持不变，可被重新认领',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'KM 文件的绝对路径',
      },
      claimId: {
        type: 'string',
        description: 'km_claim_todos 或 km_claim_collaboration_tasks 返回的认领标识',
      },
      nodeIds: {
        type: 'array',
        items: { type: 'string' },
        description: '可选，只释放该 claim 中的部分节点；默认释放全部认领节点',
      },
      failReason: {
        type: 'string',
        description: '可选，失败原因；提供时任务状态记为 failed 以便审计',
      },
      executionId: {
        type: 'string',
        description: '可选，已绑定的 executionId；提供时把节点最近会话原子更新为 failed/cancelled',
      },
      dryRun: {
        type: 'boolean',
        description: '只校验释放与会话终态，不写文件',
      },
    },
    required: ['filePath', 'claimId'],
  },
};

export async function handleKmReleaseClaim(args: {
  filePath: string;
  claimId: string;
  nodeIds?: string[];
  failReason?: string;
  executionId?: string;
  dryRun?: boolean;
}) {
  const result = await releaseClaim(args.filePath, args.claimId, {
    nodeIds: args.nodeIds,
    failReason: args.failReason,
    dryRun: args.dryRun,
    sessionUpdate: args.executionId ? { executionId: args.executionId } : undefined,
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

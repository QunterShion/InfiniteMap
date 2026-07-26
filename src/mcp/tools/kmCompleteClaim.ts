/**
 * km_complete_claim 工具：在锁内校验租约与节点快照后完成认领的任务
 */
import { completeClaim } from '../services/kmExecState';

export const kmCompleteClaimTool = {
  name: 'km_complete_claim',
  description:
    '完成认领的任务：锁内校验租约有效、节点仍存在、节点内容与认领时一致且仍为待拆解，全部通过后把节点标签改为"已完成"并原子写回；其他执行者已完成的节点不会被旧快照覆盖。支持 dry-run',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'KM 文件的绝对路径',
      },
      claimId: {
        type: 'string',
        description: 'km_claim_todos 返回的认领标识',
      },
      nodeIds: {
        type: 'array',
        items: { type: 'string' },
        description: '可选，只完成该 claim 中的部分节点；默认完成全部认领节点',
      },
      dryRun: {
        type: 'boolean',
        description: '是否为试运行模式（只校验不写入），默认 false',
      },
    },
    required: ['filePath', 'claimId'],
  },
};

export function handleKmCompleteClaim(args: {
  filePath: string;
  claimId: string;
  nodeIds?: string[];
  dryRun?: boolean;
}) {
  const result = completeClaim(args.filePath, args.claimId, args.nodeIds, args.dryRun ?? false);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

/**
 * km_renew_claim 工具：延长认领租约
 */
import { renewClaim, DEFAULT_LEASE_SECONDS } from '../services/kmExecState';

export const kmRenewClaimTool = {
  name: 'km_renew_claim',
  description:
    '延长认领租约：只能由原 workerId 续租，租约已过期或任务已完成/释放时续租失败',
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
      workerId: {
        type: 'string',
        description: '原认领者标识，必须与认领时一致',
      },
      leaseSeconds: {
        type: 'number',
        minimum: 1,
        description: '新的租约时长（秒），默认 600',
      },
    },
    required: ['filePath', 'claimId', 'workerId'],
  },
};

export function handleKmRenewClaim(args: {
  filePath: string;
  claimId: string;
  workerId: string;
  leaseSeconds?: number;
}) {
  const result = renewClaim(
    args.filePath,
    args.claimId,
    args.workerId,
    args.leaseSeconds ?? DEFAULT_LEASE_SECONDS
  );
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

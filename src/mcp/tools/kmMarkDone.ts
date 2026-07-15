/**
 * km_mark_done 工具：批量将指定节点的 resource 从 待拆解 替换为 已完成
 */
import { markNodesDone } from '../services/kmFileWriter';

export const kmMarkDoneTool = {
  name: 'km_mark_done',
  description: '批量将 KM 文件中指定节点的标签从"待拆解"改为"已完成"，支持 dry-run 试运行模式',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'KM 文件的绝对路径',
      },
      nodeIds: {
        type: 'array',
        items: { type: 'string' },
        description: '要标记为已完成的节点 ID 数组',
      },
      dryRun: {
        type: 'boolean',
        description: '是否为试运行模式（不实际写入文件），默认 false',
      },
    },
    required: ['filePath', 'nodeIds'],
  },
};

export function handleKmMarkDone(args: {
  filePath: string;
  nodeIds: string[];
  dryRun?: boolean;
}) {
  const result = markNodesDone(args.filePath, args.nodeIds, args.dryRun ?? false);
  return {
    content: [
      {
        type: 'text',
        text: args.dryRun
          ? `[DRY RUN] 将修改 ${result.modified} 个节点（未实际写入），文件: ${result.filePath}`
          : `已成功标记 ${result.modified} 个节点为"已完成"，校验${result.verified ? '通过' : '未通过'}。文件: ${result.filePath}`,
      },
    ],
  };
}

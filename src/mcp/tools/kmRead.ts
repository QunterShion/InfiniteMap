/**
 * km_read 工具：读取并解析 KM 文件，返回树结构摘要
 */
import { getKmSummary } from '../services/kmFileReader';

export const kmReadTool = {
  name: 'km_read',
  description: '读取并解析 KM 思维导图文件，返回树结构摘要（节点总数、树深度、根节点文本、待办数量）',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'KM 文件的绝对路径',
      },
    },
    required: ['filePath'],
  },
};

export function handleKmRead(args: { filePath: string }) {
  const summary = getKmSummary(args.filePath);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(summary, null, 2),
      },
    ],
  };
}

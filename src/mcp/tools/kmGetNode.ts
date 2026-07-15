/**
 * km_get_node 工具：按节点 ID 读取单个节点及其完整子树
 */
import { getNodeById, getNodePath } from '../services/kmFileReader';

export const kmGetNodeTool = {
  name: 'km_get_node',
  description: '按节点 ID 读取 KM 文件中指定节点及其完整子树',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'KM 文件的绝对路径',
      },
      nodeId: {
        type: 'string',
        description: '目标节点的 ID',
      },
    },
    required: ['filePath', 'nodeId'],
  },
};

export function handleKmGetNode(args: { filePath: string; nodeId: string }) {
  const node = getNodeById(args.filePath, args.nodeId);
  if (!node) {
    return {
      content: [
        {
          type: 'text',
          text: `未找到节点 ID: ${args.nodeId}`,
        },
      ],
    };
  }
  const nodePath = getNodePath(args.filePath, args.nodeId);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            nodePath,
            node,
          },
          null,
          2
        ),
      },
    ],
  };
}

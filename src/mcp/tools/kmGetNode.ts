/**
 * km_get_node 工具：按节点 ID 读取单个节点及其完整子树
 */
import { getNodeWithPath } from '../services/kmFileReader';

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

export async function handleKmGetNode(args: { filePath: string; nodeId: string }) {
  // 单次读文件同时获取节点与路径，消除原先两次读盘（MCP-P1-02）
  const result = await getNodeWithPath(args.filePath, args.nodeId);
  if (!result) {
    return {
      content: [
        {
          type: 'text',
          text: `未找到节点 ID: ${args.nodeId}`,
        },
      ],
    };
  }
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            nodePath: result.nodePath,
            node: result.node,
          },
          null,
          2
        ),
      },
    ],
  };
}

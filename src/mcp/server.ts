/**
 * KM MCP Server 入口
 * 将 instruction-breakdown-rules.md 第4~6章的 KM 操作能力封装为 MCP 工具
 *
 * 启动方式：
 *   npx ts-node --project tsconfig.mcp.json src/mcp/server.ts
 *   或编译后:
 *   node dist/mcp/server.js
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

// 导入工具处理函数
import { handleKmRead } from './tools/kmRead';
import { handleKmListTodos } from './tools/kmListTodos';
import { handleKmGetNode } from './tools/kmGetNode';
import { handleKmMarkDone } from './tools/kmMarkDone';
import { handleKmValidate } from './tools/kmValidate';

/** 工具清单 */
const tools: Tool[] = [
  {
    name: 'km_read',
    description: '读取并解析 KM 思维导图文件，返回树结构摘要（节点总数、树深度、根节点文本、待办数量）',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'KM 文件的绝对路径' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'km_list_todos',
    description: '列出 KM 文件中所有标记为"待拆解"的节点，返回节点路径、文本、层级和父级上下文',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'KM 文件的绝对路径' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'km_get_node',
    description: '按节点 ID 读取 KM 文件中指定节点及其完整子树',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'KM 文件的绝对路径' },
        nodeId: { type: 'string', description: '目标节点的 ID' },
      },
      required: ['filePath', 'nodeId'],
    },
  },
  {
    name: 'km_mark_done',
    description: '批量将 KM 文件中指定节点的标签从"待拆解"改为"已完成"，支持 dry-run 试运行模式',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'KM 文件的绝对路径' },
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
  },
  {
    name: 'km_validate',
    description: '校验 KM 文件的 JSON 合法性、节点 ID 唯一性和标签一致性',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'KM 文件的绝对路径' },
      },
      required: ['filePath'],
    },
  },
];

const toolHandlers: Record<string, (args: any) => any> = {
  km_read: handleKmRead,
  km_list_todos: handleKmListTodos,
  km_get_node: handleKmGetNode,
  km_mark_done: handleKmMarkDone,
  km_validate: handleKmValidate,
};

/**
 * 创建并启动 MCP Server
 */
export async function startServer() {
  const server = new Server(
    {
      name: 'km-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // 注册工具列表
  server.setRequestHandler(
    ListToolsRequestSchema,
    async () => {
      return { tools };
    }
  );

  // 注册工具调用处理
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: any) => {
      const toolName = request.params.name;
      const handler = toolHandlers[toolName];

      if (!handler) {
        throw new Error(`未知的工具: ${toolName}`);
      }

      return handler(request.params.arguments || {});
    }
  );

  // 使用 stdio 传输
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('KM MCP Server 已启动 (stdio)');
}

// 直接运行时启动服务器
startServer().catch((err: any) => {
  console.error('KM MCP Server 启动失败:', err);
  process.exit(1);
});

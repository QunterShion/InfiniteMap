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
import { handleKmListCollaborationTasks } from './tools/kmListCollaborationTasks';
import { handleKmGetCollaborationContext } from './tools/kmGetCollaborationContext';
import { handleKmExpandCollaboration } from './tools/kmExpandCollaboration';
import { kmClaimTodosTool, handleKmClaimTodos } from './tools/kmClaimTodos';
import { kmRenewClaimTool, handleKmRenewClaim } from './tools/kmRenewClaim';
import { kmCompleteClaimTool, handleKmCompleteClaim } from './tools/kmCompleteClaim';
import { kmReleaseClaimTool, handleKmReleaseClaim } from './tools/kmReleaseClaim';

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
    description: '列出 KM 文件中所有标记为"待拆解"的节点，返回节点路径、文本、层级、父级上下文和文件版本 kmRevision',
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
    description: '批量将 KM 文件中指定节点的标签从"待拆解"改为"已完成"，支持 dry-run 试运行模式；可传入 expectedRevision 检测并发修改冲突',
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
        expectedRevision: {
          type: 'string',
          description: '可选，由 km_list_todos 返回的文件版本 kmRevision；传入时若文件已被并发修改则拒绝写入',
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
  {
    name: 'km_list_collaboration_tasks',
    description: '从最新 KM 文件中列出所有标记为"待协同"的节点，并返回文件版本和根路径上下文',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'KM 文件的绝对路径' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'km_get_collaboration_context',
    description: '读取待协同节点的根到目标链路、完整子树和必要同级上下文，并返回最新文件版本',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'KM 文件的绝对路径' },
        nodeId: { type: 'string', description: '目标待协同节点 ID' },
        siblingLimit: {
          type: 'number',
          minimum: 0,
          maximum: 50,
          description: '最多返回的同级上下文节点数，默认 8',
        },
      },
      required: ['filePath', 'nodeId'],
    },
  },
  {
    name: 'km_expand_collaboration',
    description: '在待协同节点下扩散生成无标签子节点，并将父节点标记为已完成；支持版本校验和 dry-run',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'KM 文件的绝对路径' },
        nodeId: { type: 'string', description: '目标待协同节点 ID' },
        expectedRevision: {
          type: 'string',
          description: '由最新协同清单或上下文返回的文件版本',
        },
        childTexts: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: '要扩散生成的直接子节点文本数组，生成节点不带标签',
        },
        dryRun: {
          type: 'boolean',
          description: '是否为试运行模式（不实际写入文件），默认 false',
        },
      },
      required: ['filePath', 'nodeId', 'expectedRevision', 'childTexts'],
    },
  },
  kmClaimTodosTool as Tool,
  kmRenewClaimTool as Tool,
  kmCompleteClaimTool as Tool,
  kmReleaseClaimTool as Tool,
];

const toolHandlers: Record<string, (args: any) => any> = {
  km_read: handleKmRead,
  km_list_todos: handleKmListTodos,
  km_get_node: handleKmGetNode,
  km_mark_done: handleKmMarkDone,
  km_validate: handleKmValidate,
  km_list_collaboration_tasks: handleKmListCollaborationTasks,
  km_claim_todos: handleKmClaimTodos,
  km_renew_claim: handleKmRenewClaim,
  km_complete_claim: handleKmCompleteClaim,
  km_release_claim: handleKmReleaseClaim,
  km_get_collaboration_context: handleKmGetCollaborationContext,
  km_expand_collaboration: handleKmExpandCollaboration,
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
      instructions:
        'All .km reads, task discovery, node inspection, validation, and writes must use these MCP tools. Never read or write .km files through shell or filesystem APIs. Always pass an absolute filePath and reread the current file for every new request. When the user only provides a .km path, discover pending breakdown and collaboration tasks first. Before km_mark_done or km_expand_collaboration, validate the file and run dryRun. When writing back with km_mark_done, pass the kmRevision returned by km_list_todos as expectedRevision so concurrent modifications are rejected instead of silently overwritten. For collaboration, read the latest context, pass its fileRevision as expectedRevision, generate unlabeled child nodes, then validate and list tasks again. For parallel execution by multiple independent workers, use the lease workflow instead of km_mark_done: km_claim_todos to claim leaf todos (returns claimId), km_renew_claim to extend the lease during long work, km_complete_claim to verify-and-complete atomically, and km_release_claim to give tasks back (optionally with failReason). Nodes claimed under an active lease are protected from km_mark_done.',
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

/**
 * km_list_todos 工具：筛选所有 resource 包含 待拆解 的节点
 */
import { listTodos } from '../services/kmFileReader';

export const kmListTodosTool = {
  name: 'km_list_todos',
  description: '列出 KM 文件中所有标记为"待拆解"的节点，返回节点路径、文本、层级和父级上下文',
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

export function handleKmListTodos(args: { filePath: string }) {
  const todos = listTodos(args.filePath);
  return {
    content: [
      {
        type: 'text',
        text: todos.length === 0
          ? '该 KM 文件中没有"待拆解"节点。'
          : JSON.stringify(todos, null, 2),
      },
    ],
  };
}

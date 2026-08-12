/**
 * km_list_todos 工具：筛选所有 resource 包含 待拆解 的节点，
 * 返回文件版本，并标注叶子待办与租约认领状态
 */
import { listTodosWithRevisionAndDoc } from '../services/kmFileReader';
import { readExecState, isLeaseActive, collectLeafTodos } from '../services/kmExecState';

export const kmListTodosTool = {
  name: 'km_list_todos',
  description:
    '列出 KM 文件中所有标记为"待拆解"的节点，返回节点路径、文本、层级、父级上下文、文件版本 kmRevision，并标注叶子待办（isLeaf）与认领状态（execState）',
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

export async function handleKmListTodos(args: { filePath: string }) {
  // 单次读文件拿到 todos + doc，避免 collectLeafTodos 再次读盘（MCP-P1-02）
  const { doc, ...todoList } = await listTodosWithRevisionAndDoc(args.filePath);
  const execState = await readExecState(todoList.filePath);
  const leafIds = new Set((await collectLeafTodos(todoList.filePath, doc)).map((leaf) => leaf.nodeId));

  const todos = todoList.todos.map((todo) => {
    const entry = execState.tasks[todo.nodeId];
    const claimed = isLeaseActive(entry);
    return {
      ...todo,
      isLeaf: leafIds.has(todo.nodeId),
      execState: claimed ? 'claimed' : 'pending',
      ...(claimed
        ? { claimedBy: entry!.workerId, leaseUntil: entry!.leaseUntil }
        : {}),
    };
  });

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ...todoList, todos }, null, 2),
      },
    ],
  };
}

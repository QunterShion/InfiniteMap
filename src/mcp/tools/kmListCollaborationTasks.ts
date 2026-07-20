/**
 * km_list_collaboration_tasks 工具：从最新文件中筛选所有 resource 包含 待协同 的节点
 */
import { listCollaborationTasks } from '../services/kmFileReader';

export function handleKmListCollaborationTasks(args: { filePath: string }) {
  const result = listCollaborationTasks(args.filePath);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}
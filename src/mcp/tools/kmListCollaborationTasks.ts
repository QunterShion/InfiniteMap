/**
 * km_list_collaboration_tasks 工具：从最新文件中筛选所有 resource 包含 待协同 的节点
 */
import { listCollaborationTasks } from '../services/kmFileReader';
import { isLeaseActive, readExecState } from '../services/kmExecState';

export function handleKmListCollaborationTasks(args: { filePath: string }) {
  const result = listCollaborationTasks(args.filePath);
  const execState = readExecState(result.filePath);
  const tasks = result.tasks.map((task) => {
    const entry = execState.tasks[task.nodeId];
    const claimed = isLeaseActive(entry);
    return {
      ...task,
      execState: claimed ? 'claimed' : 'pending',
      ...(claimed
        ? {
            claimedBy: entry!.workerId,
            leaseUntil: entry!.leaseUntil,
            claimKind: entry!.taskKind || 'todo',
          }
        : {}),
    };
  });
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ...result, tasks }, null, 2),
      },
    ],
  };
}

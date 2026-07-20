/**
 * km_expand_collaboration 工具：扩散生成无标签子节点并完成待协同父节点
 */
import { expandCollaborationTask } from '../services/kmFileWriter';

export function handleKmExpandCollaboration(args: {
  filePath: string;
  nodeId: string;
  expectedRevision: string;
  childTexts: string[];
  dryRun?: boolean;
}) {
  const result = expandCollaborationTask(
    args.filePath,
    args.nodeId,
    args.expectedRevision,
    args.childTexts,
    args.dryRun ?? false
  );
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}
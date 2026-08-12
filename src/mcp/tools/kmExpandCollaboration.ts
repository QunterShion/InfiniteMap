/**
 * km_expand_collaboration 工具：扩散生成无标签子节点并完成待协同父节点
 */
import { expandCollaborationTask } from '../services/kmFileWriter';

export async function handleKmExpandCollaboration(args: {
  filePath: string;
  nodeId: string;
  expectedRevision: string;
  childTexts: string[];
  dryRun?: boolean;
  executionId?: string;
  summary?: string;
}) {
  const result = await expandCollaborationTask(
    args.filePath,
    args.nodeId,
    args.expectedRevision,
    args.childTexts,
    args.dryRun ?? false,
    args.executionId ? { executionId: args.executionId, summary: args.summary } : undefined
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

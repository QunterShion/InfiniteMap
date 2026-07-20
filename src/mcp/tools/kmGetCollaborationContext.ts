/**
 * km_get_collaboration_context 工具：读取待协同节点的完整协同上下文
 */
import { getCollaborationContext } from '../services/kmFileReader';

export function handleKmGetCollaborationContext(args: {
  filePath: string;
  nodeId: string;
  siblingLimit?: number;
}) {
  const result = getCollaborationContext(
    args.filePath,
    args.nodeId,
    args.siblingLimit ?? 8
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
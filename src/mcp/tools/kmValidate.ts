/**
 * km_validate 工具：校验 KM 文件的 JSON 合法性、节点 ID 唯一性、标签一致性
 */
import { validateKmFile } from '../services/kmFileWriter';

export const kmValidateTool = {
  name: 'km_validate',
  description: '校验 KM 文件的 JSON 合法性、节点 ID 唯一性和标签一致性',
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

export async function handleKmValidate(args: { filePath: string }) {
  const result = await validateKmFile(args.filePath);

  let summary = '';
  if (result.valid) {
    summary = '✅ KM 文件校验通过，无错误。';
  } else {
    summary = `❌ KM 文件校验未通过，发现 ${result.errors.length} 个错误。`;
  }

  const details: Record<string, string[]> = {};
  if (result.errors.length > 0) {
    details['错误'] = result.errors;
  }
  if (result.warnings.length > 0) {
    details['警告'] = result.warnings;
  }

  return {
    content: [
      {
        type: 'text',
        text: `${summary}\n\n${JSON.stringify(details, null, 2)}`,
      },
    ],
  };
}

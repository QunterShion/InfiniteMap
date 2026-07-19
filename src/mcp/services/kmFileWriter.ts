/**
 * KM 文件安全写回服务
 * 负责将修改后的 KM JSON 写回磁盘，带备份和校验机制
 */

import * as fs from 'fs';
import * as path from 'path';
import { readKmFile, countNodes, getTreeDepth, KmDocument, KmNode } from './kmFileReader';

/** 写回结果 */
export interface WriteResult {
  modified: number;
  filePath: string;
  verified: boolean;
  backupPath?: string;
}

/**
 * 安全地写入 KM 文件（带备份）
 */
function safeWriteFile(filePath: string, content: string): void {
  const backupPath = filePath + '.backup';

  // 1. 备份原文件
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
  }

  try {
    // 2. 写入新内容
    fs.writeFileSync(filePath, content, 'utf-8');

    // 3. 校验写入后的 JSON 合法性
    const verifyRaw = fs.readFileSync(filePath, 'utf-8');
    JSON.parse(verifyRaw);

    // 4. 校验通过，删除备份
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }
  } catch (e) {
    // 写入失败，从备份恢复
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, filePath);
      fs.unlinkSync(backupPath);
    }
    throw new Error(`文件写入失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 批量标记节点为已完成
 * @param filePath KM 文件路径
 * @param nodeIds 要标记的节点 ID 数组
 * @param dryRun 是否为试运行模式（不实际写入）
 */
export function markNodesDone(
  filePath: string,
  nodeIds: string[],
  dryRun: boolean = false
): WriteResult {
  const resolved = path.resolve(filePath);
  const before = fs.statSync(resolved);
  const doc = readKmFile(resolved);
  let modified = 0;

  function process(node: KmNode): boolean {
    let nodeModified = false;

    if (nodeIds.includes(node.data.id)) {
      const resources = node.data.resource || [];
      // 移除待拆解，添加已完成
      const newResources = resources
        .filter((r) => r !== '待拆解')
        .concat('已完成');
      // 去重
      node.data.resource = [...new Set(newResources)];
      modified++;
      nodeModified = true;
    }

    if (node.children) {
      for (const child of node.children) {
        if (process(child)) {
          nodeModified = true;
        }
      }
    }
    return nodeModified;
  }

  process(doc.root);

  if (modified === 0) {
    return {
      modified: 0,
      filePath: resolved,
      verified: true,
    };
  }

  if (!dryRun) {
    const content = JSON.stringify(doc, null, 4);
    safeWriteFile(resolved, content);
  }

  // 校验
  const after = fs.statSync(resolved);
  let verified = false;
  try {
    const verifyDoc = readKmFile(resolved);
    // 验证修改已生效
    let verifyCount = 0;
    function verify(node: KmNode): void {
      if (nodeIds.includes(node.data.id)) {
        const resources = node.data.resource || [];
        if (resources.includes('已完成') && !resources.includes('待拆解')) {
          verifyCount++;
        }
      }
      if (node.children) {
        for (const child of node.children) {
          verify(child);
        }
      }
    }
    verify(verifyDoc.root);
    verified = verifyCount === modified;
  } catch {
    verified = false;
  }

  return {
    modified,
    filePath: resolved,
    verified,
  };
}

/**
 * 校验 KM 文件的 JSON 合法性、节点 ID 唯一性、标签一致性
 */
export function validateKmFile(filePath: string): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();

  try {
    const doc = readKmFile(filePath);
    const totalNodes = countNodes(doc);

    // 检查节点 ID 唯一性
    function checkIds(node: KmNode): void {
      if (node.data?.id) {
        if (ids.has(node.data.id)) {
          errors.push(`重复的节点 ID: ${node.data.id} (节点: ${node.data.text})`);
        }
        ids.add(node.data.id);
      }

      // 检查标签一致性
      const resources = node.data.resource || [];
      if (resources.includes('待拆解') && resources.includes('已完成')) {
        errors.push(
          `节点标签冲突: "${node.data.text}" 同时包含"待拆解"和"已完成"`
        );
      }

      if (node.children) {
        for (const child of node.children) {
          checkIds(child);
        }
      }
    }

    checkIds(doc.root);

    if (totalNodes === 0) {
      warnings.push('KM 文件仅包含根节点，无子节点');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  } catch (e) {
    return {
      valid: false,
      errors: [`文件校验异常: ${e instanceof Error ? e.message : String(e)}`],
      warnings: [],
    };
  }
}

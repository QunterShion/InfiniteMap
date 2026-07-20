/**
 * KM 文件安全写回服务
 * 负责将修改后的 KM JSON 写回磁盘，带备份和校验机制
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  readKmFile,
  countNodes,
  getKmFileRevision,
  KmDocument,
  KmNode,
  KM_COLLABORATION_LABEL,
  KM_DONE_LABEL,
  KM_TODO_LABEL,
} from './kmFileReader';

/** 写回结果 */
export interface WriteResult {
  modified: number;
  filePath: string;
  verified: boolean;
  backupPath?: string;
}

/** 协同扩散生成的子节点摘要 */
export interface ExpandedChildNode {
  nodeId: string;
  text: string;
}

/** 协同任务扩散写回结果 */
export interface ExpandCollaborationResult {
  filePath: string;
  dryRun: boolean;
  revisionBefore: string;
  revisionAfter: string;
  appendedCount: number;
  appendedChildren: ExpandedChildNode[];
  parentCompleted: boolean;
  verified: boolean;
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

function collectNodeIds(node: KmNode, ids: Set<string>): void {
  ids.add(node.data.id);
  if (node.children) {
    for (const child of node.children) {
      collectNodeIds(child, ids);
    }
  }
}

function findNode(node: KmNode, nodeId: string): KmNode | null {
  if (node.data.id === nodeId) {
    return node;
  }

  if (node.children) {
    for (const child of node.children) {
      const found = findNode(child, nodeId);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

function createUniqueNodeId(existingIds: Set<string>): string {
  let candidate = '';
  do {
    candidate = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  } while (existingIds.has(candidate));

  existingIds.add(candidate);
  return candidate;
}

function completeNodeByLabel(node: KmNode, labelToRemove: string): void {
  const resources = node.data.resource || [];
  const newResources = resources
    .filter((resource) => resource !== labelToRemove)
    .concat(KM_DONE_LABEL);

  node.data.resource = [...new Set(newResources)];
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
        .filter((r) => r !== KM_TODO_LABEL)
        .concat(KM_DONE_LABEL);
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
        if (resources.includes(KM_DONE_LABEL) && !resources.includes(KM_TODO_LABEL)) {
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
 * 在待协同节点下扩散生成直接子节点，并原子地将父节点标记为已完成
 * @param filePath KM 文件路径
 * @param nodeId 目标待协同节点 ID
 * @param expectedRevision 调用方读取上下文时获得的文件版本
 * @param childTexts 要生成的直接子节点文本
 * @param dryRun 是否为试运行模式（不实际写入）
 */
export function expandCollaborationTask(
  filePath: string,
  nodeId: string,
  expectedRevision: string,
  childTexts: string[],
  dryRun: boolean = false
): ExpandCollaborationResult {
  const resolved = path.resolve(filePath);
  const expected = (expectedRevision || '').trim();
  if (!expected) {
    throw new Error('expectedRevision 不能为空，必须先读取最新协同上下文');
  }
  if (!Array.isArray(childTexts) || childTexts.length === 0) {
    throw new Error('childTexts 必须至少包含一个子节点文本');
  }

  const normalizedChildTexts = childTexts.map((text) => text.trim());
  const emptyIndex = normalizedChildTexts.findIndex((text) => text.length === 0);
  if (emptyIndex >= 0) {
    throw new Error(`childTexts[${emptyIndex}] 不能为空`);
  }

  const revisionBefore = getKmFileRevision(resolved);
  if (revisionBefore !== expected) {
    throw new Error(
      `KM 文件版本已变化，请重新读取最新上下文。expected=${expected}, actual=${revisionBefore}`
    );
  }

  const doc = readKmFile(resolved);
  const existingIds = new Set<string>();
  collectNodeIds(doc.root, existingIds);
  const target = findNode(doc.root, nodeId);

  if (!target) {
    throw new Error(`未找到节点 ID: ${nodeId}`);
  }

  const targetResources = target.data.resource || [];
  if (
    !targetResources.includes(KM_COLLABORATION_LABEL) ||
    targetResources.includes(KM_DONE_LABEL)
  ) {
    throw new Error(`节点不是有效的"${KM_COLLABORATION_LABEL}"任务: ${nodeId}`);
  }

  if (!target.children) {
    target.children = [];
  }

  const createdAt = Date.now();
  const childNodes = normalizedChildTexts.map((text, index) => {
    const id = createUniqueNodeId(existingIds);
    return {
      data: {
        id,
        created: createdAt + index,
        text,
      },
      children: [],
    };
  });
  const appendedChildren = childNodes.map((child) => ({
    nodeId: child.data.id,
    text: child.data.text,
  }));

  target.children.push(...childNodes);
  completeNodeByLabel(target, KM_COLLABORATION_LABEL);

  let revisionAfter = revisionBefore;
  let verified = true;

  if (!dryRun) {
    const content = JSON.stringify(doc, null, 4);
    safeWriteFile(resolved, content);
    revisionAfter = getKmFileRevision(resolved);

    const verifyDoc = readKmFile(resolved);
    const verifyTarget = findNode(verifyDoc.root, nodeId);
    if (!verifyTarget) {
      verified = false;
    } else {
      const verifyResources = verifyTarget.data.resource || [];
      const generatedChildren = verifyTarget.children || [];
      verified =
        verifyResources.includes(KM_DONE_LABEL) &&
        !verifyResources.includes(KM_COLLABORATION_LABEL) &&
        appendedChildren.every((child) => {
          const persisted = generatedChildren.find((node) => node.data.id === child.nodeId);
          return Boolean(
            persisted &&
            persisted.data.text === child.text &&
            !persisted.data.resource
          );
        });
    }
  }

  return {
    filePath: resolved,
    dryRun,
    revisionBefore,
    revisionAfter,
    appendedCount: appendedChildren.length,
    appendedChildren,
    parentCompleted: true,
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
      if (resources.includes(KM_TODO_LABEL) && resources.includes(KM_DONE_LABEL)) {
        errors.push(
          `节点标签冲突: "${node.data.text}" 同时包含"${KM_TODO_LABEL}"和"${KM_DONE_LABEL}"`
        );
      }
      if (resources.includes(KM_COLLABORATION_LABEL) && resources.includes(KM_DONE_LABEL)) {
        errors.push(
          `节点标签冲突: "${node.data.text}" 同时包含"${KM_COLLABORATION_LABEL}"和"${KM_DONE_LABEL}"`
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

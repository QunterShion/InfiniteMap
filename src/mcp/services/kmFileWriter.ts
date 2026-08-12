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
  buildNodeIndex,
  KmDocument,
  KmNode,
  KM_COLLABORATION_LABEL,
  KM_DONE_LABEL,
  KM_TODO_LABEL,
} from './kmFileReader';
import {
  atomicWriteJsonFile,
  withKmFileLock,
  readExecState,
  writeExecState,
  isLeaseActive,
  getExecStatePath,
} from './kmExecState';
import {
  commitTerminalSessionUpdate,
  prepareTerminalSessionUpdate,
  SessionArtifact,
} from './kmSessionState';

/** 写回结果 */
export interface WriteResult {
  modified: number;
  filePath: string;
  verified: boolean;
  backupPath?: string;
  revisionBefore?: string;
  revisionAfter?: string;
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
 * 安全地写入 KM 文件：临时文件写入 + JSON 校验 + 原子 rename 替换，
 * 避免并发读取方读到半文件
 */
async function safeWriteFile(filePath: string, content: string): Promise<void> {
  await atomicWriteJsonFile(filePath, content);
}

/**
 * 若旁车执行状态存在，把本次完成的节点同步为 done，并刷新旁车中的文件版本
 */
async function syncExecStateAfterWrite(
  filePath: string,
  completedNodeIds: string[],
  completedBy: 'claim' | 'legacy',
  /** 调用方在 safeWriteFile 之后已读取一次的版本，传入可省去内部重复读盘 */
  knownRevision?: string
): Promise<void> {
  if (!fs.existsSync(getExecStatePath(filePath))) {
    return;
  }
  const execState = await readExecState(filePath);
  const nowIso = new Date().toISOString();
  let touched = false;

  for (const nodeId of completedNodeIds) {
    const entry = execState.tasks[nodeId];
    if (entry && entry.state !== 'done') {
      entry.state = 'done';
      entry.doneAt = nowIso;
      entry.completedBy = completedBy;
      touched = true;
    }
  }

  // 优先使用调用方已计算的版本，避免重复读盘
  const latestRevision = knownRevision ?? await getKmFileRevision(filePath);
  if (execState.kmRevision !== latestRevision) {
    execState.kmRevision = latestRevision;
    touched = true;
  }
  if (touched) {
    await writeExecState(filePath, execState);
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
 * @param expectedRevision 可选，由 km_list_todos 返回的文件版本；传入时不匹配即拒绝写入
 */
export async function markNodesDone(
  filePath: string,
  nodeIds: string[],
  dryRun: boolean = false,
  expectedRevision?: string,
  sessionUpdate?: { executionId: string; summary?: string; artifacts?: SessionArtifact[] }
): Promise<WriteResult> {
  const resolved = path.resolve(filePath);
  return withKmFileLock(resolved, () =>
    markNodesDoneLocked(resolved, nodeIds, dryRun, expectedRevision, sessionUpdate)
  );
}

/** markNodesDone 的锁内实现：所有校验和写入都基于锁内重新读取的文件 */
async function markNodesDoneLocked(
  resolved: string,
  nodeIds: string[],
  dryRun: boolean,
  expectedRevision?: string,
  sessionUpdate?: { executionId: string; summary?: string; artifacts?: SessionArtifact[] }
): Promise<WriteResult> {
  const revisionBefore = await getKmFileRevision(resolved);

  if (expectedRevision !== undefined) {
    const expected = expectedRevision.trim();
    if (!expected) {
      throw new Error('expectedRevision 不能为空字符串，应传入 km_list_todos 返回的 kmRevision');
    }
    if (revisionBefore !== expected) {
      throw new Error(
        `KM 文件版本已变化，请重新调用 km_list_todos 获取最新清单后再回写。expected=${expected}, actual=${revisionBefore}`
      );
    }
  }

  // 活跃租约保护：目标节点被其他执行者认领且租约未过期时，禁止绕过 claim 直接回写
  const execState = await readExecState(resolved);
  for (const nodeId of nodeIds) {
    const entry = execState.tasks[nodeId];
    if (isLeaseActive(entry)) {
      throw new Error(
        `节点已被 ${entry!.workerId} 认领且租约未过期，请由认领者通过 km_complete_claim 完成，或先 km_release_claim 释放: ${nodeId}`
      );
    }
  }

  const doc = await readKmFile(resolved);
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

  const preparedSession = sessionUpdate
    ? await prepareTerminalSessionUpdate(resolved, doc, { ...sessionUpdate, status: 'completed' })
    : undefined;
  if (preparedSession && !nodeIds.includes(preparedSession.nodeId)) {
    throw new Error(`executionId 对应节点不属于本次完成目标: ${preparedSession.nodeId}`);
  }

  if (modified === 0) {
    // 没有节点被修改 → 目标节点不存在或不携带待拆解标签，向调用方报错
    const err = new Error(
      `指定的节点 ID 均未找到待拆解标签，未作任何修改: [${nodeIds.join(', ')}]`
    ) as Error & { code: string };
    err.code = 'NODE_NOT_FOUND';
    throw err;
  }

  // 写后只读一次 revision，后续传入各下游避免重复读盘
  let revisionAfterWrite: string | undefined;
  if (!dryRun) {
    const content = JSON.stringify(doc, null, 4);
    await safeWriteFile(resolved, content);
    revisionAfterWrite = await getKmFileRevision(resolved);
    await syncExecStateAfterWrite(resolved, nodeIds, 'legacy', revisionAfterWrite);
    if (preparedSession) {
      await commitTerminalSessionUpdate(resolved, preparedSession, revisionAfterWrite);
    }
  }

  // 校验：直接在内存文档上验证，无需写后重新读盘（原子写成功则落盘与内存一致）
  let verified = false;
  try {
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
    verify(doc.root);
    verified = verifyCount === modified;
  } catch {
    verified = false;
  }

  return {
    modified,
    filePath: resolved,
    verified,
    revisionBefore,
    revisionAfter: dryRun ? revisionBefore : revisionAfterWrite!,
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
export async function expandCollaborationTask(
  filePath: string,
  nodeId: string,
  expectedRevision: string,
  childTexts: string[],
  dryRun: boolean = false,
  sessionUpdate?: { executionId: string; summary?: string; artifacts?: SessionArtifact[] }
): Promise<ExpandCollaborationResult> {
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

  // 版本校验与写入在同一把文件锁内完成，消除”校验通过后被并发写入”的竞态窗口
  return withKmFileLock(resolved, async () => {
  const revisionBefore = await getKmFileRevision(resolved);
  if (revisionBefore !== expected) {
    throw new Error(
      `KM 文件版本已变化，请重新读取最新上下文。expected=${expected}, actual=${revisionBefore}`
    );
  }

  const execState = await readExecState(resolved);
  const activeEntry = execState.tasks[nodeId];
  if (isLeaseActive(activeEntry)) {
    throw new Error(
      `协同节点已被 ${activeEntry!.workerId} 认领且租约未过期，请由认领者通过 km_complete_collaboration_claim 完成，或先 km_release_claim 释放: ${nodeId}`
    );
  }

  const doc = await readKmFile(resolved);
  // 用索引替代 collectNodeIds + findNode 两次 DFS，只遍历一次（MCP-P1-04）
  const nodeIndex = buildNodeIndex(doc);
  const existingIds = new Set(nodeIndex.keys());
  const target = nodeIndex.get(nodeId) ?? null;

  if (!target) {
    throw new Error(`未找到节点 ID: ${nodeId}`);
  }

  const targetResources = target.data.resource || [];
  if (
    !targetResources.includes(KM_COLLABORATION_LABEL) ||
    targetResources.includes(KM_DONE_LABEL)
  ) {
    throw new Error(`节点不是有效的”${KM_COLLABORATION_LABEL}”任务: ${nodeId}`);
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
        ...(sessionUpdate ? { infiniteMap: { schemaVersion: 1 as const, originExecutionId: sessionUpdate.executionId } } : {}),
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
  const preparedSession = sessionUpdate
    ? await prepareTerminalSessionUpdate(resolved, doc, {
        ...sessionUpdate,
        nodeId,
        status: 'completed',
        generatedNodeIds: appendedChildren.map((child) => child.nodeId),
      })
    : undefined;

  let revisionAfter = revisionBefore;
  let verified = true;

  if (!dryRun) {
    const content = JSON.stringify(doc, null, 4);
    await safeWriteFile(resolved, content);
    // 写后只读一次 revision，传入下游避免重复读盘
    revisionAfter = await getKmFileRevision(resolved);
    await syncExecStateAfterWrite(resolved, [nodeId], 'legacy', revisionAfter);
    if (preparedSession) {
      await commitTerminalSessionUpdate(resolved, preparedSession, revisionAfter);
    }

    // 校验：在内存 doc 上验证，无需重新读盘（原子写成功则落盘与内存一致）
    const verifyTarget = nodeIndex.get(nodeId) ?? null;
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
  });
}

/**
 * 校验 KM 文件的 JSON 合法性、节点 ID 唯一性、标签一致性
 */
export async function validateKmFile(filePath: string): Promise<{
  valid: boolean;
  errors: string[];
  warnings: string[];
}> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();

  try {
    const doc = await readKmFile(filePath);
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

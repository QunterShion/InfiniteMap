/**
 * 待协同任务并行租约服务。
 *
 * 多个执行者可以先认领互不相同的待协同节点并并行生成 childTexts，
 * 完成时仅校验目标节点完整子树哈希，因此无关节点先写回不会造成冲突。
 */

import * as crypto from 'crypto';
import * as path from 'path';
import {
  getKmFileRevision,
  KmDocument,
  KmNode,
  KM_COLLABORATION_LABEL,
  KM_DONE_LABEL,
  readKmFile,
} from './kmFileReader';
import {
  atomicWriteJsonFile,
  DEFAULT_CLAIM_LIMIT,
  DEFAULT_LEASE_SECONDS,
  getSubtreeHash,
  isLeaseActive,
  readExecState,
  withKmFileLock,
  writeExecState,
} from './kmExecState';
import {
  commitTerminalSessionUpdate,
  prepareTerminalSessionUpdate,
  readSessionState,
  SessionArtifact,
} from './kmSessionState';

interface CollaborationCandidate {
  nodeId: string;
  text: string;
  path: string;
  node: KmNode;
}

export interface CollaborationClaimResult {
  filePath: string;
  fileRevision: string;
  claimId: string | null;
  workerId: string;
  leaseUntil: string | null;
  claimedCount: number;
  tasks: Array<{
    nodeId: string;
    text: string;
    path: string;
    baseSubtreeHash: string;
  }>;
}

export interface CollaborationCompletionInput {
  nodeId: string;
  childTexts: string[];
}

export interface CollaborationCompletionResult {
  filePath: string;
  dryRun: boolean;
  completedCount: number;
  appendedCount: number;
  revisionBefore: string;
  revisionAfter: string;
  tasks: Array<{
    nodeId: string;
    appendedCount: number;
    appendedChildren: Array<{ nodeId: string; text: string }>;
    parentCompleted: boolean;
  }>;
  verified: boolean;
}

function isCollaborationNode(node: KmNode): boolean {
  const resources = node.data.resource || [];
  return (
    resources.includes(KM_COLLABORATION_LABEL) &&
    !resources.includes(KM_DONE_LABEL)
  );
}

function collectCollaborationCandidates(doc: KmDocument): CollaborationCandidate[] {
  const candidates: CollaborationCandidate[] = [];

  function traverse(node: KmNode, segments: string[]): void {
    const currentPath = [...segments, node.data.text];
    if (isCollaborationNode(node)) {
      candidates.push({
        nodeId: node.data.id,
        text: node.data.text,
        path: currentPath.join(' > '),
        node,
      });
    }
    for (const child of node.children || []) {
      traverse(child, currentPath);
    }
  }

  traverse(doc.root, []);
  return candidates;
}

function indexNodes(node: KmNode, index: Map<string, KmNode>, ids: Set<string>): void {
  index.set(node.data.id, node);
  ids.add(node.data.id);
  for (const child of node.children || []) {
    indexNodes(child, index, ids);
  }
}

function createUniqueNodeId(existingIds: Set<string>): string {
  let candidate = '';
  do {
    candidate = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  } while (existingIds.has(candidate));
  existingIds.add(candidate);
  return candidate;
}

function normalizeChildTexts(nodeId: string, childTexts: string[]): string[] {
  if (!Array.isArray(childTexts) || childTexts.length === 0) {
    throw new Error(`节点 ${nodeId} 的 childTexts 必须至少包含一个子节点文本`);
  }

  const normalized = childTexts.map((text) => String(text).trim());
  const emptyIndex = normalized.findIndex((text) => text.length === 0);
  if (emptyIndex >= 0) {
    throw new Error(`节点 ${nodeId} 的 childTexts[${emptyIndex}] 不能为空`);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`节点 ${nodeId} 的 childTexts 不能包含重复文本`);
  }
  return normalized;
}

function completeCollaborationNode(node: KmNode): void {
  const resources = node.data.resource || [];
  node.data.resource = [
    ...new Set(
      resources
        .filter((resource) => resource !== KM_COLLABORATION_LABEL)
        .concat(KM_DONE_LABEL)
    ),
  ];
}

/** 认领一批待协同节点；认领只写旁车，不修改 KM。 */
export async function claimCollaborationTasks(
  kmPath: string,
  workerId: string,
  options: {
    limit?: number;
    nodeIds?: string[];
    leaseSeconds?: number;
    expectedFileRevision?: string;
  } = {}
): Promise<CollaborationClaimResult> {
  const resolved = path.resolve(kmPath);
  const worker = (workerId || '').trim();
  if (!worker) {
    throw new Error('workerId 不能为空');
  }

  return withKmFileLock(resolved, async () => {
    const fileRevision = await getKmFileRevision(resolved);
    const expected = options.expectedFileRevision?.trim();
    if (expected && expected !== fileRevision) {
      throw new Error(
        `KM 文件版本已变化，请重新读取协同任务清单。expected=${expected}, actual=${fileRevision}`
      );
    }

    const doc = await readKmFile(resolved);
    const execState = await readExecState(resolved);
    const now = Date.now();
    const candidates = collectCollaborationCandidates(doc);
    const eligible = candidates.filter(
      (candidate) => !isLeaseActive(execState.tasks[candidate.nodeId], now)
    );

    let targets: CollaborationCandidate[];
    if (options.nodeIds && options.nodeIds.length > 0) {
      if (new Set(options.nodeIds).size !== options.nodeIds.length) {
        throw new Error('nodeIds 不能包含重复节点');
      }
      targets = options.nodeIds.map((nodeId) => {
        const target = eligible.find((candidate) => candidate.nodeId === nodeId);
        if (target) {
          return target;
        }
        const activeEntry = execState.tasks[nodeId];
        if (isLeaseActive(activeEntry, now)) {
          throw new Error(
            `协同节点已被 ${activeEntry!.workerId} 认领且租约未过期，不能重复认领: ${nodeId}`
          );
        }
        throw new Error(`节点不是可认领的待协同任务（不存在、已完成或标签不匹配）: ${nodeId}`);
      });
    } else {
      const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_CLAIM_LIMIT));
      targets = eligible.slice(0, limit);
    }

    if (targets.length === 0) {
      return {
        filePath: resolved,
        fileRevision,
        claimId: null,
        workerId: worker,
        leaseUntil: null,
        claimedCount: 0,
        tasks: [],
      };
    }

    const claimId = crypto.randomUUID();
    const leaseSeconds = Math.max(
      1,
      Math.floor(options.leaseSeconds ?? DEFAULT_LEASE_SECONDS)
    );
    const claimedAt = new Date(now).toISOString();
    const leaseUntil = new Date(now + leaseSeconds * 1000).toISOString();

    for (const target of targets) {
      execState.tasks[target.nodeId] = {
        state: 'claimed',
        taskKind: 'collaboration',
        claimId,
        workerId: worker,
        claimedAt,
        leaseUntil,
        baseNodeHash: getSubtreeHash(target.node),
      };
    }
    execState.kmRevision = fileRevision;
    await writeExecState(resolved, execState);

    return {
      filePath: resolved,
      fileRevision,
      claimId,
      workerId: worker,
      leaseUntil,
      claimedCount: targets.length,
      tasks: targets.map((target) => ({
        nodeId: target.nodeId,
        text: target.text,
        path: target.path,
        baseSubtreeHash: execState.tasks[target.nodeId].baseNodeHash,
      })),
    };
  });
}

/**
 * 完成一批已认领协同任务。所有目标在锁内一次性校验；任一冲突时零写入。
 */
export async function completeCollaborationClaim(
  kmPath: string,
  claimId: string,
  tasks: CollaborationCompletionInput[],
  dryRun: boolean = false,
  sessionUpdate?: { executionId: string; summary?: string; artifacts?: SessionArtifact[] }
): Promise<CollaborationCompletionResult> {
  const resolved = path.resolve(kmPath);
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('tasks 必须至少包含一个待完成的协同任务');
  }
  const uniqueNodeIds = new Set(tasks.map((task) => task.nodeId));
  if (uniqueNodeIds.size !== tasks.length) {
    throw new Error('tasks 不能包含重复 nodeId');
  }
  const normalizedTasks = tasks.map((task) => ({
    nodeId: task.nodeId,
    childTexts: normalizeChildTexts(task.nodeId, task.childTexts),
  }));

  return withKmFileLock(resolved, async () => {
    const execState = await readExecState(resolved);
    const claimEntries = Object.entries(execState.tasks)
      .filter(
        ([, entry]) =>
          entry.claimId === claimId &&
          entry.state === 'claimed' &&
          entry.taskKind === 'collaboration'
      )
      .map(([nodeId, entry]) => ({ nodeId, entry }));

    if (claimEntries.length === 0) {
      throw new Error(`未找到处于认领状态的待协同任务，claimId: ${claimId}`);
    }

    const claimedIds = new Set(claimEntries.map(({ nodeId }) => nodeId));
    for (const task of normalizedTasks) {
      if (!claimedIds.has(task.nodeId)) {
        throw new Error(`协同节点不属于该 claim，不能通过此 claimId 完成: ${task.nodeId}`);
      }
    }

    const now = Date.now();
    for (const { nodeId, entry } of claimEntries) {
      if (uniqueNodeIds.has(nodeId) && !isLeaseActive(entry, now)) {
        throw new Error(
          `协同任务租约已过期，任务已回到待认领状态，不能通过旧 claim 完成: ${nodeId}`
        );
      }
    }

    const revisionBefore = await getKmFileRevision(resolved);
    const doc = await readKmFile(resolved);
    const nodeIndex = new Map<string, KmNode>();
    const existingIds = new Set<string>();
    indexNodes(doc.root, nodeIndex, existingIds);

    for (const task of normalizedTasks) {
      const node = nodeIndex.get(task.nodeId);
      if (!node) {
        throw new Error(`目标协同节点已不存在: ${task.nodeId}`);
      }
      const entry = execState.tasks[task.nodeId];
      if (getSubtreeHash(node) !== entry.baseNodeHash) {
        throw new Error(
          `协同节点子树在认领后已被修改，存在版本冲突，请重新认领并生成内容: ${task.nodeId}`
        );
      }
      if (!isCollaborationNode(node)) {
        throw new Error(`节点不再是待协同状态，可能已被其他执行者完成: ${task.nodeId}`);
      }
    }

    let createdOffset = 0;
    const createdAt = Date.now();
    const plans = normalizedTasks.map((task) => {
      const childNodes: KmNode[] = task.childTexts.map((text) => ({
        data: {
          id: createUniqueNodeId(existingIds),
          created: createdAt + createdOffset++,
          text,
        },
        children: [],
      }));
      return {
        nodeId: task.nodeId,
        childNodes,
        appendedChildren: childNodes.map((child) => ({
          nodeId: child.data.id,
          text: child.data.text,
        })),
      };
    });

    const appendedCount = plans.reduce((sum, plan) => sum + plan.childNodes.length, 0);
    const resultTasks = plans.map((plan) => ({
      nodeId: plan.nodeId,
      appendedCount: plan.childNodes.length,
      appendedChildren: plan.appendedChildren,
      parentCompleted: true,
    }));

    const sessionState = sessionUpdate ? await readSessionState(resolved) : undefined;
    const sessionPlan = sessionUpdate && sessionState
      ? plans.find((plan) => sessionState.executions[sessionUpdate.executionId]?.nodeId === plan.nodeId)
      : undefined;
    if (sessionUpdate && !sessionPlan) {
      throw new Error('executionId 对应节点不属于本次协同完成目标');
    }
    if (sessionPlan && sessionUpdate) {
      for (const child of sessionPlan.childNodes) {
        child.data.infiniteMap = {
          schemaVersion: 1,
          originExecutionId: sessionUpdate.executionId,
        };
      }
    }
    const preparedSession = sessionUpdate && sessionPlan
      ? await prepareTerminalSessionUpdate(resolved, doc, {
          ...sessionUpdate,
          nodeId: sessionPlan.nodeId,
          status: 'completed',
          generatedNodeIds: sessionPlan.childNodes.map((child) => child.data.id),
        })
      : undefined;

    if (dryRun) {
      return {
        filePath: resolved,
        dryRun: true,
        completedCount: plans.length,
        appendedCount,
        revisionBefore,
        revisionAfter: revisionBefore,
        tasks: resultTasks,
        verified: true,
      };
    }

    for (const plan of plans) {
      const node = nodeIndex.get(plan.nodeId)!;
      node.children = node.children || [];
      node.children.push(...plan.childNodes);
      completeCollaborationNode(node);
    }

    await atomicWriteJsonFile(resolved, JSON.stringify(doc, null, 4));
    const revisionAfter = await getKmFileRevision(resolved);
    const doneAt = new Date(now).toISOString();
    for (const plan of plans) {
      const entry = execState.tasks[plan.nodeId];
      entry.state = 'done';
      entry.doneAt = doneAt;
      entry.completedBy = 'collaboration-claim';
      entry.generatedNodeIds = plan.childNodes.map((child) => child.data.id);
    }
    execState.kmRevision = revisionAfter;
    await writeExecState(resolved, execState);
    if (preparedSession) {
      await commitTerminalSessionUpdate(resolved, preparedSession, revisionAfter);
    }

    let verified = false;
    try {
      const verifyDoc = await readKmFile(resolved);
      const verifyIndex = new Map<string, KmNode>();
      const verifyIds = new Set<string>();
      indexNodes(verifyDoc.root, verifyIndex, verifyIds);
      verified = plans.every((plan) => {
        const node = verifyIndex.get(plan.nodeId);
        if (!node) {
          return false;
        }
        const resources = node.data.resource || [];
        return (
          resources.includes(KM_DONE_LABEL) &&
          !resources.includes(KM_COLLABORATION_LABEL) &&
          plan.appendedChildren.every((child) => {
            const persisted = (node.children || []).find(
              (candidate) => candidate.data.id === child.nodeId
            );
            return Boolean(
              persisted &&
              persisted.data.text === child.text &&
              !persisted.data.resource
            );
          })
        );
      });
    } catch {
      verified = false;
    }

    return {
      filePath: resolved,
      dryRun: false,
      completedCount: plans.length,
      appendedCount,
      revisionBefore,
      revisionAfter,
      tasks: resultTasks,
      verified,
    };
  });
}

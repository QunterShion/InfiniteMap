/**
 * KM 并行执行状态服务
 * 负责旁车状态文件（<km>.exec.json）、跨进程文件锁（<km>.lock）、
 * 原子写入与任务租约（claim/renew/complete/release）管理
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  readKmFile,
  getKmFileRevision,
  KmDocument,
  KmNode,
  KM_TODO_LABEL,
  KM_DONE_LABEL,
} from './kmFileReader';
import { atomicWriteJsonFile, withKmFileLock } from './kmFileLock';
import {
  commitTerminalSessionUpdate,
  prepareTerminalSessionUpdate,
  SessionArtifact,
  SessionError,
} from './kmSessionState';
export {
  atomicWriteJsonFile,
  getLockPath,
  LOCK_EXPIRE_MS,
  LOCK_RETRY_INTERVAL_MS,
  LOCK_RETRY_LIMIT,
  withKmFileLock,
} from './kmFileLock';

export const EXEC_SCHEMA_VERSION = 1;
export const DEFAULT_LEASE_SECONDS = 600;
export const DEFAULT_CLAIM_LIMIT = 5;

export type ExecTaskState = 'claimed' | 'done' | 'released' | 'failed';
export type ExecTaskKind = 'todo' | 'collaboration';

/** 旁车文件中单个任务的租约与状态记录 */
export interface ExecTaskEntry {
  state: ExecTaskState;
  /** 旧版旁车没有该字段，读取时按 todo 兼容。 */
  taskKind?: ExecTaskKind;
  claimId: string;
  workerId: string;
  claimedAt: string;
  leaseUntil: string;
  baseNodeHash: string;
  doneAt?: string;
  releasedAt?: string;
  failedAt?: string;
  failReason?: string;
  completedBy?: 'claim' | 'collaboration-claim' | 'legacy';
  generatedNodeIds?: string[];
}

/** 旁车执行状态文件结构 */
export interface ExecState {
  schemaVersion: number;
  kmRevision: string;
  tasks: Record<string, ExecTaskEntry>;
}

/** 可认领的叶子待办 */
export interface LeafTodo {
  nodeId: string;
  text: string;
  path: string;
  node: KmNode;
}

/** 认领结果 */
export interface ClaimResult {
  filePath: string;
  kmRevision: string;
  claimId: string | null;
  workerId: string;
  leaseUntil: string | null;
  claimedCount: number;
  tasks: Array<{ nodeId: string; text: string; path: string; baseNodeHash: string }>;
}

/** 完成认领结果 */
export interface CompleteClaimResult {
  filePath: string;
  dryRun: boolean;
  completedCount: number;
  nodeIds: string[];
  revisionBefore: string;
  revisionAfter: string;
  verified: boolean;
}

export function getExecStatePath(kmPath: string): string {
  return path.resolve(kmPath) + '.exec.json';
}

/** 计算节点自身内容哈希（id + 文本 + 排序后标签），用于完成时检测节点被并发修改 */
export function getNodeHash(node: KmNode): string {
  const canonical = JSON.stringify({
    id: node.data.id,
    text: node.data.text,
    resource: [...(node.data.resource || [])].sort(),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * 计算待协同目标完整子树哈希。协同输出依赖目标已有子节点，认领后目标
 * 子树的任何变化都应阻止旧结果回写；其他兄弟节点变化不影响本哈希。
 */
export function getSubtreeHash(node: KmNode): string {
  function canonicalize(current: KmNode): unknown {
    const data = current.data as typeof current.data & {
      infiniteMap?: unknown;
    };
    // 运行追溯元数据不属于协同内容语义；认领期间写入会话链接不能使 claim 失效。
    const { infiniteMap: _infiniteMap, ...stableData } = data;
    return {
      data: {
        ...stableData,
        resource: [...(current.data.resource || [])].sort(),
      },
      children: (current.children || []).map(canonicalize),
    };
  }

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(node)))
    .digest('hex');
}

/**
 * 旁车文件 JSON 损坏时抛出此错误。
 * 调用方应将其作为工具级错误透传，而非静默降级为空状态——
 * 空状态会让租约保护失效，导致并发写入冲突。
 */
export class KmCorruptedSidecarError extends Error {
  public readonly execPath: string;
  constructor(execPath: string, cause: unknown) {
    super(`旁车文件损坏，无法读取执行状态，请检查或删除后重试: ${execPath}`);
    this.name = 'KmCorruptedSidecarError';
    this.execPath = execPath;
    if (cause instanceof Error) {
      (this as any).cause = cause;
    }
  }
}

/** 读取旁车执行状态。文件不存在返回空状态；文件存在但损坏则抛出 KmCorruptedSidecarError */
export async function readExecState(kmPath: string): Promise<ExecState> {
  const execPath = getExecStatePath(kmPath);
  let raw: string;
  try {
    raw = await fs.promises.readFile(execPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schemaVersion: EXEC_SCHEMA_VERSION, kmRevision: '', tasks: {} };
    }
    throw new KmCorruptedSidecarError(execPath, err);
  }

  let state: ExecState;
  try {
    state = JSON.parse(raw) as ExecState;
  } catch (err) {
    throw new KmCorruptedSidecarError(execPath, err);
  }

  if (!state || typeof state !== 'object' || typeof state.tasks !== 'object') {
    throw new KmCorruptedSidecarError(execPath, new Error('缺失必要字段 tasks'));
  }

  return {
    schemaVersion: state.schemaVersion || EXEC_SCHEMA_VERSION,
    kmRevision: state.kmRevision || '',
    tasks: state.tasks || {},
  };
}

/** 写入旁车执行状态（原子替换） */
export async function writeExecState(kmPath: string, state: ExecState): Promise<void> {
  await atomicWriteJsonFile(getExecStatePath(kmPath), JSON.stringify(state, null, 2));
}

/** 判断任务条目是否持有有效租约 */
export function isLeaseActive(entry: ExecTaskEntry | undefined, now: number = Date.now()): boolean {
  return Boolean(entry && entry.state === 'claimed' && Date.parse(entry.leaseUntil) > now);
}

function isTodoNode(node: KmNode): boolean {
  const resources = node.data.resource || [];
  return resources.includes(KM_TODO_LABEL) && !resources.includes(KM_DONE_LABEL);
}

function subtreeHasTodo(node: KmNode): boolean {
  if (!node.children) return false;
  for (const child of node.children) {
    if (isTodoNode(child) || subtreeHasTodo(child)) {
      return true;
    }
  }
  return false;
}

/**
 * 收集叶子待办：带"待拆解"且子树中不再包含其他待拆解节点。
 * 父级待办不进入认领批次，由协调者在子任务全部完成后单独汇总。
 * @param kmPath KM 文件路径
 * @param doc 可选，调用方已解析的文档对象；传入可省去一次读盘（MCP-P1-02）
 */
export async function collectLeafTodos(kmPath: string, doc?: KmDocument): Promise<LeafTodo[]> {
  const actualDoc = doc ?? await readKmFile(kmPath);
  const leaves: LeafTodo[] = [];

  function traverse(node: KmNode, segments: string[]): void {
    const currentPath = [...segments, node.data.text];
    if (isTodoNode(node) && !subtreeHasTodo(node)) {
      leaves.push({
        nodeId: node.data.id,
        text: node.data.text,
        path: currentPath.join(' > '),
        node,
      });
    }
    if (node.children) {
      for (const child of node.children) {
        traverse(child, currentPath);
      }
    }
  }

  traverse(actualDoc.root, []);
  return leaves;
}

/**
 * 认领一批叶子待办：写入租约后返回 claimId 与节点快照哈希。
 * 认领失败（版本不符、目标不可认领）时不修改任何状态。
 */
export async function claimTodos(
  kmPath: string,
  workerId: string,
  options: {
    limit?: number;
    nodeIds?: string[];
    leaseSeconds?: number;
    expectedKmRevision?: string;
  } = {}
): Promise<ClaimResult> {
  const resolved = path.resolve(kmPath);
  const worker = (workerId || '').trim();
  if (!worker) {
    throw new Error('workerId 不能为空');
  }

  return withKmFileLock(resolved, async () => {
    const kmRevision = await getKmFileRevision(resolved);
    const expected = options.expectedKmRevision?.trim();
    if (expected && expected !== kmRevision) {
      throw new Error(
        `KM 文件版本已变化，请重新读取待办清单。expected=${expected}, actual=${kmRevision}`
      );
    }

    const execState = await readExecState(resolved);
    const now = Date.now();
    const leafTodos = await collectLeafTodos(resolved);
    const eligible = leafTodos.filter((leaf) => !isLeaseActive(execState.tasks[leaf.nodeId], now));

    let targets: LeafTodo[];
    if (options.nodeIds && options.nodeIds.length > 0) {
      targets = options.nodeIds.map((nodeId) => {
        const leaf = eligible.find((candidate) => candidate.nodeId === nodeId);
        if (!leaf) {
          const activeEntry = execState.tasks[nodeId];
          if (isLeaseActive(activeEntry, now)) {
            throw new Error(
              `节点已被 ${activeEntry!.workerId} 认领且租约未过期，不能重复认领: ${nodeId}`
            );
          }
          throw new Error(`节点不是可认领的叶子待办（不存在、非待拆解或子树仍有待办）: ${nodeId}`);
        }
        return leaf;
      });
    } else {
      const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_CLAIM_LIMIT));
      targets = eligible.slice(0, limit);
    }

    if (targets.length === 0) {
      return {
        filePath: resolved,
        kmRevision,
        claimId: null,
        workerId: worker,
        leaseUntil: null,
        claimedCount: 0,
        tasks: [],
      };
    }

    const claimId = crypto.randomUUID();
    const leaseSeconds = Math.max(1, Math.floor(options.leaseSeconds ?? DEFAULT_LEASE_SECONDS));
    const claimedAt = new Date(now).toISOString();
    const leaseUntil = new Date(now + leaseSeconds * 1000).toISOString();

    for (const leaf of targets) {
      execState.tasks[leaf.nodeId] = {
        state: 'claimed',
        taskKind: 'todo',
        claimId,
        workerId: worker,
        claimedAt,
        leaseUntil,
        baseNodeHash: getNodeHash(leaf.node),
      };
    }
    execState.kmRevision = kmRevision;
    await writeExecState(resolved, execState);

    return {
      filePath: resolved,
      kmRevision,
      claimId,
      workerId: worker,
      leaseUntil,
      claimedCount: targets.length,
      tasks: targets.map((leaf) => ({
        nodeId: leaf.nodeId,
        text: leaf.text,
        path: leaf.path,
        baseNodeHash: execState.tasks[leaf.nodeId].baseNodeHash,
      })),
    };
  });
}

/** 按 claimId 查找处于 claimed 状态的任务条目 */
function findClaimEntries(
  execState: ExecState,
  claimId: string
): Array<{ nodeId: string; entry: ExecTaskEntry }> {
  return Object.entries(execState.tasks)
    .filter(([, entry]) => entry.claimId === claimId && entry.state === 'claimed')
    .map(([nodeId, entry]) => ({ nodeId, entry }));
}

/**
 * 续租：仅原 workerId 可续租，租约过期后不可续租（任务已回到待认领状态）
 */
export async function renewClaim(
  kmPath: string,
  claimId: string,
  workerId: string,
  leaseSeconds: number = DEFAULT_LEASE_SECONDS
): Promise<{ filePath: string; renewedCount: number; leaseUntil: string }> {
  const resolved = path.resolve(kmPath);

  return withKmFileLock(resolved, async () => {
    const execState = await readExecState(resolved);
    const entries = findClaimEntries(execState, claimId);
    if (entries.length === 0) {
      throw new Error(`未找到处于认领状态的任务，claimId: ${claimId}`);
    }
    const now = Date.now();
    for (const { entry } of entries) {
      if (entry.workerId !== workerId) {
        throw new Error(`只能由原认领者续租，当前认领者: ${entry.workerId}`);
      }
      if (!isLeaseActive(entry, now)) {
        throw new Error('租约已过期，任务已回到待认领状态，请重新认领');
      }
    }

    const leaseUntil = new Date(
      now + Math.max(1, Math.floor(leaseSeconds)) * 1000
    ).toISOString();
    for (const { entry } of entries) {
      entry.leaseUntil = leaseUntil;
    }
    await writeExecState(resolved, execState);

    return { filePath: resolved, renewedCount: entries.length, leaseUntil };
  });
}

/**
 * 完成认领：锁内校验租约有效、节点仍存在、节点哈希与认领时一致且仍为待拆解，
 * 校验通过后仅修改这些节点标签并原子写回，再把旁车状态置为 done。
 */
export async function completeClaim(
  kmPath: string,
  claimId: string,
  nodeIds?: string[],
  dryRun: boolean = false,
  sessionUpdate?: {
    executionId: string;
    summary?: string;
    artifacts?: SessionArtifact[];
    error?: SessionError;
  }
): Promise<CompleteClaimResult> {
  const resolved = path.resolve(kmPath);

  return withKmFileLock(resolved, async () => {
    const execState = await readExecState(resolved);
    const entries = findClaimEntries(execState, claimId);
    if (entries.length === 0) {
      throw new Error(`未找到处于认领状态的任务，claimId: ${claimId}`);
    }
    if (entries.some(({ entry }) => entry.taskKind === 'collaboration')) {
      throw new Error(
        '该 claim 属于待协同任务，请使用 km_complete_collaboration_claim 完成'
      );
    }

    const claimedIds = entries.map(({ nodeId }) => nodeId);
    const targets = nodeIds && nodeIds.length > 0 ? nodeIds : claimedIds;
    for (const nodeId of targets) {
      if (!claimedIds.includes(nodeId)) {
        throw new Error(`节点不属于该 claim，不能通过此 claimId 完成: ${nodeId}`);
      }
    }

    const now = Date.now();
    for (const { nodeId, entry } of entries) {
      if (targets.includes(nodeId) && !isLeaseActive(entry, now)) {
        throw new Error('租约已过期，任务已回到待认领状态，不能再通过该 claim 完成');
      }
    }

    const revisionBefore = await getKmFileRevision(resolved);
    const doc = await readKmFile(resolved);
    const nodeIndex = new Map<string, KmNode>();

    function index(node: KmNode): void {
      nodeIndex.set(node.data.id, node);
      if (node.children) {
        for (const child of node.children) {
          index(child);
        }
      }
    }
    index(doc.root);

    for (const nodeId of targets) {
      const node = nodeIndex.get(nodeId);
      if (!node) {
        throw new Error(`目标节点已不存在: ${nodeId}`);
      }
      const entry = execState.tasks[nodeId];
      if (getNodeHash(node) !== entry.baseNodeHash) {
        throw new Error(
          `节点在认领后已被修改，存在版本冲突，请重新认领并核对内容: ${nodeId}`
        );
      }
      const resources = node.data.resource || [];
      if (!resources.includes(KM_TODO_LABEL) || resources.includes(KM_DONE_LABEL)) {
        throw new Error(`节点不再是待拆解状态，可能已被其他执行者完成: ${nodeId}`);
      }
    }

    const preparedSession = sessionUpdate
      ? await prepareTerminalSessionUpdate(resolved, doc, {
          ...sessionUpdate,
          status: 'completed',
        })
      : undefined;
    if (preparedSession && !targets.includes(preparedSession.nodeId)) {
      throw new Error(`executionId 对应节点不属于本次完成目标: ${preparedSession.nodeId}`);
    }

    if (dryRun) {
      return {
        filePath: resolved,
        dryRun: true,
        completedCount: targets.length,
        nodeIds: [...targets],
        revisionBefore,
        revisionAfter: revisionBefore,
        verified: true,
      };
    }

    for (const nodeId of targets) {
      const node = nodeIndex.get(nodeId)!;
      const resources = node.data.resource || [];
      node.data.resource = [
        ...new Set(resources.filter((r) => r !== KM_TODO_LABEL).concat(KM_DONE_LABEL)),
      ];
    }

    await atomicWriteJsonFile(resolved, JSON.stringify(doc, null, 4));
    const revisionAfter = await getKmFileRevision(resolved);

    const doneAt = new Date(now).toISOString();
    for (const nodeId of targets) {
      const entry = execState.tasks[nodeId];
      entry.state = 'done';
      entry.doneAt = doneAt;
      entry.completedBy = 'claim';
    }
    execState.kmRevision = revisionAfter;
    await writeExecState(resolved, execState);
    if (preparedSession) {
      await commitTerminalSessionUpdate(resolved, preparedSession, revisionAfter);
    }

    let verified = false;
    try {
      const verifyDoc = await readKmFile(resolved);
      let verifyCount = 0;
      function verify(node: KmNode): void {
        if (targets.includes(node.data.id)) {
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
      verified = verifyCount === targets.length;
    } catch {
      verified = false;
    }

    return {
      filePath: resolved,
      dryRun: false,
      completedCount: targets.length,
      nodeIds: [...targets],
      revisionBefore,
      revisionAfter,
      verified,
    };
  });
}

/**
 * 释放认领：不带 failReason 时记为 released，带 failReason 时记为 failed；
 * 两种情况下 KM 节点标签都保持不变，可被重新认领。
 */
export async function releaseClaim(
  kmPath: string,
  claimId: string,
  options: {
    nodeIds?: string[];
    failReason?: string;
    dryRun?: boolean;
    sessionUpdate?: { executionId: string; summary?: string; error?: SessionError };
  } = {}
): Promise<{
  filePath: string;
  dryRun: boolean;
  releasedCount: number;
  state: ExecTaskState;
  revisionBefore: string;
  revisionAfter: string;
}> {
  const resolved = path.resolve(kmPath);

  return withKmFileLock(resolved, async () => {
    const execState = await readExecState(resolved);
    const entries = findClaimEntries(execState, claimId);
    if (entries.length === 0) {
      throw new Error(`未找到处于认领状态的任务，claimId: ${claimId}`);
    }

    const claimedIds = entries.map(({ nodeId }) => nodeId);
    const targets = options.nodeIds && options.nodeIds.length > 0 ? options.nodeIds : claimedIds;
    for (const nodeId of targets) {
      if (!claimedIds.includes(nodeId)) {
        throw new Error(`节点不属于该 claim: ${nodeId}`);
      }
    }

    const failReason = options.failReason?.trim();
    const nowIso = new Date().toISOString();
    const nextState: ExecTaskState = failReason ? 'failed' : 'released';
    const revisionBefore = await getKmFileRevision(resolved);
    const doc = options.sessionUpdate ? await readKmFile(resolved) : undefined;
    const preparedSession = options.sessionUpdate && doc
      ? await prepareTerminalSessionUpdate(resolved, doc, {
          ...options.sessionUpdate,
          status: failReason ? 'failed' : 'cancelled',
          error: options.sessionUpdate.error || (failReason
            ? { code: 'TASK_FAILED', message: failReason, retryable: true }
            : undefined),
        })
      : undefined;
    if (preparedSession && !targets.includes(preparedSession.nodeId)) {
      throw new Error(`executionId 对应节点不属于本次释放目标: ${preparedSession.nodeId}`);
    }

    if (options.dryRun) {
      return {
        filePath: resolved,
        dryRun: true,
        releasedCount: targets.length,
        state: nextState,
        revisionBefore,
        revisionAfter: revisionBefore,
      };
    }

    for (const nodeId of targets) {
      const entry = execState.tasks[nodeId];
      entry.state = nextState;
      if (failReason) {
        entry.failedAt = nowIso;
        entry.failReason = failReason;
      } else {
        entry.releasedAt = nowIso;
      }
    }
    let revisionAfter = revisionBefore;
    if (preparedSession && doc) {
      await atomicWriteJsonFile(resolved, JSON.stringify(doc, null, 4));
      revisionAfter = await getKmFileRevision(resolved);
      await commitTerminalSessionUpdate(resolved, preparedSession, revisionAfter);
      execState.kmRevision = revisionAfter;
    }
    await writeExecState(resolved, execState);

    return {
      filePath: resolved,
      dryRun: false,
      releasedCount: targets.length,
      state: nextState,
      revisionBefore,
      revisionAfter,
    };
  });
}

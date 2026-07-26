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
  KmNode,
  KM_TODO_LABEL,
  KM_DONE_LABEL,
} from './kmFileReader';

export const EXEC_SCHEMA_VERSION = 1;
export const DEFAULT_LEASE_SECONDS = 600;
export const DEFAULT_CLAIM_LIMIT = 5;
export const LOCK_EXPIRE_MS = 10_000;
export const LOCK_RETRY_INTERVAL_MS = 50;
export const LOCK_RETRY_LIMIT = 40;

export type ExecTaskState = 'claimed' | 'done' | 'released' | 'failed';

/** 旁车文件中单个任务的租约与状态记录 */
export interface ExecTaskEntry {
  state: ExecTaskState;
  claimId: string;
  workerId: string;
  claimedAt: string;
  leaseUntil: string;
  baseNodeHash: string;
  doneAt?: string;
  releasedAt?: string;
  failedAt?: string;
  failReason?: string;
  completedBy?: 'claim' | 'legacy';
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

export function getLockPath(kmPath: string): string {
  return path.resolve(kmPath) + '.lock';
}

/** 同步睡眠，用于文件锁自旋等待 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 原子写入文件：临时文件写入 + JSON 解析校验 + 同目录 rename 替换
 */
export function atomicWriteJsonFile(filePath: string, content: string): void {
  const resolved = path.resolve(filePath);
  const tmpPath = `${resolved}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  try {
    fs.writeFileSync(tmpPath, content, 'utf-8');
    JSON.parse(fs.readFileSync(tmpPath, 'utf-8'));
    fs.renameSync(tmpPath, resolved);
  } catch (e) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // 清理失败不掩盖原始错误
    }
    throw new Error(`文件写入失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 获取 KM 文件的跨进程旁车锁并在临界区内执行；退出时释放锁。
 * 锁通过原子创建（wx）获得，持有超过 LOCK_EXPIRE_MS 视为残留，可被抢占清理。
 */
export function withKmFileLock<T>(kmPath: string, fn: () => T): T {
  const lockPath = getLockPath(kmPath);
  let acquired = false;

  for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + LOCK_EXPIRE_MS).toISOString(),
        })
      );
      fs.closeSync(fd);
      acquired = true;
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw e;
      }
      // 已有锁：检测是否为残留锁
      try {
        const holder = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
        if (holder && typeof holder.expiresAt === 'string' && Date.parse(holder.expiresAt) < Date.now()) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        // 锁文件损坏或已被释放，下一轮重试
      }
      sleepSync(LOCK_RETRY_INTERVAL_MS);
    }
  }

  if (!acquired) {
    throw new Error(`获取 KM 文件锁超时，文件正被其他进程写入: ${getLockPath(kmPath)}`);
  }

  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // 锁已被过期清理时忽略
    }
  }
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

/** 读取旁车执行状态；文件不存在或损坏时返回空状态（可从 KM 重建） */
export function readExecState(kmPath: string): ExecState {
  const execPath = getExecStatePath(kmPath);
  if (!fs.existsSync(execPath)) {
    return { schemaVersion: EXEC_SCHEMA_VERSION, kmRevision: '', tasks: {} };
  }

  try {
    const state = JSON.parse(fs.readFileSync(execPath, 'utf-8')) as ExecState;
    if (!state || typeof state !== 'object' || typeof state.tasks !== 'object') {
      return { schemaVersion: EXEC_SCHEMA_VERSION, kmRevision: '', tasks: {} };
    }
    return {
      schemaVersion: state.schemaVersion || EXEC_SCHEMA_VERSION,
      kmRevision: state.kmRevision || '',
      tasks: state.tasks || {},
    };
  } catch {
    return { schemaVersion: EXEC_SCHEMA_VERSION, kmRevision: '', tasks: {} };
  }
}

/** 写入旁车执行状态（原子替换） */
export function writeExecState(kmPath: string, state: ExecState): void {
  atomicWriteJsonFile(getExecStatePath(kmPath), JSON.stringify(state, null, 2));
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
 */
export function collectLeafTodos(kmPath: string): LeafTodo[] {
  const doc = readKmFile(kmPath);
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

  traverse(doc.root, []);
  return leaves;
}

/**
 * 认领一批叶子待办：写入租约后返回 claimId 与节点快照哈希。
 * 认领失败（版本不符、目标不可认领）时不修改任何状态。
 */
export function claimTodos(
  kmPath: string,
  workerId: string,
  options: {
    limit?: number;
    nodeIds?: string[];
    leaseSeconds?: number;
    expectedKmRevision?: string;
  } = {}
): ClaimResult {
  const resolved = path.resolve(kmPath);
  const worker = (workerId || '').trim();
  if (!worker) {
    throw new Error('workerId 不能为空');
  }

  return withKmFileLock(resolved, () => {
    const kmRevision = getKmFileRevision(resolved);
    const expected = options.expectedKmRevision?.trim();
    if (expected && expected !== kmRevision) {
      throw new Error(
        `KM 文件版本已变化，请重新读取待办清单。expected=${expected}, actual=${kmRevision}`
      );
    }

    const execState = readExecState(resolved);
    const now = Date.now();
    const leafTodos = collectLeafTodos(resolved);
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
        claimId,
        workerId: worker,
        claimedAt,
        leaseUntil,
        baseNodeHash: getNodeHash(leaf.node),
      };
    }
    execState.kmRevision = kmRevision;
    writeExecState(resolved, execState);

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
export function renewClaim(
  kmPath: string,
  claimId: string,
  workerId: string,
  leaseSeconds: number = DEFAULT_LEASE_SECONDS
): { filePath: string; renewedCount: number; leaseUntil: string } {
  const resolved = path.resolve(kmPath);

  return withKmFileLock(resolved, () => {
    const execState = readExecState(resolved);
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
    writeExecState(resolved, execState);

    return { filePath: resolved, renewedCount: entries.length, leaseUntil };
  });
}

/**
 * 完成认领：锁内校验租约有效、节点仍存在、节点哈希与认领时一致且仍为待拆解，
 * 校验通过后仅修改这些节点标签并原子写回，再把旁车状态置为 done。
 */
export function completeClaim(
  kmPath: string,
  claimId: string,
  nodeIds?: string[],
  dryRun: boolean = false
): CompleteClaimResult {
  const resolved = path.resolve(kmPath);

  return withKmFileLock(resolved, () => {
    const execState = readExecState(resolved);
    const entries = findClaimEntries(execState, claimId);
    if (entries.length === 0) {
      throw new Error(`未找到处于认领状态的任务，claimId: ${claimId}`);
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

    const revisionBefore = getKmFileRevision(resolved);
    const doc = readKmFile(resolved);
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

    atomicWriteJsonFile(resolved, JSON.stringify(doc, null, 4));
    const revisionAfter = getKmFileRevision(resolved);

    const doneAt = new Date(now).toISOString();
    for (const nodeId of targets) {
      const entry = execState.tasks[nodeId];
      entry.state = 'done';
      entry.doneAt = doneAt;
      entry.completedBy = 'claim';
    }
    execState.kmRevision = revisionAfter;
    writeExecState(resolved, execState);

    let verified = false;
    try {
      const verifyDoc = readKmFile(resolved);
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
 * 两种情况下 KM 节点都保持"待拆解"，可被重新认领。
 */
export function releaseClaim(
  kmPath: string,
  claimId: string,
  options: { nodeIds?: string[]; failReason?: string } = {}
): { filePath: string; releasedCount: number; state: ExecTaskState } {
  const resolved = path.resolve(kmPath);

  return withKmFileLock(resolved, () => {
    const execState = readExecState(resolved);
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
    writeExecState(resolved, execState);

    return { filePath: resolved, releasedCount: targets.length, state: nextState };
  });
}

import * as fs from 'fs';
import * as path from 'path';
import {
  getKmFileRevision,
  KmDocument,
  KmLatestSession,
  KmNode,
  KmTaskKind,
  NodeExecutionStatus,
  readKmFile,
  KM_COLLABORATION_LABEL,
  KM_DONE_LABEL,
  KM_TODO_LABEL,
} from './kmFileReader';
import { atomicWriteJsonFile, withKmFileLock } from './kmFileLock';

export const SESSION_SCHEMA_VERSION = 1;
export const DEFAULT_SESSION_PAGE_SIZE = 20;
export const MAX_SESSION_PAGE_SIZE = 100;

export interface SessionReference {
  provider: string;
  sessionId: string;
  threadId?: string;
  turnId?: string;
  surface: 'app-server' | 'copilot-sdk' | 'claude-agent-sdk' | 'language-model' | 'provider-pack';
  modelId?: string;
  effort?: string;
  openUri: string;
}

export interface SessionError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface SessionArtifact {
  path: string;
  kind: 'file' | 'report' | 'validation';
}

export interface NodeExecutionRecord {
  executionId: string;
  nodeId: string;
  taskKind: KmTaskKind;
  status: NodeExecutionStatus;
  session: SessionReference;
  requestedConfig?: { modelId?: string; effort?: string };
  effectiveConfig?: { modelId?: string; effort?: string };
  degradations?: Array<{
    field: string;
    action: 'dropped' | 'substituted' | 'blocked';
    reason: string;
  }>;
  workerId: string;
  claimId?: string;
  inputRevision: string;
  resultRevision?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  summary?: string;
  artifacts?: SessionArtifact[];
  generatedNodeIds?: string[];
  error?: SessionError;
}

export interface SessionState {
  schemaVersion: 1;
  kmRevision: string;
  executions: Record<string, NodeExecutionRecord>;
  nodeIndex: Record<string, string[]>;
}

export interface RecordSessionInput {
  filePath: string;
  nodeId: string;
  executionId: string;
  taskKind: KmTaskKind;
  status: NodeExecutionStatus;
  session: SessionReference;
  workerId: string;
  claimId?: string;
  expectedRevision?: string;
  inputRevision?: string;
  resultRevision?: string;
  requestedConfig?: { modelId?: string; effort?: string };
  effectiveConfig?: { modelId?: string; effort?: string };
  degradations?: NodeExecutionRecord['degradations'];
  startedAt?: string;
  summary?: string;
  artifacts?: SessionArtifact[];
  generatedNodeIds?: string[];
  error?: SessionError;
  dryRun?: boolean;
}

export interface RecordSessionResult {
  filePath: string;
  executionId: string;
  nodeId: string;
  dryRun: boolean;
  created: boolean;
  status: NodeExecutionStatus;
  historyCount: number;
  revisionBefore: string;
  revisionAfter: string;
}

export interface SessionPage {
  filePath: string;
  nodeId: string | null;
  orphan: boolean;
  total: number;
  cursor: string | null;
  nextCursor: string | null;
  sessions: NodeExecutionRecord[];
}

export async function listFileSessions(
  filePath: string,
  cursor?: string,
  limit: number = DEFAULT_SESSION_PAGE_SIZE
): Promise<SessionPage> {
  const resolved = path.resolve(filePath);
  const pageSize = Math.max(1, Math.min(MAX_SESSION_PAGE_SIZE, Math.floor(limit)));
  const offset = parseCursor(cursor);
  return withKmFileLock(resolved, async () => {
    const state = await readSessionState(resolved);
    const ordered = Object.values(state.executions).sort((left, right) => {
      const updatedDelta = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      return updatedDelta || right.executionId.localeCompare(left.executionId);
    });
    const sessions = ordered.slice(offset, offset + pageSize);
    return {
      filePath: resolved,
      nodeId: null,
      orphan: false,
      total: ordered.length,
      cursor: offset === 0 ? null : String(offset),
      nextCursor: offset + sessions.length < ordered.length ? String(offset + sessions.length) : null,
      sessions,
    };
  });
}

export interface TerminalSessionUpdate {
  executionId: string;
  nodeId?: string;
  status: Extract<NodeExecutionStatus, 'completed' | 'failed' | 'cancelled' | 'conflict' | 'interrupted'>;
  summary?: string;
  error?: SessionError;
  artifacts?: SessionArtifact[];
  generatedNodeIds?: string[];
}

export interface PreparedTerminalSessionUpdate {
  state: SessionState;
  record: NodeExecutionRecord;
  nodeId: string;
}

export function getSessionStatePath(kmPath: string): string {
  return path.resolve(kmPath) + '.sessions.json';
}

export async function readSessionState(kmPath: string): Promise<SessionState> {
  const resolved = path.resolve(kmPath);
  const sessionPath = getSessionStatePath(resolved);
  let raw: string;
  try {
    raw = await fs.promises.readFile(sessionPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return rebuildSessionState(resolved);
    }
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as SessionState;
    if (!parsed || parsed.schemaVersion !== SESSION_SCHEMA_VERSION
      || typeof parsed.executions !== 'object' || typeof parsed.nodeIndex !== 'object') {
      throw new Error('invalid session sidecar schema');
    }
    return normalizeState(parsed);
  } catch {
    await quarantineCorruptSidecar(sessionPath);
    const recovered = await rebuildSessionState(resolved);
    if (Object.keys(recovered.executions).length > 0) {
      await writeSessionState(resolved, recovered);
    }
    return recovered;
  }
}

export async function writeSessionState(kmPath: string, state: SessionState): Promise<void> {
  await atomicWriteJsonFile(getSessionStatePath(kmPath), JSON.stringify(normalizeState(state), null, 2));
}

export async function recordSession(input: RecordSessionInput): Promise<RecordSessionResult> {
  validateRecordInput(input);
  const resolved = path.resolve(input.filePath);
  return withKmFileLock(resolved, () => recordSessionLocked(resolved, input));
}

export async function listNodeSessions(
  filePath: string,
  nodeId: string,
  cursor?: string,
  limit: number = DEFAULT_SESSION_PAGE_SIZE
): Promise<SessionPage> {
  const resolved = path.resolve(filePath);
  const normalizedNodeId = requiredText(nodeId, 'nodeId', 256);
  const pageSize = Math.max(1, Math.min(MAX_SESSION_PAGE_SIZE, Math.floor(limit)));
  const offset = parseCursor(cursor);
  return withKmFileLock(resolved, async () => {
    const state = await readSessionState(resolved);
    const ids = state.nodeIndex[normalizedNodeId] || [];
    const sessions = ids
      .slice(offset, offset + pageSize)
      .map((executionId) => state.executions[executionId])
      .filter((record): record is NodeExecutionRecord => Boolean(record));
    const doc = await readKmFile(resolved);
    return {
      filePath: resolved,
      nodeId: normalizedNodeId,
      orphan: !findNode(doc.root, normalizedNodeId),
      total: ids.length,
      cursor: offset === 0 ? null : String(offset),
      nextCursor: offset + sessions.length < ids.length ? String(offset + sessions.length) : null,
      sessions,
    };
  });
}

/**
 * Prepare a terminal session mutation while the caller already owns <km>.lock.
 * This mutates only the caller's in-memory KM document and the returned sidecar snapshot.
 */
export async function prepareTerminalSessionUpdate(
  kmPath: string,
  doc: KmDocument,
  update: TerminalSessionUpdate
): Promise<PreparedTerminalSessionUpdate> {
  const state = await readSessionState(kmPath);
  const record = state.executions[update.executionId];
  if (!record) {
    throw new Error(`未找到 executionId 对应的会话记录: ${update.executionId}`);
  }
	const nodeId = update.nodeId || record.nodeId;
  if (record.nodeId !== nodeId) {
    throw new Error(`executionId 与目标节点不匹配: ${update.executionId}`);
  }
  const node = findNode(doc.root, nodeId);
  if (!node) {
    throw new Error(`会话终态目标节点不存在: ${nodeId}`);
  }
  const now = new Date().toISOString();
  record.status = update.status;
  record.updatedAt = now;
  record.completedAt = now;
  record.summary = update.summary === undefined ? record.summary : update.summary;
  record.error = update.error === undefined ? record.error : update.error;
  record.artifacts = update.artifacts === undefined ? record.artifacts : update.artifacts;
  record.generatedNodeIds = update.generatedNodeIds === undefined
    ? record.generatedNodeIds
    : [...update.generatedNodeIds];

  const historyCount = (state.nodeIndex[nodeId] || []).length;
  node.data.infiniteMap = {
    ...(node.data.infiniteMap || {}),
    schemaVersion: 1,
    latestSession: toLatestSession(record),
    sessionHistoryCount: historyCount,
  };
  return { state, record, nodeId };
}

/** Persist a prepared sidecar after the caller atomically replaced the KM document. */
export async function commitTerminalSessionUpdate(
  kmPath: string,
  prepared: PreparedTerminalSessionUpdate,
  revisionAfter: string
): Promise<void> {
  prepared.record.resultRevision = revisionAfter;
  prepared.state.kmRevision = revisionAfter;
  await writeSessionState(kmPath, prepared.state);
}

async function recordSessionLocked(resolved: string, input: RecordSessionInput): Promise<RecordSessionResult> {
  const revisionBefore = await getKmFileRevision(resolved);
  const expected = input.expectedRevision?.trim();
  if (expected !== undefined && expected.length === 0) {
    throw new Error('expectedRevision 不能为空字符串');
  }
  if (expected && expected !== revisionBefore) {
    throw new Error(
      `KM 文件版本已变化，请重新读取上下文。expected=${expected}, actual=${revisionBefore}`
    );
  }
  if (input.taskKind === 'collaboration' && !isTerminalStatus(input.status) && !expected) {
    throw new Error('待协同会话启动记录必须携带最新 expectedRevision');
  }

  const doc = await readKmFile(resolved);
  const node = findNode(doc.root, input.nodeId);
  if (!node) {
    throw new Error(`未找到节点 ID: ${input.nodeId}`);
  }
  assertTaskKind(node, input.taskKind, input.status);
  await assertClaimBinding(resolved, input);

  const state = await readSessionState(resolved);
  const existing = state.executions[input.executionId];
  if (existing) {
    if (existing.nodeId !== input.nodeId || existing.taskKind !== input.taskKind
      || existing.session.provider !== input.session.provider
      || existing.session.sessionId !== input.session.sessionId) {
      throw new Error('executionId 已绑定到不同的节点或 Provider 会话');
    }
  }

  const now = new Date().toISOString();
  const record = buildRecord(input, existing, revisionBefore, now);
  const index = state.nodeIndex[input.nodeId] || [];
  const uniqueIndex = [input.executionId, ...index.filter((id) => id !== input.executionId)];
  state.executions[input.executionId] = record;
  state.nodeIndex[input.nodeId] = uniqueIndex;

  if (input.dryRun) {
    return {
      filePath: resolved,
      executionId: input.executionId,
      nodeId: input.nodeId,
      dryRun: true,
      created: !existing,
      status: input.status,
      historyCount: uniqueIndex.length,
      revisionBefore,
      revisionAfter: revisionBefore,
    };
  }

  const latest = node.data.infiniteMap?.latestSession;
  if (!latest || latest.executionId === input.executionId
    || Date.parse(record.startedAt) >= Date.parse(latest.startedAt)) {
    node.data.infiniteMap = {
      ...(node.data.infiniteMap || {}),
      schemaVersion: 1,
      latestSession: toLatestSession(record),
      sessionHistoryCount: uniqueIndex.length,
    };
  } else {
    node.data.infiniteMap = {
      ...(node.data.infiniteMap || {}),
      schemaVersion: 1,
      sessionHistoryCount: uniqueIndex.length,
    };
  }

  // The KM reference is written first. If the sidecar update fails, it can be rebuilt from this node field.
  await atomicWriteJsonFile(resolved, JSON.stringify(doc, null, 4));
  const revisionAfter = await getKmFileRevision(resolved);
  state.kmRevision = revisionAfter;
  record.resultRevision = input.resultRevision || record.resultRevision;
  await writeSessionState(resolved, state);

  return {
    filePath: resolved,
    executionId: input.executionId,
    nodeId: input.nodeId,
    dryRun: false,
    created: !existing,
    status: input.status,
    historyCount: uniqueIndex.length,
    revisionBefore,
    revisionAfter,
  };
}

function buildRecord(
  input: RecordSessionInput,
  existing: NodeExecutionRecord | undefined,
  revisionBefore: string,
  now: string
): NodeExecutionRecord {
  const startedAt = existing?.startedAt || normalizeDate(input.startedAt, 'startedAt') || now;
  return {
    executionId: input.executionId,
    nodeId: input.nodeId,
    taskKind: input.taskKind,
    status: input.status,
    session: { ...input.session },
    requestedConfig: input.requestedConfig || existing?.requestedConfig,
    effectiveConfig: input.effectiveConfig || existing?.effectiveConfig,
    degradations: input.degradations || existing?.degradations,
    workerId: input.workerId,
    claimId: input.claimId || existing?.claimId,
    inputRevision: existing?.inputRevision || input.inputRevision || revisionBefore,
    resultRevision: input.resultRevision || existing?.resultRevision,
    startedAt,
    updatedAt: now,
    completedAt: isTerminalStatus(input.status) ? now : undefined,
    summary: input.summary,
    artifacts: input.artifacts,
    generatedNodeIds: input.generatedNodeIds,
    error: input.error,
  };
}

function validateRecordInput(input: RecordSessionInput): void {
  requiredText(input.filePath, 'filePath', 4096);
  requiredText(input.nodeId, 'nodeId', 256);
  requiredText(input.executionId, 'executionId', 256);
  requiredText(input.workerId, 'workerId', 256);
  requiredText(input.session.provider, 'session.provider', 128);
  requiredText(input.session.sessionId, 'session.sessionId', 512);
  validateOpenUri(input.session.openUri, input.executionId, input.nodeId);
  if (!['breakdown', 'collaboration'].includes(input.taskKind)) {
    throw new Error(`不支持的 taskKind: ${input.taskKind}`);
  }
  if (input.summary && input.summary.length > 4096) {
    throw new Error('summary 超过 4096 字符限制');
  }
  for (const artifact of input.artifacts || []) {
    const artifactPath = requiredText(artifact.path, 'artifact.path', 2048);
    if (path.isAbsolute(artifactPath) || artifactPath.split(/[\\/]/).includes('..')) {
      throw new Error(`产物路径必须是工作区相对路径: ${artifactPath}`);
    }
  }
}

function validateOpenUri(openUri: string, executionId: string, nodeId: string): void {
  const value = requiredText(openUri, 'session.openUri', 4096);
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw new Error('session.openUri 必须是有效的 InfiniteMap Deep Link');
  }
  if (uri.protocol !== 'vscode:' || uri.hostname !== 'chanterxiao.infinite-map'
    || uri.pathname !== '/session/open') {
    throw new Error('session.openUri 不是允许的 InfiniteMap Deep Link');
  }
  if (uri.searchParams.get('executionId') !== executionId || uri.searchParams.get('nodeId') !== nodeId) {
    throw new Error('session.openUri 的 executionId/nodeId 与记录不匹配');
  }
  const mapHint = uri.searchParams.get('map');
  if (mapHint && (path.isAbsolute(mapHint) || mapHint.split(/[\\/]/).includes('..'))) {
    throw new Error('session.openUri 的 map 必须是工作区相对路径');
  }
  for (const key of uri.searchParams.keys()) {
    if (!['v', 'executionId', 'map', 'nodeId'].includes(key)) {
      throw new Error(`session.openUri 包含不允许的参数: ${key}`);
    }
  }
}

function assertTaskKind(node: KmNode, taskKind: KmTaskKind, status: NodeExecutionStatus): void {
  const labels = node.data.resource || [];
  const isCompleted = labels.includes(KM_DONE_LABEL);
  const matches = taskKind === 'breakdown'
    ? labels.includes(KM_TODO_LABEL)
    : labels.includes(KM_COLLABORATION_LABEL);
  if (!matches && !(isTerminalStatus(status) && isCompleted)) {
    throw new Error(`节点标签与 taskKind=${taskKind} 不匹配: ${node.data.id}`);
  }
}

async function assertClaimBinding(resolved: string, input: RecordSessionInput): Promise<void> {
  const entry = await readExecEntry(resolved, input.nodeId);
  const leaseActive = Boolean(entry && entry.state === 'claimed' && Date.parse(entry.leaseUntil) > Date.now());
  if (leaseActive && input.claimId !== entry!.claimId) {
    throw new Error(`节点存在活动租约，claimId 不匹配: ${input.nodeId}`);
  }
  if (input.claimId) {
    if (!entry || entry.claimId !== input.claimId) {
      throw new Error(`未找到与会话记录匹配的 claimId: ${input.claimId}`);
    }
    if (entry.workerId !== input.workerId) {
      throw new Error(`workerId 与 claim 认领者不匹配: ${input.nodeId}`);
    }
  }
}

async function readExecEntry(kmPath: string, nodeId: string): Promise<{
  state: string;
  claimId: string;
  workerId: string;
  leaseUntil: string;
} | undefined> {
  const execPath = path.resolve(kmPath) + '.exec.json';
  try {
    const raw = await fs.promises.readFile(execPath, 'utf8');
    const state = JSON.parse(raw);
    return state && state.tasks ? state.tasks[nodeId] : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    return undefined;
  }
}

async function rebuildSessionState(kmPath: string): Promise<SessionState> {
  const doc = await readKmFile(kmPath);
  const state = emptyState(await getKmFileRevision(kmPath));
  walk(doc.root, (node) => {
    const latest = node.data.infiniteMap?.latestSession;
    if (!latest || !latest.executionId) {
      return;
    }
    const record: NodeExecutionRecord = {
      executionId: latest.executionId,
      nodeId: node.data.id,
      taskKind: latest.taskKind,
      status: latest.status,
      session: {
        provider: latest.provider,
        sessionId: latest.sessionId,
        surface: latest.surface as SessionReference['surface'],
        modelId: latest.modelId,
        effort: latest.effort,
        openUri: latest.openUri,
      },
      workerId: 'recovered',
      inputRevision: state.kmRevision,
      startedAt: latest.startedAt,
      updatedAt: latest.updatedAt,
      completedAt: isTerminalStatus(latest.status) ? latest.updatedAt : undefined,
    };
    state.executions[record.executionId] = record;
    state.nodeIndex[node.data.id] = [record.executionId];
  });
  return state;
}

function normalizeState(state: SessionState): SessionState {
  const executions = state.executions || {};
  const nodeIndex: Record<string, string[]> = {};
  for (const [nodeId, ids] of Object.entries(state.nodeIndex || {})) {
    nodeIndex[nodeId] = [...new Set((ids || []).filter((id) => Boolean(executions[id])))]
      .sort((left, right) => Date.parse(executions[right].updatedAt) - Date.parse(executions[left].updatedAt));
  }
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    kmRevision: state.kmRevision || '',
    executions,
    nodeIndex,
  };
}

function emptyState(kmRevision: string): SessionState {
  return { schemaVersion: SESSION_SCHEMA_VERSION, kmRevision, executions: {}, nodeIndex: {} };
}

function toLatestSession(record: NodeExecutionRecord): KmLatestSession {
  return {
    executionId: record.executionId,
    taskKind: record.taskKind,
    provider: record.session.provider,
    sessionId: record.session.sessionId,
    surface: record.session.surface,
    modelId: record.session.modelId,
    effort: record.session.effort,
    openUri: record.session.openUri,
    status: record.status,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
  };
}

async function quarantineCorruptSidecar(sessionPath: string): Promise<void> {
  try {
    const quarantinePath = `${sessionPath}.corrupt-${Date.now().toString(36)}`;
    await fs.promises.rename(sessionPath, quarantinePath);
  } catch {
    // Recovery remains available in memory if the damaged sidecar cannot be moved.
  }
}

function findNode(node: KmNode, nodeId: string): KmNode | null {
  if (node.data.id === nodeId) return node;
  for (const child of node.children || []) {
    const found = findNode(child, nodeId);
    if (found) return found;
  }
  return null;
}

function walk(node: KmNode, visitor: (node: KmNode) => void): void {
  visitor(node);
  for (const child of node.children || []) walk(child, visitor);
}

function parseCursor(cursor?: string): number {
  if (cursor === undefined || cursor === '') return 0;
  if (!/^\d+$/.test(cursor)) throw new Error('cursor 无效');
  return Number(cursor);
}

function requiredText(value: string, name: string, maxLength: number): string {
  const normalized = (value || '').trim();
  if (!normalized) throw new Error(`${name} 不能为空`);
  if (normalized.length > maxLength) throw new Error(`${name} 超过长度限制 ${maxLength}`);
  return normalized;
}

function normalizeDate(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${name} 必须是 ISO 时间`);
  return new Date(timestamp).toISOString();
}

export function isTerminalStatus(status: NodeExecutionStatus): boolean {
  return ['interrupted', 'completed', 'failed', 'cancelled', 'conflict'].includes(status);
}

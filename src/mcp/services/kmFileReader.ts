/**
 * KM 文件读取/解析服务
 * 负责从磁盘读取 .km 文件并解析为 JSON 树结构
 */

import * as fs from 'fs';
import * as path from 'path';
import { getCachedKmFileRevision } from './kmRevisionCache';

export const KM_TODO_LABEL = '待拆解';
export const KM_COLLABORATION_LABEL = '待协同';
export const KM_DONE_LABEL = '已完成';

export type KmTaskKind = 'breakdown' | 'collaboration';
export type NodeExecutionStatus =
  | 'allocated'
  | 'starting'
  | 'running'
  | 'idle'
  | 'interrupting'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'conflict'
  | 'disconnected';

export interface KmLatestSession {
  executionId: string;
  taskKind: KmTaskKind;
  provider: string;
  sessionId: string;
  surface: string;
  modelId?: string;
  effort?: string;
  openUri: string;
  status: NodeExecutionStatus;
  startedAt: string;
  updatedAt: string;
}

/** KM 节点结构 */
export interface KmNode {
  data: {
    id: string;
    created: number;
    text: string;
    resource?: string[];
    expandState?: string;
    hyperlink?: string;
    note?: string;
    infiniteMap?: {
      schemaVersion: 1;
      latestSession?: KmLatestSession;
      sessionHistoryCount?: number;
      originExecutionId?: string;
    };
  };
  children: KmNode[];
}

/** KM 文件根结构 */
export interface KmDocument {
  root: KmNode;
  template?: string;
  theme?: string;
  version?: string;
  [key: string]: unknown;
}

/** 待办节点摘要 */
export interface TodoNode {
  nodeId: string;
  text: string;
  path: string;
  depth: number;
  parentText?: string;
  grandParentText?: string;
}

/** 待拆解任务清单（含文件版本） */
export interface TodoList {
  filePath: string;
  kmRevision: string;
  todoCount: number;
  todos: TodoNode[];
}

/** 待协同节点摘要 */
export interface CollaborationTaskNode extends TodoNode {
  labels: string[];
}

/** 待协同任务清单 */
export interface CollaborationTaskList {
  filePath: string;
  fileRevision: string;
  taskCount: number;
  tasks: CollaborationTaskNode[];
}

/** 祖先节点上下文 */
export interface AncestorContext {
  nodeId: string;
  text: string;
  depth: number;
  labels: string[];
}

/** 同级节点上下文 */
export interface SiblingContext {
  nodeId: string;
  text: string;
  index: number;
  labels: string[];
  childCount: number;
}

/** 待协同节点完整上下文 */
export interface CollaborationContext {
  filePath: string;
  fileRevision: string;
  nodePath: string;
  targetDepth: number;
  targetIndex: number;
  siblingCount: number;
  ancestors: AncestorContext[];
  siblings: SiblingContext[];
  node: KmNode;
}

/** 文件读取结果 */
export interface ReadResult {
  filePath: string;
  fileName: string;
  nodeCount: number;
  treeDepth: number;
  todoCount: number;
  rootText: string;
}

/**
 * 读取并解析 KM 文件
 */
export async function readKmFile(filePath: string): Promise<KmDocument> {
  const resolved = path.resolve(filePath);
  let raw: string;
  try {
    raw = await fs.promises.readFile(resolved, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`文件不存在: ${resolved}`);
    }
    throw err;
  }
  try {
    const doc = JSON.parse(raw) as KmDocument;
    if (!doc.root || !doc.root.data) {
      throw new Error('无效的 KM 文件格式: 缺少 root 节点');
    }
    return doc;
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`KM 文件 JSON 解析失败: ${e.message}`);
    }
    throw e;
  }
}

/**
 * 计算 KM 文件内容版本，用于协同写回时检测过期上下文
 */
export async function getKmFileRevision(filePath: string): Promise<string> {
	const resolved = path.resolve(filePath);
	return getCachedKmFileRevision(resolved);
}

/**
 * 获取 KM 文件摘要信息
 */
export async function getKmSummary(filePath: string): Promise<ReadResult> {
  const resolved = path.resolve(filePath);
  const doc = await readKmFile(resolved);

  let nodeCount = 0;
  let maxDepth = 0;
  let todoCount = 0;

  function traverse(node: KmNode, depth: number): void {
    nodeCount++;
    if (depth > maxDepth) maxDepth = depth;
    const resources = node.data.resource || [];
    if (resources.includes(KM_TODO_LABEL) && !resources.includes(KM_DONE_LABEL)) {
      todoCount++;
    }
    if (node.children) {
      for (const child of node.children) {
        traverse(child, depth + 1);
      }
    }
  }
  traverse(doc.root, 0);

  return {
    filePath: resolved,
    fileName: path.basename(resolved),
    nodeCount,
    treeDepth: maxDepth,
    todoCount,
    rootText: doc.root.data.text,
  };
}

/**
 * 列出所有待拆解节点
 */
export async function listTodos(filePath: string): Promise<TodoNode[]> {
  const doc = await readKmFile(filePath);
  const todos: TodoNode[] = [];

  function traverse(
    node: KmNode,
    depth: number,
    pathSegments: string[],
    parentText?: string,
    grandParentText?: string
  ): void {
    const resources = node.data.resource || [];
    const hasTodo = resources.includes(KM_TODO_LABEL);
    const hasDone = resources.includes(KM_DONE_LABEL);

    if (hasTodo && !hasDone) {
      todos.push({
        nodeId: node.data.id,
        text: node.data.text,
        path: [...pathSegments, node.data.text].join(' > '),
        depth,
        parentText,
        grandParentText,
      });
    }

    const newSegments = [...pathSegments, node.data.text];
    const currentText = node.data.text;
    const currentParent = depth === 0 ? undefined : pathSegments[pathSegments.length - 1];

    if (node.children) {
      for (const child of node.children) {
        traverse(child, depth + 1, newSegments, currentText, currentParent || parentText);
      }
    }
  }

  traverse(doc.root, 0, [], undefined, undefined);
  return todos;
}

/**
 * 列出所有待拆解节点，并返回文件内容版本供回写时乐观校验
 */
export async function listTodosWithRevision(filePath: string): Promise<TodoList> {
  const resolved = path.resolve(filePath);
  const todos = await listTodos(resolved);

  return {
    filePath: resolved,
    kmRevision: await getKmFileRevision(resolved),
    todoCount: todos.length,
    todos,
  };
}

/**
 * 单次读文件，同时返回 todos、kmRevision 和已解析的文档对象，
 * 供调用方（如 km_list_todos）复用 doc 传入 collectLeafTodos，避免双重读盘（MCP-P1-02）
 */
export async function listTodosWithRevisionAndDoc(filePath: string): Promise<TodoList & { doc: KmDocument }> {
  const resolved = path.resolve(filePath);
  const doc = await readKmFile(resolved);
  const todos: TodoNode[] = [];

  function traverse(
    node: KmNode,
    depth: number,
    pathSegments: string[],
    parentText?: string,
    grandParentText?: string
  ): void {
    const resources = node.data.resource || [];
    const hasTodo = resources.includes(KM_TODO_LABEL);
    const hasDone = resources.includes(KM_DONE_LABEL);

    if (hasTodo && !hasDone) {
      todos.push({
        nodeId: node.data.id,
        text: node.data.text,
        path: [...pathSegments, node.data.text].join(' > '),
        depth,
        parentText,
        grandParentText,
      });
    }

    const newSegments = [...pathSegments, node.data.text];
    const currentText = node.data.text;
    const currentParent = depth === 0 ? undefined : pathSegments[pathSegments.length - 1];

    if (node.children) {
      for (const child of node.children) {
        traverse(child, depth + 1, newSegments, currentText, currentParent || parentText);
      }
    }
  }

  traverse(doc.root, 0, [], undefined, undefined);

  return {
    filePath: resolved,
    kmRevision: await getKmFileRevision(resolved),
    todoCount: todos.length,
    todos,
    doc,
  };
}

/**
 * 列出所有待协同节点
 */
export async function listCollaborationTasks(filePath: string): Promise<CollaborationTaskList> {
  const resolved = path.resolve(filePath);
  const doc = await readKmFile(resolved);
  const tasks: CollaborationTaskNode[] = [];

  function traverse(
    node: KmNode,
    depth: number,
    pathSegments: string[],
    parentText?: string,
    grandParentText?: string
  ): void {
    const labels = node.data.resource || [];
    const hasCollaboration = labels.includes(KM_COLLABORATION_LABEL);
    const hasDone = labels.includes(KM_DONE_LABEL);

    if (hasCollaboration && !hasDone) {
      tasks.push({
        nodeId: node.data.id,
        text: node.data.text,
        path: [...pathSegments, node.data.text].join(' > '),
        depth,
        parentText,
        grandParentText,
        labels,
      });
    }

    const newSegments = [...pathSegments, node.data.text];
    const currentText = node.data.text;
    const currentParent = depth === 0 ? undefined : pathSegments[pathSegments.length - 1];

    if (node.children) {
      for (const child of node.children) {
        traverse(child, depth + 1, newSegments, currentText, currentParent || parentText);
      }
    }
  }

  traverse(doc.root, 0, [], undefined, undefined);

  return {
    filePath: resolved,
    fileRevision: await getKmFileRevision(resolved),
    taskCount: tasks.length,
    tasks,
  };
}

/**
 * 获取待协同节点的根到目标链路、完整子树和必要同级上下文
 */
export async function getCollaborationContext(
  filePath: string,
  nodeId: string,
  siblingLimit: number = 8
): Promise<CollaborationContext> {
  const resolved = path.resolve(filePath);
  const doc = await readKmFile(resolved);
  const fileRevision = await getKmFileRevision(resolved);
  let targetNode: KmNode | null = null;
  let parentNode: KmNode | null = null;
  let targetDepth = 0;
  let ancestorEntries: Array<{ node: KmNode; depth: number }> = [];

  function find(
    node: KmNode,
    depth: number,
    ancestors: Array<{ node: KmNode; depth: number }>
  ): boolean {
    if (node.data.id === nodeId) {
      targetNode = node;
      parentNode = ancestors.length > 0 ? ancestors[ancestors.length - 1].node : null;
      targetDepth = depth;
      ancestorEntries = ancestors;
      return true;
    }

    if (node.children) {
      const nextAncestors = [...ancestors, { node, depth }];
      for (const child of node.children) {
        if (find(child, depth + 1, nextAncestors)) {
          return true;
        }
      }
    }

    return false;
  }

  find(doc.root, 0, []);

  if (!targetNode) {
    throw new Error(`未找到节点 ID: ${nodeId}`);
  }

  // TypeScript 无法跨递归闭包追踪赋值，此处在空值检查后明确收窄。
  const target = targetNode as KmNode;
  const parent = parentNode as KmNode | null;
  const targetLabels = target.data.resource || [];
  if (!targetLabels.includes(KM_COLLABORATION_LABEL) || targetLabels.includes(KM_DONE_LABEL)) {
    throw new Error(`节点不是有效的"${KM_COLLABORATION_LABEL}"任务: ${nodeId}`);
  }

  const normalizedSiblingLimit = Math.max(0, Math.min(50, Math.floor(siblingLimit)));
  const ancestors = ancestorEntries.map(({ node, depth }) => ({
    nodeId: node.data.id,
    text: node.data.text,
    depth,
    labels: node.data.resource || [],
  }));
  const nodePath = [...ancestors.map((ancestor) => ancestor.text), target.data.text].join(' > ');
  let targetIndex = -1;
  let siblingCount = 0;
  let siblings: SiblingContext[] = [];

  if (parent && parent.children) {
    targetIndex = parent.children.findIndex((child) => child.data.id === nodeId);
    const siblingNodes = parent.children
      .map((child, index) => ({ child, index }))
      .filter(({ child }) => child.data.id !== nodeId);

    siblingCount = siblingNodes.length;
    siblings = siblingNodes
      .map(({ child, index }) => ({
        child,
        index,
        distance: targetIndex === -1 ? index : Math.abs(index - targetIndex),
      }))
      .sort((a, b) => a.distance - b.distance || a.index - b.index)
      .slice(0, normalizedSiblingLimit)
      .sort((a, b) => a.index - b.index)
      .map(({ child, index }) => ({
        nodeId: child.data.id,
        text: child.data.text,
        index,
        labels: child.data.resource || [],
        childCount: child.children ? child.children.length : 0,
      }));
  }

  return {
    filePath: resolved,
    fileRevision,
    nodePath,
    targetDepth,
    targetIndex,
    siblingCount,
    ancestors,
    siblings,
    node: target,
  };
}

/**
 * 从已解析的文档构建 nodeId → KmNode 索引，避免每次查找都做 DFS O(n)
 */
export function buildNodeIndex(doc: KmDocument): Map<string, KmNode> {
  const index = new Map<string, KmNode>();
  function traverse(node: KmNode): void {
    index.set(node.data.id, node);
    if (node.children) {
      for (const child of node.children) {
        traverse(child);
      }
    }
  }
  traverse(doc.root);
  return index;
}

/**
 * 按节点 ID 获取节点详情（含完整子树）和路径，单次读文件
 */
export async function getNodeWithPath(
  filePath: string,
  nodeId: string
): Promise<{ node: KmNode; nodePath: string } | null> {
  const doc = await readKmFile(filePath);
  const index = buildNodeIndex(doc);
  const node = index.get(nodeId);
  if (!node) return null;

  function findPath(current: KmNode, segments: string[]): string | null {
    if (current.data.id === nodeId) {
      return [...segments, current.data.text].join(' > ');
    }
    if (current.children) {
      for (const child of current.children) {
        const found = findPath(child, [...segments, current.data.text]);
        if (found) return found;
      }
    }
    return null;
  }

  const nodePath = findPath(doc.root, []) ?? nodeId;
  return { node, nodePath };
}

/**
 * 按节点 ID 获取节点详情（含完整子树）
 */
export async function getNodeById(filePath: string, nodeId: string): Promise<KmNode | null> {
  const doc = await readKmFile(filePath);

  function find(node: KmNode): KmNode | null {
    if (node.data.id === nodeId) return node;
    if (node.children) {
      for (const child of node.children) {
        const found = find(child);
        if (found) return found;
      }
    }
    return null;
  }

  return find(doc.root);
}

/**
 * 获取节点的路径（从根开始的文本路径）
 */
export async function getNodePath(filePath: string, nodeId: string): Promise<string | null> {
  const doc = await readKmFile(filePath);

  function findPath(node: KmNode, segments: string[]): string | null {
    if (node.data.id === nodeId) {
      return [...segments, node.data.text].join(' > ');
    }
    if (node.children) {
      for (const child of node.children) {
        const found = findPath(child, [...segments, node.data.text]);
        if (found) return found;
      }
    }
    return null;
  }

  return findPath(doc.root, []);
}

/**
 * 统计全树节点数量
 */
export function countNodes(doc: KmDocument): number {
  let count = 0;
  function traverse(node: KmNode): void {
    count++;
    if (node.children) {
      for (const child of node.children) {
        traverse(child);
      }
    }
  }
  traverse(doc.root);
  return count;
}

/**
 * 计算树最大深度
 */
export function getTreeDepth(doc: KmDocument): number {
  let maxDepth = 0;
  function traverse(node: KmNode, depth: number): void {
    if (depth > maxDepth) maxDepth = depth;
    if (node.children) {
      for (const child of node.children) {
        traverse(child, depth + 1);
      }
    }
  }
  traverse(doc.root, 0);
  return maxDepth;
}

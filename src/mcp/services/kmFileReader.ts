/**
 * KM 文件读取/解析服务
 * 负责从磁盘读取 .km 文件并解析为 JSON 树结构
 */

import * as fs from 'fs';
import * as path from 'path';

/** KM 节点结构 */
export interface KmNode {
  data: {
    id: string;
    created: number;
    text: string;
    resource?: string[];
    expandState?: string;
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
export function readKmFile(filePath: string): KmDocument {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`文件不存在: ${resolved}`);
  }

  const raw = fs.readFileSync(resolved, 'utf-8');
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
 * 获取 KM 文件摘要信息
 */
export function getKmSummary(filePath: string): ReadResult {
  const resolved = path.resolve(filePath);
  const doc = readKmFile(resolved);

  let nodeCount = 0;
  let maxDepth = 0;

  function traverse(node: KmNode, depth: number): void {
    nodeCount++;
    if (depth > maxDepth) maxDepth = depth;
    if (node.children) {
      for (const child of node.children) {
        traverse(child, depth + 1);
      }
    }
  }
  traverse(doc.root, 0);

  const todos = listTodos(filePath);

  return {
    filePath: resolved,
    fileName: path.basename(resolved),
    nodeCount,
    treeDepth: maxDepth,
    todoCount: todos.length,
    rootText: doc.root.data.text,
  };
}

/**
 * 列出所有待拆解节点
 */
export function listTodos(filePath: string): TodoNode[] {
  const doc = readKmFile(filePath);
  const todos: TodoNode[] = [];

  function traverse(
    node: KmNode,
    depth: number,
    pathSegments: string[],
    parentText?: string,
    grandParentText?: string
  ): void {
    const resources = node.data.resource || [];
    const hasTodo = resources.includes('待拆解');
    const hasDone = resources.includes('已完成');

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
 * 按节点 ID 获取节点详情（含完整子树）
 */
export function getNodeById(filePath: string, nodeId: string): KmNode | null {
  const doc = readKmFile(filePath);

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
export function getNodePath(filePath: string, nodeId: string): string | null {
  const doc = readKmFile(filePath);

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

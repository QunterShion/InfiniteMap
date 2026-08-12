/**
 * KM MCP 服务本地测试脚本
 * 运行方式: npx ts-node --project tsconfig.mcp.json src/mcp/test.ts
 */

import { getKmSummary, listTodos, getNodeById, getNodePath, countNodes, getTreeDepth } from './services/kmFileReader';
import { markNodesDone, validateKmFile } from './services/kmFileWriter';
import * as path from 'path';

const testFile = 'D:\\GalaxyProjectStation\\10-Workspace\\10-工作计划空间\\平台项目规划\\座舱行业软件前瞻.km';

console.log('=== KM MCP 服务本地测试 ===\n');
console.log(`测试文件: ${testFile}\n`);

// 测试 1: km_read
console.log('--- 测试 km_read ---');
try {
  const summary = getKmSummary(testFile);
  console.log(`文件名: ${summary.fileName}`);
  console.log(`节点总数: ${summary.nodeCount}`);
  console.log(`树深度: ${summary.treeDepth}`);
  console.log(`根节点: ${summary.rootText}`);
  console.log(`待办数: ${summary.todoCount}`);
} catch (e: any) {
  console.error(`错误: ${e.message}`);
}

// 测试 2: km_list_todos
console.log('\n--- 测试 km_list_todos ---');
try {
  const todos = listTodos(testFile);
  console.log(`找到 ${todos.length} 个待拆解节点:`);
  todos.forEach((t, i) => {
    console.log(`  ${i + 1}. [${t.nodeId}] ${t.text}`);
    console.log(`     路径: ${t.path}`);
  });
} catch (e: any) {
  console.error(`错误: ${e.message}`);
}

// 测试 3: km_get_node (如果有待办节点)
console.log('\n--- 测试 km_get_node ---');
try {
  const todos = listTodos(testFile);
  if (todos.length > 0) {
    const node = getNodeById(testFile, todos[0].nodeId);
    if (node) {
      console.log(`节点: ${node.data.text}`);
      console.log(`标签: ${JSON.stringify(node.data.resource)}`);
      const nodePath = getNodePath(testFile, todos[0].nodeId);
      console.log(`路径: ${nodePath}`);
    }
  } else {
    console.log('没有待拆解节点，跳过测试');
  }
} catch (e: any) {
  console.error(`错误: ${e.message}`);
}

// 测试 4: km_validate
console.log('\n--- 测试 km_validate ---');
try {
  const validation = validateKmFile(testFile);
  console.log(`有效性: ${validation.valid ? 'PASS' : 'FAIL'}`);
  if (validation.errors.length > 0) {
    console.log('错误:');
    validation.errors.forEach((e) => console.log(`  - ${e}`));
  }
  if (validation.warnings.length > 0) {
    console.log('警告:');
    validation.warnings.forEach((w) => console.log(`  - ${w}`));
  }
} catch (e: any) {
  console.error(`错误: ${e.message}`);
}

// 测试 5: km_mark_done (dry-run)
console.log('\n--- 测试 km_mark_done (dry-run) ---');
try {
  const todos = listTodos(testFile);
  if (todos.length > 0) {
    const nodeIds = todos.map((t) => t.nodeId);
    void markNodesDone(testFile, nodeIds, true).then((result) => {
      console.log(`DRY RUN: 将修改 ${result.modified} 个节点`);
    });
  } else {
    console.log('没有待拆解节点，跳过测试');
  }
} catch (e: any) {
  console.error(`错误: ${e.message}`);
}

console.log('\n=== 测试完成 ===');

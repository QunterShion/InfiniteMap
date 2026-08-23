const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

require('ts-node/register/transpile-only');
const { listTodos, listTodosWithRevision, getKmFileRevision } = require('../src/mcp/services/kmFileReader.ts');
const { markNodesDone } = require('../src/mcp/services/kmFileWriter.ts');

const TODO = '\u5f85\u62c6\u89e3';
const DONE = '\u5df2\u5b8c\u6210';

function createNode(id, children = []) {
  return {
    data: {
      id,
      created: 1,
      text: id,
      resource: [TODO],
    },
    children,
  };
}

test('marks a selected parent and its selected descendants in one batch', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-writer-'));
  const filePath = path.join(directory, 'fixture.json');
  const nodeIds = ['parent', 'child-a', 'child-b'];
  const document = {
    root: createNode('root', [
      createNode('parent', [createNode('child-a'), createNode('child-b')]),
    ]),
  };

  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(filePath, JSON.stringify(document), 'utf8');

  const before = fs.readFileSync(filePath, 'utf8');
  const dryRun = await markNodesDone(filePath, nodeIds, true);
  assert.equal(dryRun.modified, 3);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);

  const result = await markNodesDone(filePath, nodeIds, false);
  assert.equal(result.modified, 3);
  assert.equal(result.verified, true);
  assert.deepEqual((await listTodos(filePath)).map((todo) => todo.nodeId), ['root']);

  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const parent = persisted.root.children[0];
  assert.deepEqual(parent.data.resource, [DONE]);
  assert.deepEqual(parent.children[0].data.resource, [DONE]);
  assert.deepEqual(parent.children[1].data.resource, [DONE]);
});

test('list todos returns kmRevision matching the current file content', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-writer-'));
  const filePath = path.join(directory, 'fixture.json');
  const document = { root: createNode('root', [createNode('leaf')]) };

  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(filePath, JSON.stringify(document), 'utf8');

  const todoList = await listTodosWithRevision(filePath);
  assert.equal(todoList.todoCount, 2);
  assert.deepEqual(todoList.todos.map((todo) => todo.nodeId), ['root', 'leaf']);
  assert.equal(todoList.kmRevision, await getKmFileRevision(filePath));

  // 文件内容变化后版本必须变化
  await markNodesDone(filePath, ['leaf'], false);
  assert.notEqual((await listTodosWithRevision(filePath)).kmRevision, todoList.kmRevision);
});

test('mark done with matching expectedRevision succeeds and returns new revision', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-writer-'));
  const filePath = path.join(directory, 'fixture.json');
  const document = { root: createNode('root', [createNode('leaf')]) };

  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(filePath, JSON.stringify(document), 'utf8');

  const { kmRevision } = await listTodosWithRevision(filePath);
  const result = await markNodesDone(filePath, ['leaf'], false, kmRevision);
  assert.equal(result.modified, 1);
  assert.equal(result.verified, true);
  assert.equal(result.revisionBefore, kmRevision);
  assert.notEqual(result.revisionAfter, kmRevision);
  assert.equal(result.revisionAfter, await getKmFileRevision(filePath));
});

test('mark done with stale expectedRevision is rejected without writing', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-writer-'));
  const filePath = path.join(directory, 'fixture.json');
  const document = { root: createNode('root', [createNode('leaf-a'), createNode('leaf-b')]) };

  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(filePath, JSON.stringify(document), 'utf8');

  const { kmRevision: staleRevision } = await listTodosWithRevision(filePath);

  // 模拟并发写入者先完成 leaf-a，文件版本随之变化
  await markNodesDone(filePath, ['leaf-a'], false);
  const contentAfterConcurrent = fs.readFileSync(filePath, 'utf8');

  await assert.rejects(
    markNodesDone(filePath, ['leaf-b'], false, staleRevision),
    /KM 文件版本已变化/
  );
  // 冲突拒绝时不得写入任何内容
  assert.equal(fs.readFileSync(filePath, 'utf8'), contentAfterConcurrent);
  assert.deepEqual((await listTodos(filePath)).map((todo) => todo.nodeId), ['root', 'leaf-b']);
});

test('mark done without expectedRevision keeps legacy behavior', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-writer-'));
  const filePath = path.join(directory, 'fixture.json');
  const document = { root: createNode('root', [createNode('leaf')]) };

  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(filePath, JSON.stringify(document), 'utf8');

  const result = await markNodesDone(filePath, ['leaf'], false);
  assert.equal(result.modified, 1);
  assert.equal(result.verified, true);
});

test('mark done with empty expectedRevision string is rejected', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-writer-'));
  const filePath = path.join(directory, 'fixture.json');
  const document = { root: createNode('root', [createNode('leaf')]) };

  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(filePath, JSON.stringify(document), 'utf8');

  await assert.rejects(
    markNodesDone(filePath, ['leaf'], false, '  '),
    /expectedRevision 不能为空字符串/
  );
});

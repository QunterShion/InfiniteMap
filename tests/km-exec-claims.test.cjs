const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

require('ts-node/register/transpile-only');
const {
  claimTodos,
  completeClaim,
  renewClaim,
  releaseClaim,
  readExecState,
  writeExecState,
  getExecStatePath,
  getLockPath,
  withKmFileLock,
  collectLeafTodos,
} = require('../src/mcp/services/kmExecState.ts');
const { markNodesDone } = require('../src/mcp/services/kmFileWriter.ts');
const { listTodos, getKmFileRevision } = require('../src/mcp/services/kmFileReader.ts');

const TODO = '待拆解';
const DONE = '已完成';

function createNode(id, children = [], resource = [TODO]) {
  return {
    data: {
      id,
      created: 1,
      text: id,
      resource: [...resource],
    },
    children,
  };
}

function createFixture(t, document) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-claims-'));
  const filePath = path.join(directory, 'fixture.km');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(filePath, JSON.stringify(document), 'utf8');
  return filePath;
}

// 父节点带待拆解、两个叶子待办的标准夹具
function parentWithTwoLeaves() {
  return {
    root: createNode('root', [
      createNode('parent', [createNode('leaf-a'), createNode('leaf-b')]),
    ], []),
  };
}

test('claim only targets leaf todos and skips parents', async (t) => {
  const filePath = createFixture(t, {
    root: createNode('root', [
      createNode('parent', [createNode('leaf-a'), createNode('leaf-b')]),
    ], []),
  });

  const leaves = collectLeafTodos(filePath).map((leaf) => leaf.nodeId);
  assert.deepEqual(leaves, ['leaf-a', 'leaf-b']);

  const result = await claimTodos(filePath, 'agent-a');
  assert.ok(result.claimId);
  assert.equal(result.claimedCount, 2);
  assert.deepEqual(result.tasks.map((task) => task.nodeId), ['leaf-a', 'leaf-b']);
  assert.equal(result.kmRevision, getKmFileRevision(filePath));

  const execState = readExecState(filePath);
  assert.equal(execState.tasks['leaf-a'].state, 'claimed');
  assert.equal(execState.tasks['leaf-a'].workerId, 'agent-a');
  assert.ok(execState.tasks['leaf-a'].baseNodeHash);
  assert.equal(execState.tasks.parent, undefined);
  // 认领不修改 KM 本身
  assert.deepEqual(listTodos(filePath).map((todo) => todo.nodeId), ['parent', 'leaf-a', 'leaf-b']);
});

test('second worker cannot claim nodes under an active lease', async (t) => {
  const filePath = createFixture(t, parentWithTwoLeaves());

  const first = await claimTodos(filePath, 'agent-a', { nodeIds: ['leaf-a'] });
  assert.equal(first.claimedCount, 1);

  // 自动分派跳过已被认领的 leaf-a
  const second = await claimTodos(filePath, 'agent-b');
  assert.deepEqual(second.tasks.map((task) => task.nodeId), ['leaf-b']);

  // 显式指定已被认领的节点则整体失败
  await assert.rejects(
    claimTodos(filePath, 'agent-c', { nodeIds: ['leaf-a'] }),
    /已被 agent-a 认领且租约未过期/
  );
});

test('complete claim marks nodes done atomically and updates sidecar', async (t) => {
  const filePath = createFixture(t, parentWithTwoLeaves());
  const claim = await claimTodos(filePath, 'agent-a');

  const dryRun = await completeClaim(filePath, claim.claimId, undefined, true);
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.completedCount, 2);
  assert.deepEqual(listTodos(filePath).map((todo) => todo.nodeId), ['parent', 'leaf-a', 'leaf-b']);

  const result = await completeClaim(filePath, claim.claimId);
  assert.equal(result.completedCount, 2);
  assert.equal(result.verified, true);
  assert.notEqual(result.revisionAfter, result.revisionBefore);

  assert.deepEqual(listTodos(filePath).map((todo) => todo.nodeId), ['parent']);
  const execState = readExecState(filePath);
  assert.equal(execState.tasks['leaf-a'].state, 'done');
  assert.equal(execState.tasks['leaf-a'].completedBy, 'claim');
  assert.equal(execState.kmRevision, getKmFileRevision(filePath));
});

test('complete claim rejects when node was modified after claiming', async (t) => {
  const filePath = createFixture(t, parentWithTwoLeaves());
  const claim = await claimTodos(filePath, 'agent-a', { nodeIds: ['leaf-a'] });

  // 模拟人工修改被认领节点的文本
  const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  doc.root.children[0].children[0].data.text = 'leaf-a-modified';
  fs.writeFileSync(filePath, JSON.stringify(doc), 'utf8');
  const contentBefore = fs.readFileSync(filePath, 'utf8');

  await assert.rejects(
    completeClaim(filePath, claim.claimId),
    /节点在认领后已被修改/
  );
  assert.equal(fs.readFileSync(filePath, 'utf8'), contentBefore);
});

test('expired lease returns task to pending and blocks completion', async (t) => {
  const filePath = createFixture(t, parentWithTwoLeaves());
  const claim = await claimTodos(filePath, 'agent-a', { nodeIds: ['leaf-a'] });

  // 直接把租约改为过期，模拟执行者崩溃
  const execState = readExecState(filePath);
  execState.tasks['leaf-a'].leaseUntil = new Date(Date.now() - 1000).toISOString();
  writeExecState(filePath, execState);

  await assert.rejects(completeClaim(filePath, claim.claimId), /租约已过期/);
  await assert.rejects(
    renewClaim(filePath, claim.claimId, 'agent-a'),
    /租约已过期/
  );

  // 过期后其他执行者可以重新认领
  const reclaimed = await claimTodos(filePath, 'agent-b', { nodeIds: ['leaf-a'] });
  assert.equal(reclaimed.claimedCount, 1);
  assert.equal(readExecState(filePath).tasks['leaf-a'].workerId, 'agent-b');
});

test('renew extends lease for the original worker only', async (t) => {
  const filePath = createFixture(t, parentWithTwoLeaves());
  const claim = await claimTodos(filePath, 'agent-a');
  const leaseBefore = readExecState(filePath).tasks['leaf-a'].leaseUntil;

  await assert.rejects(
    renewClaim(filePath, claim.claimId, 'agent-b'),
    /只能由原认领者续租/
  );

  const renewed = await renewClaim(filePath, claim.claimId, 'agent-a', 1200);
  assert.equal(renewed.renewedCount, 2);
  assert.ok(Date.parse(renewed.leaseUntil) > Date.parse(leaseBefore));
});

test('release and fail return tasks to pending for re-claiming', async (t) => {
  const filePath = createFixture(t, parentWithTwoLeaves());
  const claim = await claimTodos(filePath, 'agent-a');

  const released = await releaseClaim(filePath, claim.claimId, { nodeIds: ['leaf-a'] });
  assert.equal(released.state, 'released');

  const failed = await releaseClaim(filePath, claim.claimId, {
    nodeIds: ['leaf-b'],
    failReason: '输出物验证不通过',
  });
  assert.equal(failed.state, 'failed');

  const execState = readExecState(filePath);
  assert.equal(execState.tasks['leaf-a'].state, 'released');
  assert.equal(execState.tasks['leaf-b'].state, 'failed');
  assert.equal(execState.tasks['leaf-b'].failReason, '输出物验证不通过');
  // KM 节点仍保持待拆解
  assert.deepEqual(listTodos(filePath).map((todo) => todo.nodeId), ['parent', 'leaf-a', 'leaf-b']);

  // 释放和失败的任务都可以被重新认领
  const reclaimed = await claimTodos(filePath, 'agent-b');
  assert.deepEqual(reclaimed.tasks.map((task) => task.nodeId), ['leaf-a', 'leaf-b']);
});

test('legacy mark done is blocked for actively claimed nodes', async (t) => {
  const filePath = createFixture(t, parentWithTwoLeaves());
  const claim = await claimTodos(filePath, 'agent-a', { nodeIds: ['leaf-a'] });

  await assert.rejects(
    markNodesDone(filePath, ['leaf-a'], false),
    /已被 agent-a 认领且租约未过期/
  );

  // 释放后 legacy 回写恢复可用，且旁车条目被同步为 done
  await releaseClaim(filePath, claim.claimId);
  const result = await markNodesDone(filePath, ['leaf-a'], false);
  assert.equal(result.modified, 1);
  const entry = readExecState(filePath).tasks['leaf-a'];
  assert.equal(entry.state, 'done');
  assert.equal(entry.completedBy, 'legacy');
});

test('stale lock file is preempted and lock is cleaned after critical section', async (t) => {
  const filePath = createFixture(t, parentWithTwoLeaves());
  const lockPath = getLockPath(filePath);

  // 残留的过期锁
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 99999, acquiredAt: new Date(0).toISOString(), expiresAt: new Date(Date.now() - 60_000).toISOString() })
  );

  const value = await withKmFileLock(filePath, () => {
    assert.ok(fs.existsSync(lockPath));
    return 42;
  });
  assert.equal(value, 42);
  assert.equal(fs.existsSync(lockPath), false);

  // 有效锁存在时无法进入临界区
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 99999, acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() })
  );
  t.after(() => fs.rmSync(lockPath, { force: true }));
  let timerFired = false;
  const timer = setTimeout(() => { timerFired = true; }, 10);
  await assert.rejects(claimTodos(filePath, 'agent-a'), /获取 KM 文件锁超时/);
  clearTimeout(timer);
  assert.equal(timerFired, true, 'async lock waiting must not block the event loop');
});

test('claim with stale expectedKmRevision is rejected', async (t) => {
  const filePath = createFixture(t, parentWithTwoLeaves());
  const staleRevision = getKmFileRevision(filePath);

  await markNodesDone(filePath, ['leaf-b'], false);

  await assert.rejects(
    claimTodos(filePath, 'agent-a', { expectedKmRevision: staleRevision }),
    /KM 文件版本已变化/
  );
  assert.equal(fs.existsSync(getExecStatePath(filePath)) && Object.keys(readExecState(filePath).tasks).filter((id) => readExecState(filePath).tasks[id].state === 'claimed').length > 0, false);
});

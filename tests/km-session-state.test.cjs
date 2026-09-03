const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  getSessionStatePath,
	listFileSessions,
  listNodeSessions,
  recordSession,
} = require('../dist/mcp/services/kmSessionState.js');
const { getKmFileRevision, readKmFile } = require('../dist/mcp/services/kmFileReader.js');
const {
  claimTodos,
  completeClaim,
  getNodeHash,
  readExecState,
  releaseClaim,
} = require('../dist/mcp/services/kmExecState.js');
const {
  expandCollaborationTask,
  markNodesDone,
} = require('../dist/mcp/services/kmFileWriter.js');
const {
  claimCollaborationTasks,
  completeCollaborationClaim,
} = require('../dist/mcp/services/kmCollaborationClaims.js');

function createMap(tempDir, label = '待拆解') {
  const filePath = path.join(tempDir, 'tasks.km');
  fs.writeFileSync(filePath, JSON.stringify({
    root: {
      data: { id: 'root', created: 1, text: 'Root' },
      children: [{
        data: {
          id: 'task-1',
          created: 2,
          text: 'Task',
          resource: [label],
          hyperlink: 'https://example.com',
          note: 'keep me',
        },
        children: [],
      }],
    },
  }, null, 2));
  return filePath;
}

function sessionInput(filePath, overrides = {}) {
  const executionId = overrides.executionId || 'exec-1';
  const nodeId = overrides.nodeId || 'task-1';
  return {
    filePath,
    nodeId,
    executionId,
    taskKind: 'breakdown',
    status: 'running',
    workerId: 'worker-1',
    session: {
      provider: 'codex',
      sessionId: 'thread-1',
      surface: 'app-server',
      modelId: 'gpt-test',
      effort: 'medium',
      openUri: `vscode://chanterxiao.infinite-map/session/open?v=1&executionId=${executionId}&map=tasks.km&nodeId=${nodeId}`,
    },
    ...overrides,
  };
}

test('km_record_session dry-run is zero-write and actual recording preserves claim hashes', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-session-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const filePath = createMap(tempDir);
  const claim = await claimTodos(filePath, 'worker-1', { nodeIds: ['task-1'] });
  const before = (await readKmFile(filePath)).root.children[0];
  const beforeHash = getNodeHash(before);
  const input = sessionInput(filePath, { claimId: claim.claimId });

  const dryRun = await recordSession({ ...input, dryRun: true });
  assert.equal(dryRun.dryRun, true);
  assert.equal(fs.existsSync(getSessionStatePath(filePath)), false);
  assert.equal((await readKmFile(filePath)).root.children[0].data.infiniteMap, undefined);

  const recorded = await recordSession(input);
  assert.equal(recorded.created, true);
  const node = (await readKmFile(filePath)).root.children[0];
  assert.equal(getNodeHash(node), beforeHash);
  assert.equal(node.data.infiniteMap.latestSession.executionId, 'exec-1');
  assert.equal(node.data.hyperlink, 'https://example.com');
  assert.equal(node.data.note, 'keep me');
  assert.deepEqual(node.data.resource, ['待拆解']);

  await completeClaim(filePath, claim.claimId, ['task-1']);
  await recordSession({ ...input, status: 'completed', resultRevision: await getKmFileRevision(filePath) });
  const page = await listNodeSessions(filePath, 'task-1');
  assert.equal(page.total, 1);
  assert.equal(page.sessions[0].status, 'completed');
  assert.deepEqual(page.sessions[0].session.sessionId, 'thread-1');
});

test('session history is idempotent, paginated, recoverable, and marks orphan nodes', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-session-history-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const filePath = createMap(tempDir);
  await recordSession(sessionInput(filePath, { status: 'failed' }));
  await recordSession(sessionInput(filePath, {
    executionId: 'exec-2',
    status: 'cancelled',
    session: {
      provider: 'claudecode',
      sessionId: 'claude-2',
      surface: 'claude-agent-sdk',
      openUri: 'vscode://chanterxiao.infinite-map/session/open?v=1&executionId=exec-2&map=tasks.km&nodeId=task-1',
    },
  }));
  const firstPage = await listNodeSessions(filePath, 'task-1', undefined, 1);
  assert.equal(firstPage.total, 2);
  assert.equal(firstPage.sessions.length, 1);
  assert.equal(firstPage.nextCursor, '1');
  const secondPage = await listNodeSessions(filePath, 'task-1', firstPage.nextCursor, 1);
  assert.equal(secondPage.sessions.length, 1);
  assert.equal(secondPage.nextCursor, null);
	const filePage = await listFileSessions(filePath, undefined, 1);
	assert.equal(filePage.nodeId, null);
	assert.equal(filePage.total, 2);
	assert.equal(filePage.sessions[0].executionId, 'exec-2');
	assert.equal(filePage.nextCursor, '1');

  fs.writeFileSync(getSessionStatePath(filePath), '{bad json');
  const recovered = await listNodeSessions(filePath, 'task-1');
  assert.equal(recovered.total, 1);
  assert.equal(recovered.sessions[0].executionId, 'exec-2');
  assert.ok(fs.readdirSync(tempDir).some((name) => name.includes('.sessions.json.corrupt-')));

  const doc = await readKmFile(filePath);
  doc.root.children = [];
  fs.writeFileSync(filePath, JSON.stringify(doc, null, 2));
  assert.equal((await listNodeSessions(filePath, 'task-1')).orphan, true);
});

test('host can persist an unbound session before an agent claims a KM node', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-host-session-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const filePath = createMap(tempDir);
  const input = {
    filePath,
    executionId: 'host-exec-1',
    status: 'running',
    workerId: 'infinite-map-host:test',
    session: {
      provider: 'codex',
      sessionId: 'host-thread-1',
      surface: 'app-server',
      openUri: 'vscode://chanterxiao.infinite-map/session/open?v=1&executionId=host-exec-1&map=tasks.km',
    },
  };

  await assert.rejects(
    recordSession({ ...input, workerId: 'agent-worker' }),
    /只能由扩展宿主创建或更新/
  );

  const dryRun = await recordSession({ ...input, dryRun: true });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.nodeId, null);
  assert.equal(fs.existsSync(getSessionStatePath(filePath)), false);

  const recorded = await recordSession(input);
  assert.equal(recorded.created, true);
  assert.equal(recorded.nodeId, null);
  const page = await listFileSessions(filePath);
  assert.equal(page.total, 1);
  assert.equal(page.sessions[0].executionId, 'host-exec-1');
  assert.equal(page.sessions[0].nodeId, undefined);

  await recordSession({ ...input, status: 'idle' });
  const updated = await listFileSessions(filePath);
  assert.equal(updated.total, 1);
  assert.equal(updated.sessions[0].status, 'idle');
});

test('session recording rejects claim impersonation, unsafe links, and stale collaboration context', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-session-security-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const filePath = createMap(tempDir);
  const claim = await claimTodos(filePath, 'worker-1', { nodeIds: ['task-1'] });
  await assert.rejects(
    recordSession(sessionInput(filePath, { claimId: 'wrong-claim' })),
    /claimId 不匹配/
  );
  await assert.rejects(
    recordSession(sessionInput(filePath, {
      claimId: claim.claimId,
      session: {
        provider: 'codex',
        sessionId: 'thread-1',
        surface: 'app-server',
        openUri: 'file:///Users/private/tasks.km',
      },
    })),
    /Deep Link/
  );

  const collaborationDir = path.join(tempDir, 'collaboration');
  fs.mkdirSync(collaborationDir);
  const collaborationPath = createMap(collaborationDir, '待协同');
  await assert.rejects(
    recordSession(sessionInput(collaborationPath, { taskKind: 'collaboration' })),
    /expectedRevision/
  );
});

test('completion and release tools atomically update task and session terminal state', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-session-terminal-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const completedDir = path.join(tempDir, 'completed');
  fs.mkdirSync(completedDir);
  const completedPath = createMap(completedDir);
  const completeLease = await claimTodos(completedPath, 'worker-1', { nodeIds: ['task-1'] });
  await recordSession(sessionInput(completedPath, { claimId: completeLease.claimId }));
  await completeClaim(
    completedPath,
    completeLease.claimId,
    ['task-1'],
    true,
    { executionId: 'exec-1', summary: 'done' }
  );
  assert.deepEqual((await readKmFile(completedPath)).root.children[0].data.resource, ['待拆解']);
  assert.equal((await listNodeSessions(completedPath, 'task-1')).sessions[0].status, 'running');

  await completeClaim(
    completedPath,
    completeLease.claimId,
    ['task-1'],
    false,
    { executionId: 'exec-1', summary: 'done' }
  );
  const completedNode = (await readKmFile(completedPath)).root.children[0];
  assert.deepEqual(completedNode.data.resource, ['已完成']);
  assert.equal(completedNode.data.infiniteMap.latestSession.status, 'completed');
  assert.equal((await listNodeSessions(completedPath, 'task-1')).sessions[0].summary, 'done');

  const failedDir = path.join(tempDir, 'failed');
  fs.mkdirSync(failedDir);
  const failedPath = createMap(failedDir);
  const failedLease = await claimTodos(failedPath, 'worker-1', { nodeIds: ['task-1'] });
  await recordSession(sessionInput(failedPath, { claimId: failedLease.claimId }));
  await releaseClaim(failedPath, failedLease.claimId, {
    failReason: 'provider stopped',
    sessionUpdate: { executionId: 'exec-1' },
  });
  const failedNode = (await readKmFile(failedPath)).root.children[0];
  assert.deepEqual(failedNode.data.resource, ['待拆解']);
  assert.equal(failedNode.data.infiniteMap.latestSession.status, 'failed');
  assert.equal((await listNodeSessions(failedPath, 'task-1')).sessions[0].error.message, 'provider stopped');
  assert.equal((await readExecState(failedPath)).tasks['task-1'].state, 'failed');
});

test('single-writer and collaboration completion persist session links with generated nodes', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-session-writeback-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const todoDir = path.join(tempDir, 'todo');
  fs.mkdirSync(todoDir);
  const todoPath = createMap(todoDir);
  await recordSession(sessionInput(todoPath));
  await markNodesDone(
    todoPath,
    ['task-1'],
    false,
    await getKmFileRevision(todoPath),
    { executionId: 'exec-1' }
  );
  assert.equal((await readKmFile(todoPath)).root.children[0].data.infiniteMap.latestSession.status, 'completed');

  const collaborationDir = path.join(tempDir, 'collaboration');
  fs.mkdirSync(collaborationDir);
  const collaborationPath = createMap(collaborationDir, '待协同');
  const initialRevision = await getKmFileRevision(collaborationPath);
  await recordSession(sessionInput(collaborationPath, {
    taskKind: 'collaboration',
    expectedRevision: initialRevision,
  }));
  const expanded = await expandCollaborationTask(
    collaborationPath,
    'task-1',
    await getKmFileRevision(collaborationPath),
    ['Child A'],
    false,
    { executionId: 'exec-1' }
  );
  const expandedNode = (await readKmFile(collaborationPath)).root.children[0];
  assert.equal(expandedNode.data.infiniteMap.latestSession.status, 'completed');
  assert.equal(expandedNode.children[0].data.infiniteMap.originExecutionId, 'exec-1');
  assert.deepEqual(
    (await listNodeSessions(collaborationPath, 'task-1')).sessions[0].generatedNodeIds,
    expanded.appendedChildren.map((child) => child.nodeId)
  );

  const claimedDir = path.join(tempDir, 'claimed-collaboration');
  fs.mkdirSync(claimedDir);
  const claimedPath = createMap(claimedDir, '待协同');
  const lease = await claimCollaborationTasks(claimedPath, 'worker-1', { nodeIds: ['task-1'] });
  await recordSession(sessionInput(claimedPath, {
    taskKind: 'collaboration',
    claimId: lease.claimId,
    expectedRevision: await getKmFileRevision(claimedPath),
  }));
  await completeCollaborationClaim(
    claimedPath,
    lease.claimId,
    [{ nodeId: 'task-1', childTexts: ['Child B'] }],
    false,
    { executionId: 'exec-1' }
  );
  const claimedNode = (await readKmFile(claimedPath)).root.children[0];
  assert.equal(claimedNode.data.infiniteMap.latestSession.status, 'completed');
  assert.equal(claimedNode.children[0].data.infiniteMap.originExecutionId, 'exec-1');
});

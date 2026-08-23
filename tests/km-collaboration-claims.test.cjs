const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

require('ts-node/register/transpile-only');
const {
  claimCollaborationTasks,
  completeCollaborationClaim,
} = require('../src/mcp/services/kmCollaborationClaims.ts');
const {
  completeClaim,
  readExecState,
  releaseClaim,
  renewClaim,
} = require('../src/mcp/services/kmExecState.ts');
const {
  getKmFileRevision,
  listCollaborationTasks,
  readKmFile,
} = require('../src/mcp/services/kmFileReader.ts');
const { expandCollaborationTask } = require('../src/mcp/services/kmFileWriter.ts');

const COLLABORATION = '待协同';
const DONE = '已完成';

function createNode(id, text = id, labels = [], children = []) {
  return {
    data: {
      id,
      created: 1,
      text,
      ...(labels.length > 0 ? { resource: [...labels] } : {}),
    },
    children,
  };
}

function createFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-collab-claims-'));
  const filePath = path.join(directory, 'fixture.km');
  const document = {
    root: createNode('root', 'root', [], [
      createNode('collab-a', 'collaboration A', [COLLABORATION], [
        createNode('existing-a', 'existing A'),
      ]),
      createNode('collab-b', 'collaboration B', [COLLABORATION]),
    ]),
  };

  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(filePath, JSON.stringify(document, null, 2), 'utf8');
  return filePath;
}

test('claims collaboration tasks without modifying the KM file', async (t) => {
  const filePath = createFixture(t);
  const before = fs.readFileSync(filePath, 'utf8');
  const revision = await getKmFileRevision(filePath);

  const claim = await claimCollaborationTasks(filePath, 'agent-a', {
    expectedFileRevision: revision,
  });

  assert.ok(claim.claimId);
  assert.equal(claim.claimedCount, 2);
  assert.deepEqual(claim.tasks.map((task) => task.nodeId), ['collab-a', 'collab-b']);
  assert.ok(claim.tasks.every((task) => task.baseSubtreeHash));
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);

  const execState = await readExecState(filePath);
  assert.equal(execState.tasks['collab-a'].taskKind, 'collaboration');
  assert.equal(execState.tasks['collab-a'].state, 'claimed');
});

test('different workers complete independent collaboration nodes after unrelated writes', async (t) => {
  const filePath = createFixture(t);
  const first = await claimCollaborationTasks(filePath, 'agent-a', { nodeIds: ['collab-a'] });
  const second = await claimCollaborationTasks(filePath, 'agent-b', { nodeIds: ['collab-b'] });

  const completedA = await completeCollaborationClaim(filePath, first.claimId, [
    { nodeId: 'collab-a', childTexts: ['idea A1', 'idea A2'] },
  ]);
  assert.equal(completedA.verified, true);

  // collab-a 写回改变了全文件 revision，但 collab-b 子树未变，旧 claim 仍可安全完成。
  const completedB = await completeCollaborationClaim(filePath, second.claimId, [
    { nodeId: 'collab-b', childTexts: ['idea B1'] },
  ]);
  assert.equal(completedB.verified, true);
  assert.equal((await listCollaborationTasks(filePath)).taskCount, 0);

  const doc = await readKmFile(filePath);
  for (const node of doc.root.children) {
    assert.deepEqual(node.data.resource, [DONE]);
  }
});

test('dry-run previews collaboration completion without writing', async (t) => {
  const filePath = createFixture(t);
  const claim = await claimCollaborationTasks(filePath, 'agent-a', { nodeIds: ['collab-a'] });
  const before = fs.readFileSync(filePath, 'utf8');

  const result = await completeCollaborationClaim(
    filePath,
    claim.claimId,
    [{ nodeId: 'collab-a', childTexts: ['idea one'] }],
    true
  );

  assert.equal(result.dryRun, true);
  assert.equal(result.completedCount, 1);
  assert.equal(result.appendedCount, 1);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  assert.equal((await readExecState(filePath)).tasks['collab-a'].state, 'claimed');
});

test('session trace metadata does not invalidate a collaboration claim', async (t) => {
  const filePath = createFixture(t);
  const claim = await claimCollaborationTasks(filePath, 'agent-a', { nodeIds: ['collab-a'] });
  const doc = await readKmFile(filePath);
  doc.root.children[0].data.infiniteMap = {
    latestSession: { executionId: 'exec-1', provider: 'codex' },
  };
  fs.writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf8');

  const result = await completeCollaborationClaim(filePath, claim.claimId, [
    { nodeId: 'collab-a', childTexts: ['idea after session binding'] },
  ]);
  assert.equal(result.verified, true);
});

test('rejects completion when the claimed collaboration subtree changed', async (t) => {
  const filePath = createFixture(t);
  const claim = await claimCollaborationTasks(filePath, 'agent-a', { nodeIds: ['collab-a'] });
  const doc = await readKmFile(filePath);
  doc.root.children[0].children[0].data.text = 'manually changed';
  fs.writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf8');
  const before = fs.readFileSync(filePath, 'utf8');

  await assert.rejects(
    completeCollaborationClaim(filePath, claim.claimId, [
      { nodeId: 'collab-a', childTexts: ['stale idea'] },
    ]),
    /子树在认领后已被修改/
  );
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
});

test('batch completion is all-or-nothing when one target conflicts', async (t) => {
  const filePath = createFixture(t);
  const claim = await claimCollaborationTasks(filePath, 'agent-a');
  const doc = await readKmFile(filePath);
  doc.root.children[1].data.text = 'collaboration B changed';
  fs.writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf8');
  const before = fs.readFileSync(filePath, 'utf8');

  await assert.rejects(
    completeCollaborationClaim(filePath, claim.claimId, [
      { nodeId: 'collab-a', childTexts: ['idea A'] },
      { nodeId: 'collab-b', childTexts: ['idea B'] },
    ]),
    /子树在认领后已被修改/
  );
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  assert.equal((await listCollaborationTasks(filePath)).taskCount, 2);
});

test('collaboration claims reuse renew and release, then can be reclaimed', async (t) => {
  const filePath = createFixture(t);
  const claim = await claimCollaborationTasks(filePath, 'agent-a', { nodeIds: ['collab-a'] });
  const renewed = await renewClaim(filePath, claim.claimId, 'agent-a', 1200);
  assert.equal(renewed.renewedCount, 1);

  const released = await releaseClaim(filePath, claim.claimId, { failReason: 'agent failed' });
  assert.equal(released.state, 'failed');
  assert.deepEqual((await readKmFile(filePath)).root.children[0].data.resource, [COLLABORATION]);

  const reclaimed = await claimCollaborationTasks(filePath, 'agent-b', {
    nodeIds: ['collab-a'],
  });
  assert.equal(reclaimed.claimedCount, 1);
  assert.equal(reclaimed.workerId, 'agent-b');
});

test('legacy completion tools cannot bypass an active collaboration lease', async (t) => {
  const filePath = createFixture(t);
  const claim = await claimCollaborationTasks(filePath, 'agent-a', { nodeIds: ['collab-a'] });
  const revision = await getKmFileRevision(filePath);

  await assert.rejects(
    expandCollaborationTask(filePath, 'collab-a', revision, ['legacy idea']),
    /km_complete_collaboration_claim/
  );
  await assert.rejects(
    completeClaim(filePath, claim.claimId),
    /km_complete_collaboration_claim/
  );
});

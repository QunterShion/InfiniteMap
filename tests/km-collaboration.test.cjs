const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

require('ts-node/register/transpile-only');
const {
  getCollaborationContext,
  listCollaborationTasks,
  readKmFile,
} = require('../src/mcp/services/kmFileReader.ts');
const {
  expandCollaborationTask,
  validateKmFile,
} = require('../src/mcp/services/kmFileWriter.ts');

const COLLABORATION = '\u5f85\u534f\u540c';
const DONE = '\u5df2\u5b8c\u6210';

function createNode(id, text, labels, children = []) {
  const data = { id, created: 1, text };
  if (labels) {
    data.resource = labels;
  }
  return { data, children };
}

function createFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-collaboration-'));
  const filePath = path.join(directory, 'fixture.km');
  const document = {
    root: createNode('root', 'root', undefined, [
      createNode('section', 'section', undefined, [
        createNode('before', 'before'),
        createNode('target', 'target', [COLLABORATION], [
          createNode('existing-child', 'existing child'),
        ]),
        createNode('after', 'after'),
      ]),
    ]),
  };

  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(filePath, JSON.stringify(document, null, 2), 'utf8');
  return filePath;
}

test('rereads the current file when listing collaboration tasks', async (t) => {
  const filePath = createFixture(t);
  const first = await listCollaborationTasks(filePath);
  assert.equal(first.taskCount, 1);
  assert.equal(first.tasks[0].path, 'root > section > target');

  const document = await readKmFile(filePath);
  document.root.children[0].children[2].data.resource = [COLLABORATION];
  fs.writeFileSync(filePath, JSON.stringify(document, null, 2), 'utf8');

  const second = await listCollaborationTasks(filePath);
  assert.equal(second.taskCount, 2);
  assert.notEqual(second.fileRevision, first.fileRevision);
  assert.deepEqual(second.tasks.map((task) => task.nodeId), ['target', 'after']);
});

test('returns root path, subtree, and bounded sibling context', async (t) => {
  const filePath = createFixture(t);
  const context = await getCollaborationContext(filePath, 'target', 1);

  assert.equal(context.nodePath, 'root > section > target');
  assert.deepEqual(context.ancestors.map((node) => node.nodeId), ['root', 'section']);
  assert.equal(context.node.data.id, 'target');
  assert.equal(context.node.children[0].data.id, 'existing-child');
  assert.equal(context.siblingCount, 2);
  assert.equal(context.siblings.length, 1);
});

test('dry-runs then appends unlabeled children and completes the parent', async (t) => {
  const filePath = createFixture(t);
  const context = await getCollaborationContext(filePath, 'target');
  const before = fs.readFileSync(filePath, 'utf8');

  const dryRun = await expandCollaborationTask(
    filePath,
    'target',
    context.fileRevision,
    ['idea one', 'idea two'],
    true
  );
  assert.equal(dryRun.appendedCount, 2);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);

  const result = await expandCollaborationTask(
    filePath,
    'target',
    context.fileRevision,
    ['idea one', 'idea two'],
    false
  );
  assert.equal(result.verified, true);
  assert.equal(result.parentCompleted, true);
  assert.notEqual(result.revisionAfter, result.revisionBefore);
  assert.equal((await listCollaborationTasks(filePath)).taskCount, 0);
  assert.equal((await validateKmFile(filePath)).valid, true);

  const document = await readKmFile(filePath);
  const target = document.root.children[0].children[1];
  assert.deepEqual(target.data.resource, [DONE]);
  assert.deepEqual(
    target.children.slice(-2).map((node) => ({ text: node.data.text, labels: node.data.resource })),
    [
      { text: 'idea one', labels: undefined },
      { text: 'idea two', labels: undefined },
    ]
  );
});

test('rejects collaboration writes based on a stale file revision', async (t) => {
  const filePath = createFixture(t);
  const context = await getCollaborationContext(filePath, 'target');
  const document = await readKmFile(filePath);
  document.root.data.text = 'changed root';
  fs.writeFileSync(filePath, JSON.stringify(document, null, 2), 'utf8');

  await assert.rejects(
    expandCollaborationTask(
      filePath,
      'target',
      context.fileRevision,
      ['should not persist'],
      false
    ),
    /KM \u6587\u4ef6\u7248\u672c\u5df2\u53d8\u5316/
  );

  const target = (await readKmFile(filePath)).root.children[0].children[1];
  assert.equal(target.children.length, 1);
  assert.deepEqual(target.data.resource, [COLLABORATION]);
});

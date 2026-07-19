const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

require('ts-node/register/transpile-only');
const { listTodos } = require('../src/mcp/services/kmFileReader.ts');
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

test('marks a selected parent and its selected descendants in one batch', (t) => {
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
  const dryRun = markNodesDone(filePath, nodeIds, true);
  assert.equal(dryRun.modified, 3);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);

  const result = markNodesDone(filePath, nodeIds, false);
  assert.equal(result.modified, 3);
  assert.equal(result.verified, true);
  assert.deepEqual(listTodos(filePath).map((todo) => todo.nodeId), ['root']);

  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const parent = persisted.root.children[0];
  assert.deepEqual(parent.data.resource, [DONE]);
  assert.deepEqual(parent.children[0].data.resource, [DONE]);
  assert.deepEqual(parent.children[1].data.resource, [DONE]);
});

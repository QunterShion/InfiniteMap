const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

require('ts-node/register/transpile-only');
const {
  RootNameSyncEventGuard,
  getKmFileStem,
  getKmRootText,
  planFileRenameAfterRootEdit,
  planRootUpdateAfterFileRename,
  replaceKmRootText,
  validateKmRootName,
} = require('../src/rootNameSync.ts');

function km(rootText, extra = '') {
  return `{
  "root": {
    "data": { "text": ${JSON.stringify(rootText)}, "priority": 2 },
    "children": []
  },
  "unsafeInteger": 9007199254740993123456789${extra}
}\n`;
}

function emptyProbe() {
  return {
    exists: async () => false,
  };
}

test('a .km file rename updates only the root text token', () => {
  const original = km('Old title');
  const plan = planRootUpdateAfterFileRename('/maps/New title.km', original);

  assert.equal(plan.kind, 'update-root');
  assert.equal(plan.rootText, 'New title');
  assert.equal(plan.expectedContent, original);
  assert.equal(getKmRootText(plan.content), 'New title');
  assert.equal(
    plan.content.replace('"New title"', '"Old title"'),
    original,
    'non-root bytes, formatting, and unsafe integer lexemes must remain untouched'
  );
});

test('root replacement handles escaped strings and effective duplicate JSON keys', () => {
  const content = '{"root":{"data":{"text":"ignored"}},"root":{"data":{"text":"a\\\"b"},"other":1}}';
  const updated = replaceKmRootText(content, 'final\\name');

  assert.equal(getKmRootText(content), 'a"b');
  assert.equal(getKmRootText(updated), 'final\\name');
  assert.equal(updated.startsWith('{"root":{"data":{"text":"ignored"}}'), true);
  assert.deepEqual(JSON.parse(updated).root.data, { text: 'final\\name' });
  assert.equal(JSON.parse(updated).root.other, 1);
});

test('already equal names converge to a no-op in both directions', async () => {
  const content = km('Roadmap');

  assert.deepEqual(
    planRootUpdateAfterFileRename('/maps/Roadmap.km', content),
    { kind: 'noop', reason: 'already-synchronized', filePath: '/maps/Roadmap.km' }
  );
  assert.deepEqual(
    await planFileRenameAfterRootEdit('/maps/Roadmap.km', content, emptyProbe()),
    { kind: 'noop', reason: 'already-synchronized', filePath: '/maps/Roadmap.km' }
  );
});

test('a valid root edit creates a same-directory rename plan without changing content', async () => {
  const content = km('Release plan');
  const plan = await planFileRenameAfterRootEdit('/maps/Draft.km', content, emptyProbe());

  assert.deepEqual(plan, {
    kind: 'rename-file',
    fromPath: '/maps/Draft.km',
    toPath: '/maps/Release plan.km',
    content,
    rootText: 'Release plan',
    caseOnly: false,
  });
});

test('an occupied target blocks the root-driven rename instead of overwriting it', async () => {
  const content = km('Existing');
  const plan = await planFileRenameAfterRootEdit('/maps/Draft.km', content, {
    exists: async (candidate) => candidate === '/maps/Existing.km',
    isSameFile: async () => false,
  });

  assert.equal(plan.kind, 'blocked');
  assert.equal(plan.code, 'target-collision');
  assert.equal(plan.targetPath, '/maps/Existing.km');
});

test('case-only renames are allowed only when the occupied spelling is the same file', async () => {
  const content = km('roadmap');
  const sameFilePlan = await planFileRenameAfterRootEdit('/maps/Roadmap.km', content, {
    exists: async () => true,
    isSameFile: async () => true,
  });
  const collisionPlan = await planFileRenameAfterRootEdit('/maps/Roadmap.km', content, {
    exists: async () => true,
    isSameFile: async () => false,
  });

  assert.equal(sameFilePlan.kind, 'rename-file');
  assert.equal(sameFilePlan.caseOnly, true);
  assert.equal(sameFilePlan.toPath, '/maps/roadmap.km');
  assert.equal(collisionPlan.kind, 'blocked');
  assert.equal(collisionPlan.code, 'target-collision');
});

test('invalid and non-portable root names are rejected without sanitizing text', async (t) => {
  const invalidNames = [
    '',
    '.',
    '..',
    'folder/name',
    'folder\\name',
    'question?',
    'colon:name',
    'line\nbreak',
    'trailing.',
    'trailing ',
    'CON',
    'nul.notes',
    `${'界'.repeat(84)}a`,
  ];

  for (const rootText of invalidNames) {
    await t.test(JSON.stringify(rootText), async () => {
      const validation = validateKmRootName(rootText);
      assert.equal(validation.valid, false);
      const plan = await planFileRenameAfterRootEdit('/maps/Original.km', km(rootText), emptyProbe());
      assert.equal(plan.kind, 'blocked');
      assert.equal(plan.code, 'invalid-root-name');
    });
  }
});

test('a filename at the portable byte limit is accepted', () => {
  assert.equal(validateKmRootName('a'.repeat(252)).valid, true);
  assert.equal(validateKmRootName('a'.repeat(253)).valid, false);
});

test('invalid documents are blocked and unsupported extensions are ignored', async () => {
  const invalid = '{"root":{"data":{}}}';
  const renamePlan = planRootUpdateAfterFileRename('/maps/Renamed.km', invalid);
  const editPlan = await planFileRenameAfterRootEdit('/maps/Old.km', invalid, emptyProbe());

  assert.equal(renamePlan.kind, 'blocked');
  assert.equal(renamePlan.code, 'invalid-document');
  assert.equal(editPlan.kind, 'blocked');
  assert.equal(editPlan.code, 'invalid-document');
  assert.deepEqual(
    planRootUpdateAfterFileRename('/maps/Renamed.xmind', invalid),
    { kind: 'noop', reason: 'not-a-km-file', filePath: '/maps/Renamed.xmind' }
  );
  assert.equal(getKmFileStem('/maps/UPPER.KM'), 'UPPER');
  assert.equal(getKmFileStem('/maps/.km'), undefined);
});

test('self-generated rename and root-write notifications are consumed once and expire', () => {
  let currentTime = 100;
  const guard = new RootNameSyncEventGuard(() => currentTime, 50);
  const oldPath = path.resolve('/maps/Old.km');
  const newPath = path.resolve('/maps/New.km');

  guard.rememberRename(oldPath, newPath);
  assert.equal(guard.consumeRename(oldPath, newPath), true);
  assert.equal(guard.consumeRename(oldPath, newPath), false);

  guard.rememberRootWrite(newPath, 'New');
  assert.equal(guard.consumeRootWrite(newPath, 'Other'), false);

  guard.rememberRootWrite(newPath, 'New');
  currentTime = 151;
  assert.equal(guard.consumeRootWrite(newPath, 'New'), false);

  guard.rememberRename(oldPath, newPath);
  currentTime = 202;
  assert.equal(guard.consumeRename(oldPath, newPath), false);
});

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { runInNewContext } = require('node:vm');

const source = readFileSync(
  join(__dirname, '..', 'webui/node_modules/kityminder-core/src/module/view.js'),
  'utf8',
);

function loadBoundaryCorrection() {
  const start = source.indexOf('function calculateBoundaryCorrection');
  const end = source.indexOf('\n\n    var ViewDragger', start);
  assert.ok(start >= 0 && end > start, 'boundary correction helper should be defined');
  return runInNewContext(`(${source.slice(start, end)})`);
}

test('view boundary centers content that is smaller than the viewport', () => {
  const correct = loadBoundaryCorrection();

  assert.equal(correct(0, 1000, 400, 600), 0);
  assert.equal(correct(-500, 500, 400, 600), -500);
  assert.equal(correct(500, 1500, 400, 600), 500);
});

test('view boundary clamps both edges for content larger than the viewport', () => {
  const correct = loadBoundaryCorrection();

  assert.equal(correct(-200, 800, 0, 2000), -200);
  assert.equal(correct(1200, 2200, 0, 2000), 200);
  assert.equal(correct(500, 1500, 0, 2000), 0);
});

test('all view movement uses the live content boundary', () => {
  assert.match(source, /position = this\.constrainPosition\(position\)/);
  assert.match(source, /getRenderContainer\(\)\.getBoundaryBox\(\)/);
  assert.match(source, /viewBoundaryPadding:\s*120/);
  assert.match(source, /zoom:\s*function\(\) \{[\s\S]*?constrainToContent\(\)/);
  assert.match(source, /'selectionchange layoutallfinish':[\s\S]*?constrainToContent\(\)/);
});

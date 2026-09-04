const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const source = readFileSync(join(__dirname, '..', 'webui/node_modules/kityminder-core/src/module/expand.js'), 'utf8');
function intersect(box, vertex, direction) {
  const tx = direction.x > 0 ? (box.right - vertex.x) / direction.x : direction.x < 0 ? (box.left - vertex.x) / direction.x : Infinity;
  const ty = direction.y > 0 ? (box.bottom - vertex.y) / direction.y : direction.y < 0 ? (box.top - vertex.y) / direction.y : Infinity;
  const hit = Math.min(tx >= 0 ? tx : Infinity, ty >= 0 ? ty : Infinity);
  assert(Number.isFinite(hit) && hit >= 0);
  return { x: vertex.x + direction.x * hit, y: vertex.y + direction.y * hit };
}
test('reverse expander is attached to current node and uses ray-box positioning', () => {
  assert.match(source, /node\.getRenderContainer\(\)\.prependShape\(this\.expanderReverse\)/);
  assert.match(source, /node\.getContentBox\(\)/);
  assert.match(source, /node\.getLayoutVectorIn\(\)/);
  assert.doesNotMatch(source, /getVertexOut\(\).*expanderReverse/);
});

test('reverse expander collapses and restores the current node with its descendants', () => {
  const collapsedStateStart = source.indexOf('function hasCollapsedBranch(node) {');
  const actionStart = source.indexOf('function setSubtreeExpanded(node, shouldExpand) {');
  const rendererStart = source.indexOf('var ExpanderRenderer', actionStart);
  const collapsedState = source.slice(collapsedStateStart, actionStart);
  const action = source.slice(actionStart, rendererStart);

  assert.ok(collapsedStateStart >= 0, 'reverse-expander subtree state check should be defined');
  assert.ok(actionStart >= 0 && rendererStart > actionStart, 'reverse-expander subtree action should be defined');
  assert.match(action, /node\.traverse\(function\(current\)/);
  assert.match(action, /current\.children\.length > 0/);
  assert.match(action, /current\.expand\(\)/);
  assert.match(action, /current\.collapse\(\)/);
  assert.match(collapsedState, /node\.traverse\(function\(current\)/);
  assert.match(collapsedState, /!current\.isExpanded\(\)/);
  assert.doesNotMatch(action, /current\s*!==\s*node/);
  assert.doesNotMatch(collapsedState, /current\s*!==\s*node/);
  assert.match(source, /var shouldExpand = hasCollapsedBranch\(node\);[\s\S]*?setSubtreeExpanded\(node, shouldExpand\);/);
});
test('reverse expander ray intersection handles orthogonal and fishbone directions', () => {
  const box = { left: -40, top: -20, right: 60, bottom: 20 };
  const cases = [
    [{ x: -40, y: 0 }, { x: 1, y: 0 }], [{ x: 60, y: 0 }, { x: -1, y: 0 }],
    [{ x: 0, y: -20 }, { x: 0, y: 1 }], [{ x: 0, y: 20 }, { x: 0, y: -1 }],
    [{ x: -40, y: -20 }, { x: 1, y: 1 }], [{ x: -40, y: 20 }, { x: 1, y: -1 }],
    [{ x: -40, y: -10 }, { x: 2, y: 1 }], [{ x: 60, y: 20 }, { x: 1, y: -2 }],
  ];
  for (const [vertex, direction] of cases) {
    const edge = intersect(box, vertex, direction);
    assert.ok(edge.x >= box.left && edge.x <= box.right);
    assert.ok(edge.y >= box.top && edge.y <= box.bottom);
    assert.ok((edge.x - vertex.x) * direction.x + (edge.y - vertex.y) * direction.y >= 0);
  }
});

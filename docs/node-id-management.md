# Node ID Management

## Previous behavior

Every `MinderNode` received an ID from `utils.guid()` when constructed. The
generator combined the current timestamp and a random number, then encoded the
result in base 36. Collisions were unlikely, but the editor did not keep a
document-level registry to detect them.

The two copy paths could also bypass generation entirely:

- Native clipboard copy exported each node's full `data` object. During paste,
  `importNode()` replaced the newly created node data with the copied data,
  including the original ID.
- The in-memory clipboard used `MinderNode.clone()`, which cloned the complete
  data object and therefore cloned IDs recursively.

`getNodeById()` returns the first matching node, so duplicated IDs made node
lookup and MCP operations ambiguous.

## Current invariants

`NodeIdRuntime` now owns an in-memory ID-to-node registry for each editor:

1. Existing documents are scanned when loaded. The first occurrence of an ID
   is retained and later collisions receive new IDs.
2. Newly created and attached nodes are registered. Missing or already-owned
   IDs are replaced using a timestamp plus a monotonic per-millisecond suffix.
3. Native clipboard imports are reconciled after `importNode()` overwrites the
   provisional IDs. Copies therefore receive fresh IDs throughout the subtree.
4. Removed nodes release their registry entries, allowing undo and cut/paste to
   restore their identity when no live node owns the ID.
5. Dragging, reparenting, and sibling reordering operate on the same node
   objects. Re-registering the same object keeps its ID unchanged.

The registry is rebuilt after a full document import, so duplicate IDs from
older files are repaired before subsequent editing operations.

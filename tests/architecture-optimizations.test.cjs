const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

require('ts-node/register/transpile-only');
const {
  clearKmFileRevisionCache,
  getCachedKmFileRevision,
} = require('../src/mcp/services/kmRevisionCache.ts');
const { atomicWriteJsonFile } = require('../src/mcp/services/kmFileLock.ts');

const root = path.resolve(__dirname, '..');

test('KM revision cache reuses an unchanged mtime and atomic writes invalidate it', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-revision-cache-'));
  const filePath = path.join(directory, 'tasks.km');
  t.after(() => {
    clearKmFileRevisionCache();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.writeFileSync(filePath, '{"root":{"data":{"id":"root","text":"one"}}}');

  const originalRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function patchedRead(target, ...args) {
    if (path.resolve(String(target)) === filePath) reads += 1;
    return originalRead.call(this, target, ...args);
  };
  try {
    const first = getCachedKmFileRevision(filePath);
    assert.equal(getCachedKmFileRevision(filePath), first);
    assert.equal(reads, 1);
    atomicWriteJsonFile(filePath, '{"root":{"data":{"id":"root","text":"two"}}}');
    assert.notEqual(getCachedKmFileRevision(filePath), first);
    assert.equal(reads, 2);
  } finally {
    fs.readFileSync = originalRead;
  }
});

test('KM file lock is async and contains no event-loop blocking wait', () => {
  const source = fs.readFileSync(path.join(root, 'src/mcp/services/kmFileLock.ts'), 'utf8');
  assert.match(source, /export async function withKmFileLock/);
  assert.match(source, /await delay\(LOCK_RETRY_INTERVAL_MS\)/);
  assert.doesNotMatch(source, /Atomics\.wait|SharedArrayBuffer|sleepSync/);
});

test('legacy and agent Webview messages all carry protocolVersion 1', () => {
	const mindEditor = fs.readFileSync(path.join(root, 'src/mindEditor.ts'), 'utf8');
  const relativePaths = [
    'src/mindEditor.ts',
    'src/editor/MindEditorDocument.ts',
    'src/editor/ImportExportHandler.ts',
    'src/editor/ExecStateWatcher.ts',
    'src/sessions/agentControlBarCoordinator.ts',
    'webui/main.js',
    'webui/refreshBtn.js',
    'webui/src/runtime/node-split.js'
  ];
  for (const relative of relativePaths) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    const blocks = source.split(/postMessage\s*\(\s*\{/).slice(1);
    assert.ok(blocks.length > 0, `${relative} should send at least one message`);
    for (const block of blocks) {
      assert.match(block.slice(0, 240), /protocolVersion/, `${relative} contains an unversioned postMessage`);
    }
  }
	assert.match(
		fs.readFileSync(path.join(root, 'webui/ui/service/agentSession.service.js'), 'utf8'),
		/command: 'agentSession',[\s\S]*protocolVersion: protocolVersion/
	);
  assert.match(fs.readFileSync(path.join(root, 'webui/mindmap.html'), 'utf8'), /infiniteMapProtocolVersion = 1/);
  assert.match(fs.readFileSync(path.join(root, 'webui/mindmap.html'), 'utf8'), /infiniteMapDocumentUri = decodeURIComponent\("\$\{vscode_document_uri\}"\)/);
  assert.match(mindEditor, /encodeURIComponent\(document\.uri\.toString\(\)\)/);
});

test('rendered content hash suppresses redundant Webview imports', () => {
  const source = fs.readFileSync(path.join(root, 'src/editor/MindEditorDocument.ts'), 'utf8');
  assert.match(source, /lastRenderedHashes/);
  assert.match(source, /createHash\('sha256'\)/);
  assert.match(source, /contentHash === this\.lastRenderedHashes\.get\(docKey\)/);
});

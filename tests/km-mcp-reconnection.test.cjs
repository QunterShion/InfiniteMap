const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

require('ts-node/register/transpile-only');
const { KmMcpClient } = require('../src/mcpClient/kmMcpClient.ts');
const { REQUIRED_KM_TOOL_NAMES } = require('../src/mcpClient/kmToolContracts.ts');

function waitFor(predicate, message) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 3000;
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(message));
      setTimeout(check, 10);
    };
    check();
  });
}

test('KM MCP reconnects after a process exit without replaying the interrupted tool call', async (t) => {
  const extensionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-mcp-reconnect-'));
  const serverDir = path.join(extensionPath, 'dist', 'mcp');
  const healthyMarker = path.join(extensionPath, 'healthy');
  const callLog = path.join(extensionPath, 'calls.log');
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'server.js'), `
const fs = require('node:fs');
const readline = require('node:readline');
const healthyMarker = ${JSON.stringify(healthyMarker)};
const callLog = ${JSON.stringify(callLog)};
const tools = ${JSON.stringify(REQUIRED_KM_TOOL_NAMES)}.map((name) => ({ name }));
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (typeof request.id !== 'number') return;
  if (request.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n');
    return;
  }
  if (request.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools } }) + '\\n');
    return;
  }
  if (request.method === 'tools/call') {
    fs.appendFileSync(callLog, request.params.name + '\\n');
    if (!fs.existsSync(healthyMarker)) {
      fs.writeFileSync(healthyMarker, 'ready');
      process.exit(19);
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }
    }) + '\\n');
  }
});
`);

  const client = KmMcpClient.forWorkspace(`test:${extensionPath}`, {
    extensionPath,
    nodeExecutable: process.execPath,
    reconnectDelaysMs: [10, 20],
  });
  t.after(async () => {
    await client.dispose();
    fs.rmSync(extensionPath, { recursive: true, force: true });
  });

  const states = [];
  client.onDidChangeState((status) => states.push(status.state));
  await client.connect();
  assert.equal(client.state, 'ready');

  await assert.rejects(
    client.callTool({ name: 'km_validate', arguments: { filePath: '/tmp/test.km' } }),
    /disconnected/
  );
  await waitFor(() => client.state === 'ready' && states.includes('reconnecting'), 'KM MCP did not reconnect.');
  assert.equal(fs.readFileSync(callLog, 'utf8').trim().split('\n').length, 1, 'interrupted call was replayed');

  const response = await client.callTool({ name: 'km_validate', arguments: { filePath: '/tmp/test.km' } });
  assert.equal(response.content[0].text, '{"ok":true}');
  assert.equal(fs.readFileSync(callLog, 'utf8').trim().split('\n').length, 2);

  const connectingBeforeManualRestart = states.filter((state) => state === 'reconnecting').length;
  await client.reconnect();
  assert.equal(client.state, 'ready');
  assert.ok(
    states.filter((state) => state === 'reconnecting').length > connectingBeforeManualRestart,
    'manual reconnect did not restart a ready process'
  );
});

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

require('ts-node/register/transpile-only');
const {
  CodexRuntimeInstaller,
  CODEX_RUNTIME_VERSION,
} = require('../src/providers/codexRuntimeInstaller.ts');

const roots = [];

test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});

function harness(payload, expectedHash = createHash('sha256').update(payload).digest('hex')) {
  const storagePath = path.join(os.tmpdir(), `infinite-map-installer-${randomUUID()}`);
  roots.push(storagePath);
  const downloads = [];
  const verified = [];
  const installer = new CodexRuntimeInstaller({
    storagePath,
    platform: 'darwin',
    arch: 'arm64',
    asset: {
      fileName: 'codex-test.bin',
      sha256: expectedHash,
      format: 'executable',
    },
    downloadFile: async (url, destination) => {
      downloads.push({ url, destination });
      await fs.promises.writeFile(destination, payload);
    },
    verifyExecutable: async (executable) => {
      verified.push(executable);
      return 'codex-cli test';
    },
  });
  return { installer, downloads, verified };
}

test('Codex runtime is downloaded, checksum-verified, and installed under InfiniteMap storage', async () => {
  const payload = Buffer.from('signed-codex-test-binary');
  const { installer, downloads, verified } = harness(payload);
  const stages = [];

  const executable = await installer.install((stage) => stages.push(stage));

  assert.equal(executable, installer.executablePath);
  assert.deepEqual(stages, ['downloading', 'installing']);
  assert.equal(downloads.length, 1);
  assert.match(downloads[0].url, new RegExp(`rust-v${CODEX_RUNTIME_VERSION}/codex-test\\.bin$`));
  assert.equal(verified.length, 1);
  assert.match(verified[0], /\.install-[^/]+\/codex$/);
  assert.deepEqual(await fs.promises.readFile(executable), payload);
  assert.equal(await installer.isInstalled(), true);

  const metadata = JSON.parse(await fs.promises.readFile(path.join(path.dirname(executable), 'install.json'), 'utf8'));
  assert.equal(metadata.version, CODEX_RUNTIME_VERSION);
  assert.equal(metadata.asset, 'codex-test.bin');
});

test('checksum mismatch aborts installation and leaves no managed executable', async () => {
  const { installer } = harness(Buffer.from('tampered'), '0'.repeat(64));

  await assert.rejects(() => installer.install(), /checksum mismatch/);
  assert.equal(await installer.isInstalled(), false);
  assert.equal(fs.existsSync(installer.executablePath), false);
});

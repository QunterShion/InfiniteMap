const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

require('ts-node/register/transpile-only');
const { ManagedNpmRuntimeInstaller } = require('../src/providers/managedNpmRuntimeInstaller.ts');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-map-managed-provider-'));
  const packageRoot = path.join(root, 'source', 'package');
  fs.mkdirSync(packageRoot, { recursive: true });
  const executable = path.join(packageRoot, 'provider');
  fs.writeFileSync(executable, '#!/bin/sh\necho provider-v1\n', { mode: 0o755 });
  const archive = path.join(root, 'provider.tgz');
  execFileSync('tar', ['-czf', archive, '-C', path.join(root, 'source'), 'package']);
  const integrity = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(archive)).digest('base64')}`;
  return { root, archive, integrity };
}

test('managed SDK runtime is integrity-checked and atomically installed in InfiniteMap storage', async () => {
  const { root, archive, integrity } = fixture();
  const stages = [];
  const installer = new ManagedNpmRuntimeInstaller({
    storagePath: path.join(root, 'storage'),
    providerId: 'test-provider',
    version: '1.0.0',
    platform: 'darwin',
    arch: 'arm64',
    assets: {
      'darwin-arm64': {
        packageName: '@example/provider-darwin-arm64',
        integrity,
        executable: 'provider'
      }
    },
    downloadFile: async (_url, destination) => fs.promises.copyFile(archive, destination)
  });

  const executable = await installer.install((stage) => stages.push(stage));
  assert.deepEqual(stages, ['downloading', 'installing']);
  assert.equal(await installer.isInstalled(), true);
  assert.equal(execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim(), 'provider-v1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(executable)), 'install.json'), 'utf8')).providerId, 'test-provider');
  assert.equal(fs.existsSync(path.join(path.dirname(path.dirname(executable)), 'runtime.tgz')), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('managed SDK runtime rejects an integrity mismatch without installing an executable', async () => {
  const { root, archive } = fixture();
  const installer = new ManagedNpmRuntimeInstaller({
    storagePath: path.join(root, 'storage'),
    providerId: 'test-provider',
    version: '1.0.0',
    platform: 'darwin',
    arch: 'arm64',
    assets: {
      'darwin-arm64': {
        packageName: '@example/provider-darwin-arm64',
        integrity: 'sha512-AAAAAAAA',
        executable: 'provider'
      }
    },
    downloadFile: async (_url, destination) => fs.promises.copyFile(archive, destination)
  });

  await assert.rejects(() => installer.install(), /integrity mismatch/);
  assert.equal(await installer.isInstalled(), false);
  fs.rmSync(root, { recursive: true, force: true });
});

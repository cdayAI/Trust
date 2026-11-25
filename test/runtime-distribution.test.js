'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdir, mkdtemp, rm, symlink, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { checkRuntime } = require('../scripts/runtime-check');
const { sourceManifest } = require('../scripts/package-release');

test('local distribution enforces the Node.js floor and verifies built-in SQLite when requested', () => {
  assert.throws(() => checkRuntime({ version: '22.12.0' }), /22\.13\.0 or newer/);
  assert.throws(() => checkRuntime({ version: '21.99.99' }), /22\.13\.0 or newer/);
  assert.doesNotThrow(() => checkRuntime({ version: '22.13.0' }));
  assert.doesNotThrow(() => checkRuntime({ version: '23.0.0' }));
  assert.equal(checkRuntime().sqlite, undefined);
  assert.match(checkRuntime({ sqlite: true }).sqlite, /^3\./);
});

test('source release hashes the explicit inventory and refuses unsafe and private input paths', async t => {
  const { manifest } = sourceManifest(resolve(__dirname, '..'));
  assert.ok(manifest.files.some(file => file.path === 'server.js'));
  assert.ok(manifest.files.some(file => file.path === 'start-isolated.js'));
  assert.ok(manifest.files.some(file => file.path === 'public/index.html'));
  assert.ok(manifest.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.equal(manifest.files.find(file => file.path === 'package.json').size > 0, true);
  const room = await mkdtemp(join(tmpdir(), 'trust-release-inventory-'));
  t.after(() => rm(room, { recursive: true, force: true }));
  await mkdir(join(room, 'scripts'));
  await writeFile(join(room, 'package.json'), JSON.stringify({ name: 'test', version: '0.0.0', private: true, engines: { node: '>=22.13.0' } }));
  const setInventory = files => writeFile(join(room, 'scripts', 'release-files.json'), JSON.stringify(['package.json', ...files]));
  await setInventory(['../private.json']);
  assert.throws(() => sourceManifest(room), /Unsafe release path/);
  await setInventory(['local-access.json']);
  assert.throws(() => sourceManifest(room), /Runtime data/);
  if (process.platform !== 'win32') {
    await symlink(join(room, 'package.json'), join(room, 'shortcut.md'));
    await setInventory(['shortcut.md']);
    assert.throws(() => sourceManifest(room), /regular source file/);
  }
});

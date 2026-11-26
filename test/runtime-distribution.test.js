'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdir, mkdtemp, rm, symlink, truncate, writeFile } = require('node:fs/promises');
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
  for (const path of ['start-corporate.js', 'oidc/package.json', 'oidc/package-lock.json', 'oidc/client.js', 'oidc/signin-check.js']) {
    assert.ok(manifest.files.some(file => file.path === path), path + ' is missing from the release inventory.');
  }
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

test('release inventory supports more than 250 explicit source files within bounded count and total bytes', async t => {
  const room = await mkdtemp(join(tmpdir(), 'trust-release-capacity-'));
  t.after(() => rm(room, { recursive: true, force: true }));
  await mkdir(join(room, 'scripts'));
  await writeFile(join(room, 'package.json'), JSON.stringify({ name: 'test', version: '0.0.0', private: true, engines: { node: '>=22.13.0' } }));
  const names = Array.from({ length: 512 }, (_, i) => 'fictional-' + i + '.md');
  const setInventory = files => writeFile(join(room, 'scripts', 'release-files.json'), JSON.stringify(['package.json', ...files]));
  for (const name of names.slice(0, 250)) await writeFile(join(room, name), 'Synthetic fixture\n');
  await setInventory(names.slice(0, 250));
  assert.equal(sourceManifest(room).manifest.files.length, 251);
  await setInventory(names);
  assert.throws(() => sourceManifest(room), /Invalid release inventory/);
  await setInventory(names.slice(0, 8));
  for (const name of names.slice(0, 8)) await truncate(join(room, name), 4 * 1024 * 1024);
  assert.throws(() => sourceManifest(room), /32 MiB total input limit/);
});


test('compiled Rust release inventory binds only the fixed artifact and preserves the source variant',()=>{
  const {existsSync}=require('node:fs');
  const contract=require('../rust-core-abi');
  const directory=resolve(__dirname,'..');
  const source=sourceManifest(directory).manifest;
  assert.equal(source.format,'mvw-trust-source-release');
  assert.ok(!source.files.some(row=>row.path.endsWith('.wasm')));
  const built=join(directory,...contract.built.split('/'));
  if(!existsSync(built))return;
  const {lstatSync,readFileSync}=require('node:fs');
  assert.equal(lstatSync(built).nlink,1);
  assert.deepEqual(readFileSync(built),readFileSync(join(directory,...contract.cargoOutput.split('/'))));
  const {manifest,files}=sourceManifest(directory,{rust:true});
  const row=manifest.files.find(row=>row.path===contract.packaged);
  const bytes=files.find(file=>file.path===contract.packaged).bytes;
  assert.equal(manifest.format,contract.format);
  assert.equal(manifest.wasmAbi,contract.abi);
  assert.equal(manifest.files.length,source.files.length+1);
  assert.equal(row.size,bytes.length);
  assert.equal(row.sha256,contract.sha256(bytes));
  assert.equal(contract.instantiate(bytes).trust_abi(),contract.abi);
});


test('native release is a distinct platform-bound inventory with exactly two compiled artifacts',()=>{
  const {existsSync}=require('node:fs');
  const native=require('../native-storage-abi'),core=require('../rust-core-abi');
  const directory=resolve(__dirname,'..');
  if(process.platform!==native.target.platform||process.arch!==native.target.architecture){
    assert.throws(()=>native.requireTarget(),/Unsupported native Rust release target/);
    return;
  }
  if(!existsSync(join(directory,native.built))||!existsSync(join(directory,core.built)))return;
  const source=sourceManifest(directory).manifest;
  const portable=sourceManifest(directory,{rust:true}).manifest;
  const {manifest,files}=sourceManifest(directory,{native:true});
  assert.equal(manifest.format,native.format);
  assert.equal(manifest.nativeAbi,native.abi);
  assert.equal(manifest.wasmAbi,core.abi);
  assert.deepEqual(manifest.target,native.target);
  assert.equal(manifest.files.length,source.files.length+2);
  assert.equal(manifest.files.length,portable.files.length+1);
  assert.equal(source.files.some(row=>row.path.endsWith('.node')),false);
  assert.equal(portable.files.some(row=>row.path.endsWith('.node')),false);
  const row=manifest.files.find(row=>row.path===native.packaged);
  const bytes=files.find(row=>row.path===native.packaged).bytes;
  assert.equal(row.size,bytes.length);
  assert.equal(row.sha256,require('node:crypto').createHash('sha256').update(bytes).digest('hex'));
  native.verifyBinary(bytes);
  assert.throws(()=>native.verifyBinary(Buffer.alloc(64)),/binary format/);
});

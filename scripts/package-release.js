'use strict';

const { closeSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, opendirSync, fsyncSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { basename, dirname, isAbsolute, join, resolve, sep } = require('node:path');
const { tmpdir } = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { checkRuntime } = require('./runtime-check');

const maxFileBytes = 4 * 1024 * 1024;
const maxArchiveBytes = 32 * 1024 * 1024;
const maxSourceFiles = 512;
const maxSourceBytes = 32 * 1024 * 1024;
const root = resolve(__dirname, '..');
const checksum = buffer => createHash('sha256').update(buffer).digest('hex');

function inspectSource(directory, relative, limit=maxFileBytes) {
  if (typeof relative !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(relative) ||
      relative.split('/').some(segment => !segment || segment.startsWith('.'))) {
    throw new Error('Unsafe release path: ' + relative);
  }
  const parts = relative.split('/');
  let full = directory;
  let size = 0;
  for (const [i, part] of parts.entries()) {
    full = join(full, part);
    const info = lstatSync(full);
    if (i < parts.length - 1) {
      if (!info.isDirectory()) throw new Error('Unsafe release directory: ' + relative);
    } else if (!info.isFile() || info.nlink !== 1 || info.size > limit) {
      throw new Error('Release input is not a single-link regular source file: ' + relative);
    } else {
      size = info.size;
    }
  }
  return { full, size };
}

function readSource(directory, relative, limit=maxFileBytes) {
  const { full } = inspectSource(directory, relative,limit);
  const bytes = readFileSync(full);
  if (bytes.length > limit) throw new Error('Release source grew beyond its per-file limit: ' + relative);
  return bytes;
}

function sourceManifest(directory, { rust = false, native = false, nativeHttp = false, packaged = false } = {}) {
  if(nativeHttp)native=true;
  if(native)rust=true;
  const declared = JSON.parse(readSource(directory, 'scripts/release-files.json'));
  if (!Array.isArray(declared) || !declared.includes('package.json') ||
      new Set(declared).size !== declared.length || declared.length > maxSourceFiles) {
    throw new Error('Invalid release inventory.');
  }
  if (declared.some(path => typeof path !== 'string' || /\.wasm$/i.test(path) || path.startsWith('rust-core/target/') || path.startsWith('native-storage/target/') || path.startsWith('native-http/target/') || /\.node$/i.test(path))) {
    throw new Error('Only explicit Rust source files may appear in the source inventory.');
  }
  const paths = declared.sort();
  let total = 0;
  for (const path of paths) {
    if (/^(?:data|dist|node_modules)(?:\/|$)|(?:^|\/)(?:node_modules|release-profile\.json|.*access\.json)(?:\/|$)|\.(?:zip|tgz|sqlite3?|db)(?:$|-)/i.test(path)) {
      throw new Error('Runtime data must not be included in the release: ' + path);
    }
    total += inspectSource(directory, path).size;
    if (total > maxSourceBytes) throw new Error('Release source exceeds the 32 MiB total input limit.');
  }
  let loaded = 0;
  const files = paths.map(path => {
    const bytes = readSource(directory, path);
    loaded += bytes.length;
    if (loaded > maxSourceBytes) throw new Error('Release source exceeds the 32 MiB total input limit.');
    if (bytes.includes(0)) throw new Error('Only source and documentation text is packaged: ' + path);
    return { path, bytes };
  });
  const pkg = JSON.parse(files.find(file => file.path === 'package.json').bytes);
  if (!pkg.private || Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.optionalDependencies ?? {}).length) {
    throw new Error('This release command requires a private, install-free runtime package.');
  }
  let contract;
  if (rust) {
    contract = require('../rust-core-abi');
    if (files.length >= maxSourceFiles) throw new Error('Rust release exceeds the file inventory limit.');
    const bytes = readSource(directory, packaged ? contract.packaged : contract.built);
    contract.instantiate(bytes);
    loaded += bytes.length;
    if (loaded > maxSourceBytes) throw new Error('Rust release exceeds the 32 MiB total input limit.');
    files.push({ path: contract.packaged, bytes });
    files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  }
  let nativeContract;
  if(native){
    nativeContract=require('../native-storage-abi');
    nativeContract.requireTarget();
    if(files.length>=maxSourceFiles)throw Error('Native release exceeds the file inventory limit.');
    const bytes=readSource(directory,packaged?nativeContract.packaged:nativeContract.built,nativeContract.maxBytes);
    nativeContract.verifyBinary(bytes);
    loaded+=bytes.length;
    if(loaded>maxSourceBytes)throw Error('Native release exceeds the 32 MiB total input limit.');
    files.push({path:nativeContract.packaged,bytes});
    files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  }
  let httpContract;
  if(nativeHttp){
    httpContract=require('../native-http-abi');httpContract.requireTarget();
    if(files.length>=maxSourceFiles)throw Error('Native HTTP release exceeds the file inventory limit.');
    const bytes=readSource(directory,packaged?httpContract.packaged:httpContract.built,httpContract.maxBytes);
    httpContract.verifyBinary(bytes);loaded+=bytes.length;
    if(loaded>maxSourceBytes)throw Error('Native HTTP release exceeds the 32 MiB total input limit.');
    files.push({path:httpContract.packaged,bytes});
    files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  }
  const manifest = {
    format: nativeHttp ? httpContract.format : native ? nativeContract.format : rust ? contract.format : 'mvw-trust-source-release',
    version: 1,
    package: pkg.name,
    packageVersion: pkg.version,
    node: pkg.engines.node,
    ...(rust ? { wasmAbi: contract.abi } : {}),
    ...(native ? {nativeAbi:nativeContract.abi,target:nativeContract.target}:{}),
    ...(nativeHttp ? {httpAbi:httpContract.abi}:{}),
    files: files.map(({ path, bytes }) => ({ path, size: bytes.length, sha256: checksum(bytes) })),
  };
  return { files, manifest };
}

function publishNew(target, bytes) {
  const output = resolve(target);
  const parent = dirname(output);
  mkdirSync(parent, { mode: 0o700, recursive: true });
  const temp = join(parent, '.' + basename(output) + '.' + randomUUID() + '.tmp');
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600, flush: true });
    linkSync(temp, output);
  } finally {
    rmSync(temp, { force: true });
  }
  if (process.platform !== 'win32') {
    const directory = openSync(parent, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}

function packageRelease({ directory = root, target, npm = process.env.npm_execpath, rust = false, native = false, nativeHttp = false }) {
  checkRuntime();
  if (typeof target !== 'string' || !target.endsWith('.tgz')) throw new Error('Provide a new .tgz output pathname.');
  if (typeof npm !== 'string' || !isAbsolute(npm)) throw new Error('Run packaging through npm run release:local.');
  const { files, manifest } = sourceManifest(directory, { rust,native,nativeHttp });
  const temp = mkdtempSync(join(tmpdir(), 'mvw-trust-source-release-'));
  try {
    const staged = join(temp, 'workbench');
    mkdirSync(staged, { mode: 0o700 });
    for (const { path, bytes } of files) {
      const output = join(staged, ...path.split('/'));
      mkdirSync(dirname(output), { mode: 0o700, recursive: true });
      writeFileSync(output, bytes, { flag: 'wx', mode: 0o644 });
    }
    const inventory = 'RELEASE-MANIFEST.json';
    writeFileSync(join(staged, inventory), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    const userConfig = join(temp, 'user-npmrc'), globalConfig = join(temp, 'global-npmrc');
    for (const config of [userConfig, globalConfig]) writeFileSync(config, '', { flag: 'wx', mode: 0o600 });
    const packed = spawnSync(process.execPath, [npm, 'pack', '--ignore-scripts', '--offline', '--json',
      '--userconfig', userConfig, '--globalconfig', globalConfig, '--cache', join(temp, 'cache'), '--pack-destination', temp], {
      cwd: staged, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, encoding: 'utf8', timeout: 30000,
    });
    if (packed.error) throw packed.error;
    if (packed.status !== 0) throw new Error('npm could not generate the offline release package. ' + packed.stderr.trim());
    const [result] = JSON.parse(packed.stdout);
    const actual = result.files.map(file => file.path).sort();
    const expected = [...manifest.files.map(file => file.path), inventory].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Packaged file inventory differs from the explicit source allowlist.');
    if (basename(result.filename) !== result.filename || result.filename.includes(sep) ||
        lstatSync(join(temp, result.filename)).size > maxArchiveBytes) throw new Error('Invalid release package output.');
    const bytes = readFileSync(join(temp, result.filename));
    if (result.integrity !== 'sha512-' + createHash('sha512').update(bytes).digest('base64')) {
      throw new Error('npm artifact integrity did not verify.');
    }
    publishNew(target, bytes);
    return { file: resolve(target), size: bytes.length, sha256: checksum(bytes), files: actual.length };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function verifyExactTree(directory, manifest) {
  const files = new Set(['RELEASE-MANIFEST.json', ...manifest.files.map(file => file.path)]);
  const directories = new Set();
  for (const file of files) {
    for (let end = file.lastIndexOf('/'); end !== -1; end = file.lastIndexOf('/', end - 1)) {
      directories.add(file.slice(0, end));
    }
  }
  const pending = [''];
  while (pending.length) {
    const relativeDir = pending.pop();
    const handle = opendirSync(join(directory, relativeDir));
    try {
      for (let entry; (entry = handle.readSync()) !== null;) {
        const relative = relativeDir === '' ? entry.name : relativeDir + '/' + entry.name;
        if (entry.isDirectory() && directories.has(relative)) pending.push(relative);
        else if (!entry.isFile() || !files.has(relative)) {
          throw new Error('Unexpected entry in extracted release: ' + JSON.stringify(relative));
        }
      }
    } finally { handle.closeSync(); }
  }
}

function verifyExtracted(directory = root) {
  const actual = JSON.parse(readSource(directory, 'RELEASE-MANIFEST.json'));
  const { manifest } = sourceManifest(directory, { rust: actual.format === 'mvw-trust-rust-release',
    native:actual.format==='mvw-trust-native-rust-release',nativeHttp:actual.format==='mvw-trust-native-http-release', packaged: true });
  if (JSON.stringify(actual) !== JSON.stringify(manifest)) {
    throw new Error('Extracted package does not match its release manifest.');
  }
  verifyExactTree(directory, manifest);
  return { package: manifest.package, packageVersion: manifest.packageVersion, files: manifest.files.length };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const rust = args[0] === '--rust',native=args[0]==='--native-rust',nativeHttp=args[0]==='--native-http',compiled=rust||native||nativeHttp;
    if (args.length !== (compiled ? 2 : 1)) throw new Error('Usage: npm run release:local -- <new-file.tgz> | npm run release:rust -- <new-file.tgz> | npm run release:native-rust -- <new-file.tgz> | npm run release:native-http -- <new-file.tgz> | npm run release:verify');
    console.log(JSON.stringify(args[0] === '--verify-extracted' ? verifyExtracted() : packageRelease({ target: args[compiled ? 1 : 0], rust,native,nativeHttp })));
  } catch (error) {
    console.error('Packaging failed: ' + error.message);
    process.exitCode = 1;
  }
}
module.exports = { sourceManifest, packageRelease, verifyExtracted };

'use strict';

const { spawn } = require('node:child_process');
const { readdir,appendFile } = require('node:fs/promises');
const { createInterface } = require('node:readline');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { isAbsolute, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { checkRuntime } = require('./runtime-check');

async function runAudit(shard,env,test){
  if(!/^[0-3]$/.test(shard??''))throw Error('Invalid 100-pass shard.');
  const suites=(await readdir(join(__dirname,'..','test'))).filter(x=>/^[a-z0-9-]+\.test\.js$/.test(x)).sort();
  const focus=['governance-document-attachments.test.js','attachment-binary-batch.test.js','api.test.js','access-policy.test.js','workspace-access.test.js','document-review-seats.test.js','rights-case-scope.test.js','rights-deadline-policy.test.js','workflow-engine.test.js','workflow-http.test.js','assessment-config.test.js','processing-register.test.js','reporting.test.js','reporting-runs.test.js','report-schedules.test.js','durable-storage.test.js','storage-encryption.test.js','native-storage.test.js','evidence-recovery.test.js','fixture-migration.test.js','incident-policy.test.js','browser-concurrent-review.test.js','browser-release-processing-rework.test.js','browser-release-report-schedule-race.test.js'];
  if(!suites.length||suites.length>99||focus.some(x=>!suites.includes(x)))throw Error('The current test inventory does not fit the audit.');
  const plan=suites.map(suite=>{
    if(suite==='release-upgrade.test.js'&&!env.MVW_TRUST_STAGE20_ARCHIVE){
      console.log('Optional stage20 upgrade rehearsal not executable: pinned external archive was not supplied. Its slot runs the current native release-launcher suite instead.');
      return {suite:'release-launcher.test.js',mode:'native'};
    }
    return {suite,mode:suite==='native-storage.test.js'?'native':suite==='rust-core.test.js'?'wasm':'auto'};
  });
  for(let i=0;plan.length<99;i++)plan.push({suite:focus[i%focus.length],mode:'native'});
  plan.push({suite:null,mode:'auto'});
  let passed=0;
  const header='| Pass | Suite | Runtime | Result | Tests | Passed | Failed | Skipped |\n| ---: | --- | --- | --- | ---: | ---: | ---: | ---: |\n';
  if(env.GITHUB_STEP_SUMMARY)await appendFile(env.GITHUB_STEP_SUMMARY,header);
  for(let i=0;i<25;i++){
    const pass=Number(shard)*25+i+1,{suite,mode}=plan[pass-1],label=suite??'Full integrated suite',counts={};
    console.log('::group::Pass '+pass+'/100: '+label+' ('+mode+')');
    const status=await new Promise((resolveCode,reject)=>{
      const child=spawn(process.execPath,[...test,'--test-reporter=tap',...(suite?[join('test',suite)]:[])],
        {cwd:resolve(__dirname,'..'),env:{...env,TRUST_RUST_CORE:mode==='auto'?'auto':'required',TRUST_SQLITE_DRIVER:mode==='native'?'rust':'node'},stdio:['ignore','pipe','inherit']});
      const lines=createInterface({input:child.stdout,crlfDelay:Infinity});
      lines.on('line',line=>{console.log(line);const m=/^# (tests|pass|fail|skipped|cancelled|todo) (\d+)$/.exec(line);if(m)counts[m[1]]=Number(m[2]);});
      child.once('error',reject);child.once('close',code=>resolveCode(code??1));
    });
    console.log('::endgroup::');
    const ok=status===0&&counts.tests>0&&counts.pass>0&&counts.fail===0&&counts.cancelled===0&&counts.todo===0&&counts.pass+counts.skipped===counts.tests;
    if(ok)passed++;
    const row='| '+[pass,label,mode,ok?'PASS':'FAIL',counts.tests??'?',counts.pass??'?',counts.fail??'?',counts.skipped??'?'].join(' | ')+' |';
    console.log(row);
    if(env.GITHUB_STEP_SUMMARY)await appendFile(env.GITHUB_STEP_SUMMARY,row+'\n');
  }
  console.log('Shard '+shard+': '+passed+'/25 successful test processes.');
  process.exitCode=passed===25?0:1;
}
async function verify() {
  checkRuntime({ sqlite: true });
  const browserModules = join(__dirname, 'browser-tools', 'node_modules');
  const env = { ...process.env, RUN_BROWSER_SMOKE: '1', NODE_PATH: browserModules };
  // Several suites spawn Chromium. Bound parallel workers so low-CPU CI
  // runners measure the application instead of starving browser processes.
  const test = ['--test', '--test-concurrency=2', '--test-timeout=90000'];
  // Keep a caller's explicitly opted-in browser binary. The locked bundled
  // Chromium in CI is a Linux x64/ARM64 build, not a desktop installer.
  if (env.CHROMIUM_PATH) {
    if (!isAbsolute(env.CHROMIUM_PATH)) throw new Error('CHROMIUM_PATH must be an absolute local executable location.');
  } else if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
    throw new Error('Provide CHROMIUM_PATH for an installed desktop Chromium on this platform.');
  }
  const scratch = await mkdtemp(join(tmpdir(), 'mvw-trust-chromium-'));
  const previousTmpdir = process.env.TMPDIR;
  try {
    require.resolve('playwright', { paths: [browserModules] });
    require.resolve('axe-core', { paths: [browserModules] });
    if (!env.CHROMIUM_PATH) {
      // Load the optional browser binary without changing the application
      // dependency graph or inheriting a previous /tmp/chromium binary.
      process.env.TMPDIR = scratch;
      const modulePath = require.resolve('@sparticuz/chromium', { paths: [browserModules] });
      const { default: chromium } = await import(pathToFileURL(modulePath).href);
      env.CHROMIUM_PATH = await chromium.executablePath();
    }
    if(env.TRUST_QA_SHARD!==undefined){await runAudit(env.TRUST_QA_SHARD,env,test);return;}
    console.log('Running the full suite with browser verification enabled.');
    const code = await new Promise((resolveCode, reject) => {
      const child = spawn(process.execPath, test, { cwd: resolve(__dirname, '..'), env, stdio: 'inherit' });
      child.once('error', reject);
      child.once('close', status => resolveCode(status ?? 1));
    });
    process.exitCode = code;
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    await rm(scratch, { recursive: true, force: true });
  }
}

verify().catch(error => {
  console.error('Browser verification failed: ' + error.message);
  process.exitCode = 1;
});

'use strict';

// This opt-in verification owns its listener, fixture accounts and on-disk
// SQLite files. It deliberately accepts no URL, database or credential input.
const assert=require('node:assert/strict');
const {randomBytes,randomUUID}=require('node:crypto');
const {once}=require('node:events');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {performance}=require('node:perf_hooks');
const {createServer}=require('../server');
const {backupDatabase,verifyBackup,restoreDatabase,openSqlite}=require('../durable-storage');
const {codeHash}=require('../workspace-access');

const rights='/api/rights/cases',docs='/api/governance-documents',retention='/api/retention/schedules',jobs='/api/operator/v1/jobs';
const accounts={aa:['alpha','analyst'],ar:['alpha','reviewer'],ao:['alpha','case-operator'],
  ba:['beta','analyst'],br:['beta','reviewer'],bo:['beta','case-operator']};
const fixedNow=Date.parse('2026-11-25T14:00:00Z');
const actors=Object.keys(accounts);
const alphaNote='Fictional alpha access intake';
const betaNote='Fictional beta deletion intake';
const fileTxt=Buffer.from('Synthetic preservation canary.\r\n');
const fileCsv=Buffer.from('record,score\r\nfictional,1\r\n');
const asOf='2199-12-30';
const round=x=>Number(x.toFixed(2));
const identity=(workspace,role)=>'fixture-'+workspace+'-'+role;
const row=(model,id)=>model.cases.find(c=>c.id===id);
const version=(model,id)=>model.documents.flatMap(d=>d.revisions).find(v=>v.id===id);
const tfile=(filename,mediaType,bytes)=>({filename,mediaType,data:bytes.toString('base64')});
const formatAudit=event=>event.action;

async function verifySqliteResilience(){
  const started=performance.now();
  const folder=await mkdtemp(join(tmpdir(),'trust-sqlite-resilience-'));
  const deadline=AbortSignal.timeout(25_000);
  const firstFile=join(folder,'live.sqlite'),backupFile=join(folder,'checkpoint.json'),restoredFile=join(folder,'restored.sqlite');
  const codes=Object.fromEntries(actors.map(k=>[k,randomBytes(32).toString('base64url')]));
  const isolated={root:join(folder,'workspaces'),now:()=>fixedNow,
    workspaces:[{id:'alpha',label:'Fictional Alpha'},{id:'beta',label:'Fictional Beta'}],
    accounts:actors.map(k=>{
      const [workspace,role]=accounts[k];
      return {id:identity(workspace,role),codeHash:codeHash(codes[k]),memberships:{[workspace]:role}};
    }),
    attachmentReviewWorkspaces:['alpha','beta']
  };
  let server,origin,scenario,currentFile=firstFile;
  const scenarios=[], cookies=new Map(), labels=new Set();
  let alphaCase,betaCase,jobId,editionId,editionPath,firstAttachment,receipt,backupSummary;
  let afterBackupAlpha,afterBackupBeta,docRevision=0,ruleRevision=0;
  const scenarioFn=async(name,execute)=>{
    const record={name,operations:0,passed:0,http:0,local:0,allowed:0,expectedDenials:0,denialsByStatus:{},steps:[]};
    const at=performance.now();
    scenario=record;
    try{await execute();}
    catch(error){
      if(error.message.startsWith(name+' / '))throw error;
      const anchor=record.steps.at(-1)?.label??'startup';
      throw Error(name+' / invariant after '+anchor+': '+error.message.split('\n')[0],{cause:error});
    }
    record.elapsedMs=round(performance.now()-at);
    scenarios.push(record);
  };
  async function step(label,kind,expected,perform){
    assert.ok(scenario&&label&&!labels.has(label),'Workload checks must have distinct labels.');
    labels.add(label);
    deadline.throwIfAborted();
    const at=performance.now();
    try{
      const result=await perform();
      const elapsedMs=round(performance.now()-at);
      scenario.operations++;scenario.passed++;scenario[kind]++;
      if(kind==='http'){
        if(expected>=400){
          scenario.expectedDenials++;
          scenario.denialsByStatus[expected]=(scenario.denialsByStatus[expected]??0)+1;
        }else scenario.allowed++;
      }
      scenario.steps.push({label,kind,...(kind==='http'?{status:expected}:{}),elapsedMs});
      return result;
    }catch(error){
      // Do not print response bodies, keys, paths, or session tokens.
      throw Error(scenario.name+' / '+label+': '+error.message.split('\n')[0],{cause:error});
    }
  }
  const local=(label,perform)=>step(label,'local',null,perform);
  const http=(label,route,{actor,workspace,expected=200,body,headers={},code,cookie}={})=>step(label,'http',expected,async()=>{
    const url=new URL(route,origin);
    const scope=workspace===undefined?accounts[actor]?.[0]:workspace;
    if(scope)url.searchParams.append('workspace',scope);
    const auth=cookie??cookies.get(actor);
    const response=await fetch(url,{method:body===undefined?'GET':'POST',headers:{
      ...(auth?{Cookie:auth}:{}),...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...headers
    },...(body===undefined?{}:{body:JSON.stringify(body)}),
    signal:AbortSignal.any([deadline,AbortSignal.timeout(5000)]),redirect:'error'});
    const binary=response.headers.get('content-type')==='application/octet-stream';
    const value=binary?Buffer.from(await response.arrayBuffer()):await response.json();
    assert.equal(response.status,expected,'HTTP status mismatch: got '+response.status+', wanted '+expected+
      (typeof value?.code==='string'?' ('+value.code+')':''));
    if(code)assert.equal(value.code,code,'Stable denial code mismatch.');
    return {value,response};
  });
  async function login(label,actor){
    const [workspace,role]=accounts[actor];
    const result=await http(label,'/api/session/login',{workspace:null,body:{account:identity(workspace,role),workspace,code:codes[actor]}});
    assert.equal(result.value.workspace,workspace);assert.equal(result.value.actor,role);
    const token=result.response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(token);cookies.set(actor,token);
  }
  async function start(){
    server=createServer({dataFile:join(folder,'unused-demo.json'),sqliteFile:currentFile,isolated}).listen(0,'127.0.0.1');
    await once(server,'listening',{signal:deadline});
    origin='http://127.0.0.1:'+server.address().port;
    const ready=await fetch(origin+'/health/ready',{signal:AbortSignal.timeout(5000)});
    assert.equal(ready.status,200);
    assert.equal((await ready.json()).status,'ready');
  }
  async function stop(){
    if(!server?.listening)return;
    server.closeAllConnections();
    await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
  const post=(label,route,actor,body,expected=200,code)=>http(label,route,{actor,body,expected,code});
  async function createCase(label,actor,kind,owner,note){
    const {value}=await post(label,rights,actor,{kind,owner,days:14,note});
    const record=value.cases.find(c=>c.summary===note);
    assert.ok(record&&record.revision===1);
    return record.id;
  }
  const caseAction=(label,id,actor,operation,revision,expected=200,code)=>post(label,rights+'/'+id+'/'+operation,actor,
    {expectedRevision:revision,note:'Fictional controlled case action.'},expected,code);
  async function changeDoc(label,route,actor,body,expected=200,code){
    const {value}=await post(label,route,actor,{expectedRevision:docRevision,...body},expected,code);
    if(expected===200)docRevision=value.revision;
    return value;
  }
  async function changeRule(label,route,actor,body){
    const {value}=await post(label,route,actor,{expectedRevision:ruleRevision,...body});
    ruleRevision=value.revision;return value;
  }
  function countCase(model,record,expected){assert.equal(row(model,record)?.status,expected);}
  function auditCheck(events,foreignIds=[]){
    assert.ok(events.length>0,'Expected a nonempty audit.');
    assert.equal(new Set(events.map(event=>event.id)).size,events.length,'Duplicate audit event.');
    assert.deepEqual(events.map(event=>event.sequence),events.map((_,index)=>index+1),'Unexpected audit sequence gap.');
    assert.ok(events.every(event=>!foreignIds.includes(event.entityId)),'Foreign scope identifier in audit.');
  }

  try{
    await scenarioFn('Session and role boundaries',async()=>{
      await local('Start isolated SQLite listener with readiness check',start);
      const anonymous=await http('Describe unauthenticated session','/api/session',{workspace:null});
      assert.equal(anonymous.value.authenticated,false);
      await http('Reject unauthenticated workspace state','/api/state',{workspace:'alpha',expected:401});
      await http('Reject invented fixture access code','/api/session/login',{workspace:null,body:{
        account:identity('alpha','analyst'),workspace:'alpha',code:'A'.repeat(43)
      },expected:401});
      await http('Reject cross-origin sign-in','/api/session/login',{workspace:null,body:{
        account:identity('alpha','analyst'),workspace:'alpha',code:codes.aa
      },headers:{Origin:'http://127.0.0.1:1'},expected:403});
      for(const actor of actors)await login('Sign in '+accounts[actor].join(' '),actor);
      const a=await http('Verify Alpha session binds exact role','/api/session',{actor:'aa',workspace:null});
      assert.equal(a.value.workspace,'alpha');assert.equal(a.value.actor,'analyst');
      const b=await http('Verify Beta operator session binds exact role','/api/session',{actor:'bo',workspace:null});
      assert.equal(b.value.workspace,'beta');assert.equal(b.value.actor,'case-operator');
      await http('Reject Alpha cookie at the Beta boundary','/api/state',{actor:'aa',workspace:'beta',expected:403});
      await http('Reject ambiguous repeated workspace parameter','/api/state?workspace=beta',{actor:'aa',expected:403});
      await http('Reject forged reviewer role header on report','/api/reporting',{actor:'ao',headers:{'X-Demo-Actor':'reviewer'},expected:403});
      const empty=await http('Read empty assigned personal queue','/api/my-work',{actor:'ao'});
      assert.deepEqual(empty.value.tasks,[]);
    });
    await scenarioFn('Independent rights cases and stale revisions',async()=>{
      alphaCase=await createCase('Open Alpha access case assigned to operator','aa','access','case-operator',alphaNote);
      betaCase=await createCase('Open Beta deletion case assigned to analyst','ba','deletion','analyst',betaNote);
      await caseAction('Refuse author acting as reviewer',alphaCase,'aa','verify',1,403,'INDEPENDENT_REVIEW_REQUIRED');
      await caseAction('Refuse operator before identity verification',alphaCase,'ao','begin',1,409,'IDENTITY_REQUIRED');
      await caseAction('Verify Alpha identity through reviewer',alphaCase,'ar','verify',1);
      await caseAction('Refuse stale verification version',alphaCase,'ar','verify',1,409,'STALE_REVISION');
      await caseAction('Record Beta failed identity verification',betaCase,'br','deny-verification',1);
      await caseAction('Refuse non-owner starting assigned Alpha work',alphaCase,'aa','begin',2,403,'OWNER_REQUIRED');
      const work=(await http('Check verified case appears only in assigned work','/api/my-work',{actor:'ao'})).value;
      assert.equal(work.tasks.length,1);
      assert.equal(work.tasks[0].actionLabel,'Begin mock fulfillment');
      await http('Refuse copied personal task link to another role','/api/my-work/tasks/'+work.tasks[0].key,{actor:'ar',expected:404});
      const started=await caseAction('Begin Alpha mock fulfillment as assigned operator',alphaCase,'ao','begin',2);
      countCase(started.value,alphaCase,'in-progress');
      const complete=await caseAction('Finish Alpha mock fulfillment without data release',alphaCase,'ao','fulfill',3);
      countCase(complete.value,alphaCase,'fulfilled');
      assert.equal(row(complete.value,alphaCase).completion.releasedData,false);
      const closed=await caseAction('Close Beta failed-identity case without disclosure',betaCase,'ba','close-unverified',2);
      countCase(closed.value,betaCase,'closed-unverified');
      await caseAction('Refuse repeating completion of a closed case',alphaCase,'ao','fulfill',4,409,'CASE_CLOSED');
      const denied=await caseAction('Refuse Beta reviewer replaying Alpha case ID',alphaCase,'br','verify',4,404,'NOT_FOUND');
      assert.ok(!JSON.stringify(denied.value).includes(alphaNote));
      const scoped=(await http('Verify Beta operator sees no unassigned cases',rights,{actor:'bo'})).value;
      assert.deepEqual(scoped.cases,[]);
    });
    await scenarioFn('Operator job idempotency and governed handoff',async()=>{
      const target=await createCase('Open distinct Alpha queue-assignment case','aa','correction','analyst','Fictional delegated operator job case');
      const proposal={action:'rights.case.assign',args:{caseId:target,expectedRevision:1},idempotencyKey:randomUUID()};
      const submitted=await post('Propose governed assignment job',jobs,'aa',proposal,201);
      jobId=submitted.value.job.id;assert.equal(submitted.value.job.status,'awaiting-approval');
      const route=jobs+'/'+jobId;
      const replay=await post('Replay identical idempotency key without another job',jobs,'aa',proposal);
      assert.deepEqual(replay.value,submitted.value);
      await post('Reject changed payload for occupied idempotency key',jobs,'aa',{...proposal,args:{...proposal.args,expectedRevision:2}},409,'IDEMPOTENCY_CONFLICT');
      await post('Reject original author approving own job',route+'/decision','aa',{decision:'approve'},403,'ACCESS_DENIED');
      await post('Reject execution before independent approval',route+'/run','aa',{},409,'JOB_NOT_RUNNABLE');
      await http('Refuse Alpha job identifier in Beta workspace',route,{actor:'ba',expected:404,code:'JOB_NOT_FOUND'});
      await http('Reject case operator browsing job register',jobs,{actor:'ao',expected:403,code:'ACCESS_DENIED'});
      const review=await http('Load pending job as designated reviewer',jobs,{actor:'ar'});
      assert.deepEqual(review.value.jobs.map(job=>job.id),[jobId]);
      const approved=await post('Reviewer approves exact pending job',route+'/decision','ar',{decision:'approve'});
      assert.equal(approved.value.job.status,'queued');
      const before=(await http('Verify approval alone does not mutate case',rights,{actor:'ar'})).value;
      assert.equal(row(before,target).owner,'analyst');assert.equal(row(before,target).revision,1);
      const ran=await post('Author runs independently approved assignment',route+'/run','aa',{});
      assert.equal(ran.value.job.status,'succeeded');
      const finished=(await http('Verify only assignment and its revision committed',rights,{actor:'ar'})).value;
      assert.equal(row(finished,target).owner,'case-operator');assert.equal(row(finished,target).revision,2);
      const same=await post('Replay completed job returns its existing receipt',route+'/run','aa',{});
      assert.deepEqual(same.value,ran.value);
    });
    await scenarioFn('Evidence, quarantine, holds and rehearsal',async()=>{
      const schedule=(await changeRule('Draft fictional creation-based retention rule',retention,'aa',{
        category:'demo-operations',title:'Fictional resilience rule',trigger:'created',days:1,disposition:'archive'
      })).schedules[0];
      await changeRule('Submit exact fictional rule',retention+'/'+schedule.id+'/submit','aa',{});
      await changeRule('Reviewer activates pinned fictional rule',retention+'/'+schedule.id+'/activate','ar',{note:'Synthetic review only.'});
      const draft=(await changeDoc('Create Alpha policy edition draft',docs+'/records','aa',{
        kind:'policy',title:'Fictional resilience edition',content:'Fictional published edition will stay unchanged.',links:[]
      })).documents[0];
      editionId=draft.revisions[0].id;editionPath=docs+'/records/'+draft.id+'/revisions/'+editionId;
      const attachments=editionPath+'/attachments';
      const txt=tfile('fictional-note.txt','text/plain',fileTxt),csv=tfile('fictional-record.csv','text/csv',fileCsv);
      const bad=tfile('fictional.bmp','image/bmp',Buffer.from('Fictional non-image bytes.'));
      const rejection=await changeDoc('Refuse invalid mixed batch atomically',attachments+'/batch','aa',{files:[txt,bad,csv]},415,'ATTACHMENT_BATCH_INVALID');
      assert.deepEqual(rejection.fileErrors.map(e=>e.index),[1]);
      const clean=(await http('Verify invalid batch left no attachments or revision increment',docs,{actor:'aa'})).value;
      assert.equal(clean.revision,docRevision);assert.deepEqual(version(clean,editionId).attachments,[]);
      const provisioned=await changeDoc('Commit mixed text and CSV batch as one revision',attachments+'/batch','aa',{files:[txt,csv]});
      const files=version(provisioned,editionId).attachments;
      assert.deepEqual(files.map(a=>a.reviewStatus),['pending','pending']);firstAttachment=files[0];
      await post('Refuse reviewer download while quarantined',attachments+'/'+files[0].id+'/download','ar',{},409,'ATTACHMENT_QUARANTINED');
      await changeDoc('Refuse publication prep while attachments are pending',editionPath+'/submit','aa',{},409,'ATTACHMENT_QUARANTINED');
      await changeDoc('Reject quarantine release that cites wrong digest',attachments+'/'+files[0].id+'/review','ar',
        {operation:'release',sha256:'0'.repeat(64)},422,'ATTACHMENT_REVIEW_DIGEST');
      for(const [label,file] of [['text',files[0]],['CSV',files[1]]])
        await changeDoc('Independently release exact '+label+' bytes',attachments+'/'+file.id+'/review','ar',{operation:'release',sha256:file.sha256});
      await changeDoc('Submit reviewed edition',editionPath+'/submit','aa',{});
      await changeDoc('Independently publish immutable edition',editionPath+'/publish','ar',{note:'Fictional independent publication.'});
      const uploaded=await post('Download original text bytes as opaque attachment',attachments+'/'+files[0].id+'/download','ar',{});
      assert.deepEqual(uploaded.value,fileTxt);
      assert.equal(uploaded.response.headers.get('content-disposition'),'attachment; filename="fictional-note.txt"');
      const checker=await post('Download original CSV bytes through scoped operator',attachments+'/'+files[1].id+'/download','ao',{});
      assert.deepEqual(checker.value,fileCsv);
      const request={scheduleId:schedule.id,scheduleVersion:schedule.version,asOf};
      const held=version(await changeDoc('Place hold on exact published edition',editionPath+'/evidence-hold/place','aa',{reason:'audit-review'}),editionId).evidenceHold;
      await changeDoc('Block disposition preview while preservation hold is active',editionPath+'/evidence-disposition/preview','aa',request,409,'EVIDENCE_ACTIVE_HOLD');
      await changeDoc('Request exact hold release',editionPath+'/evidence-hold/request-release','aa',{holdId:held.id,reason:'review-complete'});
      await changeDoc('Independently release preservation hold without deleting bytes',editionPath+'/evidence-hold/approve-release','ar',
        {holdId:held.id,reason:'review-complete'});
      const pinned=version(await changeDoc('Pin published edition to exact active rule',editionPath+'/evidence-disposition/preview','aa',request),editionId).evidenceRehearsal;
      const result=version(await changeDoc('Record independent audit-only rehearsal receipt',editionPath+'/evidence-disposition/rehearse','ar',{previewId:pinned.id}),editionId);
      receipt=result.evidenceRehearsal.result.id;
      assert.equal(result.evidenceRehearsal.result.deleted,false);assert.equal(result.evidenceRehearsal.result.changedEvidence,false);
      await changeDoc('Reject reuse of a completed evidence preview',editionPath+'/evidence-disposition/rehearse','ar',{previewId:pinned.id},409,'EVIDENCE_PREVIEW_CONFLICT');
      const other=(await http('Verify Beta evidence register exposes no Alpha record',docs,{actor:'ba'})).value;
      assert.deepEqual(other.documents,[]);
      const report='/api/reporting?dataset=activity&group=workflow&workflow=governance-documents';
      const aggregate=(await http('Verify Alpha evidence audit activity rolls into redacted aggregate',report,{actor:'ar'})).value;
      assert.equal(aggregate.rows[0]?.key,'governance-documents');
      assert.ok(aggregate.counts.total>=10);
      assert.doesNotMatch(JSON.stringify(aggregate),/fictional-note|Fictional published edition/);
      const itsOwn=(await http('Verify Beta aggregate does not inherit Alpha evidence activity',report,{actor:'br'})).value;
      assert.equal(itsOwn.counts.total,0);
      assert.deepEqual(itsOwn.rows,[]);
    });
    await scenarioFn('Checkpoint, restart and isolated recovery',async()=>{
      backupSummary=await local('Make verified while-live backup containing both scope snapshots',()=>backupDatabase(currentFile,backupFile));
      assert.equal(backupSummary.mode,'isolated');
      const captured=await local('Verify checksum and governance evidence of saved checkpoint',()=>verifyBackup(backupFile));
      assert.deepEqual(new Set(captured.documents.map(d=>d.scope)),new Set(['workspace:alpha','workspace:beta']));
      afterBackupAlpha=await createCase('Commit distinct Alpha case after checkpoint','aa','portability','analyst','Fictional Alpha after checkpoint');
      afterBackupBeta=await createCase('Commit distinct Beta case after checkpoint','ba','correction','analyst','Fictional Beta after checkpoint');
      const originalA=cookies.get('aa'),originalB=cookies.get('ba');
      await local('Close listener and database deterministically',stop);
      await local('Restart against original SQLite file and check readiness',start);
      await http('Reject pre-restart Alpha token','/api/state',{actor:'aa',cookie:originalA,expected:401});
      await http('Reject pre-restart Beta token','/api/state',{actor:'ba',cookie:originalB,expected:401});
      await login('Sign in Alpha analyst again after server restart','aa');
      await login('Sign in Beta analyst again after server restart','ba');
      const a=(await http('Read durable newer Alpha case after restart',rights,{actor:'aa'})).value;
      assert.ok(row(a,afterBackupAlpha));assert.equal(row(a,afterBackupBeta),undefined);
      const b=(await http('Read durable newer Beta case after restart',rights,{actor:'ba'})).value;
      assert.ok(row(b,afterBackupBeta));assert.equal(row(b,afterBackupAlpha),undefined);
      await local('Stop source before opening a separate restore target',stop);
      await local('Restore verified checkpoint to fresh SQLite file',()=>restoreDatabase(backupFile,restoredFile));
      await local('Start restored listener and check readiness',async()=>{currentFile=restoredFile;await start();});
      await login('Sign in new Alpha analyst session on restore','aa');
      await login('Sign in new Alpha reviewer session on restore','ar');
      await login('Sign in new Beta analyst session on restore','ba');
      await login('Sign in new Beta reviewer session on restore','br');
      const restoredA=(await http('Verify restored Alpha includes closed case not later writes',rights,{actor:'aa'})).value;
      countCase(restoredA,alphaCase,'fulfilled');assert.equal(row(restoredA,afterBackupAlpha),undefined);
      const restoredB=(await http('Verify restored Beta includes closed case not later writes',rights,{actor:'ba'})).value;
      countCase(restoredB,betaCase,'closed-unverified');assert.equal(row(restoredB,afterBackupBeta),undefined);
      const restoredDocs=(await http('Verify evidence rehearsal receipt survived restore',docs,{actor:'ar'})).value;
      assert.equal(version(restoredDocs,editionId).evidenceRehearsal.result.id,receipt);
      const restoredBytes=await post('Verify byte-exact evidence download after restore',editionPath+'/attachments/'+firstAttachment.id+'/download','ar',{});
      assert.deepEqual(restoredBytes.value,fileTxt);
      const restoredJob=(await http('Verify completed job receipt survives restore',jobs+'/'+jobId,{actor:'aa'})).value.job;
      assert.equal(restoredJob.status,'succeeded');assert.equal(restoredJob.id,jobId);
      const alphaAudit=(await http('Verify unique ordered Alpha audit is tenant-bound','/api/audit/export',{actor:'ar'})).value.audit;
      auditCheck(alphaAudit,[betaCase,afterBackupAlpha,afterBackupBeta]);
      assert.equal(alphaAudit.filter(e=>e.action==='governance-documents.evidence-disposition.rehearse').length,1);
      assert.equal(alphaAudit.filter(e=>e.details?.receiptId===receipt).length,1);
      const betaAudit=(await http('Verify unique ordered Beta audit is tenant-bound','/api/audit/export',{actor:'br'})).value.audit;
      auditCheck(betaAudit,[alphaCase,afterBackupAlpha,afterBackupBeta,jobId]);
      assert.ok(betaAudit.map(formatAudit).includes('rights.case.close-unverified'));
      assert.ok(!betaAudit.map(formatAudit).includes('governance-documents.evidence-disposition.rehearse'));
      await local('Compare SQLite source and restored snapshot and prove source unchanged',()=>{
        const source=openSqlite(firstFile,{readOnly:true}),restore=openSqlite(restoredFile,{readOnly:true});
        try{
          const workbenches=database=>new Map(database.snapshot().documents.filter(d=>d.kind==='workbench').map(d=>[d.scope,d.payload]));
          const live=workbenches(source), recovered=workbenches(restore);
          assert.ok(live.get('workspace:alpha').rightsCases.some(c=>c.id===afterBackupAlpha));
          assert.ok(live.get('workspace:beta').rightsCases.some(c=>c.id===afterBackupBeta));
          assert.ok(!recovered.get('workspace:alpha').rightsCases.some(c=>c.id===afterBackupAlpha));
          assert.ok(!recovered.get('workspace:beta').rightsCases.some(c=>c.id===afterBackupBeta));
        }finally{source.close();restore.close();}
      });
    });
    const totals=Object.fromEntries(['operations','passed','http','local','allowed','expectedDenials'].map(key=>[
      key,scenarios.reduce((result,entry)=>result+entry[key],0)
    ]));
    assert.equal(totals.operations,100,'Fixture has a fixed 100 named operations.');
    assert.equal(totals.operations,labels.size);
    assert.equal(totals.operations,totals.passed);
    return {schemaVersion:1,backend:'SQLite',fixture:'two isolated synthetic loopback workspaces',
      node:process.versions.node,readinessProbesBundledInStartup:3,elapsedMs:round(performance.now()-started),totals,scenarios};
  }finally{
    await stop();
    await rm(folder,{recursive:true,force:true});
  }
}

module.exports={verifySqliteResilience};
if(require.main===module){
  const args=process.argv.slice(2);
  if(args.length===1&&args[0]==='--help'){
    console.log('Usage: npm run verify:resilience (no endpoint, data or credential arguments).');
  }else if(args.length){
    console.error('This synthetic verification does not accept arguments.');process.exitCode=1;
  }else verifySqliteResilience().then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{
    console.error('SQLite resilience verification failed: '+error.message);process.exitCode=1;
  });
}

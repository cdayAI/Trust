'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {randomBytes}=require('node:crypto');
const {mkdtemp,readFile,readdir,writeFile,symlink,stat,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
const source=require('../fixtures/fictional-transfer-v1.json');
const command=promisify(execFile);
const base=join(__dirname,'..'),cli=join(base,'storage-cli.js');
const fixture=join(base,'fixtures','fictional-transfer-v1.json');
const workspace='migration-receiving';
const copy=()=>structuredClone(source);
const call=async(...args)=>JSON.parse((await command(process.execPath,[cli,...args],{cwd:base})).stdout);
async function room(t){
  const dir=await mkdtemp(join(tmpdir(),'trust-fixture-transfer-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  return (...items)=>join(dir,...items);
}
function invalid(args,message){
  return assert.rejects(call(...args),error=>error.code===1&&message.test(error.stderr));
}
const digestPattern=/^[0-9a-f]{64}$/;
const setup=async(sqliteFile,root)=>{
  const seats=['analyst','reviewer','beta'].map(role=>({id:'fixture-'+role,code:randomBytes(32).toString('base64url'),
    memberships:role==='beta'?{'migration-other':'analyst'}:{[workspace]:role}}));
  const cfg={root,workspaces:[{id:workspace,label:'Fictional receiving'},{id:'migration-other',label:'Empty other workspace'}],
    accounts:seats.map(({id,code,memberships})=>({id,memberships,codeHash:codeHash(code)}))};
  const server=createServer({sqliteFile,isolated:cfg}).listen(0,'127.0.0.1');
  await once(server,'listening');
  const url='http://127.0.0.1:'+server.address().port;
  const request=async(path,status,{body,cookie,scope}={})=>{
    const response=await fetch(url+path+(scope?'?workspace='+scope:''),{
      ...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),headers:{
        ...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json',Origin:url})
      }
    });
    const value=await response.json();
    assert.equal(response.status,status,JSON.stringify(value));
    return {value,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const login=async(index,scope=workspace)=>{
    const {id:account,code}=seats[index];
    return (await request('/api/session/login',200,{body:{account,code,workspace:scope}})).cookie;
  };
  return {request,login,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
};
test('dry run is read-only except for review plan, stable under reordering, and folds duplicates',async t=>{
  const output=await room(t),file=output('plan.json');
  const plan=await call('plan-fixture-import',fixture,workspace,file);
  assert.deepEqual(await readdir(output()),['plan.json']);
  if(process.platform!=='win32')assert.equal((await stat(file)).mode&0o777,0o600);
  assert.deepEqual(JSON.parse(await readFile(file)),plan);
  assert.match(plan.planDigest,digestPattern);
  assert.deepEqual(plan.stages.map(({count,duplicates})=>[count,duplicates]),[[3,1],[2,1],[2,0],[2,0]]);
  assert.equal(plan.map.links.find(x=>x.key==='l0001').id,plan.map.linkAliases[0].id);
  assert.equal(plan.map.linkAliases[0].canonicalKey,'l0001');
  const revised=copy();
  for(const group of ['inventories','relationships','terms','termBindings'])revised[group].reverse();
  await writeFile(output('reorder.json'),JSON.stringify(revised));
  assert.deepEqual(await call('plan-fixture-import',output('reorder.json'),workspace,output('reordered-plan.json')),plan);
  revised.relationships.push({key:'l0000',kind:'hosts',from:'n0001',to:'n0002'});
  await writeFile(output('reorder.json'),JSON.stringify(revised));
  const alias=await call('plan-fixture-import',output('reorder.json'),workspace,output('alias-plan.json'));
  assert.equal(alias.map.links.find(x=>x.key==='l0000').id,plan.map.links.find(x=>x.key==='l0001').id);
  assert.deepEqual(alias.map.nodes,plan.map.nodes);
  assert.notEqual(alias.planDigest,plan.planDigest);
});
test('CLI rejects invalid source, scope, canonical plan changes, missing confirmations, and unsafe existing paths',async t=>{
  const output=await room(t),planFile=output('plan.json'),db=output('test.sqlite');
  const plan=await call('plan-fixture-import',fixture,workspace,planFile);
  const testFile=output('invalid-input.json');
  async function malformed(mutator,message){
    const value=copy();mutator(value);
    await writeFile(testFile,JSON.stringify(value));
    await invalid(['plan-fixture-import',testFile,workspace,output('rejected.json')],message);
  }
  await malformed(s=>s.inventories[0].name='Sample private note rejected',/unsupported field/);
  await malformed(s=>s.inventories[0].key='n0002\n',/unsupported field/);
  await malformed(s=>s.relationships[0].from='n9999',/unresolved inventory/);
  await malformed(s=>s.relationships[0].from='n0001',/incompatible/);
  await malformed(s=>s.relationships.push({key:'l0010',kind:'writes',from:'n0003',to:'n0002'}),/directed cycle/);
  await malformed(s=>s.inventories[3].owner='quality',/conflicts/);
  await malformed(s=>{s.relationships[0]={key:'l0001',kind:'reads',from:'n0002',to:'n0003'};},/conflicts/);
  await malformed(s=>s.termBindings[0].node='n0001',/incompatible/);
  await malformed(s=>s.termBindings[0].term='t9999',/unresolved inventory or term/);
  await malformed(s=>s.inventories=Array.from({length:101},()=>s.inventories[0]),/bounded count/);
  await writeFile(testFile,JSON.stringify(source).replace('"packageId":',String.raw`"packageId":"fixture-0000","package\u0049d":`));
  await invalid(['plan-fixture-import',testFile,workspace,output('rejected.json')],/Duplicate JSON object member/);
  await writeFile(testFile,Buffer.alloc(512*1024+1,32));
  await invalid(['plan-fixture-import',testFile,workspace,output('rejected.json')],/512 KiB/);
  if(process.platform!=='win32'){
    await symlink(fixture,output('link.json'));
    await invalid(['plan-fixture-import',output('link.json'),workspace,output('rejected.json')],/single-link/);
  }
  await invalid(['plan-fixture-import',fixture,'ordinary-workspace',output('rejected.json')],/must begin with migration-/);
  await invalid(['plan-fixture-import',fixture,workspace+'\n',output('rejected.json')],/must begin with migration-/);
  await invalid(['plan-fixture-import',fixture,workspace,planFile],/EEXIST/);
  await invalid(['import-fixture',fixture,planFile,db],/Usage/);
  await invalid(['import-fixture',fixture,planFile,db,'--confirm','0'.repeat(64)],/differs from the reviewed plan/);
  await writeFile(output('tampered.json'),JSON.stringify({...plan,map:{...plan.map,nodes:[]}}));
  await invalid(['import-fixture',fixture,output('tampered.json'),db,'--confirm',plan.planDigest],/differs from the reviewed plan/);
  await writeFile(testFile,JSON.stringify({...source,packageId:'fixture-0001'}));
  await invalid(['import-fixture',testFile,planFile,db,'--confirm',plan.planDigest],/differs from the reviewed plan/);
  assert.equal((await readdir(output())).includes('test.sqlite'),false);
  assert.equal((await readdir(output())).includes('rejected.json'),false);
  await writeFile(db,'do not overwrite');
  await invalid(['import-fixture',fixture,planFile,db,'--confirm',plan.planDigest],/EEXIST/);
  assert.equal(await readFile(db,'utf8'),'do not overwrite');
  assert.ok(!(await readdir(output())).some(file=>file.startsWith('.trust-storage-')));
});
test('CLI import reads back in the isolated HTTP app, defers approvals, and supports a pristine rollback checkpoint',async t=>{
  const output=await room(t),planFile=output('plan.json'),db=output('test.sqlite'),rollback=output('rollback.sqlite');
  const plan=await call('plan-fixture-import',fixture,workspace,planFile);
  const receipt=await call('import-fixture',fixture,planFile,db,'--confirm',plan.planDigest);
  assert.match(receipt.receiptId,digestPattern);
  assert.equal(receipt.planDigest,plan.planDigest);
  assert.equal(receipt.stages[3].outcome,'deferred-independent-approval');
  if(process.platform!=='win32')assert.equal((await stat(db)).mode&0o777,0o600);
  const backup=await call('backup',db,output('verified-backup.json'));
  assert.equal(backup.mode,'isolated');
  assert.equal(backup.documents,1);
  const document=JSON.parse(await readFile(output('verified-backup.json'))).documents[0];
  assert.equal(document.scope,'workspace:'+workspace);
  assert.deepEqual(document.payload.fixtureMigrationReceipt,receipt);
  assert.deepEqual(document.payload.dictionary.references,[]);
  assert.equal(document.payload.audit[0].action,'migration.fixture-imported');
  await invalid(['rollback-fixture-import',db,rollback,'--confirm','a'.repeat(64)],/no longer matches/);
  const undone=await call('rollback-fixture-import',db,rollback,'--confirm',receipt.receiptId);
  assert.equal(undone.sourceRetained,true);
  assert.equal(undone.workspace,workspace);
  await invalid(['rollback-fixture-import',db,db,'--confirm',receipt.receiptId],/EEXIST/);
  const cleared=await setup(rollback,output('rollback-room'));
  const live=await setup(db,output('intake-room'));
  t.after(async()=>{await live.close();await cleared.close();});
  const rollbackToken=await cleared.login(0);
  assert.deepEqual((await cleared.request('/api/data-map',200,{scope:workspace,cookie:rollbackToken})).value.nodes,[]);
  const [a,r,beta]=await Promise.all([live.login(0),live.login(1),live.login(2,'migration-other')]);
  const req=(path,status,cookie,body,scope=workspace)=>live.request(path,status,{cookie,body,scope}).then(x=>x.value);
  await req('/api/data-map',401);
  await req('/api/data-map',403,beta);
  assert.deepEqual((await req('/api/data-map',200,beta,undefined,'migration-other')).nodes,[]);
  const graph=await req('/api/data-map',200,a);
  assert.deepEqual(graph.nodes.map(n=>n.id),plan.map.nodes.map(n=>n.id));
  assert.deepEqual(graph.links.map(n=>n.id),plan.map.links.map(n=>n.id));
  const node=plan.map.nodes.find(n=>n.type==='dataset');
  const related=await req('/api/data-map/nodes/'+node.id+'/lineage',200,a);
  assert.equal(related.upstream.length,1);
  assert.equal(related.downstream.length,1);
  const dictionary=await req('/api/dictionary',200,a);
  assert.equal(dictionary.terms.length,2);
  assert.ok(dictionary.terms.every(t=>t.activeVersion===null&&t.versions[0].status==='draft'&&t.consumers.length===0));
  const audit=(await req('/api/audit/export',200,r)).audit;
  assert.equal(audit[0].details.planDigest,plan.planDigest);
  assert.doesNotMatch(JSON.stringify(await req('/api/state',200,a)),/fixtureMigrationReceipt|receiptId|snapshotDigest/);
  const draft=dictionary.terms.find(term=>term.type==='sensitivity'),item='/api/dictionary/terms/'+draft.id;
  await req(item+'/attach',409,a,{expectedRevision:1,expectedMapRevision:1,nodeId:node.id,version:1});
  await req(item+'/submit',200,a,{expectedRevision:1,version:1});
  await req(item+'/approve',403,a,{expectedRevision:2,version:1});
  await req(item+'/approve',200,r,{expectedRevision:2,version:1});
  const updated=await req(item+'/attach',200,a,{expectedRevision:3,expectedMapRevision:1,nodeId:node.id,version:1});
  assert.equal(updated.terms.find(term=>term.id===draft.id).consumers[0].nodeId,node.id);
  await invalid(['rollback-fixture-import',db,output('drifted.sqlite'),'--confirm',receipt.receiptId],/untouched/);
  assert.ok(!(await readdir(output())).includes('drifted.sqlite'));
});

async function reported(args,code){
  try{
    const result=await call(...args);
    assert.equal(code,0);
    return result;
  }catch(error){
    if(error.code!==code)throw error;
    assert.equal(error.stderr,'');
    return JSON.parse(error.stdout);
  }
}

test('diagnostics return all independent synthetic defects by stage and row and never stage a blocked plan',async t=>{
  const output=await room(t);
  const submitted=copy(),input=output('diagnose.json');
  submitted.inventories[3].owner='quality';
  submitted.relationships[0].from='n9999';
  submitted.terms[0].title='Fictional unexpected field should never echo';
  submitted.termBindings[1].node='n0002';
  await writeFile(input,JSON.stringify(submitted));
  const report=await reported(['diagnose-fixture-import',input,workspace],2);
  assert.equal(report.status,'blocked');
  assert.equal(report.issueCount,5);
  assert.deepEqual(report.issues.map(({stage,row,code})=>[stage,row,code]),[
    ['inventory',4,'CONFLICTING_KEY'],['relationships',1,'UNRESOLVED_REFERENCE'],['terms',1,'INVALID_ROW'],
    ['termBindings',1,'UNRESOLVED_REFERENCE'],['termBindings',2,'INCOMPATIBLE_REFERENCE'],
  ]);
  assert.equal(report.planDigest,undefined);
  assert.doesNotMatch(JSON.stringify(report),/Fictional unexpected field|n9999/);
  assert.deepEqual(await readdir(output()),['diagnose.json']);
  await invalid(['plan-fixture-import',input,workspace,output('no-plan.json')],/conflicts/);

  await writeFile(input,JSON.stringify({...source,relationships:Array.from({length:51},()=>null)}));
  const capped=await reported(['diagnose-fixture-import',input,workspace],2);
  assert.equal(capped.issueCount,51);
  assert.equal(capped.truncated,true);
  assert.equal(capped.issues.length,50);
  await writeFile(input,Buffer.from([0xff,0xfe]));
  assert.equal((await reported(['diagnose-fixture-import',input,workspace],2)).issues[0].code,'INVALID_UTF8');
  assert.equal((await reported(['diagnose-fixture-import',output('missing.json'),workspace],2)).issues[0].code,'INVALID_LOCAL_FILE');
  assert.equal((await reported(['diagnose-fixture-import',fixture,'incorrect-scope'],2)).issues[0].code,'INVALID_WORKSPACE');
  const ready=await reported(['diagnose-fixture-import',fixture,workspace],0);
  const plan=await call('plan-fixture-import',fixture,workspace,output('plan.json'));
  assert.equal(ready.status,'ready');
  assert.equal(ready.planDigest,plan.planDigest);
  assert.deepEqual(ready.stages,plan.stages);
});

test('read-only reconciliation verifies the complete supported snapshot, including a backup/restore round trip',async t=>{
  const output=await room(t),planFile=output('plan.json'),db=output('fixture.sqlite'),restored=output('restored.sqlite');
  const plan=await call('plan-fixture-import',fixture,workspace,planFile);
  const receipt=await call('import-fixture',fixture,planFile,db,'--confirm',plan.planDigest);
  const bytes=await readFile(db);
  const verification=(file,code=0)=>reported(['verify-fixture-import',fixture,planFile,file,'--confirm',receipt.receiptId],code);
  const report=await verification(db);
  assert.equal(report.status,'verified');
  assert.deepEqual(Object.values(report.checks),[true,true,true,true,true,true]);
  const count=n=>({expected:n,observed:n,matched:n,missing:0,changed:0,extra:0,duplicates:0});
  assert.deepEqual(report.stages,{inventory:count(3),relationships:count(2),terms:count(2),
    termBindings:{planned:2,expectedApplied:0,observedApplied:0}});
  assert.deepEqual(await readFile(db),bytes);
  await call('backup',db,output('snapshot.json'));
  const {payload:golden}=JSON.parse(await readFile(output('snapshot.json'))).documents[0];
  assert.deepEqual(golden.dataMap.nodes.map(({type,name,owner,detail,createdAt,updatedAt,archivedAt})=>
    [type,name,owner,detail,createdAt,updatedAt,archivedAt]),[
    ['system','Fictional system 0001','Fictional Studio','Fictional service sandbox.','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z',null],
    ['dataset','Fictional dataset 0002','Fictional Operations','Fictional event schema; no sample values.','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z',null],
    ['activity','Fictional activity 0003','Fictional Quality','Fictional workflow rehearsal.','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z',null],
  ]);
  const [system,dataset,activity]=golden.dataMap.nodes.map(({id})=>id);
  assert.deepEqual(golden.dataMap.links.map(({type,fromId,toId})=>[type,fromId,toId]),[['hosts',system,dataset],['reads',dataset,activity]]);
  assert.deepEqual(golden.dictionary.terms.map(({slug,activeVersion,versions})=>
    [slug,activeVersion,versions[0].title,versions[0].review]),
    [['migration-fixture-0042-t0001',null,'Fictional sensitivity term 0001',null],
      ['migration-fixture-0042-t0002',null,'Fictional purpose term 0002',null]]);
  assert.deepEqual(golden.dictionary.references,[]);
  await call('restore',output('snapshot.json'),restored);
  assert.deepEqual(await verification(restored),report);
  await invalid(['verify-fixture-import',fixture,planFile,restored,'--confirm','d'.repeat(64)],/no longer matches/);

  const {openSqlite}=require('../durable-storage');
  const sqlite=openSqlite(restored);
  try{
    sqlite.scope('workspace:'+workspace).write('workbench',(state,commit)=>{
      const [first,second,third]=state.dataMap.nodes;
      const changed={...first,detail:'Fictional changed marker not to echo'};
      state.dataMap.nodes=[changed,third,{...third,id:second.id.replace(/^.{8}/,'00000000')},changed];
      state.dataMap.links.reverse(); // Same rows; full snapshot fidelity still detects ordering drift.
      state.dictionary.terms[0].versions[0].status='review';
      state.dictionary.references.push({termId:state.dictionary.terms[0].id,nodeId:third.id,version:1});
      commit(state);
    });
  }finally{sqlite.close();}
  const drifted=await readFile(restored);
  const drift=await verification(restored,2);
  assert.equal(drift.status,'drift');
  assert.deepEqual(drift.stages.inventory,{expected:3,observed:4,matched:1,missing:1,changed:1,extra:1,duplicates:1});
  assert.deepEqual(drift.stages.relationships,count(2));
  assert.equal(drift.stages.terms.changed,1);
  assert.equal(drift.stages.termBindings.observedApplied,1);
  assert.equal(drift.checks.genesisGeneration,false);
  assert.equal(drift.checks.planMatchesReceipt,true);
  assert.equal(drift.checks.auditMatches,true);
  assert.equal(drift.checks.snapshotDigestMatches,false);
  assert.doesNotMatch(JSON.stringify(drift),/Fictional changed marker not to echo/);
  const rejected=output('not-created.sqlite');
  await invalid(['rollback-fixture-import',restored,rejected,'--confirm',receipt.receiptId],/untouched/);
  assert.deepEqual(await readFile(restored),drifted);
  assert.ok(!(await readdir(output())).includes('not-created.sqlite'));
});

test('concurrent confirmed imports and rollbacks have a single winner and preserve the verified source',async t=>{
  const output=await room(t),planFile=output('plan.json'),db=output('fixture.sqlite'),rollback=output('rollback.sqlite');
  const plan=await call('plan-fixture-import',fixture,workspace,planFile);
  function singleWinner(results){
    const ok=results.filter(r=>r.status==='fulfilled'),errors=results.filter(r=>r.status==='rejected');
    assert.equal(ok.length,1);assert.equal(errors.length,1);
    assert.match(errors[0].reason.stderr,/EEXIST/);
    return ok[0].value;
  }
  const imports=await Promise.allSettled(Array.from({length:2},()=>call('import-fixture',fixture,planFile,db,'--confirm',plan.planDigest)));
  const receipt=singleWinner(imports);
  const bytes=await readFile(db);
  assert.equal((await call('verify-fixture-import',fixture,planFile,db,'--confirm',receipt.receiptId)).status,'verified');
  const rollbacks=await Promise.allSettled(Array.from({length:2},()=>call('rollback-fixture-import',db,rollback,'--confirm',receipt.receiptId)));
  assert.equal(singleWinner(rollbacks).restoredFromReceipt,receipt.receiptId);
  assert.deepEqual(await readFile(db),bytes);
  assert.deepEqual((await readdir(output())).sort(),['fixture.sqlite','plan.json','rollback.sqlite']);
  await invalid(['verify-fixture-import',fixture,planFile,rollback,'--confirm',receipt.receiptId],/receipt is required/);
});

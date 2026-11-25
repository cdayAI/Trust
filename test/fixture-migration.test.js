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

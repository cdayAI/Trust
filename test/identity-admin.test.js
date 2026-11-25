'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {mkdtemp,rm,readFile}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {randomBytes}=require('node:crypto');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
const {backupDatabase,restoreDatabase}=require('../durable-storage');

async function setup(t,{sqlite=false}={}){
  const root=await mkdtemp(join(tmpdir(),'mvw-local-identity-'));
  const codeById=new Map();
  const now=Date.now();
  const account=(id,memberships,more={})=>{
    const code=randomBytes(32).toString('base64url');codeById.set(id,code);
    return {id,codeHash:codeHash(code),memberships,...more};
  };
  const config={
    enableIdentityAdmin:true,root:join(root,'workspaces'),now:()=>now,
    workspaces:[{id:'north',label:'Fictional North'},{id:'south',label:'Fictional South'}],
    accounts:[
      account('admin-north',{north:'identity-admin'}),account('admin-south',{south:'identity-admin'}),
      account('test-analyst',{north:'analyst',south:'analyst'}),account('test-reviewer',{north:'reviewer'}),
      account('configured-off',{north:'case-operator'},{disabled:true}),
      account('configured-expired',{north:'publisher'},{validUntil:now-1}),
      account('south-only',{south:'reviewer'})
    ]
  };
  let server,url,sqliteFile=sqlite?join(root,'identity.sqlite'):undefined;
  async function stop(){
    if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  }
  async function start(){
    server=createServer({isolated:config,sqliteFile}).listen(0,'127.0.0.1');
    await once(server,'listening');url='http://127.0.0.1:'+server.address().port;
  }
  t.after(async()=>{await stop();await rm(root,{recursive:true,force:true});});
  await start();
  async function call(route,wanted,{session,workspace='north',body,method=body===undefined?'GET':'POST',origin=url,demoActor='identity-admin'}={}){
    const target=url+'/api/'+route+(workspace===null?'':'?workspace='+workspace);
    const response=await fetch(target,{method,headers:{
      'X-Demo-Actor':demoActor,...(session?{Cookie:session}:{}),
      ...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'})
    },...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();
    assert.equal(response.status,wanted,method+' '+route+': '+JSON.stringify(data));
    return {status:response.status,data,token:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
  }
  const login=(id,workspace='north',status=200)=>call('session/login',status,{workspace:null,body:{account:id,code:codeById.get(id),workspace}});
  const roster=(session,workspace='north')=>call('identity-admin',200,{session,workspace});
  const apply=(session,target,operation,reason,expectedRevision,status=200,workspace='north')=>call('identity-admin',status,{
    session,workspace,body:{target,operation,reason,expectedRevision}
  });
  return {root,config,codeById,url,call,login,roster,apply,stop,async restart(){await stop();await start();},
    async restore(){
      await stop();const backup=join(root,'identity-backup.json'),next=join(root,'identity-restored.sqlite');
      backupDatabase(sqliteFile,backup);restoreDatabase(backup,next);sqliteFile=next;await start();
      return JSON.parse(await readFile(backup,'utf8'));
    }
  };
}

test('dedicated identity administrator cannot read program data or manage accounts outside its workspace',async t=>{
  const f=await setup(t);
  const analyst=await f.login('test-analyst'),reviewer=await f.login('test-reviewer'),admin=await f.login('admin-north');
  assert.throws(()=>createServer({isolated:{...f.config,enableIdentityAdmin:false}}),/Invalid or duplicated workspace role assignment/);
  assert.deepEqual(admin.data.capabilities,{views:['identity-admin'],workspaceAudit:false});
  await f.call('identity-admin',401);
  for(const token of [analyst.token,reviewer.token]){
    await f.call('identity-admin',403,{session:token});
    await f.apply(token,'test-analyst','disable','access-review',0,403);
  }
  for(const route of ['audit/export','workflows/studio','employee-attestations','rights/cases','reporting/export','modules'])
    await f.call(route,403,{session:admin.token});
  await f.call('projects',403,{session:admin.token,body:{name:'Not permitted'}});
  await f.call('identity-admin/extra',404,{session:admin.token});
  await f.call('identity-admin',403,{session:admin.token,workspace:'south'});
  await f.call('identity-admin',404,{session:admin.token,method:'DELETE'});
  await f.call('identity-admin',403,{session:admin.token,origin:'http://localhost:7',
    body:{target:'test-analyst',operation:'disable',reason:'access-review',expectedRevision:0}});
  const permitted=(await f.roster(admin.token)).data;
  assert.deepEqual(permitted.members.map(row=>row.id),['admin-north','test-analyst','test-reviewer','configured-off','configured-expired']);
  assert.deepEqual(permitted.members.find(row=>row.id==='admin-north').allowed,[]);
  assert.equal(permitted.members.find(row=>row.id==='configured-off').status,'configuration-disabled');
  assert.equal(permitted.members.find(row=>row.id==='configured-expired').status,'expired');
  assert.doesNotMatch(JSON.stringify(permitted),/codeHash|validUntil|admin-south|south-only/);
  for(const code of f.codeById.values())assert.ok(!JSON.stringify(permitted).includes(code));
  const own=await f.apply(admin.token,'admin-north','disable','access-review',0,403);
  assert.equal(own.data.code,'ADMIN_SEAT_PROTECTED');
  await f.apply(admin.token,'south-only','disable','access-review',0,404);
  await f.apply(admin.token,'configured-off','enable','access-review',0,409);
  await f.apply(admin.token,'configured-expired','enable','access-review',0,409);
  const attempted=await f.call('identity-admin',422,{session:admin.token,
    body:{target:'test-analyst',operation:'disable',reason:'access-review',expectedRevision:0,role:'reviewer'}});
  assert.equal(attempted.data.code,'INVALID_IDENTITY_CHANGE');
  assert.deepEqual((await f.roster(admin.token)).data.audit,[]);
});

for(const sqlite of [false,true])test(`disable, re-enable and revocation persist without reviving cookies (${sqlite?'SQLite restore':'local JSON restart'})`,async t=>{
  const f=await setup(t,{sqlite});
  const admin=await f.login('admin-north');
  const north=await f.login('test-analyst'),south=await f.login('test-analyst','south');
  const first=await f.apply(admin.token,'test-analyst','disable','assignment-ended',0);
  assert.equal(first.data.members.find(row=>row.id==='test-analyst').status,'disabled');
  await f.call('state',401,{session:north.token});
  await f.call('state',200,{session:south.token,workspace:'south'});
  assert.equal((await f.call('session',200,{session:south.token,workspace:null})).data.workspaces.some(x=>x.id==='north'),false);
  await f.call('session/switch',403,{session:south.token,workspace:null,body:{current:'south',workspace:'north'}});
  await f.login('test-analyst','north',401);
  const stale=await f.apply(admin.token,'test-analyst','enable','assignment-restored',0,409);
  assert.equal(stale.data.code,'IDENTITY_STALE');
  await f.apply(admin.token,'test-analyst','enable','assignment-restored',1);
  await f.call('state',401,{session:north.token});
  const next=await f.login('test-analyst');
  const second=await f.login('test-analyst');
  await f.apply(admin.token,'test-analyst','revoke','session-reset',2);
  await f.call('state',401,{session:next.token});
  await f.call('state',401,{session:second.token});
  await f.call('state',200,{session:south.token,workspace:'south'});
  assert.ok((await f.login('test-analyst')).token);
  await f.apply(admin.token,'test-analyst','disable','access-review',3);
  const saved=sqlite?await f.restore():null;
  if(!sqlite)await f.restart();
  const adminAfter=await f.login('admin-north');
  assert.equal((await f.login('test-analyst','north',401)).token,undefined);
  assert.ok((await f.login('test-analyst','south')).token);
  const history=(await f.roster(adminAfter.token)).data.audit;
  assert.deepEqual(history.map(row=>[row.action,row.revision]),[['disable',4],['revoke',3],['enable',2],['disable',1]]);
  assert.ok(history.every(row=>row.actor==='admin-north'&&row.target==='test-analyst'));
  const secondAdmin=await f.login('admin-south','south');
  assert.deepEqual((await f.roster(secondAdmin.token,'south')).data.audit,[]);
  const reviewer=await f.login('test-reviewer');
  const state=(await f.call('state',200,{session:reviewer.token})).data;
  assert.equal(state.identityAdministration,undefined);
  const audit=(await f.call('audit/export',200,{session:reviewer.token})).data.audit.filter(e=>e.actor==='identity-admin');
  assert.equal(audit.length,4);
  if(saved){
    assert.ok(saved.documents.some(doc=>doc.scope==='workspace:north'&&doc.payload.identityAdministration.members[0].disabled));
    const serialized=JSON.stringify(saved);
    for(const code of f.codeById.values())assert.ok(!serialized.includes(code)&&!serialized.includes(codeHash(code)));
    assert.ok(!serialized.includes(admin.token.split('=')[1]));
  }
});

test('browser: dedicated identity seat confirms disabling a synthetic membership and displays its audit', {
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 with Playwright installed',timeout:30000
},async t=>{
  const {chromium}=require('playwright');
  const f=await setup(t);
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const page=await browser.newPage();
    page.setDefaultTimeout(6000);
    await page.goto(f.url);
    await page.getByLabel('Test account').fill('admin-north');
    await page.getByLabel('Workspace ID').fill('north');
    await page.getByLabel('Local access code').fill(f.codeById.get('admin-north'));
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.getByRole('heading',{name:'Identity administration',level:1}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Reporting',exact:true}).count(),0);
    const member=page.locator('#identity-admin-view article').filter({has:page.getByRole('heading',{name:'test-analyst',exact:true})});
    await member.locator('summary').filter({hasText:'Disable workspace access'}).click();
    const disable=member.getByRole('form',{name:'Disable workspace access for test-analyst'});
    await disable.getByLabel('Reason').selectOption('assignment-ended');
    await disable.getByRole('checkbox').check();
    await disable.getByRole('button',{name:'Disable workspace access'}).click();
    await member.getByText('Disabled in this workspace',{exact:true}).waitFor();
    await page.getByText('Access disabled · test-analyst',{exact:true}).waitFor();
    assert.equal(await page.locator('#identity-member-test-analyst').evaluate(e=>document.activeElement===e),true);
    await f.login('test-analyst','north',401);
  }finally{await browser.close();}
});

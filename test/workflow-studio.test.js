'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {once}=require('node:events');
const {randomBytes}=require('node:crypto');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
async function start(options){
  const s=createServer(options);s.listen(0,'127.0.0.1');await once(s,'listening');
  return {url:'http://127.0.0.1:'+s.address().port,close:()=>new Promise(resolve=>s.close(resolve))};
}
test('workflow studio renders bounded recipes, pinned versions, allowed actions and durable audit',async t=>{
  const root=await mkdtemp(join(tmpdir(),'workflow-studio-')),opts={dataFile:join(root,'state.json')};
  let live=await start(opts);t.after(async()=>{await live.close();await rm(root,{recursive:true,force:true})});
  async function request(path,status,actor='analyst',body){
    const r=await fetch(live.url+'/api/workflows/'+path,{
      headers:{'X-Demo-Actor':actor,'Content-Type':'application/json'},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})
    });
    const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data;
  }
  assert.match(await (await fetch(live.url+'/workflow-studio-ui.js')).text(),/buildStudioDraft/);
  const before=await request('studio',200,'publisher');
  assert.equal(before.definitions.length,0);
  assert.equal(before.recipes.length,2);
  const recipe=before.recipes[0],changed={...recipe,id:'sample-studio',label:'Fictional intake plus review'};
  const publish=async(definition,expectedVersion,status=200,actor='publisher')=>request('definitions',status,actor,{definition,expectedVersion});
  await publish({...changed,states:[...changed.states,{id:'orphan',label:'Orphan'}]},0,422);
  await publish(changed,0,403,'analyst');
  await publish(changed,0);
  await publish(changed,0,409);
  const d2={...changed,label:'Revised fictional workflow',
    transitions:changed.transitions.map(x=>x.id==='approve'?{...x,requiredFields:['reason','extraComment']}:x)};
  await publish(d2,1);
  const selected=await request('studio',200,'analyst');
  assert.deepEqual(selected.definitions,[{id:changed.id,label:d2.label,versions:[1,2]}]);
  const opened=await request('instances',200,'analyst',{definitionId:changed.id,version:1,title:'Fictional case'});
  const {id}=opened.instance;
  await request('studio/wf-unknown',404);
  const getActor=who=>request('studio/'+id,200,who);
  assert.deepEqual((await getActor('reviewer')).selected.actions.map(x=>x.allowed),[false]);
  assert.deepEqual((await getActor('analyst')).selected.actions.map(x=>x.allowed),[true]);
  const transition=(name,expectedRevision,fields,actor,status=200)=>request('instances/'+id+'/transitions',status,actor,
    {transitionId:name,expectedRevision,fields});
  await transition('submit-for-review',1,{},'analyst',422);
  await transition('submit-for-review',1,{summary:'Original fictional description'},'analyst');
  assert.ok((await getActor('reviewer')).selected.actions.every(x=>x.allowed));
  assert.ok((await getActor('analyst')).selected.actions.every(x=>!x.allowed));
  await transition('approve',1,{reason:'Stale copy'},'reviewer',409);
  await transition('approve',2,{reason:'Reviewed exactly the first edition'},'reviewer');
  const finished=(await getActor('reviewer')).selected;
  assert.equal(finished.instance.definitionVersion,1);
  assert.equal(finished.instance.revision,3);
  assert.deepEqual(finished.actions,[]);
  const audit=(await request('audit',200)).audit;
  assert.ok(audit.some(x=>x.code==='INVALID_DEFINITION'));
  assert.ok(audit.some(x=>x.code==='STALE_REVISION'));
  assert.ok(audit.some(x=>x.code==='ROLE_REQUIRED'));
  await live.close();live=await start(opts);
  assert.deepEqual((await getActor('reviewer')).selected,finished);
  assert.equal((await request('definitions/'+changed.id+'/1',200)).label,changed.label);
});
test('isolated studio derives logged-in account and role and keeps the sandbox scoped',async t=>{
  const root=await mkdtemp(join(tmpdir(),'workflow-studio-isolated-'));
  const users=['publisher','analyst','reviewer'].map(role=>({role,id:'sample-'+role,code:randomBytes(32).toString('base64url')}));
  const opts={isolated:{root,workspaces:[{id:'alpha',label:'Alpha'},{id:'beta',label:'Beta'}],
    accounts:users.map(x=>({id:x.id,codeHash:codeHash(x.code),memberships:{alpha:x.role,beta:x.role}}))}};
  const live=await start(opts);t.after(async()=>{await live.close();await rm(root,{recursive:true,force:true})});
  async function api(path,status,{body,cookie,workspace,actor='publisher'}={}){
    const r=await fetch(live.url+'/api/'+path+(workspace?'?workspace='+workspace:''),{headers:{Origin:live.url,'Content-Type':'application/json',
      'X-Demo-Actor':actor,...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
    const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));
    return {data,cookie:r.headers.get('set-cookie')?.split(';')[0]};
  }
  const login=async(role,workspace)=>{
    const {id,code}=users.find(x=>x.role===role);
    return (await api('session/login',200,{body:{account:id,code,workspace}})).cookie;
  };
  await api('workflows/studio',401,{workspace:'alpha'});
  const p=await login('publisher','alpha'),a=await login('analyst','alpha'),r=await login('reviewer','alpha'),b=await login('analyst','beta');
  const studio=async(cookie,workspace='alpha')=>(await api('workflows/studio',200,{cookie,workspace})).data;
  const model=await studio(p);
  assert.deepEqual(model.actor,{id:'sample-publisher',role:'publisher'});
  const definition=model.recipes[0];
  const post=(path,status,cookie,body,workspace='alpha')=>api('workflows/'+path,status,{cookie,body,workspace});
  await post('definitions',403,a,{definition,expectedVersion:0});
  await post('definitions',200,p,{definition,expectedVersion:0});
  assert.deepEqual((await studio(b,'beta')).definitions,[]);
  assert.deepEqual((await studio(b,'beta')).recentAudit,[]);
  const instance=(await post('instances',200,a,{definitionId:definition.id,version:1,title:'Fictional tenant case'})).data.instance;
  const path='instances/'+instance.id+'/transitions';
  await post(path,200,a,{transitionId:'submit-for-review',expectedRevision:1,fields:{summary:'Test only'}});
  await post(path,403,a,{transitionId:'approve',expectedRevision:2,fields:{reason:'Wrong role'}});
  await post(path,200,r,{transitionId:'approve',expectedRevision:2,fields:{reason:'Independent decision'}});
  const alpha=await studio(a);
  assert.equal(alpha.recentAudit[0].actor.id,'sample-reviewer');
  assert.equal(alpha.recentAudit.find(x=>x.kind==='instance.start').actor.id,'sample-analyst');
  await api('workflows/studio/'+instance.id,404,{cookie:b,workspace:'beta'});
  await api('workflows/studio/'+instance.id,403,{cookie:b,workspace:'alpha'});
});

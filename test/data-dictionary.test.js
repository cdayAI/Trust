'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {once}=require('node:events');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
async function start(options){
  const server=createServer(options);server.listen(0,'127.0.0.1');await once(server,'listening');
  return {url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};
}
test('governed dictionary pins typed inventory to an exact approved version and refuses stale or invalid changes',async t=>{
  const root=await mkdtemp(join(tmpdir(),'trust-dictionary-'));
  let live=await start({dataFile:join(root,'state.json')});
  t.after(async()=>{await live.close();await rm(root,{recursive:true,force:true})});
  async function call(path,status,{body,actor='analyst'}={}){
    const res=await fetch(live.url+path,body===undefined?{}:{
      method:'POST',headers:{'Content-Type':'application/json','X-Demo-Actor':actor},body:JSON.stringify(body)
    });
    const data=await res.json();
    assert.equal(res.status,status,JSON.stringify(data));return data;
  }
  const dictionary='/api/dictionary',map='/api/data-map';
  const nodeBody=(type,name,expectedRevision)=>({type,name,owner:'Fictional owner',detail:'Fictional description',expectedRevision});
  const post=(path,body,status=200,actor)=>call(path,status,{body,actor});
  const system=(await post(map+'/nodes',nodeBody('system','Sample host',0))).nodes[0];
  const dataset=(await post(map+'/nodes',nodeBody('dataset','Sample entries',1))).nodes[1];
  const draft={expectedRevision:0,slug:'sample-sensitivity',type:'sensitivity',title:'Sample restricted',definition:'Version one fictional definition.'};
  let state=await post(dictionary+'/terms',draft);
  const term=state.terms[0],route=dictionary+'/terms/'+term.id;
  const act=(action,expectedRevision,fields,status,actor)=>post(route+'/'+action,{expectedRevision,...fields},status,actor);
  await post(dictionary+'/terms',{...draft,expectedRevision:1},409);
  const pin=(nodeId,version,expectedMapRevision)=>({nodeId,version,expectedMapRevision});
  assert.equal((await act('attach',1,pin(dataset.id,1,2),409)).code,'TERM_VERSION_REQUIRED');
  assert.equal((await act('retire',1,{reason:'Still pending'},409)).code,'TERM_PENDING');
  state=await act('submit',1,{version:1});
  assert.equal((await act('approve',2,{version:1},403)).code,'DICTIONARY_ROLE');
  assert.equal((await act('approve',1,{version:1},409,'reviewer')).code,'DICTIONARY_STALE');
  await act('approve',2,{version:1},200,'reviewer');
  assert.equal((await act('attach',3,pin(system.id,1,2),422)).code,'CONSUMER_TYPE');
  assert.equal((await act('attach',3,pin(dataset.id,1,1),409)).code,'DICTIONARY_MAP_STALE');
  state=await act('attach',3,pin(dataset.id,1,2));
  assert.equal(state.terms[0].consumers[0].nodeName,'Sample entries');
  assert.equal(state.mapRevision,3);
  assert.equal((await post(map+'/nodes/'+dataset.id+'/archive',{note:'Manual archive',expectedRevision:3},409)).code,'TERM_REFERENCES');
  assert.equal((await act('retire',4,{reason:'Still pinned'},409)).code,'TERM_IN_USE');
  await act('revise',4,{title:'Sample expanded',definition:'A fictional rejected revision.'});
  await act('submit',5,{version:2});
  await act('return',6,{version:2,reason:'Fictional refinement requested.'},200,'reviewer');
  await act('revise',7,{title:'Sample clarified',definition:'A separately approved definition.'});
  await act('submit',8,{version:3});
  assert.equal((await act('approve',9,{version:2},409,'reviewer')).code,'TERM_WRONG_VERSION');
  state=await act('approve',9,{version:3},200,'reviewer');
  assert.equal(state.terms[0].activeVersion,3);
  assert.equal(state.terms[0].versions[0].definition,draft.definition);
  assert.equal(state.terms[0].consumers[0].version,1);
  const graph=(await call(map+'/export',200)).graph;
  assert.deepEqual(graph.nodes.find(n=>n.id===dataset.id).dictionaryTerms,[{slug:draft.slug,title:draft.title,type:draft.type,version:1}]);
  assert.equal((await act('attach',10,pin(dataset.id,3,3),409)).code,'CONSUMER_ALREADY_PINNED');
  assert.equal((await act('detach',10,pin(dataset.id,3,3),409)).code,'TERM_PIN_MISMATCH');
  state=await act('detach',10,pin(dataset.id,1,3));
  assert.equal(state.terms[0].consumers.length,0);
  assert.equal((await act('attach',11,pin(dataset.id,1,4),409)).code,'TERM_VERSION_REQUIRED');
  await act('retire',11,{reason:''},422);
  assert.equal((await call(dictionary,200)).terms[0].retiredAt,null);
  const retired=await act('retire',11,{reason:'Local retirement checked.'});
  assert.ok(retired.terms[0].retiredAt);
  assert.equal((await act('attach',12,pin(dataset.id,3,4),409)).code,'TERM_RETIRED');
  await post(map+'/nodes/'+dataset.id+'/archive',{note:'Manual archive',expectedRevision:4});
  const exported=await call(dictionary+'/export',200);
  assert.ok(exported.audit.some(x=>x.action==='dictionary.refused'&&x.details.code==='TERM_IN_USE'));
  assert.ok(exported.audit.some(x=>x.action==='dictionary.retire'));
  await live.close();live=await start({dataFile:join(root,'state.json')});
  assert.deepEqual(await call(dictionary+'/export',200),exported);
});
test('dictionary scope comes from verified workspace membership and not a selected role or record ID',async t=>{
  const root=await mkdtemp(join(tmpdir(),'trust-private-dictionary-'));
  const token=randomBytes(32).toString('base64url');
  const server=await start({isolated:{root,workspaces:[{id:'alpha',label:'Alpha'},{id:'beta',label:'Beta'}],
    accounts:[{id:'local-editor',codeHash:codeHash(token),memberships:{alpha:'analyst',beta:'reviewer'}}]}});
  t.after(async()=>{await server.close();await rm(root,{recursive:true,force:true})});
  async function call(path,status,body,cookie){
    const res=await fetch(server.url+path,{...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),
      headers:{Origin:server.url,'Content-Type':'application/json','X-Demo-Actor':'analyst',...(cookie?{Cookie:cookie}:{})}});
    const data=await res.json();
    assert.equal(res.status,status,JSON.stringify(data));
    return {data,cookie:res.headers.get('set-cookie')?.split(';')[0]};
  }
  const scope='/api/dictionary';
  await call(scope+'/export?workspace=alpha',401);
  const auth=async workspace=>(await call('/api/session/login',200,{account:'local-editor',workspace,code:token})).cookie;
  const a=await auth('alpha'),b=await auth('beta');
  const record={expectedRevision:0,type:'domain',slug:'alpha-fixture',title:'Alpha fixture',definition:'Synthetic workspace boundary test'};
  await call(scope+'/terms?workspace=beta',403,record,a);
  await call(scope+'/terms?workspace=beta',403,record,b);
  await call(scope+'/terms?workspace=alpha',200,record,a);
  const alpha=(await call(scope+'/export?workspace=alpha',200,undefined,a)).data;
  assert.equal(alpha.audit.find(x=>x.action==='dictionary.create').account,'local-editor');
  const beta=(await call(scope+'/export?workspace=beta',200,undefined,b)).data;
  assert.deepEqual(beta.dictionary.terms,[]);
  assert.doesNotMatch(JSON.stringify(beta),/alpha-fixture|Alpha fixture/);
});

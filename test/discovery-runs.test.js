'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
const {once}=require('node:events');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');

const base='data-map/discovery/runs',source='sample-library';
const selectVersion=version=>({source,version});
const b=(p,name)=>p.getByRole('button',{name,exact:true});
const h=(p,name)=>p.getByRole('heading',{name,exact:true});
const see=(p,text)=>p.getByText(text,{exact:true}).waitFor();

async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'mvw-discovery-rehearsal-'));
  const roles=['analyst','reviewer','case-operator'];
  const codes=Object.fromEntries(roles.map(role=>[role,randomBytes(32).toString('base64url')]));
  const opts={sqliteFile:join(dir,'rehearsal.sqlite'),isolated:{
    root:join(dir,'isolated'),workspaces:[{id:'alpha',label:'Sample Alpha'},{id:'beta',label:'Sample Beta'}],
    discoveryRunWorkspaces:['alpha'],
    accounts:roles.map(role=>({id:'sample-'+role,codeHash:codeHash(codes[role]),memberships:{alpha:role,beta:role}}))
  }};
  let server,url;
  async function start(enabled=true){
    const isolated={...opts.isolated};
    if(!enabled)delete isolated.discoveryRunWorkspaces;
    server=createServer({...opts,isolated}).listen(0,'127.0.0.1');await once(server,'listening');
    url='http://127.0.0.1:'+server.address().port;
  }
  async function stop(){if(server?.listening){server.closeAllConnections();await new Promise(r=>server.close(r));}}
  await start();
  t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});
  async function api(path,{cookie,body,status=200,workspace='alpha',actor,method=body===undefined?'GET':'POST'}={}){
    const r=await fetch(url+'/api/'+path+(workspace?(path.includes('?')?'&':'?')+'workspace='+workspace:''),{
      method,headers:{...(cookie?{Cookie:cookie}:{}),...(actor?{'X-Demo-Actor':actor}:{}),
        ...(body===undefined?{}:{Origin:url,'Content-Type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})
    });
    const data=await r.json();
    assert.equal(r.status,status,path+' '+JSON.stringify(data));
    assert.equal(r.headers.get('cache-control'),'no-store');
    return {data,cookie:r.headers.get('set-cookie')?.split(';')[0]};
  }
  const token=async(role,workspace='alpha')=>(await api('session/login',{workspace:null,
    body:{account:'sample-'+role,workspace,code:codes[role]}})).cookie;
  const queue=(cookie,version)=>api(base,{cookie,body:selectVersion(version)}).then(r=>r.data);
  const list=cookie=>api(base,{cookie}).then(r=>r.data);
  const map=(cookie,workspace='alpha')=>api('data-map',{cookie,workspace}).then(r=>r.data);
  const action=(run,op,cookie,status=200,version=run.revision)=>api(base+'/'+run.id+'/'+op,{cookie,body:{expectedRevision:version},status}).then(r=>r.data);
  async function submit(version,a){
    let {run}=await queue(a,version);
    for(const step of ['scan','resume','submit'])({run}=await action(run,step,a));
    return run;
  }
  const approve=async(run,r)=>(await action(run,'approve',r)).run;
  const apply=async(run,a)=>(await action(run,'apply',a)).run;
  return {opts,codes,api,queue,token,list,map,action,submit,approve,apply,get url(){return url},
    restart:async(enabled=true)=>{await stop();await start(enabled)}};
}

test('discovery rehearsal persists scripted partial failure, bounds resume and review reconciliation, and applies stable inventory IDs',async t=>{
  const f=await fixture(t);
  assert.throws(()=>createServer({...f.opts,sqliteFile:undefined}),/local synthetic SQLite/);
  let a=await f.token('analyst'),r=await f.token('reviewer');
  const c=await f.token('case-operator'),beta=await f.token('analyst','beta');
  await f.api(base,{status:401});
  await f.api(base,{cookie:c,status:403});
  await f.api(base,{cookie:beta,status:403});
  await f.api(base,{cookie:beta,workspace:'beta',status:404});
  await f.api(base+'?version=2',{cookie:a,status:422});
  await f.api(base,{cookie:r,body:selectVersion(1),status:403,actor:'analyst'});
  await f.api(base,{cookie:a,body:{...selectVersion(1),hostname:'untrusted.invalid'},status:422});
  await f.api(base,{cookie:a,body:{source:'other',version:1},status:422});
  await f.api('data-map/discovery/preview',{cookie:a,body:selectVersion(1),status:409});
  await f.api('data-map/discovery/apply',{cookie:a,body:{...selectVersion(1),previewKey:'0'.repeat(64)},status:409});
  assert.equal((await f.map(a)).discoveryRehearsal,'available');
  assert.equal((await f.map(beta,'beta')).discoveryRehearsal,undefined);
  assert.equal((await f.api('data-map/discovery/preview',{cookie:beta,workspace:'beta',body:{source:'sample-garden',version:1}})).data.conflicts.length,0);

  const attempts=await Promise.all(Array.from({length:4},()=>f.queue(a,1)));
  assert.equal(attempts.filter(x=>x.changed).length,1);
  let run=attempts[0].run;
  assert.equal(run.status,'queued');
  assert.ok(attempts.every(x=>x.run.id===run.id));
  await f.action(run,'apply',a,409);
  ({run}=await f.action(run,'scan',a));
  assert.equal(run.status,'partial');
  assert.deepEqual(run.checks.map(x=>[x.status,x.code]),[
    ['complete',null],['complete',null],['failed','FIXTURE_METADATA_UNAVAILABLE']
  ]);
  assert.deepEqual((await f.map(a)).nodes,[]);
  await f.action(run,'resume',r,403);
  assert.equal((await f.action(run,'submit',a,409)).code,'DISCOVERY_STAGE_REQUIRED');
  assert.equal((await f.action(run,'resume',a,409,1)).code,'STALE_DISCOVERY_RUN');
  const partial=run;
  await f.restart();
  a=await f.token('analyst');r=await f.token('reviewer');
  assert.deepEqual((await f.list(r)).runs,[partial]);
  ({run}=await f.action(partial,'resume',a));
  assert.equal(run.status,'ready');assert.equal(run.resumes,1);
  assert.ok(run.checks.every(x=>x.status==='complete'&&x.code===null&&/^[a-f0-9]{64}$/.test(x.metadataDigest)));
  assert.deepEqual(run.checks.map(x=>x.fieldCount),[0,2,2]);
  await f.action(run,'resume',a,409);
  ({run}=await f.action(run,'submit',a));
  assert.equal(run.status,'review');
  assert.equal(run.review.plan.mapRevision,0);
  assert.match(run.review.fingerprint,/^[a-f0-9]{64}$/);
  assert.equal(run.review.plan.previewKey,undefined);
  assert.equal(run.review.plan.candidates.length,3);
  assert.deepEqual((await f.map(a)).nodes,[]);
  await f.action(run,'approve',a,403);
  await f.action(run,'apply',a,409);
  run=await f.approve(run,r);
  assert.deepEqual((await f.map(a)).nodes,[]);
  const baseline=await f.apply(run,a);
  assert.equal(baseline.status,'applied');
  assert.deepEqual(baseline.result,{createdNodes:3,refreshedNodes:0,createdLinks:2,mapRevision:1,changed:true});
  const oldGraph=await f.map(a);
  const sourceIds=Object.fromEntries(oldGraph.nodes.map(n=>[n.discovery.sourceId,n.id]));
  const linkIds=oldGraph.links.map(n=>n.id);

  let next=await f.submit(2,a);
  const plan1=next.review.fingerprint;
  assert.equal(next.review.plan.candidates.find(n=>n.sourceId==='reading-queue').recordId,sourceIds['reading-queue']);
  next=await f.approve(next,r);
  async function touch(expectedRevision,name){
    return (await f.api('data-map/nodes',{cookie:a,body:{expectedRevision,type:'activity',name,owner:'Sample analyst',detail:'A separate fictional graph edit.'}})).data;
  }
  await touch(1,'Fictional concurrent region');
  assert.equal((await f.action(next,'apply',a,409)).code,'DISCOVERY_MAP_CHANGED');
  ({run:next}=await f.action(next,'reconcile',a));
  assert.notEqual(next.review.fingerprint,plan1);assert.equal(next.review.approval,null);assert.equal(next.reconciliations,1);
  await f.action(next,'apply',a,409);
  await touch(2,'Fictional concurrent system process');
  assert.equal((await f.action(next,'approve',r,409)).code,'DISCOVERY_MAP_CHANGED');
  ({run:next}=await f.action(next,'reconcile',a));
  assert.equal(next.reconciliations,2);
  assert.equal(next.review.plan.mapRevision,3);
  const approved=await f.approve(next,r);
  const applied=await f.apply(approved,a);
  assert.deepEqual(applied.result,{createdNodes:0,refreshedNodes:3,createdLinks:0,mapRevision:4,changed:true});
  await f.action(approved,'apply',a,409);
  assert.equal((await f.queue(a,2)).changed,false);
  const graph=await f.map(a);
  for(const [sourceId,id] of Object.entries(sourceIds)){
    const row=graph.nodes.find(n=>n.id===id);
    assert.equal(row.discovery.sourceId,sourceId);assert.equal(row.discovery.version,2);
  }
  assert.deepEqual(graph.links.map(n=>n.id),linkIds);
  const reading=graph.nodes.find(n=>n.id===sourceIds['reading-queue']);
  assert.ok(reading.discovery.fields.some(f=>f.id==='loan_reference'));
  assert.equal(reading.discoveryHistory[0].version,1);
  const {data:{audit}}=await f.api('audit/export',{cookie:r});
  assert.equal(audit.filter(x=>x.action==='data-map.discovery-run.apply').length,2);
  assert.equal(audit.filter(x=>x.action==='data-map.discovery-run.resume').length,2);
  assert.equal(audit.find(x=>x.action==='data-map.discovery-run.approve').account,'sample-reviewer');
  assert.equal((await f.api('state',{cookie:a})).data.discoveryRuns,undefined);
  await f.restart(false);
  a=await f.token('analyst');
  assert.equal((await f.map(a)).discoveryRehearsal,'disabled');
  await f.api(base,{cookie:a,status:404});
  await f.api('data-map/discovery/apply',{cookie:a,body:{...selectVersion(2),previewKey:'0'.repeat(64)},status:409});
});

test('discovery rehearsal never bypasses reapproval even when reconciliation budget is exhausted',async t=>{
  const f=await fixture(t),a=await f.token('analyst'),r=await f.token('reviewer');
  let run=await f.submit(1,a);
  for(let revision=0;revision<3;revision++){
    await f.api('data-map/nodes',{cookie:a,body:{expectedRevision:revision,type:'activity',
      name:'Fictional graph drift '+revision,owner:'Fictional owner',detail:'An independent fixture change.'}});
    const reply=await f.action(run,'reconcile',a,revision<2?200:409);
    if(revision<2)run=reply.run;
    else assert.equal(reply.code,'DISCOVERY_RECONCILE_LIMIT');
  }
  assert.equal((await f.action(run,'approve',r,409)).code,'DISCOVERY_MAP_CHANGED');
  assert.equal((await f.action(run,'apply',a,409)).code,'DISCOVERY_STAGE_REQUIRED');
  assert.equal((await f.list(r)).runs[0].reconciliations,2);
  assert.ok((await f.map(a)).nodes.every(n=>n.discovery===undefined));
});

test('Chromium: analyst advances partial fixture and reconciles, reviewer approves, and inventory changes only after explicit apply',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Requires Playwright and Chromium',timeout:40_000
},async t=>{
  const f=await fixture(t),a=await f.token('analyst'),r=await f.token('reviewer');
  const baseline=await f.submit(1,a);
  await f.apply(await f.approve(baseline,r),a);
  const before=(await f.map(a)).nodes.find(n=>n.discovery.sourceId==='reading-queue');
  const {chromium}=require('playwright'),browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  t.after(()=>browser.close());
  const errors=[],outside=[],actions=[];
  async function sign(role){
    const p=await browser.newPage();p.setDefaultTimeout(6500);p.on('pageerror',e=>errors.push(e.message));
    await p.route('**/*',route=>{
      if(new URL(route.request().url()).origin===f.url)return route.continue();
      outside.push(route.request().url());return route.abort();
    });
    await p.goto(f.url);
    await p.getByLabel('Test account').fill('sample-'+role);
    await p.getByLabel('Workspace ID').fill('alpha');
    await p.getByLabel('Local access code').fill(f.codes[role]);
    await b(p,'Sign in').press('Enter');
    await b(p,'Data mapping').press('Enter');
    return p;
  }
  const analyst=await sign('analyst'),reviewer=await sign('reviewer');
  const panel=p=>p.locator('#data-map-view > section').filter({has:h(p,'Staged fixture discovery rehearsal')});
  const card=p=>panel(p).locator('article').filter({has:h(p,'Library fixture v2')});
  async function click(scope,label,witness){
    await b(scope,label).press('Enter');await witness();actions.push(label);
  }
  const pick=analyst.getByLabel('Bundled rehearsal version');
  await pick.selectOption('2');assert.equal(await pick.inputValue(),'2');actions.push('Bundled rehearsal version');
  await click(panel(analyst),'Queue fixture scan',()=>see(card(analyst),'Queued'));
  await click(card(analyst),'Run fixture checks',async()=>{
    await see(card(analyst),'Partial failure');
    await see(card(analyst),'Fictional Genre Rollup: failed (scripted metadata unavailable)');
  });
  assert.equal(await b(card(analyst),'Apply approved schema').count(),0);
  await click(card(analyst),'Resume failed check',async()=>{
    await see(card(analyst),'Ready for review');
    await see(card(analyst),'Completed checks: 3 of 3 · Resume 1/1 · Reconciliation 0/2');
  });
  await click(card(analyst),'Send schema plan for review',()=>see(card(analyst),'Awaiting independent review'));
  await click(panel(reviewer),'Refresh discovery rehearsals',()=>see(card(reviewer),'Awaiting independent review'));
  const changes=card(reviewer).locator('summary').filter({hasText:'Review schema changes'});
  await changes.press('Space');assert.equal(await changes.evaluate(e=>e.parentElement.open),true);actions.push('Review schema changes');
  await card(reviewer).getByText(/fields:.*loan_reference \(text\)/).waitFor();
  assert.equal(await b(panel(reviewer),'Queue fixture scan').count(),0);
  await click(card(reviewer),'Approve exact schema plan',()=>see(card(reviewer),'Approved'));
  await click(panel(analyst),'Refresh discovery rehearsals',()=>see(card(analyst),'Approved'));
  assert.equal((await f.map(a)).nodes.find(n=>n.id===before.id).discovery.version,1);
  await f.api('data-map/nodes',{cookie:a,body:{expectedRevision:1,type:'activity',name:'Fictional independent map edit',
    owner:'Sample',detail:'A synthetic record.'}});
  const response=analyst.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/discovery/runs/')&&r.url().includes('/apply?'));
  await click(card(analyst),'Apply approved schema',async()=>{
    assert.equal((await response).status(),409);
    await see(card(analyst),'Inventory changed. Reconciliation requires a fresh independent review.');
  });
  await click(card(analyst),'Reconcile inventory changes',()=>see(card(analyst),'Awaiting independent review'));
  assert.equal(await b(card(analyst),'Apply approved schema').count(),0);
  await click(panel(reviewer),'Refresh discovery rehearsals',()=>see(card(reviewer),'Awaiting independent review'));
  await click(card(reviewer),'Approve exact schema plan',()=>see(card(reviewer),'Approved'));
  await click(panel(analyst),'Refresh discovery rehearsals',()=>see(card(analyst),'Approved'));
  await click(card(analyst),'Apply approved schema',async()=>{
    await see(card(analyst),'Applied');
    await see(card(analyst),'Created 0 records · Refreshed 3 · Added 0 links.');
  });
  await analyst.reload();await b(analyst,'Data mapping').press('Enter');
  await see(card(analyst),'Applied');
  const item=analyst.locator('#data-map-view article').filter({has:h(analyst,'Fictional Reading Queue')});
  await item.getByText('loan_reference · text · possible identifier',{exact:true}).waitFor();
  assert.equal((await f.map(a)).nodes.find(n=>n.id===before.id).discovery.version,2);
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  t.diagnostic(JSON.stringify({activated:actions.length,actions}));
});

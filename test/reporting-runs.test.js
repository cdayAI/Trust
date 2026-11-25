'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {randomBytes}=require('node:crypto');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
const pinned=require('../reporting-runs');
const path='/api/reporting/runs';
async function listen(server){
  server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;
}
const filters={dataset:'records',workflow:'incidents',group:'stage',from:null,to:null};
async function request(url,route,{body,cookie,actor,expected=200}={}){
  const res=await fetch(url+route,{method:body===undefined?'GET':'POST',headers:{
    ...(body===undefined?{}:{Origin:url,'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{}),...(actor?{'X-Demo-Actor':actor}:{})
  },...(body===undefined?{}:{body:JSON.stringify(body)})});
  const raw=await res.text();
  assert.equal(res.status,expected,route+': '+raw);
  return {res,raw,data:res.headers.get('content-type')?.startsWith('application/json')?JSON.parse(raw):null};
}
test('SQLite pins the aggregate at a point in time; viewer and JSON bytes match after mutation and restart',async t=>{
  const root=await mkdtemp(join(tmpdir(),'pinned-report-runs-'));
  const users=[['workspace-analyst','alpha','analyst'],['workspace-reviewer','alpha','reviewer'],['workspace-case','alpha','case-operator'],['workspace-other','beta','analyst']];
  const codes=new Map(users.map(([id])=>[id,randomBytes(32).toString('base64url')]));
  const isolated={root:join(root,'workspaces'),workspaces:[{id:'alpha',label:'Alpha'},{id:'beta',label:'Beta'}],
    accounts:users.map(([id,workspace,role])=>({id,codeHash:codeHash(codes.get(id)),memberships:{[workspace]:role}}))};
  let server,url;
  async function start(){server=createServer({isolated,sqliteFile:join(root,'reports.sqlite')});url=await listen(server)}
  async function stop(){if(server?.listening)await new Promise(resolve=>server.close(resolve))}
  t.after(async()=>{await stop();await rm(root,{recursive:true,force:true})});
  await start();
  const cookies={};
  async function login(){
    for(const [id,workspace,role] of users){
      const result=await request(url,'/api/session/login',{body:{account:id,workspace,code:codes.get(id)}});
      cookies[workspace==='beta'?'beta':role]=result.res.headers.get('set-cookie').split(';')[0];
    }
  }
  await login();
  const scoped=(route,role='analyst',options={},workspace='alpha')=>request(url,route+(route.includes('?')?'&':'?')+'workspace='+workspace,
    {cookie:cookies[role],...options});
  const incident=title=>scoped('/api/incidents/cases','analyst',{body:{title,scope:'Fixture scope text should not appear'}});
  await scoped(path,null,{expected:401,actor:'analyst'});
  await scoped(path,'case-operator',{expected:403,actor:'reviewer'});
  await scoped(path,'case-operator',{body:{filters},expected:403,actor:'reviewer'});
  await scoped(path,'beta',{expected:403});
  assert.deepEqual((await scoped(path)).data.runs,[]);
  await incident('Fixture name should not appear');
  await scoped(path,'analyst',{body:{filters,rows:[{key:'logged',count:5000}]},expected:422});
  await scoped(path,'analyst',{body:{filters:{group:['stage']}},expected:422});
  await scoped(path,'analyst',{body:{filters:{format:'csv'}},expected:422});
  const created=await scoped(path,'reviewer',{body:{filters},expected:201});
  const {id}=created.data.run;
  const viewer=path+'/'+id, json=viewer+'/export?format=json', csv=viewer+'/export?format=csv';
  assert.deepEqual(created.data.rows,[{key:'logged',label:'Logged',count:1}]);
  assert.equal(created.data.counts.total,1);
  assert.doesNotMatch(created.raw,/Fixture|workspace-analyst|workspace-reviewer/);
  assert.equal((await scoped(viewer)).raw,created.raw);
  assert.deepEqual((await scoped(path,'reviewer')).data.runs.map(x=>x.id),[id]);
  assert.equal((await scoped(json,'reviewer')).raw,created.raw);
  const firstCsv=await scoped(csv);
  assert.match(firstCsv.raw,/"records","incidents","all","all","","","stage","Logged","1"\r\n$/);
  assert.equal(firstCsv.res.headers.get('content-disposition'),'attachment; filename="mvw-trust-report-'+id+'.csv"');
  await scoped(viewer+'?group=workflow','reviewer',{expected:422});
  await scoped(json+'&format=csv','reviewer',{expected:422});
  await scoped(viewer+'/export?format=xlsx','reviewer',{expected:422});
  await scoped(viewer,'case-operator',{expected:403});
  await scoped(json,'case-operator',{expected:403});
  for(const route of [viewer,json,csv])await scoped(route,'beta',{expected:404},'beta');
  assert.deepEqual((await scoped(path,'beta',{},'beta')).data.runs,[]);
  await incident('Second fixture');
  assert.equal((await scoped('/api/reporting?workflow=incidents&group=stage')).data.counts.total,2);
  const second=await scoped(path,'analyst',{body:{filters},expected:201});
  assert.equal(second.data.counts.total,2);
  assert.equal((await scoped(json)).raw,created.raw);
  assert.equal((await scoped(csv)).raw,firstCsv.raw);
  assert.equal((await scoped('/api/state')).raw.includes(id),false);

  await stop();await start();await login();
  assert.equal((await scoped(viewer)).raw,created.raw);
  assert.equal((await scoped(json)).raw,created.raw);
  assert.equal((await scoped(csv)).raw,firstCsv.raw);
  assert.deepEqual((await scoped(path)).data.runs.map(x=>x.id),[second.data.run.id,id]);
});
test('retention expires on time and caps count, bytes and single-run size without mutating saved bytes',()=>{
  const now=Date.parse('2026-03-01T00:00:00.000Z'), add=(state,body,at=now)=>JSON.parse(pinned.create(state,[],body,'synthetic-demo',{now:at}));
  const small={};
  const start=add(small,{filters});
  assert.equal(pinned.list(small,now+30*86400000-1).runs[0].id,start.run.id);
  assert.deepEqual(pinned.list(small,now+30*86400000).runs,[]);
  assert.throws(()=>pinned.read(small,start.run.id,'json',now+30*86400000),{status:404});
  add(small,{filters},now+30*86400000);
  assert.equal(small.reportRuns.length,1);
  for(let i=0;i<40;i++)add(small,{filters},now+30*86400000+i);
  assert.equal(small.reportRuns.length,pinned.limits.maxRuns);
  assert.equal(small.reportRuns.some(x=>x.id===start.run.id),false);
  const rows=count=>Array.from({length:count},(_,i)=>({
    receivedAt:new Date(Date.UTC(2010,0,1)+i*86400000).toISOString(),status:'received'
  }));
  const many={rightsCases:rows(800)},daily={filters:{group:'day',workflow:'rights'}};
  const initial=add(many,daily);
  for(let i=0;i<15;i++)add(many,daily);
  assert.ok(many.reportRuns.length<16);
  assert.ok(many.reportRuns.reduce((sum,row)=>sum+row.bytes,0)<=pinned.limits.maxWorkspaceBytes);
  assert.throws(()=>pinned.read(many,initial.run.id,'json',now),{status:404});
  const oversized={rightsCases:rows(4000)};
  assert.throws(()=>add(oversized,daily),{status:413,code:'REPORT_RUN_TOO_LARGE'});
  assert.equal(oversized.reportRuns,undefined);
});

test('Chromium: pin a mobile report, reopen after source changes, then download its exact stored results',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 with Playwright installed',timeout:35_000
},async t=>{
  const {chromium}=require('playwright');
  const root=await mkdtemp(join(tmpdir(),'pinned-browser-'));
  const server=createServer({dataFile:join(root,'reports.json')});
  const url=await listen(server);
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true})});
  const create=title=>request(url,'/api/incidents/cases',{actor:'analyst',body:{title,scope:'Synthetic fixture scope'}});
  await create('First fictional incident');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844},acceptDownloads:true});page.setDefaultTimeout(5500);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url);
    await page.getByRole('button',{name:'Browse workspace'}).click();
    await page.getByRole('button',{name:'Reporting',exact:true}).click();
    await page.getByLabel('Report workflow').selectOption('incidents');
    await page.getByLabel('Group report by').selectOption('stage');
    await page.getByRole('button',{name:'Apply report filters'}).click();
    const row=page.getByRole('row').filter({has:page.getByRole('rowheader',{name:'Logged',exact:true})});
    await row.waitFor();
    assert.equal(await row.getByRole('cell').first().innerText(),'1');
    await page.getByRole('button',{name:'Pin current report'}).click();
    await page.getByText(/^Pinned report · Saved/).waitFor();
    await create('Second fictional incident');
    await page.getByRole('button',{name:'Return to live report'}).click();
    await page.getByText(/^Live preview/).waitFor();
    assert.equal(await row.getByRole('cell').first().innerText(),'2');
    await page.getByRole('button',{name:/^Open pinned report: Workflow records, Incidents/}).click();
    await page.getByText(/^Pinned report · Saved/).waitFor();
    assert.equal(await row.getByRole('cell').first().innerText(),'1');
    const link=page.getByRole('link',{name:'Download JSON'});
    const downloadResult=page.waitForEvent('download');await link.click();const item=await downloadResult;
    let bytes='';for await(const chunk of await item.createReadStream())bytes+=chunk.toString();
    const model=JSON.parse(bytes);
    assert.match(item.suggestedFilename(),/^mvw-trust-report-[a-f0-9-]+\.json$/);
    assert.equal(model.counts.total,1);
    assert.equal((await request(url,path+'/'+model.run.id)).raw,bytes);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});

test('Chromium: a saved pin with an unavailable preview can be reopened without creating a duplicate',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 with Playwright installed',timeout:35_000
},async t=>{
  const {chromium}=require('playwright');
  const root=await mkdtemp(join(tmpdir(),'pin-preview-recovery-'));
  const server=createServer({dataFile:join(root,'reports.json')});
  const url=await listen(server);
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true})});
  await request(url,'/api/incidents/cases',{actor:'analyst',body:{title:'Fictional pin recovery incident',scope:'Synthetic fixture scope'}});
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const page=await browser.newPage();page.setDefaultTimeout(4500);
    let writes=0,previewReads=0;
    await page.route(url+'/api/reporting/runs**',route=>{
      const request=route.request(),pathname=new URL(request.url()).pathname;
      if(request.method()==='POST'&&pathname==='/api/reporting/runs')writes++;
      if(request.method()==='GET'&&pathname.startsWith('/api/reporting/runs/')&&++previewReads===1)return route.abort('failed');
      return route.continue();
    });
    await page.goto(url);
    await page.getByRole('button',{name:'Reporting',exact:true}).click();
    const pin=page.getByRole('button',{name:'Pin current report'});
    await pin.press('Enter');
    const retry=page.getByRole('button',{name:'Reopen saved report'});
    await retry.waitFor();
    assert.equal(await page.getByText('Report saved. Its preview could not be loaded.').count(),1);
    assert.equal(await pin.isDisabled(),true);
    assert.equal(await retry.evaluate(element=>element===document.activeElement),true);
    await retry.press('Enter');
    await page.getByText(/^Pinned report · Saved/).waitFor();
    assert.match(await page.locator('#notice').textContent(),/^Pinned report opened/);
    assert.equal(writes,1);
    assert.equal(previewReads,2);
    assert.equal((await request(url,path,{actor:'analyst'})).data.runs.length,1);
  }finally{await browser.close()}
});

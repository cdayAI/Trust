'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {randomBytes,randomUUID}=require('node:crypto');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createServer}=require('../server');
const {openSqlite}=require('../durable-storage');
const {codeHash}=require('../workspace-access');
const {createPager}=require('../work-queue');
const rights=require('../rights-workflow');
const incidents=require('../incident-workflow');

const path='/api/work-queue',main='alpha',other='beta',roles=['analyst','reviewer','case-operator'];
const day=86400000;
const filters={owner:'all',workflow:'all',timing:'all'};
const query=values=>'?'+new URLSearchParams(values);
const clean=({pagination,...data})=>data;
function seed(count=70){
  const state={version:1,actors:roles.map(id=>({id,name:id==='case-operator'?'Case operator':id,role:id})),
    projects:[],vendors:[],assessments:[],handoff:[],audit:[]};
  const record=(s,actor,action,projectId,entityId,details)=>s.audit.push({id:randomUUID(),sequence:s.audit.length+1,
    at:'2027-02-01T00:00:00.000Z',actor,action,projectId,entityId,details});
  for(let i=0;i<count;i++){
    rights.change(state,['rights','cases'],'analyst',{kind:i%2?'access':'correction',owner:i%3?'analyst':'case-operator',
      days:i%7+1,note:'Fictional note '+i},record);
    if(i%3===0)rights.change(state,['rights','cases',state.rightsCases.at(-1).id,'verify'],'reviewer',
      {expectedRevision:1,note:'Synthetic fixture verified.'},record);
  }
  incidents.change(state,['incidents','cases'],'analyst',{title:'Fictional case queue incident',scope:'Synthetic fixed scope.'},record);
  return state;
}
async function fixture(t){
  const room=await mkdtemp(join(tmpdir(),'mvw-queue-page-')),sqliteFile=join(room,'fixture.sqlite'),contents=seed();
  const db=openSqlite(sqliteFile);
  try{db.requireMode('isolated');db.import('isolated',[{scope:'workspace:'+main,kind:'workbench',generation:1,payload:contents}]);}
  finally{db.close();}
  const codes=Object.fromEntries(roles.map(role=>[role,randomBytes(32).toString('base64url')]));
  const isolated={root:join(room,'workspaces'),workspaces:[main,other].map(id=>({id,label:'Workspace '+id})),
    accounts:roles.map(role=>({id:'sample-'+role,codeHash:codeHash(codes[role]),memberships:{[main]:role,[other]:role}}))};
  let server,url;
  async function start(){
    server=createServer({sqliteFile,isolated}).listen(0,'127.0.0.1');
    await once(server,'listening');url='http://127.0.0.1:'+server.address().port;
  }
  async function stop(){if(server?.listening){server.closeAllConnections();await new Promise(r=>server.close(r));}}
  t.after(async()=>{await stop();await rm(room,{recursive:true,force:true});});
  await start();
  async function request(route,{cookie,workspace=main,status=200,body,spoof}={}){
    const target=new URL(route,url);
    if(!route.startsWith('/api/session'))target.searchParams.set('workspace',workspace);
    const response=await fetch(target,{method:body===undefined?'GET':'POST',headers:{
      ...(cookie?{Cookie:cookie}:{}),...(spoof?{'X-Demo-Actor':spoof}:{}),
      ...(body===undefined?{}:{Origin:url,'Content-Type':'application/json'})
    },body:body===undefined?undefined:JSON.stringify(body)});
    const raw=await response.text(),data=JSON.parse(raw);
    assert.equal(response.status,status,route+': '+raw);
    assert.equal(response.headers.get('cache-control'),'no-store');
    return {raw,data,response};
  }
  async function login(role,workspace=main){return (await request('/api/session/login',
    {body:{account:'sample-'+role,workspace,code:codes[role]}})).response.headers.get('set-cookie').split(';')[0];}
  return {start,stop,request,login,codes,get url(){return url;}};
}
test('optional pages exactly reconstruct the authorized full/export tasks, bind filters and session, and reject changed views',async t=>{
  const f=await fixture(t),author=await f.login('analyst'),reviewer=await f.login('reviewer'),operator=await f.login('case-operator');
  const get=(params={},options={})=>f.request(path+query(params),{cookie:author,...options});
  await get({limit:1},{cookie:undefined,status:401,spoof:'analyst'});
  await get({limit:1},{cookie:operator,status:403,spoof:'reviewer'});
  const full=(await get(filters)).data;
  assert.equal(full.counts.total,71);
  assert.equal(Object.hasOwn(full,'pagination'),false);
  let cursor,rows=[],kept,counts,round=0;
  do{
    const page=(await get({...filters,limit:9,...(cursor?{cursor}:{})})).data;
    assert.deepEqual(page.counts,full.counts);
    assert.deepEqual(clean(page),{...full,tasks:full.tasks.slice(rows.length,rows.length+9)});
    assert.equal(page.pagination.first,rows.length+1);
    assert.equal(page.pagination.last,rows.length+page.tasks.length);
    assert.equal(page.pagination.total,71);
    assert.equal(typeof page.pagination.previousCursor,round===0?'object':'string');
    if(round===0)assert.equal(page.pagination.previousCursor,null);
    rows.push(...page.tasks);
    if(round===0){kept=page.pagination.nextCursor;counts=page.counts;}
    if(round===1)assert.deepEqual((await get({...filters,limit:9,cursor:page.pagination.previousCursor})).data.tasks,full.tasks.slice(0,9));
    cursor=page.pagination.nextCursor;
    round++;
  }while(cursor);
  assert.deepEqual(rows,full.tasks);
  assert.equal(new Set(rows.map(x=>x.id)).size,71);
  assert.equal(round,8);
  const filtered={owner:'reviewer',workflow:'rights',timing:'upcoming'};
  const wholeFiltered=(await get(filtered)).data;
  const smallFiltered=(await get({...filtered,limit:2})).data;
  assert.deepEqual(clean(smallFiltered),{...wholeFiltered,tasks:wholeFiltered.tasks.slice(0,2)});
  assert.deepEqual((await f.request(path+'/export'+query(filtered),{cookie:author})).data,{schemaVersion:1,...wholeFiltered});
  await f.request(path+'/export?limit=2',{cookie:author,status:422});
  await f.request(path+'/export?cursor='+encodeURIComponent(kept),{cookie:author,status:422});
  for(const invalid of [{limit:0},{limit:101},{limit:'01'},{limit:'10.0'},{cursor:kept},{limit:2,cursor:'garbage'},{limit:2,owner:'no-one'}])
    await get(invalid,{status:422});
  await f.request(path+'?limit=4&limit=4',{cookie:author,status:422});
  await f.request(path+'?limit=4&owner=analyst&owner=analyst',{cookie:author,status:422});
  await get({limit:8,cursor:kept},{status:409});
  await get({limit:9,cursor:kept,workflow:'rights'},{status:409});
  await get({limit:9,cursor:kept},{cookie:reviewer,status:409});
  await get({limit:9,cursor:kept},{workspace:other,status:403});
  const foreign=await f.login('analyst',other);
  await get({limit:9,cursor:kept},{cookie:foreign,workspace:other,status:409});
  const blank=(await get({limit:9},{cookie:foreign,workspace:other})).data;
  assert.deepEqual(blank.pagination,{limit:9,first:0,last:0,total:0,previousCursor:null,nextCursor:null});
  await get({limit:9,cursor:kept.slice(0,-3)+'AAA'},{status:409});
  await f.request('/api/projects',{cookie:author,body:{name:'Unrelated workspace change'}});
  assert.deepEqual((await get({limit:9,cursor:kept})).data.counts,counts);
  await f.request('/api/rights/cases',{cookie:author,body:{kind:'access',owner:'analyst',days:2,note:'New fictional case'}});
  assert.equal((await get({limit:9,cursor:kept},{status:409})).data.code,'QUEUE_CURSOR_STALE');
  const active=(await get({limit:9})).data.pagination.nextCursor;
  await f.stop();await f.start();
  const relogged=await f.login('analyst');
  await get({limit:9,cursor:active},{cookie:relogged,status:409});
  assert.equal((await get({limit:9},{cookie:relogged})).data.counts.total,72);
});
test('UTC day rolls stale even when ordered items have not changed',()=>{
  const page=createPager(),state=seed(3),scope=['unit','alpha','analyst',0],now=new Date().toISOString().slice(0,10);
  const nextDay=new Date(Date.parse(now)+day).toISOString().slice(0,10);
  const first=page(state,new URLSearchParams({limit:'1'}),scope,now);
  assert.throws(()=>page(state,new URLSearchParams({limit:'1',cursor:first.pagination.nextCursor}),scope,nextDay),
    {code:'QUEUE_CURSOR_STALE'});
});

test('Chromium pages 25 cards, exports all matches, recovers stale and failed navigation, and preserves task focus',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Requires Playwright and Chromium',timeout:40_000
},async t=>{
  const f=await fixture(t),author=await f.login('analyst');
  const full=(await f.request(path+query(filters),{cookie:author})).data;
  const {chromium}=require('playwright');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  t.after(()=>browser.close());
  const page=await browser.newPage(),errors=[],external=[];
  page.setDefaultTimeout(6500);page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin!==f.url){external.push(url.origin);return route.abort();}
    return route.continue();
  });
  await page.goto(f.url);
  await page.getByLabel('Test account',{exact:true}).fill('sample-analyst');
  await page.getByLabel('Workspace ID',{exact:true}).fill(main);
  await page.getByLabel('Local access code',{exact:true}).fill(f.codes.analyst);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  const q=page.locator('#queue-view');
  const button=(name,scope=q)=>scope.getByRole('button',{name,exact:true});
  const range=(first,last,total)=>q.getByText('Showing '+first+'–'+last+' of '+total+' tasks',{exact:true});
  const next=button('Next queue page'),prev=button('Previous queue page');
  const pending=()=>page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.ok());
  async function click(control,first,last,total){
    const [response]=await Promise.all([pending(),control.click()]);
    await range(first,last,total).waitFor();
    return response.json();
  }
  const first=await click(button('Open shared queue',page),1,25,71);
  assert.deepEqual(first.tasks,full.tasks.slice(0,25));
  assert.equal(await q.locator('article').count(),25);
  assert.equal(await prev.isDisabled(),true);
  const second=await click(next,26,50,71);
  assert.deepEqual(second.tasks,full.tasks.slice(25,50));
  assert.equal(await range(26,50,71).evaluate(node=>node===document.activeElement),true);
  const [file]=await Promise.all([page.waitForEvent('download'),q.getByRole('link',{name:'Export filtered queue JSON',exact:true}).click()]);
  assert.equal(file.suggestedFilename(),'privacy-workbench-queue.json');
  const chunks=[];
  for await(const chunk of await file.createReadStream())chunks.push(chunk);
  assert.deepEqual(JSON.parse(Buffer.concat(chunks)),{schemaVersion:1,...full});
  const back=await click(prev,1,25,71);
  assert.deepEqual(back.tasks,first.tasks);

  await q.getByLabel('Queue owner').selectOption('reviewer');
  await q.getByLabel('Workflow filter').selectOption('rights');
  const filtered=await click(button('Apply filters'),1,25,46);
  assert.equal(filtered.counts.total,46);
  assert.deepEqual(filtered.filters,{owner:'reviewer',workflow:'rights',timing:'all'});
  assert.ok(filtered.tasks.every(row=>row.owner==='reviewer'&&row.workflow==='rights'));
  await f.request('/api/rights/cases',{cookie:author,body:{kind:'access',owner:'analyst',days:2,note:'Changes the fictional pending queue'}});
  const reset=await click(next,1,25,47);
  assert.equal(reset.counts.total,47);
  await page.getByText('Work queue changed. Showing the first page.',{exact:true}).waitFor();

  await page.route(url=>url.pathname===path,route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"Synthetic transient fault"}'}),{times:1});
  await next.click();
  await q.getByText('The work queue could not be loaded.',{exact:true}).waitFor();
  await click(button('Retry work queue'),1,25,47);

  let reached,release;
  const held=new Promise(resolve=>{release=resolve;});
  const started=new Promise(resolve=>{reached=resolve;});
  await page.route(url=>url.pathname===path&&url.searchParams.has('cursor'),async route=>{
    reached();await held;return route.continue();
  },{times:1});
  await next.click();
  try{
    await started;
    await button('Home',page).click();
    await page.getByRole('heading',{name:'My next actions',exact:true}).waitFor();
    const waiting=pending();release();
    await (await waiting).finished();
    assert.equal(await q.isHidden(),true);
  }finally{release();}
  await click(button('Open shared queue',page),1,25,72);
  const target=(await click(next,26,50,72)).tasks[0];
  await q.locator('article').first().getByRole('button').click();
  const record=page.locator('#work-record-'+target.sourceId);
  await record.waitFor();
  assert.equal(await record.evaluate(node=>node===document.activeElement),true);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
});

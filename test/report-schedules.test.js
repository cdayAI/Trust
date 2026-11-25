'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {randomBytes}=require('node:crypto');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
const pins=require('../reporting-runs');
const schedules=require('../report-schedules');
const {createWorker,provision:provisionWorker}=require('../report-schedule-worker');
const {openSqlite}=require('../durable-storage');
const {openStore}=require('../store');

const HOUR=3_600_000,day=24*HOUR,minute=60_000;
const base='/api/reporting/schedules',runs='/api/reporting/runs';
const filters={dataset:'records',workflow:'incidents',group:'stage'};
const iso=ms=>new Date(ms).toISOString();
const future=()=>Math.floor((Date.now()+2*HOUR)/minute)*minute;
const seats=[
  ['report-analyst','north','analyst'],['report-reviewer','north','reviewer'],
  ['report-case-operator','north','case-operator'],['report-other','south','analyst']
];
async function fixture(t,backend='sqlite'){
  const root=await mkdtemp(join(tmpdir(),'mvw-report-schedule-'));
  const codes=Object.fromEntries(seats.map(([id])=>[id,randomBytes(32).toString('base64url')]));
  const isolated={root:join(root,'workspaces'),workspaces:[{id:'north',label:'North fixture'},{id:'south',label:'South fixture'}],
    accounts:seats.map(([id,workspace,role])=>({id,codeHash:codeHash(codes[id]),memberships:{[workspace]:role}}))};
  let server,url;
  async function start(reportWorkerWorkspace){
    const options=backend==='demo'?{dataFile:join(root,'demo.json')}:{isolated,...(backend==='sqlite'?{sqliteFile:join(root,'program.sqlite')}:{})};
    if(reportWorkerWorkspace!==undefined)options.reportWorkerWorkspace=reportWorkerWorkspace;
    server=createServer(options).listen(0,'127.0.0.1');
    await once(server,'listening');url='http://127.0.0.1:'+server.address().port;
  }
  async function stop(){if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}
  t.after(async()=>{await stop();await rm(root,{recursive:true,force:true});});
  await start();
  async function request(route,{cookie,workspace='north',body,status=200,spoof}={}){
    const endpoint=new URL(route,url);
    if(!route.startsWith('/api/session')&&backend!=='demo')endpoint.searchParams.set('workspace',workspace);
    const response=await fetch(endpoint,{method:body===undefined?'GET':'POST',
      headers:{...(cookie?{Cookie:cookie}:{}),...(spoof?{'X-Demo-Actor':spoof}:{}),
        ...(body===undefined?{}:{Origin:url,'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const raw=await response.text();
    assert.equal(response.status,status,route+': '+raw);
    assert.equal(response.headers.get('cache-control'),'no-store');
    return {raw,response,data:response.headers.get('content-type').startsWith('application/json')?JSON.parse(raw):null};
  }
  async function login([account,workspace]){
    const {response}=await request('/api/session/login',{body:{account,workspace,code:codes[account]}});
    return response.headers.get('set-cookie').split(';')[0];
  }
  return {request,login,start,stop,get url(){return url;},codes,sqliteFile:join(root,'program.sqlite'),isolated};
}

for(const backend of ['json','sqlite'])test('local '+backend+' schedule isolates tenants, independently approves UTC slots, captures immutable bytes once and persists',async t=>{
  const f=await fixture(t,backend);
  let [author,reviewer,caseWorker,other]=await Promise.all(seats.map(f.login));
  await f.request(base,{status:401,spoof:'analyst'});
  await f.request(base,{cookie:caseWorker,status:403,spoof:'reviewer'});
  await f.request(base,{cookie:other,status:403});
  await f.request(base+'?cadence=daily',{cookie:author,status:422});
  assert.deepEqual((await f.request(base,{cookie:author})).data.plans,[]);
  const open=(title)=>f.request('/api/incidents/cases',{cookie:author,body:{title,scope:'Synthetic narrative never included in reporting.'}});
  await open('Original fictional incident');
  const source=await f.request(runs,{cookie:author,body:{filters},status:201});
  const sourceId=source.data.run.id;
  const first=future(),draftBody={expectedRevision:0,sourceRunId:sourceId,cadence:'daily',firstDueAt:iso(first)};
  const doPlan=(action,body,{cookie=author,status=200,workspace='north',spoof}={})=>f.request(base+'/'+action,{cookie,status,workspace,body,spoof});
  await doPlan('create',draftBody,{cookie:reviewer,status:403});
  await doPlan('create',draftBody,{cookie:other,workspace:'south',status:404});
  await doPlan('create',{...draftBody,recipient:'fictional@example.invalid'},{status:422});
  await doPlan('create',{...draftBody,cadence:['daily']},{status:422});
  await doPlan('create',{...draftBody,firstDueAt:'2027-02-30T04:00:00.000Z'},{status:422});
  await doPlan('create',{...draftBody,firstDueAt:'2027-02-28T04:00:00.000-05:00'},{status:422});
  await doPlan('create',{...draftBody,firstDueAt:iso(first+1)},{status:422});
  const proposed=(await doPlan('create',draftBody)).data;
  const draft=proposed.plans[0],planId=draft.id;
  const tick={planId,slotAt:iso(first),simulatedAt:iso(first)};
  assert.equal(draft.status,'draft');assert.equal(draft.nextDueAt,iso(first));
  assert.equal(JSON.stringify(draft).includes(seats[0][0]),false);
  await doPlan('create',{...draftBody,expectedRevision:proposed.revision},{status:409});
  await doPlan('tick',tick,{status:409});
  await doPlan('approve',{planId,expectedRevision:proposed.revision},{spoof:'reviewer',status:403});
  await doPlan('approve',{planId,expectedRevision:0},{cookie:reviewer,status:409});
  const active=(await doPlan('approve',{planId,expectedRevision:proposed.revision},{cookie:reviewer})).data;
  assert.equal(active.plans[0].status,'active');
  assert.equal(active.plans[0].receipts.length,0);
  await doPlan('tick',tick,{cookie:other,workspace:'south',status:404});
  await doPlan('tick',{...tick,slotAt:iso(first+day)},{status:409});
  await doPlan('tick',{...tick,slotAt:iso(first+HOUR)},{status:422});
  const early=(await doPlan('tick',{...tick,simulatedAt:iso(first-1)})).data;
  assert.equal(early.outcome,'not-due');assert.equal(early.revision,active.revision);
  assert.equal((await f.request(runs,{cookie:reviewer})).data.runs.length,1);

  await open('A second fictional incident');
  const [a,b]=await Promise.all([doPlan('tick',tick),doPlan('tick',tick,{cookie:reviewer})]);
  assert.deepEqual([a.data.outcome,b.data.outcome].sort(),['already-run','ran']);
  assert.equal(a.data.receipt.reportId,b.data.receipt.reportId);
  assert.equal(a.data.revision,active.revision+1);assert.equal(b.data.revision,a.data.revision);
  assert.equal(a.data.plans[0].nextDueAt,iso(first+day));
  assert.equal(a.data.plans[0].receipts.length,1);
  assert.notEqual(a.data.receipt.reportId,sourceId);
  assert.equal(a.data.receipt.total,2);
  assert.equal(a.data.receipt.simulatedAt,iso(first));
  assert.ok(Date.parse(a.data.receipt.capturedAt)<first);
  const report=runs+'/'+a.data.receipt.reportId;
  const [record,json,csv]=await Promise.all([
    f.request(report,{cookie:author}),f.request(report+'/export?format=json',{cookie:author}),f.request(report+'/export?format=csv',{cookie:reviewer})
  ]);
  assert.equal(record.raw,json.raw);assert.match(csv.raw,/"Logged","2"\r\n$/);
  assert.doesNotMatch(record.raw,/fictional incident|Synthetic narrative/iu);
  await f.request(report+'/export?format=json',{cookie:other,workspace:'south',status:404});
  await open('A third fictional incident');
  assert.equal((await f.request(report,{cookie:reviewer})).raw,json.raw);
  assert.equal((await f.request(runs+'/'+sourceId,{cookie:author})).raw,source.raw);
  assert.equal((await f.request('/api/state',{cookie:author})).raw.includes(planId),false);

  await f.stop();await f.start();
  [author,reviewer,caseWorker,other]=await Promise.all(seats.map(f.login));
  const recovered=(await f.request(base,{cookie:author})).data;
  assert.equal(recovered.plans[0].nextDueAt,iso(first+day));
  assert.equal(recovered.plans[0].receipts[0].reportId,a.data.receipt.reportId);
  const repeated=(await doPlan('tick',{...tick,simulatedAt:iso(first+3*day)})).data;
  assert.equal(repeated.outcome,'already-run');assert.equal(repeated.revision,recovered.revision);
  assert.equal((await f.request(report+'/export?format=json',{cookie:author})).raw,json.raw);
  assert.equal((await f.request(report+'/export?format=csv',{cookie:author})).raw,csv.raw);
  const stopped=(await doPlan('stop',{planId,expectedRevision:recovered.revision},{cookie:reviewer})).data;
  assert.equal(stopped.plans[0].status,'stopped');
  assert.equal(stopped.plans[0].receipts.length,1);
  await doPlan('tick',{planId,slotAt:iso(first+day),simulatedAt:iso(first+day)},{status:409});
  assert.equal((await doPlan('tick',tick)).data.outcome,'already-run');
  const audit=(await f.request('/api/audit/export',{cookie:reviewer})).data.audit;
  assert.equal(audit.filter(e=>e.action==='reporting.schedule.ran').length,1);
  assert.equal(audit.find(e=>e.action==='reporting.schedule.approved').account,seats[1][0]);
  assert.equal((await f.request(base,{cookie:other,workspace:'south'})).data.plans.length,0);
});

test('weekly cadence at an exact UTC boundary, persistent dedup beyond bounded history, and independent review',()=>{
  const now=Date.UTC(2028,1,27,23,59),initial=now+minute,state={audit:[]};
  const caller={actor:'analyst',account:'author'},review={actor:'reviewer',account:'reviewer'};
  const event=(s,actor,action,projectId,entityId,details)=>s.audit.push({actor,action,projectId,entityId,details});
  const source=JSON.parse(pins.create(state,[],{filters},'local-isolated',{now}));
  const run=(actor,action,body,at=now)=>schedules.change(state,[],actor,action,body,event,{now:at});
  const draft=run(caller,'create',{expectedRevision:0,cadence:'weekly',firstDueAt:iso(initial),sourceRunId:source.run.id});
  const planId=draft.value.plans[0].id;
  assert.equal(draft.value.plans[0].nextDueAt,'2028-02-28T00:00:00.000Z');
  assert.throws(()=>run({...review,account:caller.account},'approve',{expectedRevision:1,planId}),{code:'REPORT_SCHEDULE_INDEPENDENT_REVIEW'});
  run(review,'approve',{expectedRevision:1,planId});
  for(let i=0;i<25;i++){
    const slot=iso(initial+i*7*day),outcome=run(caller,'tick',{planId,slotAt:slot,simulatedAt:slot});
    assert.equal(outcome.value.receipt.slotAt,slot);
    assert.equal(outcome.value.plans[0].nextDueAt,iso(initial+(i+1)*7*day));
  }
  const lost=run(caller,'tick',{planId,slotAt:iso(initial),simulatedAt:iso(initial+day)});
  assert.deepEqual([lost.changed,lost.value.outcome,lost.value.receipt],[false,'already-run',null]);
  assert.equal(lost.value.plans[0].receipts.length,24);
  assert.equal(schedules.list(state,'reviewer','reviewer',now+31*day).plans[0].receipts.some(row=>row.available),false);
});

test('demo neither reads nor mutates a staff report schedule',async t=>{
  const f=await fixture(t,'demo');
  await f.request(base,{status:404,spoof:'analyst'});
  await f.request(base+'/create',{status:404,spoof:'analyst',body:{}});
});

test('Chromium opens the schedule on demand, uses independent review, ticks once, and downloads the exact persisted exports',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Requires Playwright and Chromium',timeout:40_000
},async t=>{
  const f=await fixture(t),author=await f.login(seats[0]),review=await f.login(seats[1]);
  await f.request('/api/incidents/cases',{cookie:author,body:{title:'Fictional browser snapshot',scope:'Synthetic metadata only.'}});
  await f.request(runs,{cookie:author,body:{filters},status:201});
  const {chromium}=require('playwright');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  t.after(()=>browser.close());
  const errors=[],external=[],scheduleRequests=[];
  const exact=(scope,name)=>scope.getByRole('button',{name,exact:true});
  const seen=(scope,text)=>scope.getByText(text,{exact:true}).waitFor();
  async function visit([account,workspace]){
    const p=await browser.newPage();
    p.setDefaultTimeout(6500);
    p.on('pageerror',error=>errors.push(error.message));
    await p.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.origin!==f.url){external.push(url.origin);return route.abort();}
      if(url.pathname.startsWith(base))scheduleRequests.push({account,route:url.pathname});
      return route.continue();
    });
    await p.goto(f.url);
    await p.getByLabel('Test account',{exact:true}).fill(account);
    await p.getByLabel('Workspace ID',{exact:true}).fill(workspace);
    await p.getByLabel('Local access code',{exact:true}).fill(f.codes[account]);
    await exact(p,'Sign in').click();
    await exact(p,'Reporting').click();
    await p.getByRole('heading',{name:'Operational reporting',exact:true}).waitFor();
    return p;
  }
  async function schedule(p,retry=false){
    const panel=p.locator('details').filter({has:p.getByText('Local report scheduling',{exact:true})});
    if(retry)await p.route(url=>url.pathname===base,route=>route.fulfill({
      status:503,contentType:'application/json',body:'{"error":"Fictional transient fault"}'
    }),{times:1});
    await panel.locator('summary').click();
    if(retry){
      await seen(panel,'The local schedule could not be loaded.');
      await exact(panel,'Retry local schedule').click();
    }
    await panel.getByRole('heading',{name:'Simulated UTC schedule',exact:true}).waitFor();
    return panel;
  }
  const analystPage=await visit(seats[0]);
  assert.deepEqual(scheduleRequests,[]);
  const panel=await schedule(analystPage,true);
  await seen(panel,'No local schedule has been proposed.');
  await panel.getByLabel('Pinned report template').selectOption({index:0});
  await panel.getByLabel('UTC cadence').selectOption('weekly');
  const first=future(),date=iso(first);
  await panel.getByLabel('First due time (UTC)',{exact:true}).fill(date.slice(0,16));
  await exact(panel,'Propose local schedule').click();
  await seen(panel,'Draft schedule saved. A separate reviewer must approve it.');
  assert.equal(await exact(panel,'Approve local schedule').count(),0);
  assert.equal(await exact(panel,'Run simulated slot').count(),0);

  const reviewerPage=await visit(seats[1]),decision=await schedule(reviewerPage);
  assert.equal(await exact(decision,'Propose local schedule').count(),0);
  await exact(decision,'Approve local schedule').click();
  await seen(decision,'Schedule approved for explicit simulated runs.');
  assert.equal(await decision.getByRole('heading',{name:'Simulated UTC schedule',exact:true})
    .evaluate(node=>node===document.activeElement),true);
  await exact(panel,'Reload local schedule').click();
  await panel.getByRole('heading',{name:'Weekly report plan · active',exact:true}).waitFor();
  const simulated=panel.getByLabel('Simulated time (UTC)',{exact:true});
  await simulated.fill(iso(first-minute).slice(0,16));
  await exact(panel,'Run simulated slot').click();
  await seen(panel,'No report was saved. The slot is not due at the simulated time.');
  assert.equal(await panel.getByRole('link',{name:'Download scheduled JSON'}).count(),0);

  await simulated.fill(date.slice(0,16));
  await exact(panel,'Run simulated slot').click();
  await seen(panel,'One scheduled report was saved.');
  assert.equal(await panel.getByRole('link',{name:'Download scheduled JSON'}).count(),1);
  const outcome=(await f.request(base,{cookie:author})).data.plans[0];
  assert.equal(outcome.nextDueAt,iso(first+7*day));
  assert.equal(outcome.receipts.length,1);
  for(const format of ['json','csv']){
    const [download]=await Promise.all([analystPage.waitForEvent('download'),
      panel.getByRole('link',{name:'Download scheduled '+format.toUpperCase(),exact:true}).click()]);
    const reportId=outcome.receipts[0].reportId;
    assert.equal(download.suggestedFilename(),'mvw-trust-report-'+reportId+'.'+format);
    const chunks=[];
    for await(const chunk of await download.createReadStream())chunks.push(chunk);
    const stored=await f.request(runs+'/'+reportId+'/export?format='+format,{cookie:author});
    assert.deepEqual(Buffer.concat(chunks),Buffer.from(stored.raw));
  }
  await exact(decision,'Reload local schedule').click();
  await decision.getByRole('heading',{name:'Simulated run history',exact:true}).waitFor();
  await exact(decision,'Stop local schedule').click();
  await seen(decision,'Schedule stopped. Its history remains available.');
  assert.equal(await exact(decision,'Run simulated slot').count(),0);
  assert.equal(await decision.getByRole('link',{name:'Download scheduled CSV',exact:true}).count(),1);
  assert.equal((await f.request(base,{cookie:review})).data.plans[0].status,'stopped');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
});

function fakeWakeClock(start){
  let current=start,nextId=1;
  const callbacks=new Map();
  return {
    move(next){current=next;},
    clock:()=>current,
    schedule(callback,delay){assert.equal(delay,minute);const id=nextId++;callbacks.set(id,callback);return id;},
    cancel:id=>callbacks.delete(id),
    waiting:()=>callbacks.size,
    wake(){
      assert.equal(callbacks.size,1);
      const [id,callback]=callbacks.entries().next().value;
      callbacks.delete(id);callback();
    }
  };
}
test('worker requires explicit local isolated SQLite scope, never corporate or demo; timer is single and cancellable',()=>{
  const isolated={workspaces:[{id:'north'}]};
  assert.equal(provisionWorker(undefined,{}),null);
  assert.equal(provisionWorker('north',{isolated,sqliteFile:'reserved-fixture-path'}),'north');
  for(const options of [
    {reportWorkerWorkspace:'north'},
    {reportWorkerWorkspace:'north',isolated},
    {reportWorkerWorkspace:'unknown',isolated,sqliteFile:'reserved-fixture-path'},
    {reportWorkerWorkspace:'north',isolated,sqliteFile:'reserved-fixture-path',corporate:{}},
    {reportWorkerWorkspace:{workspace:'north'},isolated,sqliteFile:'reserved-fixture-path'}
  ])assert.throws(()=>createServer(options),/requires one named local synthetic workspace and SQLite/);
  const time=fakeWakeClock(20),seen=[],errors=[];
  const runner=createWorker({...time,wake:now=>{seen.push(now);if(seen.length===1)throw Error('fixture failure');},
    onError:error=>errors.push(error.message)});
  runner.start();runner.start();
  assert.equal(time.waiting(),1);
  assert.deepEqual(seen,[]);
  time.move(81);time.wake();
  assert.deepEqual(seen,[81]);assert.deepEqual(errors,['fixture failure']);
  assert.equal(time.waiting(),1);
  time.move(142);time.wake();
  assert.deepEqual(seen,[81,142]);assert.equal(time.waiting(),1);
  runner.stop();runner.stop();
  assert.equal(time.waiting(),0);
});
test('named SQLite worker shares immutable slots with staff, preserves independent approval and skips bounded backlog atomically across restart',async t=>{
  const f=await fixture(t),first=future();
  let analyst=await f.login(seats[0]),reviewer=await f.login(seats[1]),south=await f.login(seats[3]);
  const plan=async(action,body,cookie=analyst,status=200,workspace='north')=>
    (await f.request(base+'/'+action,{cookie,body,status,workspace})).data;
  const model=async(cookie=analyst,workspace='north')=>(await f.request(base,{cookie,workspace})).data;
  await f.request('/api/incidents/cases',{cookie:analyst,body:{title:'Fictional worker count item',scope:'Not included in report outputs.'}});
  const pinned=(await f.request(runs,{cookie:analyst,body:{filters},status:201})).data.run.id;
  const proposed={expectedRevision:0,sourceRunId:pinned,cadence:'daily',firstDueAt:iso(first)};
  await plan('create',{...proposed,execution:'local-worker'},analyst,409);
  let current=await plan('create',proposed);
  const legacy=current.plans[0].id;
  await plan('approve',{expectedRevision:current.revision,planId:legacy},reviewer);
  assert.equal((await model()).workerEnabled,false);

  await f.stop();await f.start('north');
  [analyst,reviewer,south]=await Promise.all([seats[0],seats[1],seats[3]].map(f.login));
  assert.equal((await model()).workerEnabled,true);
  assert.equal((await model(south,'south')).workerEnabled,false);
  const southPin=(await f.request(runs,{cookie:south,workspace:'south',body:{filters},status:201})).data.run.id;
  await plan('create',{...proposed,sourceRunId:southPin,execution:'local-worker'},south,409,'south');
  await f.request(base+'/worker',{cookie:analyst,body:{},status:404});

  let db,runner,scope;
  const time=fakeWakeClock(first),outcomes=[];
  function openWorker(){
    db=openSqlite(f.sqliteFile);scope=db.scope('workspace:north');
    const store=openStore(join(f.isolated.root,'north','state.json'),{empty:true,storage:scope,reportWorkerEnabled:true});
    const southStore=openStore(join(f.isolated.root,'south','state.json'),{empty:true,storage:db.scope('workspace:south')});
    assert.throws(()=>southStore.runReportScheduleWorker(first),/disabled/);
    runner=createWorker({...time,wake:now=>outcomes.push(store.runReportScheduleWorker(now)),onError:error=>{throw error;}});
    runner.start();
  }
  function stopWorker(){runner?.stop();db?.close();db=null;}
  t.after(()=>stopWorker());
  function readGeneration(){return scope.readSince('workbench',-1).generation;}
  function wake(at,expected,changed){
    const before=readGeneration();
    time.move(at);time.wake();
    const outcome=outcomes.at(-1);
    assert.equal(outcome.outcome,expected);assert.equal(outcome.changed,changed);
    assert.equal(readGeneration(),before+(changed?1:0));
    return outcome;
  }
  openWorker();
  wake(first,'idle',false); // Existing approval explicitly meant simulation only.
  current=await model();
  assert.equal(current.plans[0].receipts.length,0);
  const stoppedLegacy=await plan('stop',{expectedRevision:current.revision,planId:legacy},reviewer);
  current=await plan('create',{...proposed,expectedRevision:stoppedLegacy.revision,execution:'local-worker'});
  const id=current.plans[0].id;
  wake(first,'idle',false); // A queued worker draft never runs.
  await plan('approve',{expectedRevision:current.revision,planId:id},analyst,403);
  const approved=await plan('approve',{expectedRevision:current.revision,planId:id},reviewer);
  assert.equal(approved.plans[0].execution,'local-worker');
  wake(first-1,'not-due',false);
  const tick={planId:id,slotAt:iso(first),simulatedAt:iso(first)};
  assert.equal((await plan('tick',tick)).outcome,'not-due'); // Real actual time is still earlier.
  const firstRun=wake(first,'ran',true).receipt;
  assert.equal(firstRun.slotAt,iso(first));assert.equal(firstRun.capturedAt,iso(first));
  assert.equal(firstRun.executor,'local-worker');assert.equal(firstRun.total,1);
  wake(first,'not-due',false);
  const parallelConnection=openSqlite(f.sqliteFile);
  try{
    const contender=openStore(join(f.isolated.root,'north','state.json'),
      {empty:true,storage:parallelConnection.scope('workspace:north'),reportWorkerEnabled:true});
    assert.deepEqual(contender.runReportScheduleWorker(first),{changed:false,outcome:'not-due'});
  }finally{parallelConnection.close();}
  assert.equal((await plan('tick',tick)).receipt.reportId,firstRun.reportId);
  const exportRun=(id,format)=>f.request(runs+'/'+id+'/export?format='+format,{cookie:analyst});
  const json=(await exportRun(firstRun.reportId,'json')).raw,csv=(await exportRun(firstRun.reportId,'csv')).raw;
  assert.doesNotMatch(json,/Fictional worker count item|Not included/);

  stopWorker();await f.stop();await f.start('north');
  [analyst,reviewer]=await Promise.all([seats[0],seats[1]].map(f.login));
  openWorker();
  wake(first,'not-due',false);
  assert.equal((await exportRun(firstRun.reportId,'json')).raw,json);
  assert.equal((await exportRun(firstRun.reportId,'csv')).raw,csv);
  const later=first+20*day,second=wake(later,'ran',true).receipt;
  const approvedAfter=(await model()).plans[0];
  assert.equal(approvedAfter.workerRuns,2);assert.equal(approvedAfter.skippedSlots,13);
  assert.equal(second.slotAt,iso(first+14*day));assert.equal(second.capturedAt,iso(later));
  assert.equal(approvedAfter.nextDueAt,iso(first+15*day));assert.equal(approvedAfter.receipts.length,2);
  assert.deepEqual(approvedAfter.skippedRanges,[{from:iso(first+day),through:iso(first+13*day),count:13}]);
  const backfill=await plan('tick',{planId:id,slotAt:iso(first+day),simulatedAt:iso(later)});
  assert.equal(backfill.outcome,'skipped');
  assert.equal(backfill.receipt,null);
  wake(first+14*day,'not-due',false); // A backward clock cannot rewind the cursor.
  const third=wake(later,'ran',true).receipt;
  assert.equal(third.slotAt,iso(first+15*day));
  current=await model();
  await plan('stop',{expectedRevision:current.revision,planId:id},reviewer);
  wake(later,'idle',false);
  assert.equal((await plan('tick',tick)).receipt.reportId,firstRun.reportId);
  const audit=(await f.request('/api/audit/export',{cookie:reviewer})).data.audit.filter(row=>row.action==='reporting.schedule.ran');
  assert.equal(audit.length,3);
  assert.ok(audit.every(e=>e.actor==='system'&&!Object.hasOwn(e,'account')&&e.details.execution==='local-worker'&&e.details.total===1));
});

test('an oversized due export holds once without advancing; actual staff retry is persisted and never rerun',()=>{
  const start=Date.UTC(2027,1,1,1),slot=start+minute;
  const state={audit:[]},workerAuthor={actor:'analyst',account:'author'},review={actor:'reviewer',account:'reviewer'};
  const source=JSON.parse(pins.create(state,[],{filters:{dataset:'records',workflow:'rights',group:'day'}},'local-isolated',{now:start}));
  const event=(s,actor,action,projectId,entityId,details)=>s.audit.push({actor,action,projectId,entityId,details});
  const call=(actor,action,body,now=start)=>schedules.change(state,[],actor,action,body,event,{now,workerEnabled:true});
  const created=call(workerAuthor,'create',{expectedRevision:0,sourceRunId:source.run.id,execution:'local-worker',cadence:'weekly',firstDueAt:iso(slot)});
  const planId=created.value.plans[0].id;
  call(review,'approve',{expectedRevision:1,planId});
  state.rightsCases=Array.from({length:3600},(_,i)=>({status:'received',receivedAt:iso(start-i*day)}));
  const failed=schedules.runWorker(state,[],slot,event);
  assert.equal(failed.outcome,'worker-held');assert.equal(failed.changed,true);
  assert.equal(state.reportScheduleBook.plans[0].nextDueAt,iso(slot));
  assert.equal(state.reportScheduleBook.plans[0].workerFailure.code,'REPORT_RUN_TOO_LARGE');
  assert.equal(state.reportRuns.length,1);
  const locked=schedules.runWorker(state,[],slot+minute,event);
  assert.deepEqual(locked,{changed:false,outcome:'held'});
  assert.equal(state.audit.filter(e=>e.action==='reporting.schedule.worker-held').length,1);
  state.rightsCases=state.rightsCases.slice(0,1);
  const retry={planId,slotAt:iso(slot),simulatedAt:iso(slot)};
  const result=call(workerAuthor,'tick',retry,slot+minute);
  assert.equal(result.value.receipt.executor,'staff');assert.equal(result.value.receipt.total,1);
  assert.equal(state.reportScheduleBook.plans[0].workerFailure,null);
  assert.equal(state.reportScheduleBook.plans[0].workerRuns,0);
  assert.deepEqual(schedules.runWorker(state,[],slot+minute,event),{changed:false,outcome:'not-due'});
  assert.equal(call(workerAuthor,'tick',retry,slot+minute).value.receipt.reportId,result.value.receipt.reportId);
});

test('Chromium distinguishes staff simulation from approved worker execution and shows its saved output',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Requires Playwright and Chromium',timeout:35_000
},async t=>{
  const f=await fixture(t);
  await f.stop();await f.start('north');
  const analyst=await f.login(seats[0]);
  await f.request(runs,{cookie:analyst,body:{filters},status:201});
  const {chromium}=require('playwright');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  t.after(()=>browser.close());
  const errors=[],external=[];
  const exact=(target,name)=>target.getByRole('button',{name,exact:true});
  const text=(target,value)=>target.getByText(value,{exact:true});
  async function visit([account,workspace]){
    const p=await browser.newPage();p.setDefaultTimeout(6500);p.on('pageerror',error=>errors.push(error.message));
    await p.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.origin!==f.url){external.push(url.origin);return route.abort();}
      return route.continue();
    });
    await p.goto(f.url);
    await p.getByLabel('Test account',{exact:true}).fill(account);
    await p.getByLabel('Workspace ID',{exact:true}).fill(workspace);
    await p.getByLabel('Local access code',{exact:true}).fill(f.codes[account]);
    await exact(p,'Sign in').click();await exact(p,'Reporting').click();
    const detail=p.locator('details').filter({has:text(p,'Local report scheduling')});
    await detail.locator('summary').click();
    await detail.getByRole('heading',{name:'Local UTC report schedule',exact:true}).waitFor();
    return {p,detail};
  }
  const author=await visit(seats[0]);
  await author.detail.getByLabel('Schedule execution').selectOption('local-worker');
  const slot=future();
  await author.detail.getByLabel('First due time (UTC)',{exact:true}).fill(iso(slot).slice(0,16));
  await exact(author.detail,'Propose local schedule').click();
  await text(author.detail,'Draft schedule saved. A separate reviewer must approve it.').waitFor();
  assert.equal(await exact(author.detail,'Run one due slot').count(),0);
  const review=await visit(seats[1]);
  await text(review.detail,'Execution: approved local worker · 0 automatic runs · 0 older slots skipped').waitFor();
  await exact(review.detail,'Approve local schedule').click();
  await text(review.detail,'Schedule approved for the local worker.').waitFor();
  assert.equal(await review.detail.getByLabel('Simulated time (UTC)',{exact:true}).count(),0);
  await exact(review.detail,'Run one due slot').click();
  await text(review.detail,'No report was saved. The slot is not due at the actual UTC time.').waitFor();
  const db=openSqlite(f.sqliteFile);
  try{
    const store=openStore(join(f.isolated.root,'north','state.json'),{empty:true,storage:db.scope('workspace:north'),reportWorkerEnabled:true});
    assert.equal(store.runReportScheduleWorker(slot).outcome,'ran');
  }finally{db.close();}
  await exact(author.detail,'Reload local schedule').click();
  await text(author.detail,'Execution: approved local worker · 1 automatic run · 0 older slots skipped').waitFor();
  const [download]=await Promise.all([author.p.waitForEvent('download'),
    author.detail.getByRole('link',{name:'Download scheduled JSON',exact:true}).click()]);
  const chunks=[];
  for await(const chunk of await download.createReadStream())chunks.push(chunk);
  const data=JSON.parse(Buffer.concat(chunks));
  assert.equal(data.generatedAt,iso(slot));assert.equal(data.counts.total,0);
  await exact(review.detail,'Reload local schedule').click();
  await text(review.detail,'Execution: approved local worker · 1 automatic run · 0 older slots skipped').waitFor();
  await exact(review.detail,'Stop local schedule').click();
  await text(review.detail,'Schedule stopped. Its history remains available.').waitFor();
  assert.equal(await exact(review.detail,'Run one due slot').count(),0);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
});

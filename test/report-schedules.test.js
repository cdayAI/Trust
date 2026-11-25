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
  async function start(){
    const options=backend==='demo'?{dataFile:join(root,'demo.json')}:{isolated,...(backend==='sqlite'?{sqliteFile:join(root,'program.sqlite')}:{})};
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
  return {request,login,start,stop,get url(){return url;},codes};
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

'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {mkdtemp,readFile,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join,resolve,relative,isAbsolute}=require('node:path');

const base='/api/reporting/schedules',runs='/api/reporting/runs';
const incidentFilters={dataset:'records',workflow:'incidents',stage:'logged',group:'stage'};
const rightsFilters={dataset:'records',workflow:'rights',group:'workflow'};
const b=(s,name)=>s.getByRole('button',{name,exact:true});
const h=(s,name)=>s.getByRole('heading',{name,exact:true});
const see=(s,value)=>s.getByText(value,{exact:true}).waitFor();
const iso=v=>new Date(v).toISOString();

async function setup(t){
  const room=await mkdtemp(join(tmpdir(),'mvw-release-schedule-race-'));
  const child=spawn(process.execPath,[resolve(__dirname,'../start-release.js'),'--port','0'],{
    cwd:room,env:{...process.env,TMPDIR:room,TMP:room,TEMP:room},stdio:['ignore','pipe','pipe']
  });
  const exit=once(child,'exit');
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exit;}
    await rm(room,{recursive:true,force:true,maxRetries:2});
  });
  const announcement=await new Promise((ok,fail)=>{
    let buffer='';
    const timer=setTimeout(()=>fail(Error('Release start deadline.')),20_000);
    exit.then(()=>{clearTimeout(timer);fail(Error('Release exited before starting.'));},fail);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      buffer+=chunk;
      if(buffer.includes('\n')){clearTimeout(timer);ok(buffer.split('\n')[0]);}
    });
    child.stderr.resume();
  });
  const live=JSON.parse(announcement);
  assert.equal(live.status,'ready');
  assert.match(live.url,/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/);
  const rel=relative(room,live.accessFile);
  assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));
  const access=JSON.parse(await readFile(live.accessFile,'utf8'));
  assert.equal(access.mode,'local-synthetic-only');
  const seat=(workspace,role)=>access.staff.find(s=>s.memberships[workspace]===role);

  async function request(path,{workspace='harbor',cookie,body,status=200}={}){
    const endpoint=new URL(path,live.url);
    if(workspace)endpoint.searchParams.set('workspace',workspace);
    const res=await fetch(endpoint,{
      ...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),
      headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{Origin:live.url,'Content-Type':'application/json'})},
      signal:AbortSignal.timeout(7000)
    });
    assert.equal(res.status,status,path);
    const raw=Buffer.from(await res.arrayBuffer());
    return {raw,data:res.headers.get('content-type')?.startsWith('application/json')?JSON.parse(raw):null,
      cookie:res.headers.get('set-cookie')?.split(';')[0]};
  }
  async function login(role,workspace='harbor'){
    const {id:account,code}=seat(workspace,role);
    return (await request('/api/session/login',{body:{account,workspace,code},workspace:null})).cookie;
  }
  return {url:live.url,seat,request,login};
}

test('composed Chromium: competing scoped drafts, stale review, due-slot retry and exact report evidence',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Requires Playwright and Chromium',timeout:65_000
},async t=>{
  const f=await setup(t),{chromium}=require('playwright');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  t.after(()=>browser.close());
  const author=await f.login('analyst'),reviewer=await f.login('reviewer'),orchard=await f.login('reviewer','orchard');
  const errors=[],external=[];
  const send=(path,body)=>f.request(path,{cookie:author,body,status:path===runs?201:200}).then(r=>r.data);
  const inspect=()=>f.request(base,{cookie:author}).then(r=>r.data);
  const snapshot=()=>f.request(runs,{cookie:author}).then(r=>r.data.runs);
  const incident=title=>send('/api/incidents/cases',{title,scope:'Synthetic scope not reproduced in aggregate exports.'});
  const before=await send(runs,{filters:incidentFilters}),alternate=await send(runs,{filters:rightsFilters});
  const due=Math.floor((Date.now()+2*3600000)/60000)*60000,dueISO=iso(due);
  const heading='Simulated UTC schedule';
  const panel=p=>p.locator('details').filter({has:p.getByText('Local report scheduling',{exact:true})});
  const approval='Schedule approved for explicit simulated runs.';
  const stale='This schedule changed. Reload it before retrying.';
  async function focus(locator){
    await locator.waitFor();
    assert.equal(await locator.evaluate(node=>node===document.activeElement),true,
      'focus should be on '+await locator.textContent()+'; was '+await locator.page().evaluate(()=>document.activeElement.tagName));
  }
  async function visit(role,workspace='harbor'){
    const p=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true,reducedMotion:'reduce'});
    p.setDefaultTimeout(6500);
    p.on('pageerror',error=>errors.push(error.message));
    await p.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.origin===f.url)return route.continue();
      external.push(url.origin);return route.abort();
    });
    const {id,code}=f.seat(workspace,role);
    await p.goto(f.url);
    await p.getByLabel('Test account',{exact:true}).fill(id);
    await p.getByLabel('Workspace ID',{exact:true}).fill(workspace);
    await p.getByLabel('Local access code',{exact:true}).fill(code);
    await b(p,'Sign in').press('Enter');
    await b(p,'Reporting').press('Enter');
    await h(p,'Operational reporting').waitFor();
    await panel(p).locator('summary').press('Enter');
    await h(panel(p),heading).waitFor();
    return p;
  }
  async function submit(p,label,action,status){
    const pending=p.waitForResponse(r=>new URL(r.url()).pathname===base+'/'+action&&r.request().method()==='POST');
    await b(panel(p),label).press('Enter');
    const response=await pending;
    assert.equal(response.status(),status,action);
    assert.equal(new URL(response.url()).searchParams.get('workspace'),'harbor');
    return {model:await response.json(),body:response.request().postDataJSON()};
  }
  async function draft(p,source,cadence){
    const scope=panel(p),first=scope.getByLabel('First due time (UTC)',{exact:true});
    const template=scope.getByLabel('Pinned report template');
    const chosen=await template.selectOption(source);
    assert.deepEqual(chosen,[source]);
    await scope.getByLabel('UTC cadence').selectOption(cadence);
    await first.fill(dueISO.slice(0,16));
  }
  async function reload(p){
    const pending=p.waitForResponse(r=>new URL(r.url()).pathname===base&&r.request().method()==='GET');
    await b(panel(p),'Reload local schedule').press('Enter');
    const reply=await pending;assert.equal(reply.status(),200);
    await focus(h(panel(p),heading));
  }
  async function download(p,format,reportId){
    const link=panel(p).getByRole('link',{name:'Download scheduled '+format.toUpperCase(),exact:true});
    const url=new URL(await link.getAttribute('href'),f.url);
    assert.equal(url.pathname,runs+'/'+reportId+'/export');
    assert.deepEqual(Object.fromEntries(url.searchParams),{format,workspace:'harbor'});
    const [item]=await Promise.all([p.waitForEvent('download'),link.press('Enter')]);
    assert.equal(item.suggestedFilename(),'mvw-trust-report-'+reportId+'.'+format);
    const pieces=[];
    for await(const chunk of await item.createReadStream())pieces.push(chunk);
    return Buffer.concat(pieces);
  }

  const a=await visit('analyst'),competing=await visit('analyst');
  await draft(a,before.run.id,'daily');
  await draft(competing,alternate.run.id,'weekly');
  const first=await submit(a,'Propose local schedule','create',200);
  const primary=first.model.plans[0];
  assert.deepEqual(primary.filters,before.filters);
  assert.equal(primary.cadence,'daily');
  await see(panel(a),'Draft schedule saved. A separate reviewer must approve it.');
  await focus(h(panel(a),heading));
  const conflict=await submit(competing,'Propose local schedule','create',409);
  assert.equal(conflict.model.code,'STALE_REPORT_SCHEDULE');
  assert.equal(conflict.body.sourceRunId,alternate.run.id);
  assert.equal(conflict.body.expectedRevision,first.body.expectedRevision);
  await see(competing,stale);
  await focus(panel(competing).getByRole('alert').filter({hasText:stale}));
  assert.equal(await panel(competing).getByLabel('Pinned report template').inputValue(),alternate.run.id);
  assert.equal(await panel(competing).getByLabel('UTC cadence').inputValue(),'weekly');
  assert.equal(await panel(competing).getByLabel('First due time (UTC)',{exact:true}).inputValue(),dueISO.slice(0,16));
  await reload(competing);
  assert.equal(await b(panel(competing),'Propose local schedule').count(),0);
  await h(panel(competing),'Daily report plan · draft').waitFor();
  assert.deepEqual((await inspect()).plans.map(row=>row.id),[primary.id]);

  const r=await visit('reviewer'),staleReviewer=await visit('reviewer');
  const activated=await submit(r,'Approve local schedule','approve',200);
  await see(panel(r),approval);
  assert.equal(activated.model.plans[0].id,primary.id);
  await focus(h(panel(r),heading));
  const refused=await submit(staleReviewer,'Approve local schedule','approve',409);
  assert.equal(refused.model.code,'STALE_REPORT_SCHEDULE');
  assert.deepEqual(refused.body,activated.body);
  await see(staleReviewer,stale);
  // A failed async keyboard submission must not drop the reviewer on the page body.
  assert.notEqual(await staleReviewer.evaluate(()=>document.activeElement.tagName),'BODY','Stale review lands on the body instead of a recoverable in-panel error.');
  await focus(panel(staleReviewer).getByRole('alert').filter({hasText:stale}));
  await staleReviewer.keyboard.press('Tab');
  await focus(b(panel(staleReviewer),'Reload local schedule'));
  await reload(staleReviewer);
  await h(panel(staleReviewer),'Daily report plan · active').waitFor();
  assert.equal(await b(panel(staleReviewer),'Approve local schedule').count(),0);
  assert.equal(await panel(staleReviewer).getByRole('alert').count(),0);

  await incident('Fictional incident before due-slot capture');
  await reload(a);
  const receipts=await Promise.all([a,staleReviewer].map(p=>submit(p,'Run simulated slot','tick',200)));
  assert.deepEqual(receipts.map(x=>x.model.outcome).sort(),['already-run','ran']);
  assert.deepEqual(receipts.map(x=>x.body),Array(2).fill({planId:primary.id,slotAt:dueISO,simulatedAt:dueISO}));
  const {reportId,total}=receipts[0].model.receipt;
  assert.equal(receipts[1].model.receipt.reportId,reportId);
  assert.equal(total,before.counts.total+1);
  for(const [p,{model}] of [[a,receipts[0]],[staleReviewer,receipts[1]]]){
    await see(panel(p),model.outcome==='ran'?'One scheduled report was saved.':'That UTC slot was already processed.');
    await focus(h(panel(p),heading));
    await see(panel(p),'Next due: '+iso(due+86400000).replace('T',' ').slice(0,19)+' UTC');
    assert.equal(await panel(p).getByRole('link',{name:'Download scheduled JSON',exact:true}).count(),1);
  }
  assert.equal((await snapshot()).length,3);
  const [json,csv]=await Promise.all([download(a,'json',reportId),download(staleReviewer,'csv',reportId)]);
  assert.deepEqual(JSON.parse(json).filters,before.filters);
  assert.equal(JSON.parse(json).counts.total,total);
  assert.match(csv.toString(),new RegExp('"Logged","'+total+'"\\r\\n$'));
  assert.doesNotMatch(json.toString(),/Fictional incident before|Synthetic scope/iu);

  await incident('Fictional incident after due-slot capture');
  await submit(staleReviewer,'Stop local schedule','stop',200);
  await see(panel(staleReviewer),'Schedule stopped. Its history remains available.');
  await reload(competing);
  await draft(competing,alternate.run.id,'weekly');
  const replacement=await submit(competing,'Propose local schedule','create',200);
  assert.equal(replacement.model.plans[0].cadence,'weekly');
  assert.deepEqual(replacement.model.plans[0].filters,alternate.filters);
  assert.notEqual(replacement.model.plans[0].id,primary.id);
  assert.deepEqual(replacement.model.plans.map(row=>row.status),['draft','stopped']);
  assert.equal(replacement.model.plans[1].receipts[0].reportId,reportId);
  await reload(a);
  await h(panel(a),'Weekly report plan · draft').waitFor();
  await h(panel(a),'Daily report plan · stopped').waitFor();
  assert.deepEqual(await download(a,'json',reportId),json);
  assert.deepEqual(await download(a,'csv',reportId),csv);
  for(const [format,bytes] of [['json',json],['csv',csv]]){
    const persisted=await f.request(runs+'/'+reportId+'/export?format='+format,{cookie:reviewer});
    assert.deepEqual(persisted.raw,bytes);
  }

  const outside=await visit('reviewer','orchard');
  await see(panel(outside),'No local schedule has been proposed.');
  assert.equal(await panel(outside).getByRole('link',{name:/Download scheduled/}).count(),0);
  await f.request(runs+'/'+reportId+'/export?format=json',{cookie:orchard,workspace:'orchard',status:404});
  const audit=(await f.request('/api/audit/export',{cookie:reviewer})).data.audit;
  assert.equal(audit.filter(row=>row.action==='reporting.schedule.approved').length,1);
  assert.equal(audit.filter(row=>row.action==='reporting.schedule.ran').length,1);
  assert.equal(audit.filter(row=>row.action==='reporting.schedule.proposed').length,2);
  assert.equal((await snapshot()).length,3);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
});

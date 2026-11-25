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
const {report,csvCell}=require('../reporting');

async function serverFixture(t,isolated){
  const root=await mkdtemp(join(tmpdir(),'mvw-reporting-'));
  const server=createServer(isolated?{isolated:{root,...isolated}}:{dataFile:join(root,'state.json')});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const url='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true})});
  async function request(route,status,{body,token,actor}={}){
    const response=await fetch(url+route,{
      method:body===undefined?'GET':'POST',
      headers:{...(body===undefined?{}:{'Content-Type':'application/json',Origin:url}),...(token?{Cookie:token}:{}),...(actor?{'X-Demo-Actor':actor}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})
    });
    assert.equal(response.status,status,route);
    const raw=await response.text();
    return {response,raw,data:response.headers.get('content-type').startsWith('application/json')?JSON.parse(raw):null};
  }
  return {url,request};
}

test('reports actual assessment, rights and incident state; filters audit outcomes and exports matching aggregate rows',async t=>{
  const {request}=await serverFixture(t);
  const initial=(await request('/api/reporting?workflow=assessments&group=stage',200)).data;
  assert.deepEqual(initial.counts,{total:3,workflowCount:1,undated:0});
  assert.deepEqual(initial.rows,[{key:'draft',label:'Draft',count:3}]);
  const snapshot=(await request('/api/state',200)).data;
  const draft=snapshot.assessments.find(row=>row.questionnaire.id==='privacy');
  assert.ok(draft);
  const submit={expectedRevision:draft.revision,answers:{summary:'=Private example narrative',safeguards:'Sensitive example evidence',externalSharing:'No'}};
  await request('/api/assessments/'+draft.id+'/submit',403,{actor:'reviewer',body:submit});
  const persisted=(await request('/api/assessments/'+draft.id+'/submit',200,{actor:'analyst',body:submit})).data;
  const current=persisted.assessments.find(row=>row.id===draft.id);
  assert.equal(current.status,'in_review');
  const createdRights=(await request('/api/rights/cases',200,{actor:'analyst',body:{kind:'access',owner:'analyst',days:30,note:'Private example rights note'}})).data.cases[0];
  await request('/api/incidents/cases',200,{actor:'analyst',body:{title:'Private example incident name',scope:'Private example incident scope'}});
  const today=createdRights.receivedAt.slice(0,10);
  const scopedDate='&from='+today+'&to='+today;
  const approved=(await request('/api/reporting?workflow=assessments&stage=in-review&group=stage',200)).data;
  assert.deepEqual(approved.rows,[{key:'in-review',label:'In review',count:1}]);
  const rights=(await request('/api/reporting?workflow=rights&group=day'+scopedDate,200)).data;
  assert.deepEqual(rights.rows,[{key:today,label:today,count:1}]);
  assert.equal((await request('/api/reporting?workflow=incidents&stage=logged&group=stage',200)).data.counts.total,1);
  assert.equal((await request('/api/reporting?workflow=incidents&to=2020-01-01',200)).data.counts.total,0);
  const events=(await request('/api/reporting?dataset=activity&workflow=assessments&group=outcome',200)).data;
  assert.deepEqual(Object.fromEntries(events.rows.map(row=>[row.key,row.count])),{recorded:4,refused:1});
  const query='dataset=activity&workflow=assessments&group=outcome&outcome=refused';
  const filtered=(await request('/api/reporting?'+query,200)).data;
  const json=await request('/api/reporting/export?'+query+'&format=json',200);
  const csv=await request('/api/reporting/export?'+query+'&format=csv',200);
  assert.equal(json.response.headers.get('content-disposition'),'attachment; filename="mvw-trust-report.json"');
  assert.equal(csv.response.headers.get('content-disposition'),'attachment; filename="mvw-trust-report.csv"');
  assert.match(csv.response.headers.get('content-type'),/^text\/csv/);
  assert.equal(csv.response.headers.get('cache-control'),'no-store');
  assert.deepEqual(json.data.filters,filtered.filters);
  assert.deepEqual(json.data.rows,filtered.rows);
  assert.deepEqual(json.data.counts,filtered.counts);
  assert.match(csv.raw,/"activity","assessments","all","refused","","","outcome","Refused","1"\r\n$/);
  assert.doesNotMatch(JSON.stringify([initial,rights,events,json.raw,csv.raw]),/private example|sensitive example|decisionReason|entityId|receivedAt|reviewer-account/i);
  for(const query of [
    'group=javascript','dataset=records&group=outcome','dataset=activity&stage=draft','dataset=records&outcome=failed',
    'stage=__proto__','workflow=constructor','workflow=unregistered','from=2025-02-29','from=2025-12-01&to=2025-11-30',
    'from=','from=0000-02-01','workflow=rights&workflow=incidents','format=csv','prototype=records','workspace=alpha'
  ])assert.equal((await request('/api/reporting?'+query,422)).data.code,'INVALID_REPORT_FILTER',query);
  await request('/api/reporting/export?format=xlsx',422);
});

test('isolated reports require an entitled local session and operate on the selected workspace only',async t=>{
  const code=()=>randomBytes(32).toString('base64url');
  const codes={analyst:code(),reviewer:code(),publisher:code(),case:code()};
  const accounts=[
    {id:'a-local',codeHash:codeHash(codes.analyst),memberships:{alpha:'analyst',beta:'analyst'}},
    {id:'r-local',codeHash:codeHash(codes.reviewer),memberships:{alpha:'reviewer'}},
    {id:'p-local',codeHash:codeHash(codes.publisher),memberships:{alpha:'publisher'}},
    {id:'c-local',codeHash:codeHash(codes.case),memberships:{alpha:'case-operator'}}
  ];
  const {request}=await serverFixture(t,{workspaces:[{id:'alpha',label:'Alpha'},{id:'beta',label:'Beta'}],accounts});
  async function login(account,key,workspace='alpha'){
    const {response}=await request('/api/session/login',200,{body:{account,workspace,code:codes[key]}});
    return response.headers.get('set-cookie').split(';')[0];
  }
  const a=await login('a-local','analyst'),b=await login('a-local','analyst','beta');
  const r=await login('r-local','reviewer'),p=await login('p-local','publisher'),c=await login('c-local','case');
  await request('/api/incidents/cases?workspace=alpha',200,{token:a,body:{title:'Alpha-only synthetic incident',scope:'Alpha-only suggested scope'}});
  await request('/api/reporting?workspace=alpha',401,{actor:'analyst'});
  await request('/api/reporting/export?workspace=alpha&format=csv',401);
  await request('/api/reporting?workspace=alpha',403,{token:b});
  await request('/api/reporting/export?workspace=beta&format=csv',403,{token:r});
  await request('/api/reporting?workspace=alpha&workspace=alpha',403,{token:a});
  for(const token of [p,c]){
    await request('/api/reporting?workspace=alpha',403,{token,actor:'analyst'});
    await request('/api/reporting/export?workspace=alpha&format=csv',403,{token});
  }
  const alpha=(await request('/api/reporting?workspace=alpha',200,{token:r})).data;
  assert.equal(alpha.mode,'local-isolated');
  assert.deepEqual(alpha.rows,[{key:'incidents',label:'Incidents',count:1}]);
  const beta=(await request('/api/reporting?workspace=beta',200,{token:b})).data;
  assert.equal(beta.counts.total,0);
  assert.deepEqual(beta.rows,[]);
  assert.doesNotMatch(JSON.stringify([alpha,beta]),/Alpha-only|a-local|r-local|incidentId/);
  const csv=await request('/api/reporting/export?workspace=alpha&format=csv',200,{token:r});
  assert.match(csv.raw,/"workflow","Incidents","1"/);
});

test('UTC normalization, unknown legacy dimensions, and spreadsheet-safe escaping',()=>{
  const query=value=>new URLSearchParams(value);
  const state={rightsCases:[
    {receivedAt:'2024-02-28T23:30:00-02:00',status:'received'},
    {receivedAt:'2024-02-30T12:00:00Z',status:'=do not expose'}
  ]};
  const {model}=report(state,[],query('group=day'));
  assert.deepEqual(model.rows,[{key:'2024-02-29',label:'2024-02-29',count:1},{key:'undated',label:'Undated',count:1}]);
  assert.equal(model.counts.undated,1);
  const only=report(state,[],query('group=stage&from=2024-02-29&to=2024-02-29')).model;
  assert.deepEqual(only.rows,[{key:'received',label:'Received',count:1}]);
  assert.doesNotMatch(JSON.stringify(report(state,[],query('group=stage'))),/do not expose/);
  assert.equal(csvCell('=1+1'),'"\'=1+1"');
  assert.equal(csvCell('   @formula'),'"\'   @formula"');
  assert.equal(csvCell('line,"quoted"'),'"line,""quoted"""');
});

test('Chromium: report filters, accessible table, applied-filter exports and mobile layout', {
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 with Playwright installed',
  timeout:30_000
},async t=>{
  const {chromium}=require('playwright');
  const {url,request}=await serverFixture(t);
  await request('/api/rights/cases',200,{actor:'analyst',body:{kind:'access',owner:'analyst',days:30,note:'Private example rights note'}});
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844},acceptDownloads:true});
    page.setDefaultTimeout(5000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/api/reporting/runs',route=>route.fulfill({
      status:503,json:{error:'Report history temporarily unavailable.'},
    }),{times:1});
    await page.goto(url);
    await page.getByRole('button',{name:'Browse workspace'}).click();
    await page.getByRole('button',{name:'Reporting',exact:true}).click();
    await page.getByText('Report history temporarily unavailable.').waitFor();
    await page.getByRole('button',{name:'Retry report'}).press('Enter');
    await page.getByRole('heading',{name:'Operational reporting'}).waitFor();
    assert.equal(await page.evaluate(()=>document.activeElement.id),'report-results-heading');
    await page.getByLabel('Report workflow').selectOption('rights');
    await page.getByLabel('Group report by').selectOption('stage');
    await page.getByRole('button',{name:'Apply report filters'}).click();
    const row=page.getByRole('row').filter({has:page.getByRole('rowheader',{name:'Received',exact:true})});
    await row.waitFor();
    assert.equal(await row.getByRole('rowheader').innerText(),'Received');
    const downloadPromise=page.waitForEvent('download');
    await page.getByRole('link',{name:'Download CSV'}).click();
    const download=await downloadPromise;
    assert.equal(download.suggestedFilename(),'mvw-trust-report.csv');
    let csv='';
    for await(const chunk of await download.createReadStream())csv+=chunk.toString();
    assert.match(csv,/"records","rights","all","all","","","stage","Received","1"/);
    await page.getByLabel('Report dataset').selectOption('activity');
    assert.equal(await page.getByLabel('Report stage').isVisible(),false);
    await page.getByLabel('Group report by').selectOption('outcome');
    await page.getByLabel('Report outcome').selectOption('refused');
    await page.getByRole('button',{name:'Apply report filters'}).click();
    await page.getByText('No report results match these filters.').waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});

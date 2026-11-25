'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {randomBytes,createHash}=require('node:crypto');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
const feature=require('../processing-register');
const path='/api/processing-register';
async function listen(server){
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return 'http://127.0.0.1:'+server.address().port;
}
async function seed(post){
  const nodes={};let mapRev=0;
  for(const [type,name] of [['system','Synthetic booking system'],['dataset','Fictional account dataset'],['activity','Synthetic reservations']]){
    const result=await post('/api/data-map/nodes',{expectedRevision:mapRev,type,name,owner:'Fictional programme',detail:'Fictional operational setting'});
    nodes[type]=result.nodes.find(x=>x.name===name).id;mapRev=result.revision;
  }
  for(const [type,from,to] of [['hosts','system','dataset'],['reads','dataset','activity']]){
    const result=await post('/api/data-map/links',{expectedRevision:mapRev,type,fromId:nodes[from],toId:nodes[to],note:'Fictional processing flow'});
    mapRev=result.revision;
  }
  const dictionary='/api/dictionary/terms';
  let d=await post(dictionary,{expectedRevision:0,title:'Fictional reservations purpose',definition:'Synthetic booking fulfillment',slug:'fictional-reservations',type:'purpose'});
  const term=d.terms[0].id;
  d=await post(dictionary+'/'+term+'/submit',{expectedRevision:d.revision,version:1});
  await post(dictionary+'/'+term+'/approve',{expectedRevision:d.revision,version:1},'reviewer');
  const retention='/api/retention/schedules';
  let r=await post(retention,{expectedRevision:0,title:'Fictional reservations retention',category:'demo-customer',days:90,trigger:'closed',disposition:'delete'});
  const schedule=r.schedules[0].id;
  r=await post(retention+'/'+schedule+'/submit',{expectedRevision:r.revision});
  await post(retention+'/'+schedule+'/activate',{expectedRevision:r.revision,note:'Fictional approval'},'reviewer');
  return {nodes,term,schedule,mapRev,draft:{
    title:'Synthetic guest processing',purpose:'Fictional reservations and guest service.',ownerRole:'serviceOwner',stewardRole:'recordsSteward',
    activityId:nodes.activity,systems:[nodes.system],datasets:[nodes.dataset],terms:[term],retentionSchedules:[schedule],
    subjects:['demoCustomers'],dataCategories:['demoAccount'],
    recipients:[{type:'processor',label:'Fictional service company',destination:'otherRegion',safeguards:'Synthetic minimum disclosure and limited access.'}]
  }};
}

test('HTTP/SQLite processing register pins approved references, refuses drift and separates historical editions and workspaces',async t=>{
  const root=await mkdtemp(join(tmpdir(),'processing-register-'));
  const roster=[['local-analyst','alpha','analyst'],['local-reviewer','alpha','reviewer'],['local-case','alpha','case-operator'],['other-analyst','beta','analyst']];
  const codes=Object.fromEntries(roster.map(([id])=>[id,randomBytes(32).toString('base64url')]));
  const isolated={root:join(root,'workspaces'),workspaces:[{id:'alpha',label:'Alpha'},{id:'beta',label:'Beta'}],
    accounts:roster.map(([id,space,role])=>({id,codeHash:codeHash(codes[id]),memberships:{[space]:role}}))};
  let server,url;
  async function start(){server=createServer({isolated,sqliteFile:join(root,'processing.sqlite')});url=await listen(server)}
  async function stop(){if(server?.listening)await new Promise(resolve=>server.close(resolve))}
  t.after(async()=>{await stop();await rm(root,{recursive:true,force:true})});
  await start();
  const cookies={};
  async function request(route,{role,workspace='alpha',body,expected=200}={}){
    const res=await fetch(url+route+(route.startsWith('/api/session')?'':'?workspace='+workspace),{
      method:body===undefined?'GET':'POST',
      headers:{...(body===undefined?{}:{'Content-Type':'application/json',Origin:url}),...(role&&cookies[role]?{Cookie:cookies[role]}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await res.json();assert.equal(res.status,expected,route+': '+JSON.stringify(data));
    return {res,data};
  }
  async function login(){
    for(const [account,workspace,role] of roster){
      const {res}=await request('/api/session/login',{body:{account,workspace,code:codes[account]}});
      cookies[workspace==='beta'?'beta':role]=res.headers.get('set-cookie').split(';')[0];
    }
  }
  await login();
  const post=async(route,body,role='analyst',expected=200)=>(await request(route,{role,body,expected})).data;
  const read=async(route,role='reviewer',expected=200,workspace='alpha')=>(await request(route,{role,expected,workspace})).data;
  await request(path,{expected:401});
  await read(path,'case-operator',403);
  await read(path,'beta',403);
  const f=await seed(post);
  await post('/api/modules/processing/records',{},'analyst',409);
  await post(path+'/entries',{details:f.draft},'reviewer',403);
  const create=(patch={},expected=200)=>post(path+'/entries',{details:{...f.draft,...patch}},'analyst',expected);
  assert.match((await create({systems:[f.nodes.dataset]},422)).error,/active system/);
  assert.match((await create({terms:[f.nodes.activity]},422)).error,/approved dictionary term/);
  assert.match((await create({retentionSchedules:[f.term]},422)).error,/active retention schedule/);
  assert.match((await create({recipients:[{...f.draft.recipients[0],safeguards:''}]},422)).error,/safeguard note/);
  const disconnected=(await post('/api/data-map/nodes',{expectedRevision:f.mapRev,type:'dataset',name:'Disconnected dataset',owner:'Synthetic',
    detail:'Not a linked processing dataset'})).nodes.find(n=>n.name==='Disconnected dataset');
  assert.equal((await create({datasets:[disconnected.id]},422)).code,'PROCESSING_LINEAGE_REQUIRED');
  assert.deepEqual((await read(path+'/export')).entries,[]);
  let row=(await create()).entries[0];
  await create({},409);
  const route=path+'/entries/'+row.id,report=version=>route+'/versions/'+version+'/export';
  async function action(action,fields={},role='analyst',expected=200){
    const result=await post(route+'/'+action,{expectedRevision:row.revision,...fields},role,expected);
    if(expected===200)row=result.entries[0];
    return result;
  }
  await read(report(1),'reviewer',404);
  await action('publish',{note:'Not yet submitted'},'reviewer',409);
  await action('submit');
  await action('edit',{details:f.draft},'analyst',409);
  await action('publish',{note:'Wrong role'},'analyst',403);
  await post('/api/data-map/nodes/'+f.nodes.dataset+'/update',{expectedRevision:f.mapRev+1,name:'Updated fictional dataset',owner:'Synthetic revised owner',detail:'Fresh snapshot required'});
  assert.equal((await action('publish',{note:'References changed'},'reviewer',409)).code,'PROCESSING_REFERENCES_CHANGED');
  await action('return',{note:'Map changed since submission.'},'reviewer');
  await action('submit');
  await action('publish',{note:'Reviewed synthetic lineage and terms.'},'reviewer');
  const v1=(await read(report(1))).entries[0];
  assert.equal(v1.processing.datasets[0].name,'Updated fictional dataset');
  assert.equal(v1.processing.dictionaryTerms[0].version,1);
  assert.equal(v1.processing.retentionSchedules[0].days,90);
  assert.equal(v1.processing.lineage.length,2);
  assert.equal(v1.contentSha256,createHash('sha256').update(JSON.stringify(v1.processing)).digest('hex'));
  assert.equal(v1.reviewedBy,'local-reviewer');
  assert.match((await request(report(1),{role:'reviewer'})).res.headers.get('content-disposition'),/attachment/);
  await read(report(1),'beta',404,'beta');

  await action('revise');
  await action('edit',{details:{...f.draft,title:'Updated fictional guest processing'}});
  assert.equal((await read(path+'/export')).entries[0].version,1);
  await action('submit');
  await action('publish',{note:'Reviewed fictional revision.'},'reviewer');
  assert.equal((await read(path+'/export')).entries[0].version,2);
  const v2=(await read(report(2))).entries[0];
  assert.notEqual(v2.contentSha256,v1.contentSha256);
  assert.deepEqual((await read(report(1))).entries[0],v1);
  const workspaceAudit=await read('/api/audit/export');
  assert.match(JSON.stringify(workspaceAudit),/processing-register.publish/);
  await stop();await start();await login();
  assert.deepEqual((await read(report(1))).entries[0],v1);
  assert.deepEqual((await read(report(2))).entries[0],v2);
  assert.deepEqual((await read(path+'/export','beta',200,'beta')).entries,[]);
});

test('processing review excludes every contributor even after role changes',()=>{
  const state={processingRegister:[{id:'synthetic-entry',revision:1,versions:[{status:'in_review',contributors:['author','submitter']}]}]};
  const check=account=>feature.change(state,['processing-register','entries','synthetic-entry','publish'],'reviewer',
    {expectedRevision:1,note:'Cannot approve own work'},()=>{},null,account);
  assert.throws(()=>check('author'),{status:403,code:'PROCESSING_INDEPENDENCE_REQUIRED'});
  assert.throws(()=>check('submitter'),{status:403,code:'PROCESSING_INDEPENDENCE_REQUIRED'});
});

test('Chromium mobile: select typed references, record fictional transfer, review and download approved snapshot',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 with Playwright installed',timeout:35_000
},async t=>{
  const {chromium}=require('playwright');
  const dir=await mkdtemp(join(tmpdir(),'processing-register-browser-'));
  const server=createServer({dataFile:join(dir,'state.json')});
  const url=await listen(server);
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true})});
  const {nodes}=await seed(async(route,body,role='analyst')=>{
    const response=await fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json',Origin:url,'X-Demo-Actor':role},body:JSON.stringify(body)});
    const data=await response.json();assert.equal(response.status,200,route+': '+JSON.stringify(data));return data;
  });
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844},acceptDownloads:true});page.setDefaultTimeout(6500);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url);
    await page.getByRole('button',{name:'Browse workspace'}).click();
    await page.getByRole('button',{name:'Processing register',exact:true}).click();
    await page.getByText('Draft processing entry',{exact:true}).click();
    await page.getByLabel('Entry title',{exact:true}).fill('Mobile synthetic transfer');
    await page.getByLabel('Fictional processing purpose').fill('Fictional transaction reconciliation.');
    await page.getByLabel('Accountable role').selectOption('serviceOwner');
    await page.getByLabel('Steward role').selectOption('operationsLead');
    await page.getByLabel('Mapped activity').selectOption(nodes.activity);
    await page.getByLabel('Synthetic booking system',{exact:true}).check();
    await page.getByLabel('Fictional account dataset',{exact:true}).check();
    await page.getByLabel('Fictional customers',{exact:true}).check();
    await page.getByLabel('Transaction attributes',{exact:true}).check();
    await page.getByLabel(/Fictional reservations purpose/).check();
    await page.getByLabel(/Fictional reservations retention/).check();
    await page.getByRole('button',{name:'Add recipient'}).click();
    await page.getByLabel('Recipient label').fill('Fictional reconciliation firm');
    await page.getByLabel('Destination',{exact:true}).selectOption('otherRegion');
    await page.getByLabel('Transfer safeguards').fill('Fictional time-limited access.');
    await page.getByRole('button',{name:'Create processing draft'}).click();
    await page.getByRole('heading',{name:'Mobile synthetic transfer'}).waitFor();
    await page.getByRole('button',{name:'Submit processing entry'}).click();
    await page.getByText('in review',{exact:true}).waitFor();
    await page.getByLabel('Demo identity').selectOption('reviewer');
    await page.getByLabel('Independent processing review note').fill('Reviewed the scoped fictional dataset and recipient.');
    await page.getByRole('button',{name:'Approve and publish entry'}).click();
    await page.getByText('published',{exact:true}).waitFor();
    await page.getByText('Approved version history',{exact:true}).click();
    const dl=page.waitForEvent('download');
    await page.getByRole('link',{name:'Download approved version 1'}).click();
    const download=await dl;
    assert.equal(download.suggestedFilename(),'mvw-trust-processing-register.json');
    let bytes='';for await(const chunk of await download.createReadStream())bytes+=chunk.toString();
    const {entries:[approved]}=JSON.parse(bytes);
    assert.equal(approved.processing.activity.id,nodes.activity);
    assert.equal(approved.processing.recipients[0].destination,'Other fictional region');
    assert.equal(approved.processing.recipients[0].safeguards,'Fictional time-limited access.');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});

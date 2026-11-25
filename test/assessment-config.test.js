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
const config=require('../assessment-config');

const configPath='/api/assessment-config';
async function listen(server){
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return 'http://127.0.0.1:'+server.address().port;
}
const configuration={
  title:'Fictional routing program',forms:{
    pia:{label:'Fictional intake PIA',questions:[]},
    dpia:{label:'Fictional sensitive assessment',questions:[
      {id:'transfer',label:'Is cross-region transfer planned?',kind:'choice',required:true,options:['Yes','No']},
      {id:'region-count',label:'Region count',kind:'integer',required:true,when:{question:'transfer',equals:'Yes'}}
    ]}
  },rules:[
    {id:'sensitive-and-ai',form:'dpia',match:{handlesSensitiveData:true,usesAI:true},reason:'Enhanced review for both declarations.'},
    {id:'standard-intake',form:'pia',match:{handlesSensitiveData:false},reason:'Neither routing nor AI replaces the independent review.'}
  ]
};

test('isolated HTTP/SQLite: independently review and publish versions, use deterministic routing and pin historic instances',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'assessment-config-sqlite-'));
  const roster=[['alpha-analyst','alpha','analyst'],['alpha-reviewer','alpha','reviewer'],['alpha-case','alpha','case-operator'],['beta-analyst','beta','analyst']];
  const codes=Object.fromEntries(roster.map(([name])=>[name,randomBytes(32).toString('base64url')]));
  const isolated={root:join(dir,'workspaces'),workspaces:[{id:'alpha',label:'Alpha'},{id:'beta',label:'Beta'}],
    accounts:roster.map(([id,ws,role])=>({id,codeHash:codeHash(codes[id]),memberships:{[ws]:role}}))};
  let server,url;
  async function start(){server=createServer({isolated,sqliteFile:join(dir,'trust.sqlite')});url=await listen(server)}
  async function stop(){if(server?.listening)await new Promise(resolve=>server.close(resolve))}
  t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true})});
  await start();
  async function request(path,expected,{cookie,workspace='alpha',body,spoof}={}){
    const response=await fetch(url+path+(path.startsWith('/api/session')?'':('?workspace='+workspace)),
      {method:body===undefined?'GET':'POST',headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{Origin:url,'Content-Type':'application/json'}),
      ...(spoof?{'X-Demo-Actor':spoof}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();
    assert.equal(response.status,expected,path+': '+JSON.stringify(data));
    return {data,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  async function login(account,workspace='alpha'){return (await request('/api/session/login',200,{body:{account,workspace,code:codes[account]}})).cookie}
  let analyst=await login(roster[0][0]),reviewer=await login(roster[1][0]);
  const caseWorker=await login(roster[2][0]),beta=await login(roster[3][0],'beta');
  await request(configPath,401);
  await request(configPath,403,{cookie:caseWorker,spoof:'analyst'});
  await request(configPath,403,{cookie:beta});
  let model=(await request(configPath,200,{cookie:analyst})).data;
  assert.equal(model.activeVersion,null);
  async function command(action,fields={},expected=200,cookie=analyst){
    const res=(await request(configPath+'/'+action,expected,{cookie,body:{expectedRevision:model.revision,...fields}})).data;
    if(expected===200)model=res;
    return res;
  }
  const project=(await request('/api/projects',200,{cookie:analyst,body:{name:'Fictional impact program'}})).data.projects[0];
  async function intake(name,handlesSensitiveData,usesAI){
    const state=(await request('/api/vendors',200,{cookie:analyst,body:{projectId:project.id,name,handlesSensitiveData,usesAI}})).data;
    const vendor=state.vendors.find(x=>x.name===name);
    const assessments=state.assessments.filter(x=>x.vendorId===vendor.id);
    return {privacy:assessments.find(a=>a.type==='privacy'),ai:assessments.find(a=>a.type==='ai')};
  }
  const old=await intake('Original fixture',true,false);
  assert.equal(old.privacy.questionnaire.id,'sensitive');

  await command('create',{},403,reviewer);
  await command('create');
  assert.equal((await command('submit',{expectedRevision:0},409)).code,'STALE_REVISION');
  assert.equal(await command('publish',{note:'Not submitted'},409,reviewer).then(x=>x.code),'INVALID_TRANSITION');
  const invalid=structuredClone(configuration);invalid.forms.dpia.questions[1].when.question='missing';
  assert.match((await command('edit',{configuration:invalid},422)).error,/earlier choice question/);
  invalid.forms=configuration.forms;invalid.rules=[{...configuration.rules[1],match:{}},...configuration.rules];
  assert.match((await command('edit',{configuration:invalid},422)).error,/Sensitive intake/);
  invalid.rules=[{...configuration.rules[1],match:{},form:['pia']}];
  await command('edit',{configuration:invalid},422);
  invalid.rules=[...configuration.rules,{...configuration.rules[0],id:'shadow'}];
  assert.match((await command('edit',{configuration:invalid},422)).error,/unreachable/);
  invalid.rules=[{...configuration.rules[0],match:{'use-eval':'true'}}];
  await command('edit',{configuration:invalid},422);
  await command('edit',{configuration});
  assert.equal(model.releases[0].preview.length,4);
  assert.deepEqual(model.releases[0].preview.map(x=>x.rule),['standard-intake','standard-intake',null,'sensitive-and-ai']);

  await command('submit');
  await command('publish',{note:'Cannot publish as author'},403);
  await command('return',{note:'Check synthetic labels.'},200,reviewer);
  assert.equal(model.activeVersion,null);
  assert.equal((await intake('During return',true,true)).privacy.questionnaire.id,'sensitive');
  await command('submit');
  await command('publish',{note:'Reviewed every fictional routing outcome.'},200,reviewer);
  assert.equal(model.activeVersion,1);
  assert.equal(model.releases[0].submittedBy,'alpha-analyst');
  assert.equal(model.releases[0].decidedBy,'alpha-reviewer');
  await command('edit',{configuration},409);
  const chosen=(await intake('Synthetic DPIA and AI',true,true));
  assert.equal(chosen.privacy.questionnaire.id,'configured-dpia');
  assert.equal(chosen.privacy.routing.ruleId,'sensitive-and-ai');
  assert.equal(chosen.privacy.routing.workflowId,'assessment-enhanced-review');
  assert.equal(chosen.ai.questionnaire.id,'ai');
  const fallback=await intake('No matching rule',true,false);
  assert.equal(fallback.privacy.questionnaire.id,'sensitive');
  const standard=await intake('Synthetic standard PIA',false,true);
  assert.equal(standard.privacy.questionnaire.id,'configured-pia');
  assert.equal(standard.privacy.routing.configurationVersion,1);
  assert.equal(standard.ai.questionnaire.id,'ai');
  const {privacy}=chosen,answerPath='/api/assessments/'+privacy.id;
  const answer={summary:'Fictional summary',safeguards:'Fictional safeguards',transfer:'Yes'};
  const answerTrip=(op,expected,answers,expectedRevision,cookie=analyst)=>request(answerPath+'/'+op,expected,{cookie,
    body:{expectedRevision,...(answers?{answers}:{reason:'Reviewed fictional DPIA'})}});
  assert.equal((await answerTrip('submit',422,answer,0)).data.code,'REQUIRED_ANSWER');
  assert.equal((await answerTrip('submit',422,{...answer,'region-count':'2.5'},0)).data.code,'INVALID_ANSWER');
  assert.equal((await answerTrip('save',422,{...answer,transfer:'No','region-count':'3'},0)).data.code,'HIDDEN_QUESTION');
  await answerTrip('save',200,{...answer,'region-count':'3'},0);
  const noTransfer=(await answerTrip('save',200,{transfer:'No'},1)).data.assessments.find(x=>x.id===privacy.id);
  assert.equal(Object.hasOwn(noTransfer.answers,'region-count'),false);
  await answerTrip('submit',200,{transfer:'No'},2);
  const approved=(await answerTrip('approve',200,null,3,reviewer)).data.assessments.find(x=>x.id===privacy.id);
  assert.equal(approved.status,'approved');

  await command('create');
  const nextConfig=structuredClone(configuration);nextConfig.forms.dpia.label='Revised synthetic DPIA';
  nextConfig.rules[0].id='revised-special-review';
  await command('edit',{configuration:nextConfig});
  assert.equal((await intake('While making new draft',true,true)).privacy.routing.configurationVersion,1);
  await command('submit');
  await command('publish',{note:'New version applies to future intakes.'},200,reviewer);
  const newRecord=(await intake('New configured release',true,true)).privacy;
  assert.equal(newRecord.questionnaire.label,nextConfig.forms.dpia.label);
  assert.equal(newRecord.routing.configurationVersion,2);
  assert.equal(newRecord.routing.ruleId,'revised-special-review');
  assert.equal((await request(configPath,200,{cookie:beta,workspace:'beta'})).data.activeVersion,null);

  await stop();await start();analyst=await login(roster[0][0]);reviewer=await login(roster[1][0]);
  const restarted=(await request('/api/state',200,{cookie:analyst})).data;
  assert.deepEqual(restarted.assessments.find(x=>x.id===privacy.id),approved);
  assert.deepEqual(restarted.assessments.find(x=>x.id===old.privacy.id),old.privacy);
  const audit=await request('/api/audit/export',200,{cookie:reviewer});
  assert.match(JSON.stringify(audit.data),/assessment-config.publish/);
});

test('approval rejects draft contributors or submitters after an account role change',()=>{
  const state={};const emit=()=>{};
  config.change(state,['assessment-config','create'],'analyst',{expectedRevision:0},emit,null,'same-account');
  config.change(state,['assessment-config','submit'],'analyst',{expectedRevision:1},emit,null,'submitting-account');
  assert.throws(()=>config.change(state,['assessment-config','publish'],'reviewer',{expectedRevision:2,note:'Unsafe approval'},emit,null,'submitting-account'),
    {status:403,code:'INDEPENDENCE_REQUIRED'});
  assert.throws(()=>config.change(state,['assessment-config','publish'],'reviewer',{expectedRevision:2,note:'Unsafe approval'},emit,null,'same-account'),
    {status:403,code:'INDEPENDENCE_REQUIRED'});
});

test('Chromium: analyst builds a conditional DPIA, reviewer approves it, then new intake uses the published routing', {
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 with Playwright installed',timeout:45_000
},async t=>{
  const {chromium}=require('playwright');
  const dir=await mkdtemp(join(tmpdir(),'assessment-config-browser-'));
  const server=createServer({dataFile:join(dir,'state.json')});
  const url=await listen(server);
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true})});
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(6000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url);
    async function tab(name){
      await page.getByRole('button',{name:'Browse workspace'}).click();
      await page.getByRole('button',{name,exact:true}).click();
    }
    await tab('Assessment configuration');
    await page.getByRole('button',{name:'Start configuration draft'}).click();
    await page.getByLabel('Release title').fill('Mobile synthetic release');
    const dpia=page.locator('.assessment-config-builder').filter({has:page.getByRole('heading',{name:/^DPIA/})});
    await dpia.getByLabel('Questionnaire title').fill('Mobile-only synthetic assessment');
    await dpia.getByRole('button',{name:'Add DPIA question'}).click();
    const one=dpia.getByRole('group',{name:'Question 1',exact:true});
    await one.getByLabel('Question key',{exact:true}).fill('external');
    await one.getByLabel('Question label').fill('Is there a regional disclosure?');
    await one.getByLabel('Question type').selectOption('choice');
    await one.getByLabel('Choices (one per line)').fill('Yes\nNo');
    await one.getByLabel('Required when visible').check();
    await dpia.getByRole('button',{name:'Add DPIA question'}).click();
    const two=dpia.getByRole('group',{name:'Question 2',exact:true});
    await two.getByLabel('Question key',{exact:true}).fill('office-count');
    await two.getByLabel('Question label').fill('Number of regional offices');
    await two.getByLabel('Question type').selectOption('integer');
    await two.getByLabel('Required when visible').check();
    await two.getByLabel('Earlier choice question key (optional)').fill('external');
    await two.getByLabel('Show only for this exact choice').fill('Yes');
    assert.equal(await page.getByRole('button',{name:'Submit configuration for review'}).isDisabled(),true);
    await page.getByRole('button',{name:'Save configuration draft'}).click();
    await page.getByText('Draft saved. Routing preview updated.').waitFor();
    await page.getByText('Questionnaires and routing preview',{exact:true}).click();
    await page.getByText('Sensitive: Yes · AI: Yes',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Submit configuration for review'}).click();
    await page.getByText('Sent for independent review.',{exact:true}).waitFor();
    await page.getByLabel('Demo identity').selectOption('reviewer');
    await page.getByLabel('Independent decision note').fill('Reviewed the four synthetic coverage scenarios.');
    await page.getByRole('button',{name:'Approve and publish'}).click();
    await page.getByText('Active configuration: version 1',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
    await page.getByLabel('Demo identity').selectOption('analyst');
    await tab('Assessments');
    await page.getByLabel('Vendor name').fill('Synthetic launch intake');
    await page.getByLabel(/handles sensitive information/i).check();
    await page.getByRole('button',{name:'Add vendor',exact:true}).click();
    const assessment=page.locator('.assessment').filter({hasText:'Mobile-only synthetic assessment'});
    await assessment.getByText('Configuration v1 · Rule sensitive-review',{exact:true}).waitFor();
    await assessment.getByLabel('Summary').fill('Fictional intake summary');
    await assessment.getByLabel('Safeguards').fill('Fictional controls');
    assert.equal(await assessment.getByLabel('Number of regional offices').isVisible(),false);
    await assessment.getByLabel('Is there a regional disclosure?').selectOption('Yes');
    await assessment.getByLabel('Number of regional offices').fill('4');
    await assessment.getByRole('button',{name:'Submit for review'}).click();
    await assessment.getByText('Number of regional offices: 4',{exact:true}).waitFor();
    await page.getByLabel('Demo identity').selectOption('reviewer');
    await assessment.getByRole('button',{name:'Approve assessment'}).click();
    await assessment.getByText('approved',{exact:true}).waitFor();
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});

'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {randomBytes,createHmac}=require('node:crypto');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
const basePolicy='This fictional policy says to document a concern only through approved local channels.';
async function fixture(t,{sqlite=false}={}){
  const root=await mkdtemp(join(tmpdir(),'mvw-training-'));
  let now=Date.now();
  const accounts=[
    ['training-author','alpha','analyst'],['training-review','alpha','reviewer'],
    ['training-case','alpha','case-operator'],['training-other','beta','analyst']
  ];
  const aliases=[['sample-learner-alpha','alpha'],['sample-learner-alpha2','alpha'],['sample-learner-beta','beta']];
  const codes=Object.fromEntries([...accounts,...aliases].map(([id])=>[id,randomBytes(32).toString('base64url')]));
  const key=randomBytes(32).toString('hex');
  const options={...(sqlite?{sqliteFile:join(root,'training.sqlite')}:{}),isolated:{
    root:join(root,'local'),now:()=>now,workspaces:[{id:'alpha',label:'Synthetic A'},{id:'beta',label:'Synthetic B'}],
    accounts:accounts.map(([id,workspace,role])=>({id,codeHash:codeHash(codes[id]),memberships:{[workspace]:role}})),
    trainingGrants:aliases.map(([alias,workspace])=>({alias,workspace,codeHash:codeHash(codes[alias]),expiresAt:now+3600000})),
    trainingSigningKey:key
  }};
  let server,url;
  async function start(){
    server=createServer(options).listen(0,'127.0.0.1');await once(server,'listening');
    url='http://127.0.0.1:'+server.address().port;
  }
  async function stop(){if(server?.listening){server.closeAllConnections();await new Promise(r=>server.close(r));}}
  t.after(async()=>{await stop();await rm(root,{recursive:true,force:true});});
  await start();
  async function request(route,status,{cookie,body,headers={}}={}){
    const response=await fetch(url+'/api/'+route,{method:body===undefined?'GET':'POST',
      headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{Origin:url,'Content-Type':'application/json'}),...headers},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();
    assert.equal(response.status,status,JSON.stringify(data));return {response,data};
  }
  async function login(account,workspace='alpha'){
    const {response}=await request('session/login',200,{body:{account,workspace,code:codes[account]}});
    return response.headers.get('set-cookie').split(';')[0];
  }
  const admin=(action,cookie,body,status=200,workspace='alpha')=>request('training'+(action?'/'+action:'')+'?workspace='+workspace,status,{cookie,body}).then(x=>x.data);
  const learn=(action,alias,fields,status=200)=>request('training-learner/'+action,status,{body:{code:codes[alias],...fields}}).then(x=>x.data);
  async function publishPolicy(author,reviewer,{publish=true}={}){
    const path='governance-documents/records';
    const create=(await request(path+'?workspace=alpha',200,{cookie:author,body:{
      kind:'policy',title:'Fictional training policy',content:basePolicy,links:[],expectedRevision:0
    }})).data;
    const document=create.documents[0],edition=document.revisions[0],route=path+'/'+document.id+'/revisions/'+edition.id;
    if(publish){
      await request(route+'/submit?workspace=alpha',200,{cookie:author,body:{expectedRevision:1}});
      await request(route+'/publish?workspace=alpha',200,{cookie:reviewer,body:{expectedRevision:2,note:'A fictional approval.'}});
    }
    return {document:document.id,edition:edition.id,hash:edition.contentHash,route};
  }
  return {request,login,admin,learn,publishPolicy,codes,key,start,stop, get url(){return url;},expire(){now+=3600000;}};
}
const fields={title:'Fictional policy training',template:'fictional-policy-practice-v1'};
const alpha='sample-learner-alpha', alpha2='sample-learner-alpha2', beta='sample-learner-beta';
test('training: independent review, exact policy pin, isolated seats, bounded attempts and durable signed receipts',async t=>{
  const f=await fixture(t,{sqlite:true});
  const {request,login,admin,learn,publishPolicy}=f;
  const author=await login('training-author'),reviewer=await login('training-review'),operator=await login('training-case'),other=await login('training-other','beta');
  await admin('',null,undefined,401);
  await admin('',operator,undefined,403);
  assert.equal((await admin('',author)).editions.length,0);
  const policy=await publishPolicy(author,reviewer,{publish:false}),{route,...pin}=policy;
  await admin('create',author,{...fields,...pin},404);
  await request(route+'/submit?workspace=alpha',200,{cookie:author,body:{expectedRevision:1}});
  await request(route+'/publish?workspace=alpha',200,{cookie:reviewer,body:{expectedRevision:2,note:'A fictional approval.'}});
  await admin('create',reviewer,{...fields,...pin},403);
  await admin('create',author,{...fields,...pin,hash:'0'.repeat(64)},409);
  await admin('create',other,{...fields,...pin},404,'beta');
  let data=await admin('create',author,{...fields,...pin});
  const id=data.courses[0].id;
  const get=()=>data.courses[0];
  const action=async(name,cookie=author,extra={},status=200)=>{
    const value=await admin(name,cookie,{course:id,revision:get().revision,...extra},status);
    if(status===200)data=value;
    return value;
  };
  await action('assign',author,{learner:alpha},409);
  await action('publish',reviewer,{note:'Cannot publish before submission.'},409);
  await action('submit');
  await action('publish',author,{note:'Cannot self-approve.'},403);
  await action('return',reviewer,{note:'Refine synthetic title and retry.'});
  await action('edit',author,{...fields,...pin,title:'Revised fictional course'});
  await action('submit');
  await action('publish',reviewer,{revision:1,note:'Stale view.'},409);
  await action('publish',reviewer,{note:'Independent fictional review.'});
  assert.equal(get().status,'published');
  await action('edit',author,{...fields,...pin},409);
  await action('assign',author,{learner:beta},404);
  await action('assign',author,{learner:alpha});
  await action('assign',author,{learner:alpha});
  assert.equal(data.assignments.length,1);
  const idA=data.assignments[0].id;
  const empty=await learn('list',alpha2,{});
  assert.deepEqual(empty.assignments,[]);
  await learn('lesson',alpha2,{assignment:idA},404);
  await learn('lesson',beta,{assignment:idA},404);
  await request('training-learner/list?workspace=beta',422,{body:{code:f.codes[alpha]}});
  await request('training-learner/list',401,{body:{code:f.codes['training-review']}});
  await request('training-learner/list',403,{body:{code:f.codes[alpha]},headers:{Origin:'http://localhost:1'}});
  assert.deepEqual((await admin('',other,undefined,200,'beta')).assignments,[]);
  let lesson=(await learn('lesson',alpha,{assignment:idA})).lesson;
  assert.equal(lesson.policy.text,basePolicy);
  assert.equal(lesson.policy.number,1);
  assert.ok(lesson.questions.every(q=>Array.isArray(q.choices)&&!('correct' in q)));
  assert.equal((await learn('list',alpha,{})).assignments[0].questions,undefined);
  const step=async(name,extra={},status=200)=>{
    const value=await learn(name,alpha,{assignment:idA,revision:lesson.revision,...extra},status);
    if(status===200)lesson=value.lesson;
    return value;
  };
  await step('complete',{answers:[1,0,2],confirm:true},409);
  await step('start');
  await step('complete',{answers:[1,9,2],confirm:true},422);
  await step('complete',{answers:[1,0,2],confirm:false},422);
  await step('complete',{revision:1,answers:[1,0,2],confirm:true},409);
  for(let i=0;i<5;i++)await step('complete',{answers:[0,1,0],confirm:true});
  assert.equal(lesson.status,'retry-required');assert.equal(lesson.attemptsRemaining,0);
  await step('complete',{answers:[1,0,2],confirm:true},409);
  await admin('reset',reviewer,{assignment:idA,revision:lesson.revision},403);
  await admin('reset',author,{assignment:idA,revision:lesson.revision});
  lesson=(await learn('lesson',alpha,{assignment:idA})).lesson;
  assert.equal(lesson.status,'in-progress');assert.equal(lesson.attemptsRemaining,5);
  await step('complete',{answers:[1,0,2],confirm:true});
  assert.equal(lesson.status,'completed');assert.equal(lesson.attempts,6);
  const {signature,...signed}=lesson.receipt;
  assert.equal(signature,createHmac('sha256',Buffer.from(f.key,'hex')).update(JSON.stringify({...signed,workspace:'alpha'})).digest('hex'));
  assert.equal(signed.policyHash,pin.hash);
  const final=structuredClone(lesson);
  assert.deepEqual((await step('complete',{answers:[1,0,2],confirm:true})).lesson,final);
  const audit=(await request('audit/export?workspace=alpha',200,{cookie:reviewer})).data.audit;
  assert.equal(audit.filter(x=>x.action==='training.completed').length,1);
  assert.ok(audit.some(x=>x.action==='training.assignment-reset'));
  assert.doesNotMatch(JSON.stringify(audit),new RegExp(f.codes[alpha]));
  assert.doesNotMatch(JSON.stringify((await request('state?workspace=alpha',200,{cookie:author})).data),/Revised fictional course/);
  await f.stop();await f.start();
  assert.deepEqual((await learn('lesson',alpha,{assignment:idA})).lesson,final);
  f.expire();
  await learn('lesson',alpha,{assignment:idA},401);
});
test('browser: isolated author, reviewer and learner complete policy-linked training and download receipt',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 with Playwright installed',timeout:30000
},async t=>{
  const {chromium}=require('playwright');
  const f=await fixture(t);
  const {login,publishPolicy}=f;
  const author=await login('training-author'),reviewer=await login('training-review');
  await publishPolicy(author,reviewer);
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const authorPage=await browser.newPage(),reviewPage=await browser.newPage(),learner=await browser.newPage();
    const errors=[],external=[];
    for(const page of [authorPage,reviewPage,learner]){
      page.setDefaultTimeout(6000);
      page.on('pageerror',e=>errors.push(e.message));
      await page.route('**/*',route=>{
        if(new URL(route.request().url()).origin===f.url)return route.continue();
        external.push(route.request().url());return route.abort();
      });
    }
    const button=(page,name)=>page.getByRole('button',{name,exact:true});
    const shown=(page,value)=>page.getByText(value,{exact:true}).waitFor();
    const open=(page,value)=>page.locator('summary').filter({hasText:value}).click();
    async function operator(page,account){
      await page.goto(f.url);
      await page.getByLabel('Test account',{exact:true}).fill(account);
      await page.getByLabel('Workspace ID',{exact:true}).fill('alpha');
      await page.getByLabel('Local access code',{exact:true}).fill(f.codes[account]);
      await button(page,'Sign in').click();
      await button(page,'Training').click();
    }
    await operator(authorPage,'training-author');
    assert.equal(await authorPage.getByRole('link',{name:'Open synthetic learner portal'}).getAttribute('href'),'/training');
    await open(authorPage,'Draft a training course');
    await authorPage.getByLabel('Fictional course title',{exact:true}).fill(fields.title);
    await button(authorPage,'Create course draft').click();
    await shown(authorPage,'draft');
    await open(authorPage,'Edit course draft');
    await authorPage.locator('details[open]').getByLabel('Fictional course title',{exact:true}).fill('Revised course fixture');
    await button(authorPage,'Save course draft').click();
    await shown(authorPage,'Revised course fixture');
    await button(authorPage,'Submit course for review').click();
    await shown(authorPage,'review');
    await operator(reviewPage,'training-review');
    await open(reviewPage,'Return course to draft');
    await reviewPage.locator('details[open]').getByLabel('Review note',{exact:true}).fill('Fictional correction requested.');
    await button(reviewPage,'Return course to draft').click();
    await shown(reviewPage,'draft');
    await authorPage.reload();await button(authorPage,'Training').click();
    await button(authorPage,'Submit course for review').click();
    await shown(authorPage,'review');
    await reviewPage.reload();await button(reviewPage,'Training').click();
    await open(reviewPage,'Publish training course');
    await reviewPage.locator('details[open]').getByLabel('Review note',{exact:true}).fill('Approved fictional training.');
    await button(reviewPage,'Publish training course').click();
    await shown(reviewPage,'published');
    await authorPage.reload();await button(authorPage,'Training').click();
    await open(authorPage,'Assign course to learner');
    await authorPage.getByLabel('Synthetic learner',{exact:true}).selectOption(alpha);
    await button(authorPage,'Assign course').click();
    await open(authorPage,'Learner progress');
    await shown(authorPage,'sample-learner-alpha · assigned · 0 attempts');
    await Promise.all([authorPage.waitForURL('**/training'),authorPage.getByRole('link',{name:'Open synthetic learner portal'}).click()]);
    await authorPage.getByRole('heading',{name:'My training'}).waitFor();
    await authorPage.goBack();
    await learner.goto(f.url+'/training');
    await learner.getByLabel('Synthetic learner code',{exact:true}).fill(f.codes[alpha]);
    await button(learner,'View my assignments').click();
    await button(learner,'Open Revised course fixture').click();
    await open(learner,'Read assigned policy:');
    await shown(learner,basePolicy);
    await button(learner,'Start exercise').click();
    for(let remaining=5;remaining>=1;remaining--){
      await shown(learner,'Attempts remaining: '+remaining);
      await learner.getByLabel('An unsigned draft',{exact:true}).check();
      await learner.getByLabel('Post it publicly',{exact:true}).check();
      await learner.getByLabel('Ignore the policy',{exact:true}).check();
      await learner.getByLabel('I read the assigned fictional policy edition.',{exact:true}).check();
      await button(learner,'Submit answers').click();
    }
    await shown(learner,'No attempts remain. Ask the local analyst to reset attempts.');
    await authorPage.reload();await button(authorPage,'Training').click();await open(authorPage,'Learner progress');
    await button(authorPage,'Reset exhausted attempts').click();
    await open(authorPage,'Learner progress');
    await shown(authorPage,'sample-learner-alpha · in progress · 5 attempts');
    await button(learner,'Open Revised course fixture').click();
    await shown(learner,'Attempts remaining: 5');
    await learner.getByLabel('The assigned published policy edition',{exact:true}).check();
    await learner.getByLabel('Use the approved process',{exact:true}).check();
    await learner.getByLabel('Ask for review through the approved channels',{exact:true}).check();
    await learner.getByLabel('I read the assigned fictional policy edition.',{exact:true}).check();
    await button(learner,'Submit answers').click();
    await shown(learner,'Training completed.');
    await open(learner,'Completion receipt');
    const [download]=await Promise.all([learner.waitForEvent('download'),button(learner,'Download completion receipt').click()]);
    assert.match(download.suggestedFilename(),/^training-receipt-[a-f0-9-]{36}\.json$/);
    const chunks=[];for await(const chunk of await download.createReadStream())chunks.push(chunk);
    const receipt=JSON.parse(Buffer.concat(chunks).toString());assert.equal(receipt.score,3);assert.equal(receipt.learner,alpha);
    await button(learner,'Clear learner access').click();
    assert.equal(await learner.getByText('Revised course fixture',{exact:true}).count(),0);
    await authorPage.reload();await button(authorPage,'Training').click();await open(authorPage,'Learner progress');
    await shown(authorPage,'sample-learner-alpha · completed · 6 attempts');
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  }finally{await browser.close();}
});

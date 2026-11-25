'use strict';

const assert=require('node:assert/strict');
const {test}=require('node:test');
const {once}=require('node:events');
const {randomBytes}=require('node:crypto');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
const {addDays,kinds,mutate,view}=require('../rights-deadline-policy');
const code=()=>randomBytes(32).toString('base64url');
const rules=()=>Object.fromEntries(kinds.map(kind=>[kind,{basis:'calendar',days:30,extensionDays:0}]));
const fixture=(days=5)=>({...rules(),access:{basis:'business',days,extensionDays:2},deletion:{basis:'calendar',days:9,extensionDays:0}});
const policy='/api/rights/deadline-policy',cases='/api/rights/cases';
const later=days=>addDays(new Date().toISOString(),days,'calendar');
const accounts=()=>[
  {id:'fictional-analysis-seat',code:code(),memberships:{alpha:'analyst',beta:'analyst'}},
  {id:'fictional-review-seat',code:code(),memberships:{alpha:'reviewer'}},
  {id:'fictional-limited-seat',code:code(),memberships:{alpha:'case-operator'}}
];
async function fixtureServer(t,{sqlite=true}={}){
  const seats=accounts(),requester=code(),root=await mkdtemp(join(tmpdir(),'mvw-rights-policy-'));
  const options={...(sqlite?{sqliteFile:join(root,'state.sqlite')}:{}),isolated:{root:join(root,'isolation'),
    workspaces:[{id:'alpha',label:'Fictional Alpha'},{id:'beta',label:'Fictional Beta'}],
    accounts:seats.map(({id,code:loginCode,memberships})=>({id,memberships,codeHash:codeHash(loginCode)})),
    requesterGrants:[{id:'fictional-requester',workspace:'alpha',alias:'sample-deadline',codeHash:codeHash(requester),expiresAt:Date.now()+1e7}]}};
  async function start(){
    const server=createServer(options).listen(0,'127.0.0.1');await once(server,'listening');
    return {url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
  }
  let live=await start();
  t.after(async()=>{await live.close();await rm(root,{recursive:true,force:true});});
  const call=async(path,status,{body,cookie,workspace,origin}={})=>{
    const response=await fetch(live.url+path+(workspace?'?workspace='+workspace:''),{
      ...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),
      headers:{...(body===undefined?{}:{'Content-Type':'application/json',Origin:origin??live.url}),...(cookie?{Cookie:cookie}:{})}
    });
    const data=await response.json();
    assert.equal(response.status,status,JSON.stringify(data));
    return {data,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const login=async(index,workspace='alpha')=>
    (await call('/api/session/login',200,{body:{account:seats[index].id,code:seats[index].code,workspace}})).cookie;
  return {get url(){return live.url;},seats,requester,call,login,restart:async()=>{await live.close();live=await start();}};
}
test('deterministic UTC calendars cross weekends, fictional closures, year and leap boundaries',()=>{
  const start='2032-01-02T23:59:59.999Z';
  assert.equal(addDays(start,2,'business',['2032-01-05']),'2032-01-07');
  assert.equal(addDays(start,2,'calendar',['2032-01-04']),'2032-01-04');
  assert.equal(addDays('2032-02-28T00:15:00.000Z',1,'calendar'),'2032-02-29');
  assert.equal(addDays('2031-12-30T00:00:00.000Z',2,'business',['2032-01-01']),'2032-01-02');
  assert.equal(addDays('2032-01-03T00:00:00.000Z',1,'business'),'2032-01-05');
});
test('separation uses account identity in addition to the acting role',()=>{
  const state={},event=()=>{};
  mutate(state,'analyst','same-account','draft',{expectedRevision:0,rules:fixture(),closedDates:[]},event);
  mutate(state,'analyst','same-account','submit',{expectedRevision:1},event);
  assert.throws(()=>mutate(state,'reviewer','same-account','publish',{expectedRevision:2},event),{code:'INDEPENDENT_POLICY_REVIEW'});
  assert.equal(view(state,'same-account').activeVersion,1);
});
test('HTTP/SQLite preserves pinned staff and portal deadlines across independently reviewed changes',async t=>{
  const live=await fixtureServer(t);
  const [a,r,o,b]=await Promise.all([live.login(0),live.login(1),live.login(2),live.login(0,'beta')]);
  const req=(path,status,cookie,body,workspace='alpha')=>live.call(path,status,{cookie,body,workspace}).then(x=>x.data);
  await req(policy,401);
  await req(policy,403,o);
  await req(policy,403,a,undefined,'beta');
  await req(policy+'/draft',403,r,{});
  await req(policy+'/publish',403,a,{});
  await live.call(policy+'/draft',403,{cookie:a,workspace:'alpha',body:{},origin:'https://example.invalid'});
  const before=(await req(cases,200,a,{kind:'access',owner:'analyst',days:7,note:'Original fictional case'})).cases[0];
  assert.deepEqual(before.clockPolicy,{version:1,days:7,unit:'UTC calendar days'});
  await req(policy+'/draft',422,a,{expectedRevision:0,rules:fixture(),closedDates:['2031-02-29']});
  await req(policy+'/draft',422,a,{expectedRevision:0,rules:fixture(),closedDates:['2032-03-01','2032-03-01']});
  await req(policy+'/draft',422,a,{expectedRevision:0,rules:{...rules(),access:{basis:'local',days:3,extensionDays:0}},closedDates:[]});
  await req(policy+'/draft',422,a,{expectedRevision:0,rules:rules(),closedDates:[],freeText:'rejected'});
  const closures=[later(1),later(2)];
  assert.equal((await req(policy+'/draft',200,a,{expectedRevision:0,rules:fixture(),closedDates:closures})).draft.ownDraft,true);
  await req(policy+'/publish',409,r,{expectedRevision:1});
  await req(policy+'/submit',409,a,{expectedRevision:0});
  await req(policy+'/submit',200,a,{expectedRevision:1});
  await req(policy+'/draft',409,a,{expectedRevision:2,rules:fixture(),closedDates:[]});
  assert.equal((await req(policy,200,r)).draft.ownDraft,false);
  assert.equal((await req(policy+'/return',200,r,{expectedRevision:2})).draft.status,'draft');
  await req(policy+'/submit',200,a,{expectedRevision:3});
  const policyTwo=await req(policy+'/publish',200,r,{expectedRevision:4});
  assert.equal(policyTwo.activeVersion,2);
  assert.equal(policyTwo.draft,null);
  assert.doesNotMatch(JSON.stringify(policyTwo),/fictional-analysis-seat|fictional-review-seat/);
  assert.equal((await req(policy,200,b,undefined,'beta')).activeVersion,1);
  await req(cases,409,a,{kind:'access',owner:'analyst',days:1,note:'Cannot override'});
  const ownerCase=(await req(cases,200,a,{kind:'access',owner:'case-operator',note:'Delegated fictional case'})).cases.at(-1);
  const extension=cases+'/'+ownerCase.id;
  const original=addDays(ownerCase.receivedAt,5,'business',closures);
  assert.equal(ownerCase.originalDueDate,original);
  assert.equal(ownerCase.dueDate,original);
  assert.equal(ownerCase.clockPolicy.version,2);
  await req(cases+'/'+before.id+'/request-extension',404,o,{expectedRevision:1,reason:'fixture-volume'});
  await req(extension+'/request-extension',403,a,{expectedRevision:1,reason:'fixture-volume'});
  await req(extension+'/request-extension',422,o,{expectedRevision:1,reason:'unbounded text'});
  const requested=(await req(extension+'/request-extension',200,o,{expectedRevision:1,reason:'fixture-volume'})).cases[0];
  const extended=addDays(original,2,'business',closures);
  assert.equal(requested.extensionRequests[0].proposedDueDate,extended);
  assert.equal(requested.dueDate,original);
  assert.equal(requested.extensionRequester,undefined);
  await req(extension+'/approve-extension',403,a,{expectedRevision:2});
  await req(extension+'/approve-extension',409,r,{expectedRevision:1});
  await req(extension+'/reject-extension',200,r,{expectedRevision:2});
  await req(extension+'/request-extension',200,o,{expectedRevision:3,reason:'fixture-complexity'});
  await req(extension+'/verify',200,r,{expectedRevision:4,note:'Synthetic verified'});
  await req(extension+'/begin',200,o,{expectedRevision:5,note:'Synthetic fulfillment started'});
  await req(extension+'/fulfill',409,o,{expectedRevision:6,note:'Must decide the pending extension'});
  const queued=await req('/api/work-queue',200,r);
  assert.equal(queued.mode,'local-isolated');
  const actions=queued.tasks.filter(task=>task.sourceId===ownerCase.id);
  assert.deepEqual(actions.map(({action,owner,dueDate})=>({action,owner,dueDate})),
    [{action:'review-extension',owner:'reviewer',dueDate:original}]);
  const personal=await req('/api/my-work',200,r);
  const task=personal.tasks.find(item=>item.actionLabel==='Review deadline extension');
  assert.deepEqual((await req('/api/my-work/tasks/'+task.key,200,r)).destination,{view:'rights',recordId:ownerCase.id});
  assert.equal((await req('/api/my-work',200,o)).tasks.some(item=>item.actionLabel==='Document mock fulfillment'),false);
  const approved=(await req(extension+'/approve-extension',200,r,{expectedRevision:6})).cases.find(x=>x.id===ownerCase.id);
  assert.equal(approved.dueDate,extended);
  assert.equal((await req('/api/my-work',200,o)).tasks.some(item=>item.actionLabel==='Document mock fulfillment'),true);
  await req('/api/my-work/tasks/'+task.key,404,r);
  await req(extension+'/request-extension',409,o,{expectedRevision:7,reason:'fixture-volume'});
  await req(extension+'/fulfill',200,o,{expectedRevision:7,note:'Synthetic closed'});
  await req(policy+'/draft',200,a,{expectedRevision:5,rules:fixture(17),closedDates:[]});
  await req(policy+'/submit',200,a,{expectedRevision:6});
  assert.equal((await req(policy+'/publish',200,r,{expectedRevision:7})).activeVersion,3);
  const receipt=(await live.call('/api/requester/intake',200,{body:{code:live.requester,kind:'deletion'}})).data;
  assert.doesNotMatch(JSON.stringify(receipt),/due|policy|extension/i);
  const rows=(await req(cases,200,r)).cases;
  const portal=rows.find(x=>x.source==='synthetic-portal');
  assert.equal(portal.clockPolicy.version,3);
  assert.equal(portal.dueDate,addDays(portal.receivedAt,9,'calendar'));
  assert.equal(rows.find(x=>x.id===before.id).dueDate,before.dueDate);
  assert.equal(rows.find(x=>x.id===ownerCase.id).dueDate,extended);
  await live.restart();
  const r2=await live.login(1);
  assert.deepEqual((await req(cases,200,r2)).cases,rows);
  const saved=await req(policy,200,r2);
  assert.deepEqual(saved.versions.map(x=>x.version),[1,2,3]);
  const audit=(await req('/api/audit/export',200,r2)).audit;
  assert.equal(audit.filter(x=>x.action==='rights.deadline-policy.publish').length,2);
  assert.equal(audit.filter(x=>x.action==='rights.case.approve-extension')[0].details.dueDate,extended);
  assert.doesNotMatch(JSON.stringify(audit),/unbounded text|freeText/);
});
test('browser: analyst and reviewer configure and publish policy, then resolve an extension',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 with Playwright installed',timeout:30000,
},async t=>{
  const live=await fixtureServer(t,{sqlite:false});
  const {chromium}=require('playwright');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const a=await browser.newPage({viewport:{width:390,height:844}}),r=await browser.newPage();
    const errors=[];
    async function navigate(page,name){
      const tab=page.getByRole('button',{name,exact:true});
      await page.locator('#workbench').waitFor();
      if(!await tab.isVisible())await page.getByText('Browse workspace',{exact:true}).click();
      await tab.click();
    }
    async function login(page,seat){
      page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));
      await page.goto(live.url);
      await page.getByLabel('Test account').fill(seat.id);
      await page.getByLabel('Workspace ID').fill('alpha');
      await page.getByLabel('Local access code').fill(seat.code);
      const [response]=await Promise.all([
        page.waitForResponse(response=>new URL(response.url()).pathname==='/api/session/login'),
        page.getByRole('button',{name:'Sign in'}).click()
      ]);
      assert.equal(response.status(),200);
      await navigate(page,'Privacy rights');
      await page.getByText('View or configure deadline rules').click();

    }
    await login(a,live.seats[0]);await login(r,live.seats[1]);
    await a.getByLabel('Access calendar').selectOption('business');
    await a.getByLabel('Access deadline days').fill('4');
    await a.getByLabel('Access extension days').fill('3');
    await a.getByLabel('Fictional closed dates').fill(later(1));
    await a.getByRole('button',{name:'Save deadline draft'}).click();
    await a.getByText('Version 2 is a draft.').waitFor();
    await a.getByRole('button',{name:'Submit deadline policy for review'}).click();
    await a.getByText('Version 2 is awaiting independent publication.').waitFor();
    await r.getByText('View or configure deadline rules').click();
    await r.getByText('View or configure deadline rules').click();
    await r.getByRole('button',{name:'Return deadline policy'}).click();
    await r.getByText('Version 2 is a draft.').waitFor();
    await a.getByText('View or configure deadline rules').click();
    await a.getByText('View or configure deadline rules').click();
    await a.getByRole('button',{name:'Submit deadline policy for review'}).click();
    await a.getByText('Version 2 is awaiting independent publication.').waitFor();
    await r.getByText('View or configure deadline rules').click();
    await r.getByText('View or configure deadline rules').click();
    await r.getByRole('button',{name:'Publish deadline policy'}).click();
    await r.getByText('Active version: v2').waitFor();
    await r.getByText('Published versions (2)').click();
    await r.getByText('Published v2').click();
    await r.getByText('Closed dates: '+later(1)).waitFor();
    await navigate(a,'Work queue');
    await navigate(a,'Privacy rights');
    assert.equal(await a.getByLabel('Days to respond').count(),0);
    await a.getByLabel('Fictional intake note').fill('Browser-only fictional case');
    await a.getByRole('button',{name:'Open rights case'}).click();
    await a.getByText(/Pinned rules: v2 · 4 UTC business days/).waitFor();
    const request=async()=>{
      await a.getByText('Request deadline extension').click();
      await a.getByLabel('Fictional extension reason').selectOption('fixture-volume');
      await a.getByRole('button',{name:'Submit extension request'}).click();
      await a.getByText(/Extension requests/).waitFor();
    };
    const decide=async caption=>{
      await navigate(r,'Work queue');
      await r.getByRole('button',{name:'Open record: access request · Review deadline extension'}).click();
      await r.getByRole('button',{name:caption}).click();
      await r.getByText('Privacy rights case updated.').waitFor();
    };
    await request();
    const [analyst,reviewer]=await Promise.all([live.login(0),live.login(1)]);
    const {data}=await live.call(cases,200,{cookie:reviewer,workspace:'alpha'});
    const row=data.cases.find(item=>item.summary==='Browser-only fictional case');
    await live.call(cases+'/'+row.id+'/verify',200,{cookie:reviewer,workspace:'alpha',
      body:{expectedRevision:row.revision,note:'Fictional identity verified'}});
    await live.call(cases+'/'+row.id+'/begin',200,{cookie:analyst,workspace:'alpha',
      body:{expectedRevision:row.revision+1,note:'Fictional fulfillment started'}});
    await navigate(a,'Work queue');
    await navigate(a,'Privacy rights');
    await a.getByText('Closure is available after independent review of the deadline extension.').waitFor();
    assert.equal(await a.getByText('Document mock fulfillment',{exact:true}).count(),0);
    await decide('Reject deadline extension');
    await navigate(a,'Work queue');
    await navigate(a,'Privacy rights');
    await request();
    await decide('Approve deadline extension');
    await r.getByText('Extension requests (2)').click();
    await r.getByText(/Fictional workload volume · approved/).waitFor();
    assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth),390);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

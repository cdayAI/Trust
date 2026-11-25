'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {randomBytes,randomUUID}=require('node:crypto');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');

const source='Fictional published procedure text.';
const fileText='Fictional attachment restricted separately.';
const names={author:'sample-author',reviewer:'sample-review',admin:'sample-admin',operator:'sample-operator'};
const browserEnabled=process.env.RUN_BROWSER_SMOKE==='1';
async function setup(t,{sqlite=false}={}){
  const root=await mkdtemp(join(tmpdir(),'mvw-doc-scope-')),secret={};
  let server,url,docRev=0,now=Date.now();
  const options={
    sqliteFile:sqlite?join(root,'test.sqlite'):undefined,
    isolated:{root:join(root,'sessions'),enableIdentityAdmin:true,documentScopeWorkspaces:['alpha'],now:()=>now,
      workspaces:['alpha','beta'].map(id=>({id,label:'Sample '+id})),
      accounts:Object.entries({author:'analyst',reviewer:'reviewer',admin:'identity-admin',operator:'case-operator'}).map(([seat,role])=>{
        const code=secret[seat]=randomBytes(32).toString('base64url');
        return {id:names[seat],codeHash:codeHash(code),memberships:{alpha:role,beta:role}};
      })}
  };
  async function stop(){
    if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  }
  async function start(){
    server=createServer(options).listen(0,'127.0.0.1');await once(server,'listening');
    url='http://127.0.0.1:'+server.address().port;
  }
  t.after(async()=>{await stop();await rm(root,{recursive:true,force:true});});
  await start();
  async function call(route,status,{token,workspace='alpha',body,origin=url}={}){
    const response=await fetch(url+'/api/'+route+(workspace===null?'':'?workspace='+workspace),{
      method:body===undefined?'GET':'POST',headers:{
        'X-Demo-Actor':'reviewer',...(token?{Cookie:token}:{}),
        ...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'})
      },body:body===undefined?undefined:JSON.stringify(body)
    });
    const data=response.headers.get('content-type')==='application/octet-stream'?Buffer.from(await response.arrayBuffer()):await response.json();
    if(status!==null)assert.equal(response.status,status,route+' '+JSON.stringify(data));
    return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
  }
  async function login(seat,workspace='alpha'){
    const result=await call('session/login',200,{workspace:null,body:{account:names[seat],code:secret[seat],workspace}});
    return result.cookie;
  }
  function board(token,status=200,workspace='alpha'){return call('document-access',status,{token,workspace});}
  function action(token,operation,expectedRevision,fields,status=200){
    return call('document-access',status,{token,body:{operation,expectedRevision,reason:'operational-need',...fields}});
  }
  function catalog(token,workspace='alpha'){return call('governance-documents',200,{token,workspace});}
  async function create(author,reviewer,title='Fictional Scope Policy',{attachment=true,parent=null,kind='policy',links=[]}={}){
    const {data:created}=await call(parent?'governance-documents/records/'+parent+'/revise':'governance-documents/records',200,{token:author,
      body:{...(parent?{}:{kind}),title,content:source+' '+title,links,expectedRevision:docRev++}});
    const doc=created.documents.find(d=>d.revisions.at(-1).title===title);
    const edition=doc.revisions.at(-1).id,root='governance-documents/records/'+doc.id+'/revisions/'+edition;
    let attachmentId;
    if(attachment){
      const {data:uploaded}=await call(root+'/attachments',200,{token:author,body:{
        filename:'fictional-attachment.txt',mediaType:'text/plain',data:Buffer.from(fileText).toString('base64'),expectedRevision:docRev++
      }});
      attachmentId=uploaded.documents.find(d=>d.id===doc.id).revisions.find(r=>r.id===edition).attachments[0].id;
    }
    await call(root+'/submit',200,{token:author,body:{expectedRevision:docRev++}});
    await call(root+'/publish',200,{token:reviewer,body:{expectedRevision:docRev++,note:'Confirmed synthetic fixture.'}});
    return {document:doc.id,edition,root,title,attachment:attachmentId?root+'/attachments/'+attachmentId+'/download':null};
  }
  return {options,secret,call,login,board,action,catalog,create,moveClock:ms=>{now+=ms;},get url(){return url;},
    async restart(){await stop();await start();}};
}
const requestGrant=(f,token,revision,d,level='text',status=200)=>f.action(token,'propose',revision,
  {account:names.operator,document:d.document,edition:d.edition,level},status);
const operatorList=async(f,token,workspace)=> (await f.catalog(token,workspace)).data.documents;

test('document-edition ACL denies record discovery, direct reads and attachments until exact approvals, audits lifecycle',async t=>{
  const f=await setup(t);
  const [author,reviewer,admin,operator,south]=await Promise.all([
    f.login('author'),f.login('reviewer'),f.login('admin'),f.login('operator'),f.login('operator','beta')
  ]);
  const first=await f.create(author,reviewer),second=await f.create(author,reviewer,'Fictional hidden next edition',{parent:first.document});
  await f.board(undefined,401);await f.board(author,403);await f.board(operator,403);await f.board(admin,403,'beta');
  assert.deepEqual(await operatorList(f,operator),[]);
  assert.deepEqual(await operatorList(f,south,'beta'),[]);
  const absent=await f.call(first.root.replace(first.edition,randomUUID())+'/read',404,{token:operator,body:{}});
  const denied=await f.call(first.root+'/read',404,{token:operator,body:{}});
  assert.deepEqual(denied.data,absent.data);
  await f.call(first.root+'/download',404,{token:operator,body:{}});
  await f.call(first.attachment,404,{token:operator,body:{}});
  await f.call(first.root+'/read',403,{token:south,body:{}});
  await f.call('audit/export',403,{token:operator});
  await f.call('reporting/export',403,{token:operator});
  assert.doesNotMatch(JSON.stringify((await f.call('state',200,{token:operator})).data),/Fictional Scope|documentAccessScope/);
  await f.call(first.root+'/read',403,{token:operator,origin:'http://localhost:4',body:{}});
  await requestGrant(f,admin,0,first,'text',403);
  const proposed=await requestGrant(f,reviewer,0,first),grant=proposed.data.grants[0].id;
  assert.equal(proposed.data.grants[0].title,first.title);
  const adminBoard=(await f.board(admin)).data;
  assert.doesNotMatch(JSON.stringify(adminBoard),/Fictional Scope Policy|fictional-attachment\.txt|binding|sha256/);
  await f.action(reviewer,'approve',1,{grant},403);
  assert.deepEqual(await operatorList(f,operator),[]);
  const decisions=await Promise.all([f.action(admin,'approve',1,{grant},null),f.action(admin,'approve',1,{grant},null)]);
  assert.deepEqual(decisions.map(d=>d.status).sort(),[200,409]);
  const visible=await operatorList(f,operator);
  assert.deepEqual(visible.map(d=>d.revisions.map(r=>r.id)),[[first.edition]]);
  assert.equal(visible[0].currentRevisionId,first.edition);
  assert.deepEqual(visible[0].revisions[0].attachments,[]);
  assert.equal(visible[0].revisions[0].reviewNote,undefined);
  assert.deepEqual(visible[0].revisions[0].links,[]);
  assert.doesNotMatch(JSON.stringify(visible),/hidden next edition/);
  assert.equal((await f.call(first.root+'/read',200,{token:operator,body:{}})).data.text,source+' '+first.title);
  const dl=await f.call(first.root+'/download',200,{token:operator,body:{}});
  assert.equal(dl.data.filename,'synthetic-policy-v1.txt');assert.deepEqual(dl.data.version.attachments,[]);
  await f.call(first.attachment,404,{token:operator,body:{}});
  await f.call(second.root+'/read',404,{token:operator,body:{}});
  await f.action(admin,'revoke',2,{grant});
  await f.call(first.root+'/read',404,{token:operator,body:{}});
  await requestGrant(f,reviewer,3,first,'text-and-attachments');
  const armed=(await f.board(admin)).data.grants[0].id;
  await f.action(admin,'approve',4,{grant:armed});
  const file=await f.call(first.attachment,200,{token:operator,body:{}});
  assert.equal(file.data.toString(),fileText);
  assert.match(file.headers.get('content-security-policy'),/^sandbox/);
  assert.deepEqual((await f.board(reviewer)).data.audit.map(x=>x.action),['approve','propose','revoke','approve','propose']);
  const audit=(await f.call('audit/export',200,{token:reviewer})).data.audit;
  assert.equal(audit.filter(e=>e.action==='governance-documents.read'&&e.account===names.operator).length,1);
  assert.equal(audit.filter(e=>e.action==='document-scope.approve'&&e.account===names.admin).length,2);
});
for(const sqlite of [false,true])test(`scoped records and durable fail-closed marker survive ${sqlite?'SQLite':'JSON'} restart and provisioning removal`,async t=>{
  const f=await setup(t,{sqlite});
  let a=await f.login('author'),r=await f.login('reviewer'),m=await f.login('admin'),o=await f.login('operator');
  const d=await f.create(a,r);
  const request=(await requestGrant(f,r,0,d)).data.grants[0].id;
  await f.action(m,'approve',1,{grant:request});
  await f.restart();
  await f.call(d.root+'/read',401,{token:o,body:{}});
  o=await f.login('operator');r=await f.login('reviewer');m=await f.login('admin');
  assert.equal((await operatorList(f,o)).length,1);
  await f.call('identity-admin',200,{token:m,body:{target:names.operator,operation:'revoke',reason:'session-reset',expectedRevision:0}});
  await f.call(d.root+'/read',401,{token:o,body:{}});
  o=await f.login('operator');
  assert.equal((await operatorList(f,o)).length,0);
  assert.equal((await f.board(m)).data.grants[0].status,'stale');
  const updated=await requestGrant(f,r,2,d);
  await f.action(m,'approve',3,{grant:updated.data.grants[0].id});
  assert.equal((await operatorList(f,o)).length,1);
  f.moveClock(31*86400000);
  o=await f.login('operator');
  assert.deepEqual(await operatorList(f,o),[]);
  delete f.options.isolated.documentScopeWorkspaces;
  await f.restart();
  o=await f.login('operator');a=await f.login('author');m=await f.login('admin');
  assert.deepEqual(await operatorList(f,o),[]);
  await f.call(d.root+'/read',404,{token:o,body:{}});
  await f.board(m,404);
  assert.equal((await f.catalog(a)).data.documents.length,1);
});
test('published evidence adds current assigned rights owner and requires fresh grant after reassignment',async t=>{
  const f=await setup(t);
  const a=await f.login('author'),r=await f.login('reviewer'),m=await f.login('admin'),o=await f.login('operator');
  const created=await f.call('rights/cases',200,{token:a,body:{kind:'access',owner:'analyst',days:30,note:'Fictional request fixture.'}});
  const c=created.data.cases.at(-1);
  const move=(owner,expectedRevision)=>f.call('rights/cases/'+c.id+'/assign',200,{token:a,body:{owner,expectedRevision,note:'Fictional assignment.'}});
  await move('case-operator',c.revision);
  const ed=await f.create(a,r,'Fictional Evidence',{kind:'evidence',links:[{type:'rights-case',id:c.id}]});
  const pending=(await requestGrant(f,r,0,ed)).data.grants[0].id;
  await f.action(m,'approve',1,{grant:pending});
  await f.call(ed.root+'/read',200,{token:o,body:{}});
  await move('analyst',c.revision+1);
  await f.call(ed.root+'/read',404,{token:o,body:{}});
  await move('case-operator',c.revision+2);
  await f.call(ed.root+'/read',404,{token:o,body:{}});
  assert.equal((await f.board(m)).data.grants[0].status,'stale');
});
test('Chromium: reviewer requests exact edition, administrator approves, and signed-in operator reads only that record',{
  skip:!browserEnabled&&'Set RUN_BROWSER_SMOKE=1 and browser tools',timeout:30000
},async t=>{
  const {chromium}=require('playwright');
  const f=await setup(t),d=await f.create(await f.login('author'),await f.login('reviewer'));
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    async function pageFor(seat){
      const page=await browser.newPage();page.setDefaultTimeout(6500);await page.goto(f.url);
      await page.getByLabel('Test account').fill(names[seat]);await page.getByLabel('Workspace ID').fill('alpha');
      await page.getByLabel('Local access code').fill(f.secret[seat]);await page.getByRole('button',{name:'Sign in',exact:true}).click();
      return page;
    }
    const operator=await pageFor('operator');
    await operator.getByRole('button',{name:'Policies and documents',exact:true}).click();
    await operator.getByText(/No documents are visible/).waitFor();
    const reviewer=await pageFor('reviewer');await reviewer.getByRole('button',{name:'Document access',exact:true}).click();
    await reviewer.getByLabel('Case operator').selectOption(names.operator);
    await reviewer.getByLabel('Published edition').selectOption(d.edition);
    await reviewer.getByLabel('Access level').selectOption('text');
    await reviewer.getByLabel('Decision reason').selectOption('operational-need');
    await reviewer.getByRole('button',{name:'Request document access',exact:true}).click();
    await reviewer.getByText('Document access request recorded.',{exact:true}).waitFor();
    const admin=await pageFor('admin');await admin.getByRole('button',{name:'Document access',exact:true}).click();
    assert.equal(await admin.getByText(d.title,{exact:true}).count(),0);
    await admin.locator('summary').filter({hasText:'Approve access'}).click();
    const form=admin.getByRole('form',{name:'Approve access',exact:true});
    await form.getByLabel('Decision reason').selectOption('scope-review');await form.getByRole('checkbox').check();
    await form.getByRole('button',{name:'Approve access',exact:true}).click();
    await admin.getByText('Approve access decision recorded.',{exact:true}).waitFor();
    await operator.getByRole('button',{name:'Policies and documents',exact:true}).click();
    await operator.getByRole('heading',{name:d.title,exact:true}).waitFor();
    await operator.getByRole('button',{name:'View fictional text',exact:true}).click();
    await operator.getByText(source+' '+d.title,{exact:true}).waitFor();
    assert.equal(await operator.getByRole('button',{name:/Download attachment/}).count(),0);
  }finally{await browser.close();}
});

test('Chromium: reject document access, approve a replacement with attachments, then revoke an open operator view',{
  skip:!browserEnabled&&'Set RUN_BROWSER_SMOKE=1 and browser tools',timeout:40_000
},async t=>{
  const {chromium}=require('playwright');
  const f=await setup(t),author=await f.login('author'),review=await f.login('reviewer');
  const doc=await f.create(author,review,'Fictional document with revoked access');
  const later=await f.create(author,review,'Fictional second edition stays restricted',{parent:doc.document});
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  const errors=[],outside=[],actions=[],observed=[];
  t.after(()=>browser.close());
  const b=(scope,name)=>scope.getByRole('button',{name,exact:true});
  const h=(scope,name)=>scope.getByRole('heading',{name,exact:true});
  const see=(scope,text)=>scope.getByText(text,{exact:true}).waitFor();
  const check=async(scope,name,outcome,witness)=>{
    await b(scope,name).click();await witness();actions.push({control:name,outcome});
  };
  const select=async(scope,name,value)=>{
    const field=scope.getByLabel(name);
    await field.selectOption(value);assert.equal(await field.inputValue(),value);
    actions.push({control:name,outcome:'Selected '+value});
  };
  async function pageFor(seat){
    const p=await browser.newPage({acceptDownloads:true});
    p.setDefaultTimeout(7000);p.on('pageerror',e=>errors.push(e.message));
    await p.route('**/*',route=>{
      if(new URL(route.request().url()).origin===f.url)return route.continue();
      outside.push(route.request().url());return route.abort();
    });
    await p.goto(f.url);
    await p.getByLabel('Test account').fill(names[seat]);
    await p.getByLabel('Workspace ID').fill('alpha');
    await p.getByLabel('Local access code').fill(f.secret[seat]);
    await b(p,'Sign in').click();
    return p;
  }
  const reviewer=await pageFor('reviewer'),admin=await pageFor('admin'),operator=await pageFor('operator');
  const reviewerBoard=reviewer.locator('#document-access-view'),adminBoard=admin.locator('#document-access-view'),documents=operator.locator('#governance-docs-view');
  const name='Policies and documents',feature='Document access';
  const empty=()=>documents.getByText(/No documents are visible/).waitFor();
  await check(operator,name,'Operator starts with no published scope',empty);
  await check(reviewer,feature,'Reviewer can see published edition candidates',()=>reviewerBoard.getByLabel('Published edition').waitFor());
  async function propose(){
    await select(reviewerBoard,'Case operator',names.operator);
    await select(reviewerBoard,'Published edition',doc.edition);
    await select(reviewerBoard,'Access level','text-and-attachments');
    await select(reviewerBoard,'Decision reason','operational-need');
    await check(reviewerBoard,'Request document access','Exact edition proposed with explicit attachment scope',()=>{
      const pending=reviewerBoard.locator('article').filter({has:reviewer.getByText('pending',{exact:true})});
      return h(pending,doc.title).waitFor();
    });
  }
  async function adminRefresh(text){
    await admin.reload();
    await check(admin,feature,'Identity administrator sees live access decisions',()=>see(adminBoard,text));
    const safeProjection=await adminBoard.innerText();
    for(const text of [doc.title,later.title,source,fileText,'fictional-attachment.txt']){
      assert.equal(safeProjection.includes(text),false);
      observed.push({control:'Administrator content projection',outcome:'Sensitive fixture label/text/file omitted'});
    }
  }
  async function decide(current,caption,reason,result){
    const grant=adminBoard.locator('article').filter({has:admin.getByText(current,{exact:true})});
    await grant.locator('summary').filter({hasText:new RegExp('^'+caption+'$')}).click();
    actions.push({control:caption+' disclosure',outcome:'Decision form visible'});
    const form=grant.getByRole('form',{name:caption,exact:true});
    await select(form,'Decision reason',reason);
    const box=form.getByRole('checkbox');
    if(caption==='Reject request'){
      await check(form,caption,'Missing confirmation does not record a decision',async()=>{
        assert.equal(await box.evaluate(x=>x.validity.valueMissing),true);
        await see(grant,current);
      });
    }
    await box.check();assert.equal(await box.isChecked(),true);
    actions.push({control:caption+' confirmation',outcome:'Checked explicit edition confirmation'});
    await check(form,caption,'Exact grant moved to '+result,()=>see(adminBoard,result));
    assert.match(await admin.evaluate(()=>document.activeElement.id),/^document-grant-/);
  }
  await propose();
  await adminRefresh('pending');
  await decide('pending','Reject request','scope-review','rejected');
  await check(operator,name,'Rejected request does not grant access',empty);
  await reviewer.reload();
  await check(reviewer,feature,'Reviewer sees rejection before submitting a new request',()=>see(reviewerBoard,'rejected'));
  await propose();
  await adminRefresh('pending');
  await decide('pending','Approve access','scope-review','approved');
  await check(operator,name,'Operator sees only the approved exact older edition',()=>h(documents,doc.title).waitFor());
  assert.equal(await h(documents,later.title).count(),0);
  observed.push({control:'Later edition',outcome:'Not visible under the earlier edition grant'});
  const downloadName='Download attachment fictional-attachment.txt';
  const [file]=await Promise.all([operator.waitForEvent('download'),b(documents,downloadName).click()]);
  assert.equal(file.suggestedFilename(),'fictional-attachment.txt');
  const parts=[];for await(const part of await file.createReadStream())parts.push(part);
  assert.equal(Buffer.concat(parts).toString(),fileText);
  actions.push({control:downloadName,outcome:'Exact fictional attachment bytes returned after approval'});
  await see(operator,'Attachment download recorded.');
  await decide('approved','Revoke access','assignment-ended','revoked');
  // A legitimately opened, now stale screen must not fetch or download any new bytes.
  const downloads=[];operator.on('download',f=>downloads.push(f.suggestedFilename()));
  async function staleClick(control,ending,outcome){
    const response=operator.waitForResponse(r=>new URL(r.url()).pathname.endsWith(ending)&&r.request().method()==='POST');
    await check(documents,control,outcome,async()=>{
      assert.equal((await response).status(),404);
      await see(operator,'That document revision was not found.');
    });
  }
  await staleClick(downloadName,'/download','A stale card now refuses any additional download');
  await staleClick('View fictional text','/read','The stale card also refuses a new content read');
  assert.deepEqual(downloads,[]);
  assert.equal(await documents.getByText(source+' '+doc.title,{exact:true}).count(),0);
  await operator.reload();
  await check(operator,name,'Refreshed operator catalog persists the revocation',empty);
  assert.equal(await b(documents,downloadName).count(),0);
  const audit=(await f.board(review)).data.audit.map(x=>x.action);
  assert.deepEqual(audit,['revoke','approve','propose','reject','propose']);
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  t.diagnostic(JSON.stringify({activated:actions.length,observedOnly:observed.length,actions,observed}));
});

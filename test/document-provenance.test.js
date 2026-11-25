'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {mkdtemp,rm,readFile,writeFile}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {randomBytes}=require('node:crypto');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
const provenance=require('../document-provenance');
const chrome=process.env.RUN_BROWSER_SMOKE==='1';
async function setup(t){
  const root=await mkdtemp(join(tmpdir(),'mvw-doc-provenance-')),workspace='north';
  const codes=Object.fromEntries(['sample-alice','sample-bob','sample-carol'].map(account=>[account,randomBytes(32).toString('base64url')]));
  const isolated={root:join(root,'workspace'),workspaces:[{id:workspace,label:'Fictional North'}],accounts:[]};
  const stateFile=join(isolated.root,workspace,'state.json');
  let server,url,revision=0;
  async function stop(){if(server?.listening){server.closeAllConnections();await new Promise(res=>server.close(res));}}
  function roles(assignments){
    isolated.accounts=Object.entries(assignments).map(([id,role])=>({id,memberships:{[workspace]:role},codeHash:codeHash(codes[id])}));
  }
  async function start(){
    server=createServer({isolated}).listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+server.address().port;
  }
  roles({'sample-alice':'analyst','sample-bob':'reviewer','sample-carol':'case-operator'});
  t.after(async()=>{await stop();await rm(root,{recursive:true,force:true});});await start();
  async function api(route,expected,{token,body,space=workspace}={}){
    const response=await fetch(url+'/api/'+route+(space===null?'':'?workspace='+space),{method:body===undefined?'GET':'POST',
      headers:{'X-Demo-Actor':'reviewer',...(token?{Cookie:token}:{}),...(body===undefined?{}:{Origin:url,'Content-Type':'application/json'})},
      body:body===undefined?undefined:JSON.stringify(body)});
    const data=await response.json();
    assert.equal(response.status,expected,route+': '+JSON.stringify(data));
    return {data,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  const login=async(account)=>(await api('session/login',200,{space:null,body:{account,workspace,code:codes[account]}})).cookie;
  const req=async(token,action,expected=200,fields={})=>{
    const {data}=await api('governance-documents/'+action,expected,{token,body:{...fields,expectedRevision:revision}});
    if(expected===200&&Number.isSafeInteger(data.revision))revision=data.revision;
    return data;
  };
  async function draft(token,title,parent=null){
    const book=await req(token,parent?'records/'+parent+'/revise':'records',200,
      {...(parent?{}:{kind:'policy'}),title,content:'Fictional text: '+title,links:[]});
    const doc=book.documents.find(d=>d.revisions.at(-1).title===title),edition=doc.revisions.at(-1);
    return {id:doc.id,edition:edition.id,route:'records/'+doc.id+'/revisions/'+edition.id};
  }
  const notes={note:'Fictional independent review.'};
  return {codes,api,login,req,draft,notes,get url(){return url;},workspace,
    async switch(assignments){await stop();roles(assignments);await start();},
    async fromDisk(){return JSON.parse(await readFile(stateFile,'utf8'));},
    async legacy(edit){await stop();const state=JSON.parse(await readFile(stateFile,'utf8'));edit(state);await writeFile(stateFile,JSON.stringify(state));await start();}
  };
}
const versionOf=(book,id)=>book.documents.flatMap(d=>d.revisions).find(v=>v.id===id);
test('HTTP checks actual author/editor/submitter across account and role changes, returns, attachments, and fresh editions',async t=>{
  const f=await setup(t),a=await f.login('sample-alice'),b=await f.login('sample-bob');
  const v1=await f.draft(a,'Fictional first edition');
  await f.req(a,v1.route+'/submit');
  await f.req(b,v1.route+'/return',200,f.notes);
  await f.switch({'sample-alice':'reviewer','sample-bob':'analyst','sample-carol':'case-operator'});
  const a2=await f.login('sample-alice'),b2=await f.login('sample-bob');
  await f.req(b2,v1.route+'/edit',200,{title:'Fictional updated title',content:'Fictional edited text.',links:[]});
  await f.req(b2,v1.route+'/attachments',200,{filename:'fictional.txt',mediaType:'text/plain',data:Buffer.from('synthetic-only').toString('base64')});
  await f.req(b2,v1.route+'/submit');
  const book=(await f.api('governance-documents',200,{token:a2})).data;
  assert.equal(versionOf(book,v1.edition).publicationAuthority,'contributor');
  assert.doesNotMatch(JSON.stringify(book),/accountProvenance|sample-alice|sample-bob/);
  assert.equal((await f.req(a2,v1.route+'/publish',403,f.notes)).code,'INDEPENDENT_REVIEW_REQUIRED');
  assert.equal((await f.req(a2,v1.route+'/return',403,f.notes)).code,'INDEPENDENT_REVIEW_REQUIRED');
  assert.equal((await f.api('my-work',200,{token:a2})).data.tasks.some(task=>task.workflow==='governance-docs'),false);
  await f.switch({'sample-alice':'analyst','sample-bob':'reviewer','sample-carol':'case-operator'});
  const b3=await f.login('sample-bob');
  assert.equal((await f.req(b3,v1.route+'/publish',403,f.notes)).code,'INDEPENDENT_REVIEW_REQUIRED');
  await f.switch({'sample-alice':'analyst','sample-bob':'case-operator','sample-carol':'reviewer'});
  const c=await f.login('sample-carol'),a3=await f.login('sample-alice');
  assert.equal((await f.api('my-work',200,{token:c})).data.tasks.some(task=>task.workflow==='governance-docs'),true);
  await f.req(c,v1.route+'/publish',200,f.notes);
  const v2=await f.draft(a3,'Fictional second edition',v1.id);
  await f.req(a3,v2.route+'/submit');await f.req(c,v2.route+'/publish',200,f.notes);
  const stored=(await f.fromDisk()).governanceDocuments.documents[0].revisions;
  assert.deepEqual(stored[0].accountProvenance,{schemaVersion:1,authorAccount:'sample-alice',
    contributors:['sample-alice','sample-bob'],submittedBy:'sample-bob',publishedBy:'sample-carol'});
  assert.deepEqual(stored[1].accountProvenance.contributors,['sample-alice']);
  assert.notEqual(stored[0].id,stored[1].id);
});
test('legacy staged editions recover only from complete verification-backed historical events; ambiguous copies are read-only',async t=>{
  const f=await setup(t),a=await f.login('sample-alice'),b=await f.login('sample-bob');
  const historical=await f.draft(a,'Fixture with complete author audit');
  await f.req(a,historical.route+'/submit');
  const unknown=await f.draft(a,'Fixture without attributable editor');
  await f.req(a,unknown.route+'/edit',200,{title:'Fixture without attributable editor',content:'Fictional and ambiguous.',links:[]});
  await f.req(a,unknown.route+'/submit');
  const oldPublished=await f.draft(a,'Fixture already published');
  await f.req(a,oldPublished.route+'/submit');await f.req(b,oldPublished.route+'/publish',200,f.notes);
  await f.legacy(state=>{
    for(const doc of state.governanceDocuments.documents)for(const row of doc.revisions)delete row.accountProvenance;
    delete state.audit.find(e=>e.action==='governance-documents.edit'&&e.entityId===unknown.id).account;
  });
  await f.switch({'sample-alice':'reviewer','sample-bob':'analyst','sample-carol':'case-operator'});
  const a2=await f.login('sample-alice');
  assert.equal((await f.req(a2,historical.route+'/publish',403,f.notes)).code,'INDEPENDENT_REVIEW_REQUIRED');
  await f.switch({'sample-alice':'analyst','sample-bob':'reviewer','sample-carol':'case-operator'});
  const b2=await f.login('sample-bob');
  const book=(await f.api('governance-documents',200,{token:b2})).data;
  assert.equal(versionOf(book,historical.edition).publicationAuthority,'eligible');
  assert.equal(versionOf(book,unknown.edition).publicationAuthority,'unattributed');
  const tasks=(await f.api('my-work',200,{token:b2})).data.tasks.filter(task=>task.workflow==='governance-docs');
  assert.deepEqual(tasks.map(task=>task.recordLabel),['Fixture with complete author audit']);
  assert.equal((await f.req(b2,unknown.route+'/publish',409,f.notes)).code,'DOCUMENT_AUTHORSHIP_UNATTRIBUTED');
  assert.equal((await f.req(b2,unknown.route+'/return',409,f.notes)).code,'DOCUMENT_AUTHORSHIP_UNATTRIBUTED');
  assert.equal((await f.req(b2,oldPublished.route+'/read')).text,'Fictional text: Fixture already published');
  await f.req(b2,historical.route+'/publish',200,f.notes);
  const migrated=(await f.fromDisk()).governanceDocuments.documents.find(d=>d.id===historical.id).revisions[0];
  assert.equal(migrated.accountProvenance.authorAccount,'sample-alice');
  assert.equal(migrated.accountProvenance.publishedBy,'sample-bob');
});
test('provenance rejects malformed contributor state even when historic audit may exist',()=>{
  const revision={id:'x',number:1,status:'review',accountProvenance:{schemaVersion:1,
    authorAccount:'sample-alice',contributors:['sample-alice'],submittedBy:'sample-other',publishedBy:null}};
  assert.equal(provenance.reviewStatus({audit:[]},{id:'d'},revision,'reviewer','sample-review'),'unattributed');
});
test('Chromium: rotated author sees edition without approval controls, separate reviewer publishes',{
  skip:!chrome&&'Set RUN_BROWSER_SMOKE=1 and browser tools',timeout:30000
},async t=>{
  const f=await setup(t),a=await f.login('sample-alice'),edition=await f.draft(a,'Browser authored edition');
  await f.req(a,edition.route+'/submit');
  const {chromium}=require('playwright');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    async function pageFor(account){
      const p=await browser.newPage();p.setDefaultTimeout(6000);await p.goto(f.url);
      await p.getByLabel('Test account').fill(account);await p.getByLabel('Workspace ID').fill(f.workspace);
      await p.getByLabel('Local access code').fill(f.codes[account]);await p.getByRole('button',{name:'Sign in',exact:true}).click();
      await p.locator('#show-governance-docs').click();await p.getByRole('heading',{name:'Browser authored edition'}).waitFor();
      return p;
    }
    await f.switch({'sample-alice':'reviewer','sample-bob':'analyst','sample-carol':'case-operator'});
    const author=await pageFor('sample-alice');
    await author.getByText('You contributed to this edition. A different account must review it.',{exact:true}).waitFor();
    assert.equal(await author.locator('summary').filter({hasText:'Publish locally'}).count(),0);
    assert.equal(await author.locator('summary').filter({hasText:'Return to draft'}).count(),0);
    await f.switch({'sample-alice':'analyst','sample-bob':'reviewer','sample-carol':'case-operator'});
    const reviewer=await pageFor('sample-bob');
    const publication=reviewer.locator('details').filter({has:reviewer.locator('summary').filter({hasText:/^Publish locally$/})});
    await publication.locator('summary').click();
    await publication.getByLabel('Fictional review rationale').fill('Independently verified fictional edition.');
    await publication.getByRole('button',{name:'Publish locally',exact:true}).click();
    await reviewer.locator('#governance-docs-view').getByText('Current',{exact:true}).waitFor();
  }finally{await browser.close();}
});

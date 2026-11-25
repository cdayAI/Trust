'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('../server');

test('browser smoke: synthetic intake to independent approval, mock retry and audit download', {
  skip: process.env.RUN_BROWSER_SMOKE !== '1' && 'Set RUN_BROWSER_SMOKE=1 with Playwright installed',
  timeout: 30_000,
}, async t => {
  const { chromium } = require('playwright');
  const dir = await mkdtemp(join(tmpdir(), 'privacy-workbench-browser-'));
  const server = createServer({ dataFile: join(dir, 'state.json') });
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(4500);
    const pageErrors = [];
    const unexpectedRequests = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin === url) return route.continue();
      unexpectedRequests.push(route.request().url());
      return route.abort();
    });
    await page.goto(url);
    await page.getByRole('button',{name:'Assessments',exact:true}).click();
    await page.getByRole('heading', { name: 'Customer Support Modernization', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'HarborDesk', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Northstar Assist', exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Privacy assessment', exact: true }).count(), 2);
    assert.equal(await page.getByRole('heading', { name: 'AI-risk assessment', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Send mock handoff' }).isDisabled(), true);

    const privacyDraft=page.locator('.assessment').first();
    const aiDraft=page.locator('.assessment').filter({has:page.getByRole('heading',{name:'AI-risk assessment',exact:true})});
    await privacyDraft.getByLabel('Summary').fill('Unsaved fictional privacy notes.');
    await aiDraft.getByLabel('Summary').fill('Saved fictional AI notes.');
    const accepted=Promise.withResolvers(),deliver=Promise.withResolvers();
    await page.route('**/api/assessments/*/save',async route=>{
      const response=await route.fetch();
      accepted.resolve(await response.json());
      await deliver.promise;
      await route.fulfill({response});
    },{times:1});
    try{
      await aiDraft.getByRole('button',{name:'Save draft'}).click();
      const committed=(await accepted.promise).assessments.find(row=>row.type==='ai');
      assert.equal(committed.answers.safeguards,'');
      await aiDraft.getByLabel('Safeguards').fill('Unsaved safeguards entered while saving.');
    }finally{deliver.resolve();}
    await page.getByText('Draft saved.',{exact:true}).waitFor();
    assert.equal(await privacyDraft.getByLabel('Summary').inputValue(),'Unsaved fictional privacy notes.');
    assert.equal(await aiDraft.getByLabel('Summary').inputValue(),'Saved fictional AI notes.');
    assert.equal(await aiDraft.getByLabel('Safeguards').inputValue(),'Unsaved safeguards entered while saving.');

    for (let i = 0; i < 3; i++) {
      const card = page.locator('.assessment').filter({ has: page.getByRole('button', { name: 'Submit for review' }) }).first();
      await card.getByLabel('Summary').fill('Synthetic support workflow only.');
      await card.getByLabel('Safeguards').fill('Human review of synthetic records.');
      const choice=card.getByRole('combobox');
      const isAI=await card.getByRole('heading',{name:'AI-risk assessment'}).count();
      const branch=card.getByLabel('Describe who can stop or override the automated action');
      if(isAI) {
        assert.equal(await branch.isVisible(),false);
        await choice.selectOption('Yes');
        assert.equal(await branch.isVisible(),true);
        assert.equal(await branch.getAttribute('required'),'');
        await branch.fill('The fictional operator can stop it.');
        await choice.selectOption('No');
        assert.equal(await branch.isVisible(),false);
      }else await choice.selectOption('No');
      await Promise.all([
        page.waitForResponse(r => r.url().includes('/api/assessments/') && r.url().endsWith('/submit') && r.ok()),
        card.getByRole('button', { name: 'Submit for review' }).click(),
      ]);
      await page.getByText('Waiting for the independent reviewer.', { exact: true }).nth(i).waitFor();
    }
    assert.equal(await page.getByRole('button', { name: 'Approve assessment' }).count(), 0);
    await page.getByLabel('Demo identity').selectOption('reviewer');
    for (let i = 0; i < 3; i++) {
      const card = page.locator('.assessment').filter({ has: page.getByRole('button', { name: 'Approve assessment' }) }).first();
      await card.getByLabel('Decision reason').fill('Reviewed synthetic scope.');
      await Promise.all([
        page.waitForResponse(r => r.url().includes('/api/assessments/') && r.url().endsWith('/approve') && r.ok()),
        card.getByRole('button', { name: 'Approve assessment' }).click(),
      ]);
      await page.getByText('Reviewer decision: Reviewed synthetic scope.', { exact: true }).nth(i).waitFor();
    }
    await page.getByLabel('Demo identity').selectOption('analyst');
    await page.getByRole('button', { name: 'Send mock handoff' }).click();
    await page.locator('p.error').filter({hasText:/MOCK_TIMEOUT/}).waitFor();
    await page.getByRole('button', { name: 'Retry mock handoff' }).click();
    await page.getByText(/^Mock receipt:/).waitFor();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: 'Export audit JSON' }).click(),
    ]);
    assert.equal(download.suggestedFilename(), 'privacy-workbench-audit.json');
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    const audit = JSON.parse(Buffer.concat(chunks).toString()).audit;
    assert.deepEqual(audit.filter(e => e.action.startsWith('handoff.')).map(e => e.action), [
      'handoff.attempted', 'handoff.failed', 'handoff.attempted', 'handoff.sent',
    ]);

    await page.getByRole('button',{name:'Privacy rights',exact:true}).click();
    await page.getByRole('heading',{name:'Privacy rights cases'}).waitFor();
    await page.getByLabel('Assigned owner').selectOption('case-operator');
    await page.getByLabel('Fictional intake note').fill('Fictional request to practice responding.');
    await page.getByRole('button',{name:'Open rights case'}).click();
    const rightsCase=page.locator('#rights-view article');
    await rightsCase.getByText('Identity: pending',{exact:true}).waitFor();
    assert.equal(await rightsCase.getByText('Document mock fulfillment',{exact:true}).count(),0);
    async function docAction(action){
      const panel=rightsCase.locator('details').filter({has:page.locator('summary',{hasText:action})});
      await panel.locator('summary').click();
      await panel.getByLabel('Fictional action note').fill('Fictional case note for '+action);
      await panel.getByRole('button',{name:action,exact:true}).click();
    }
    await page.getByLabel('Demo identity').selectOption('reviewer');
    await docAction('Mark identity verified');
    await rightsCase.getByText('Identity: verified',{exact:true}).waitFor();
    await page.getByLabel('Demo identity').selectOption('case-operator');
    await docAction('Begin fulfillment');
    await rightsCase.getByText('in progress',{exact:true}).waitFor();
    await docAction('Document mock fulfillment');
    await rightsCase.getByText(/Mock fulfillment only\. No data released/).waitFor();
    await page.getByLabel('Demo identity').selectOption('analyst');
    await page.getByRole('button',{name:'Incidents',exact:true}).click();
    await page.getByRole('heading',{name:'Privacy incidents',exact:true}).waitFor();
    await page.getByLabel('Fictional incident title').fill('Fictional triage test');
    await page.getByLabel('Fictional affected scope').fill('Synthetic rows only.');
    await page.getByRole('button',{name:'Log incident',exact:true}).click();
    const incident=page.locator('#incident-view article');
    await incident.getByRole('heading',{name:'Fictional triage test'}).waitFor();
    const triage=incident.locator('details').filter({has:page.locator('summary',{hasText:'Record severity'})});
    await triage.locator('summary').click();
    await triage.getByLabel('Severity').selectOption('high');
    await triage.getByLabel('Fictional triage rationale').fill('Practice the elevated path.');
    await triage.getByRole('button',{name:'Record severity',exact:true}).click();
    await incident.getByText('Severity: High · Elevated investigation',{exact:true}).waitFor();
    assert.equal(await incident.getByText('Request notice review',{exact:true}).count(),0);
    await page.getByRole('button',{name:'Data mapping',exact:true}).click();
    await page.getByRole('heading',{name:'Data mapping and lineage',exact:true}).waitFor();
    await page.locator('#data-map-view summary').getByText('Add inventory record',{exact:true}).click();
    await page.getByLabel('Fictional name').fill('Fictional fixture system');
    await page.getByLabel('Fictional owner').fill('Fictional support team');
    await page.getByLabel('Hosting context').fill('Local simulation only');
    await page.getByRole('button',{name:'Add inventory record',exact:true}).click();
    await page.getByRole('button',{name:'Inspect lineage for Fictional fixture system'}).click();
    await page.getByRole('heading',{name:'Lineage for Fictional fixture system'}).waitFor();
    assert.equal(await page.locator('#lineage-output').getByText('None',{exact:true}).count(),2);
    await page.getByRole('button',{name:'Privacy notices',exact:true}).click();
    await page.getByRole('heading',{name:'Privacy notices',exact:true,level:1}).waitFor();
    await page.getByText('No privacy notices yet.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Retention',exact:true}).click();
    await page.getByRole('heading',{name:'Retention and holds',exact:true}).waitFor();
    await page.locator('#retention-view summary').getByText('Add fixture',{exact:true}).click();
    await page.getByLabel('Fixture ID such as SYN-RECORD01').fill('SYN-BROWSER01');
    await page.getByLabel('Created UTC date').fill('2024-02-29');
    await page.getByRole('button',{name:'Add fixture',exact:true}).click();
    await page.getByRole('heading',{name:'SYN-BROWSER01',exact:true}).waitFor();
    await page.locator('#retention-view summary').getByText('Preview disposition',{exact:true}).click();
    await page.getByLabel('Simulation UTC date').fill('2025-03-01');
    await page.getByRole('button',{name:'Save disposition preview',exact:true}).click();
    await page.getByText('No active schedule',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Risk and controls',exact:true}).click();
    await page.getByRole('heading',{name:'Risk and controls',exact:true,level:2}).waitFor();
    await page.locator('#risk-controls-view summary').getByText('Add risk',{exact:true}).click();
    await page.getByLabel('Fictional risk title').fill('Fictional risk smoke case');
    await page.getByLabel('Fictional risk scenario').fill('Only fictional accounts are included.');
    await page.getByRole('button',{name:'Add risk',exact:true}).click();
    await page.getByText('Residual score: 9 (moderate) · likelihood 3 × impact 3',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Vendor monitoring',exact:true}).click();
    await page.getByRole('heading',{name:'Vendor monitoring and due diligence',exact:true}).waitFor();
    await page.getByRole('button',{name:'Open monitoring case',exact:true}).click();
    await page.getByText('Cycle 1 · initial · moderate tier (9)',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Open linked assessments',exact:true}).click();
    await page.getByRole('heading',{name:'HarborDesk',exact:true}).waitFor();
    await page.getByRole('button',{name:'Work queue',exact:true}).click();
    await page.getByRole('heading',{name:'Work queue',exact:true,level:2}).waitFor();
    await page.getByLabel('Workflow filter').selectOption('vendor-monitoring');
    await page.getByRole('button',{name:'Apply filters',exact:true}).click();
    await page.getByRole('button',{name:/Open record: HarborDesk.*Collect cycle evidence/}).click();
    const focused=page.locator('#vendor-monitoring-view article:focus');
    await focused.getByRole('heading',{name:'HarborDesk',exact:true}).waitFor();
    await page.getByRole('button',{name:'Policies and documents',exact:true}).click();
    await page.getByRole('heading',{name:'Policies and evidence documents',exact:true}).waitFor();
    await page.locator('#governance-docs-view summary').getByText('Draft a document',{exact:true}).click();
    await page.getByLabel('Fictional title',{exact:true}).fill('Fictional document browser fixture');
    await page.getByLabel('Original fictional text',{exact:true}).fill('Only fictional text.');
    await page.getByRole('button',{name:'Create document draft',exact:true}).click();
    await page.getByRole('button',{name:'View fictional text',exact:true}).click();
    await page.getByText('Only fictional text.',{exact:true}).waitFor();
    assert.deepEqual(unexpectedRequests, []);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});

test('browser smoke: isolated sign-in, selected workspace, reload and sign-out', {
  skip: process.env.RUN_BROWSER_SMOKE !== '1' && 'Set RUN_BROWSER_SMOKE=1 with Playwright installed',
  timeout:30_000,
}, async t=>{
  const {chromium}=require('playwright');
  const {randomBytes}=require('node:crypto');
  const {codeHash}=require('../workspace-access');
  const dir=await mkdtemp(join(tmpdir(),'trust-local-browser-'));
  const code=randomBytes(32).toString('base64url');
  const server=createServer({isolated:{root:dir,
    workspaces:[{id:'alpha',label:'Synthetic Alpha'},{id:'beta',label:'Synthetic Beta'}],
    accounts:[{id:'pilot-user',codeHash:codeHash(code),memberships:{alpha:'analyst',beta:'reviewer'}}],
  }});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true})});
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const page=await browser.newPage();
    page.setDefaultTimeout(6500);
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.getByRole('heading',{name:'Sign in to a local workspace'}).waitFor();
    assert.equal(await page.getByRole('navigation',{name:'Workbench views'}).isVisible(),false);
    await page.getByLabel('Test account').fill('pilot-user');
    await page.getByLabel('Workspace ID').fill('alpha');
    await page.getByLabel('Local access code').fill(code);
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.getByRole('button',{name:'Assessments',exact:true}).click();
    await page.getByRole('heading',{name:'Assessment workspace'}).waitFor();
    assert.equal(await page.getByLabel('Demo identity').isVisible(),false);
    await page.getByLabel('Project name').fill('Synthetic Alpha project');
    await page.getByRole('button',{name:'Create project'}).click();
    await page.getByRole('heading',{name:'Synthetic Alpha project'}).waitFor();
    assert.equal(await page.locator('#audit-export').isVisible(),false);
    const oldPath=await page.locator('#audit-export').getAttribute('href');
    assert.match(oldPath,/workspace=alpha$/);
    await page.getByLabel('Workspace',{exact:true}).selectOption('beta');
    await page.getByRole('button',{name:'Switch workspace'}).click();
    await page.getByText('pilot-user · reviewer').waitFor();
    await page.getByRole('button',{name:'Assessments',exact:true}).click();
    assert.equal(await page.getByRole('link',{name:'Export audit JSON'}).isVisible(),true);
    assert.equal(await page.getByRole('heading',{name:'Synthetic Alpha project'}).count(),0);
    assert.equal(await page.getByRole('button',{name:'Create project'}).isDisabled(),true);
    const restricted=await page.evaluate(async path=>(await fetch(path)).status,oldPath);
    assert.equal(restricted,403);
    await page.getByRole('button',{name:'Sign out'}).click();
    await page.getByRole('heading',{name:'Sign in to a local workspace'}).waitFor();
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});

test('browser smoke: preview a fictional discovery fixture and apply it to inventory', {
  skip: process.env.RUN_BROWSER_SMOKE !== '1' && 'Set RUN_BROWSER_SMOKE=1 with Playwright installed',
  timeout:30_000,
},async t=>{
  const {chromium}=require('playwright');
  const dir=await mkdtemp(join(tmpdir(),'trust-discovery-browser-'));
  const server=createServer({dataFile:join(dir,'state.json')});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true})});
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const page=await browser.newPage();
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const url='http://127.0.0.1:'+server.address().port;
    await page.goto(url);
    await page.getByRole('button',{name:'Data mapping',exact:true}).click();
    await page.getByText('No fictional inventory records yet.').waitFor();
    await page.getByRole('button',{name:'Choose synthetic fixture'}).click();
    await page.getByLabel('Bundled fixture').selectOption('sample-library:1');
    await page.getByRole('button',{name:'Preview synthetic import'}).click();
    await page.getByRole('heading',{name:'Review import'}).waitFor();
    assert.equal(await page.getByText('No fictional inventory records yet.').isVisible(),true);
    await page.getByRole('button',{name:'Apply reviewed import'}).click();
    await page.getByText('Imported: 3 new records, 0 schema updates, 2 links.').waitFor();
    await page.getByRole('button',{name:'Inspect lineage for Fictional Reading Queue'}).click();
    await page.getByRole('heading',{name:'Lineage for Fictional Reading Queue'}).waitFor();
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});

test('browser smoke: requester portal checks a provisioned code and receives one receipt', {
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 with Playwright installed',
  timeout:30_000,
},async t=>{
  const {chromium}=require('playwright');
  const {randomBytes}=require('node:crypto');
  const {codeHash}=require('../workspace-access');
  const token=randomBytes(32).toString('base64url');
  const dir=await mkdtemp(join(tmpdir(),'trust-requester-browser-'));
  const server=createServer({isolated:{root:dir,workspaces:[{id:'alpha',label:'Alpha'}],
    accounts:[{id:'intake',codeHash:codeHash(randomBytes(32).toString('base64url')),memberships:{alpha:'analyst'}}],
    requesterGrants:[{id:'portal-customer',alias:'sample-customer',workspace:'alpha',codeHash:codeHash(token),expiresAt:Date.now()+3600000}]}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true})});
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const page=await browser.newPage();
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port+'/requester');
    await page.getByLabel('Synthetic access code').fill(token);
    await page.getByRole('button',{name:'Check my request'}).click();
    await page.getByRole('heading',{name:'No request submitted'}).waitFor();
    await page.getByLabel('Fictional request type').selectOption('correction');
    await page.getByRole('button',{name:'Submit synthetic request'}).click();
    await page.getByRole('heading',{name:'Received',exact:true}).waitFor();
    const receipt=await page.getByText(/^Receipt:/).textContent();
    await page.getByRole('button',{name:'Refresh status'}).click();
    await page.getByRole('heading',{name:'Received',exact:true}).waitFor();
    assert.equal(await page.getByText(/^Receipt:/).textContent(),receipt);
    await page.getByRole('button',{name:'Clear access code'}).click();
    assert.equal(await page.getByText(/^Receipt:/).count(),0);
    assert.equal(await page.getByLabel('Synthetic access code').inputValue(),'');
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});

test('browser smoke: isolated trust center controls and empty anonymous visitor preview', {
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 with Playwright installed',
  timeout:30_000,
},async t=>{
  const {chromium}=require('playwright');
  const {randomBytes}=require('node:crypto');
  const {codeHash}=require('../workspace-access');
  const dir=await mkdtemp(join(tmpdir(),'trust-center-browser-'));
  const code=randomBytes(32).toString('base64url');
  const server=createServer({isolated:{root:dir,workspaces:[{id:'alpha',label:'Alpha'}],
    accounts:[{id:'analyst',codeHash:codeHash(code),memberships:{alpha:'analyst'}}],
    trustCenters:[{slug:'sample-alpha',workspace:'alpha'}]}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true})});
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const page=await browser.newPage(),url='http://127.0.0.1:'+server.address().port;
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(url);
    await page.getByLabel('Test account').fill('analyst');
    await page.getByLabel('Workspace ID').fill('alpha');
    await page.getByLabel('Local access code').fill(code);
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.getByRole('button',{name:'Trust center',exact:true}).click();
    const privacy=page.locator('section').filter({has:page.getByRole('heading',{name:'Privacy practices',exact:true})});
    await privacy.getByLabel('Bundled fictional copy').selectOption('overview');
    await privacy.getByRole('button',{name:'Draft new version'}).click();
    await privacy.getByRole('heading',{name:'Latest version 1 · draft'}).waitFor();
    await privacy.getByRole('button',{name:'Send for review'}).click();
    await privacy.getByRole('heading',{name:'Latest version 1 · in-review'}).waitFor();
    const visitor=await browser.newPage();
    visitor.on('pageerror',e=>errors.push(e.message));
    const route=await page.getByRole('link',{name:'Open local visitor preview'}).getAttribute('href');
    await visitor.goto(url+route);
    await visitor.getByText('No published cards yet.').waitFor();
    assert.equal(await visitor.getByRole('heading',{name:'Privacy practices',exact:true}).count(),0);
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});

test('browser smoke: unassigned synthetic employee loads only their empty portal view',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 with Playwright installed',timeout:30_000,
},async t=>{
  const {chromium}=require('playwright');
  const {randomBytes}=require('node:crypto');
  const {codeHash}=require('../workspace-access');
  const token=randomBytes(32).toString('base64url');
  const dir=await mkdtemp(join(tmpdir(),'trust-employee-browser-'));
  const server=createServer({isolated:{root:dir,workspaces:[{id:'alpha',label:'Alpha'}],
    accounts:[{id:'operator',codeHash:codeHash(randomBytes(32).toString('base64url')),memberships:{alpha:'analyst'}}],
    employeeSigningKey:randomBytes(32).toString('hex'),
    employeeGrants:[{alias:'sample-staff-test',workspace:'alpha',codeHash:codeHash(token),expiresAt:Date.now()+3600000}]}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{if(server.listening)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true})});
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const page=await browser.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port+'/employee');
    await page.getByLabel('Synthetic employee code').fill(token);
    await page.getByRole('button',{name:'View my assignments'}).click();
    await page.getByText('You have no assigned policy editions.').waitFor();
    await page.getByRole('button',{name:'Clear access code'}).click();
    assert.equal(await page.getByText('You have no assigned policy editions.').count(),0);
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});

test('browser smoke: dictionary term appears for demo reviewer after submission',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 with Playwright installed',timeout:30_000,
},async t=>{
  const {chromium}=require('playwright');
  const dir=await mkdtemp(join(tmpdir(),'trust-dictionary-browser-'));
  const server=createServer({dataFile:join(dir,'state.json')});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{if(server.listening)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true})});
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const page=await browser.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.getByRole('button',{name:'Data dictionary',exact:true}).click();
    await page.getByText('Draft a term',{exact:true}).click();
    await page.getByLabel('Term type').selectOption('domain');
    await page.getByLabel('Stable slug').fill('synthetic-reading');
    await page.getByLabel('Fictional title').fill('Synthetic reading');
    await page.getByLabel('Fictional definition').fill('Standalone test term.');
    await page.getByRole('button',{name:'Create term draft'}).click();
    await page.getByRole('button',{name:'Submit version'}).click();
    await page.getByLabel('Demo identity').selectOption('reviewer');
    await page.getByRole('button',{name:'Approve version'}).click();
    await page.getByText(/approved version 1/).waitFor();
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});

test('browser smoke: publish a structured fictional workflow and launch its pinned version',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 with Playwright installed',timeout:30_000,
},async t=>{
  const {chromium}=require('playwright');
  const dir=await mkdtemp(join(tmpdir(),'trust-studio-browser-'));
  const server=createServer({dataFile:join(dir,'state.json')});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{if(server.listening)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true})});
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const page=await browser.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.getByRole('button',{name:'Workflow studio',exact:true}).click();
    await page.getByLabel('Workflow demo identity').selectOption('publisher');
    await page.getByRole('button',{name:'Load Synthetic independent review'}).click();
    await page.getByLabel('Display name').fill('Original fictional review');
    await page.getByLabel('Publish this exact immutable version').check();
    await page.getByRole('button',{name:'Publish workflow version'}).click();
    await page.getByRole('heading',{name:'Original fictional review'}).waitFor();
    await page.getByLabel('Workflow demo identity').selectOption('analyst');
    await page.getByLabel('Fictional instance title').fill('Studio journey fixture');
    await page.getByRole('button',{name:'Start pinned instance'}).click();
    await page.getByRole('heading',{name:'Studio journey fixture'}).waitFor();
    await page.getByLabel('summary',{exact:true}).fill('Synthetic submission.');
    await page.getByRole('button',{name:'Run submit-for-review'}).click();
    await page.getByLabel('Workflow demo identity').selectOption('reviewer');
    await page.getByRole('button',{name:'Run approve'}).waitFor();
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});

test('browser smoke: MVW Trust desktop and mobile shell, solid surfaces and audit navigation',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 with Playwright installed',timeout:30_000,
},async t=>{
  const {chromium}=require('playwright');
  const dir=await mkdtemp(join(tmpdir(),'mvw-brand-browser-'));
  const server=createServer({dataFile:join(dir,'state.json')}).listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true})});
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const url='http://127.0.0.1:'+server.address().port,errors=[];
    const desktop=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
    desktop.on('pageerror',e=>errors.push(e.message));
    desktop.setDefaultTimeout(6000);
    await desktop.goto(url);
    await desktop.getByRole('heading',{name:'Trust operations'}).waitFor();
    await desktop.getByRole('button',{name:'Assessments',exact:true}).click();
    assert.equal(await desktop.locator('#workspace-metrics strong').count(),3);
    assert.equal(await desktop.evaluate(()=>document.documentElement.scrollWidth),1440);
    await desktop.getByRole('button',{name:'Solid surfaces'}).click();
    assert.equal(await desktop.getByRole('button',{name:'Solid surfaces'}).getAttribute('aria-pressed'),'true');
    assert.equal(await desktop.locator('.workspace-nav').evaluate(e=>getComputedStyle(e).backdropFilter),'none');
    await desktop.getByRole('button',{name:'Audit management',exact:true}).click();
    await desktop.getByText('No audit plans yet.').waitFor();
    const mobile=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    mobile.setDefaultTimeout(6000);
    mobile.on('pageerror',e=>errors.push(e.message));
    await mobile.goto(url);
    await mobile.getByRole('heading',{name:'Trust operations'}).waitFor();
    assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth),390);
    await mobile.getByRole('button',{name:'Browse workspace'}).click();
    await mobile.getByRole('button',{name:'Privacy rights',exact:true}).click();
    await mobile.getByRole('heading',{name:'Privacy rights',level:1}).waitFor();
    assert.equal(await mobile.getByRole('button',{name:'Browse workspace'}).getAttribute('aria-expanded'),'false');
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});

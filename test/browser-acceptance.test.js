'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {mkdtemp,rm,writeFile}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createHash,randomBytes}=require('node:crypto');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
const browserOnly={skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Enable real-browser QA with RUN_BROWSER_SMOKE=1',timeout:30000};

async function setup(t,isolated){
  const root=await mkdtemp(join(tmpdir(),'mvw-acceptance-'));
  const server=createServer(isolated?{isolated:{root,...isolated}}:{dataFile:join(root,'state.json')});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true})});
  const {chromium}=require('playwright');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  return {browser,url:'http://127.0.0.1:'+server.address().port};
}
async function login(page,url,account,code){
  page.setDefaultTimeout(6000);
  await page.goto(url);
  await page.getByLabel('Test account',{exact:true}).fill(account);
  await page.getByLabel('Workspace ID',{exact:true}).fill('synthetic');
  await page.getByLabel('Local access code',{exact:true}).fill(code);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('heading',{name:'Assessment workspace',exact:true,level:1}).waitFor();
}
test('browser acceptance: separate signed-in accounts create, return, finalize and download a synthetic audit',browserOnly,async t=>{
  const identities={qaAnalyst:randomBytes(32).toString('base64url'),qaReviewer:randomBytes(32).toString('base64url')};
  const {browser,url}=await setup(t,{
    workspaces:[{id:'synthetic',label:'Synthetic acceptance workspace'}],
    accounts:[
      {id:'qa-analyst',codeHash:codeHash(identities.qaAnalyst),memberships:{synthetic:'analyst'}},
      {id:'qa-reviewer',codeHash:codeHash(identities.qaReviewer),memberships:{synthetic:'reviewer'}},
    ]
  });
  try{
    const a=await browser.newPage({acceptDownloads:true}),r=await browser.newPage({acceptDownloads:true}),stale=await browser.newPage();
    const errors=[];
    for(const p of [a,r,stale])p.on('pageerror',e=>errors.push(e.message));
    await login(a,url,'qa-analyst',identities.qaAnalyst);
    await login(r,url,'qa-reviewer',identities.qaReviewer);
    const title='Synthetic browser audit';
    const controlTitle='Synthetic evidence control';
    await a.getByRole('button',{name:'Risk and controls',exact:true}).click();
    const controlForm=a.locator('#risk-controls-view details').filter({has:a.locator('summary',{hasText:/^Add control$/})});
    await controlForm.locator('summary').click();
    await controlForm.getByLabel('Fictional control title').fill(controlTitle);
    await controlForm.getByLabel('Fictional control objective').fill('Synthetic objective for audit.');
    await controlForm.getByRole('button',{name:'Add control',exact:true}).click();
    await a.locator('#risk-controls-view').getByRole('heading',{name:controlTitle,exact:true}).waitFor();

    const openAudit=p=>p.getByRole('button',{name:'Audit management',exact:true}).click();
    await openAudit(a);
    await a.getByLabel('Synthetic audit title').fill(title);
    await a.getByLabel('Audit objective').fill('Confirm the fictional operator review.');
    await a.getByLabel('Scope and review period').fill('Synthetic Q1 documentation.');
    await a.getByRole('checkbox',{name:controlTitle,exact:true}).check();
    await a.getByRole('button',{name:'Create audit plan',exact:true}).click();
    const card=p=>p.locator('#audit-management-view article').filter({has:p.getByRole('heading',{name:title,exact:true})});
    const aCard=card(a),rCard=card(r),staleCard=card(stale);
    await login(stale,url,'qa-analyst',identities.qaAnalyst);
    await openAudit(stale);
    await staleCard.getByRole('button',{name:'Begin fieldwork',exact:true}).waitFor();
    await aCard.getByRole('button',{name:'Begin fieldwork',exact:true}).click();
    await aCard.getByText('fieldwork',{exact:true}).waitFor();
    await staleCard.getByRole('button',{name:'Begin fieldwork',exact:true}).click();
    await stale.locator('#notice').filter({hasText:'The audit plan changed. Reload before retrying.'}).waitFor();
    await stale.getByRole('button',{name:'Reload audit plans',exact:true}).click();
    await staleCard.getByText('fieldwork',{exact:true}).waitFor();
    await aCard.getByText('Assess each scoped control before submitting.',{exact:true}).waitFor();
    assert.equal(await aCard.getByRole('button',{name:'Submit audit for review',exact:true}).count(),0);
    async function recordEvidence(summary,reference,observation){
      const panel=aCard.locator('details').filter({has:a.locator('summary',{hasText:new RegExp('^'+summary+'$')})});
      await panel.locator('summary').click();
      await panel.getByLabel('Synthetic evidence reference').fill(reference);
      await panel.getByLabel('Assessment outcome').selectOption('exception');
      await panel.getByLabel('Finding severity').selectOption('high');
      await panel.getByLabel('Synthetic evidence observation').fill(observation);
      await panel.getByLabel('Proposed corrective action').fill('Review the synthetic sample again.');
      await panel.getByRole('button',{name:'Record evidence',exact:true}).click();
      await aCard.getByText('exception · '+reference,{exact:true}).waitFor();
    }
    await recordEvidence('Assess control','SYN-BROWSER-01','One synthetic sample observed.');
    await aCard.getByRole('button',{name:'Submit audit for review',exact:true}).click();
    await aCard.getByText('in-review',{exact:true}).waitFor();
    assert.equal(await aCard.getByText('Finalize audit',{exact:true}).count(),0);
    await openAudit(r);
    assert.equal(await r.getByRole('button',{name:'Create audit plan',exact:true}).count(),0);
    await rCard.locator('summary').filter({hasText:/^Return audit for changes$/}).click();
    await rCard.getByLabel('Reason for return').fill('Increase the fictional sample.');
    await rCard.getByRole('button',{name:'Return to fieldwork',exact:true}).click();
    await rCard.getByText('returned by qa-reviewer: Increase the fictional sample.',{exact:true}).waitFor();

    await openAudit(a);
    await recordEvidence('Record revised evidence','SYN-BROWSER-02','Two synthetic samples observed.');
    await aCard.locator('summary').filter({hasText:/^Prior evidence versions$/}).click();
    await aCard.getByText('SYN-BROWSER-01 · exception · One synthetic sample observed.',{exact:true}).waitFor();
    await aCard.getByRole('button',{name:'Submit audit for review',exact:true}).click();
    await aCard.getByText('in-review',{exact:true}).waitFor();
    await openAudit(r);
    await rCard.locator('summary').filter({hasText:/^Finalize audit$/}).click();
    await rCard.getByLabel('Final review rationale').fill('Independently verified the updated fictional sample.');
    await rCard.getByRole('button',{name:'Finalize and freeze report',exact:true}).click();
    await rCard.getByText('finalized',{exact:true}).waitFor();
    const [download]=await Promise.all([r.waitForEvent('download'),rCard.getByRole('link',{name:'Download finalized report JSON',exact:true}).click()]);
    assert.match(download.suggestedFilename(),/^synthetic-audit-.*\.json$/);
    const chunks=[];for await(const c of await download.createReadStream())chunks.push(c);
    const {result,sha256}=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(result.title,title);
    assert.equal(result.createdBy,'qa-analyst');
    assert.equal(result.reviewHistory.at(-1).reviewer,'qa-reviewer');
    assert.equal(result.conclusion,'exceptions-found');
    assert.equal(result.assessmentHistory.length,2);
    assert.equal(result.controls[0].assessment.evidenceReference,'SYN-BROWSER-02');
    assert.equal(sha256,createHash('sha256').update(JSON.stringify(result)).digest('hex'));
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});

test('browser acceptance: compact viewport supports keyboard skip, nav disclosure, focus transfer and assessment',browserOnly,async t=>{
  const {browser,url}=await setup(t);
  try{
    const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
    page.setDefaultTimeout(6000);
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const focused=()=>page.evaluate(()=>({id:document.activeElement?.id,text:document.activeElement?.textContent?.trim()}));
    await page.goto(url);
    await page.getByRole('heading',{name:'Assessment workspace',level:1}).waitFor();
    await page.keyboard.press('Tab');
    assert.equal((await focused()).text,'Skip to workbench');
    await page.keyboard.press('Enter');
    assert.equal((await focused()).id,'workbench');
    await page.keyboard.press('Tab');
    assert.equal((await focused()).id,'mobile-nav');
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#mobile-nav').getAttribute('aria-expanded'),'true');
    await page.keyboard.press('Tab');
    assert.equal((await focused()).id,'show-assessments');
    await page.keyboard.press('Tab');
    assert.equal((await focused()).id,'show-assessment-config');
    await page.keyboard.press('Tab');
    assert.equal((await focused()).id,'show-queue');
    await page.keyboard.press('Enter');
    await page.getByRole('heading',{name:'Work queue',level:2}).waitFor();
    assert.equal(await page.locator('#mobile-nav').getAttribute('aria-expanded'),'false');
    assert.deepEqual(await focused(),{id:'view-title',text:'Work queue'});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});

const views={
  assessments:'assessment-view',queue:'queue-view',rights:'rights-view',incidents:'incident-view',
  'vendor-monitoring':'vendor-monitoring-view','data-map':'data-map-view',dictionary:'dictionary-view',
  preferences:'preferences-view',retention:'retention-view','governance-docs':'governance-docs-view',
  'employee-attestations':'employee-attestations-view',training:'training-view','risk-controls':'risk-controls-view',
  'assessment-config':'assessment-config-view','audit-management':'audit-management-view','maturity-planning':'maturity-planning-view','workflow-studio':'workflow-studio-view',
  'trust-center':'trust-center-view',report:'report-view',modules:'module-view'
};
test('browser inventory: all workbench views and JSON download controls, with role-specific control evidence',{...browserOnly,timeout:75000},async t=>{
  const {browser,url}=await setup(t);
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});
    page.setDefaultTimeout(6000);
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(url);
    await page.getByRole('heading',{name:'Assessment workspace',level:1}).waitFor();
    const inventory=[];
    const links=new Set();
    assert.equal(await page.locator('#show-identity-admin').isVisible(),false);
    const allViews=await page.locator('#work-tabs button:visible').evaluateAll(buttons=>buttons.map(x=>x.id.replace(/^show-/,'')));
    assert.deepEqual(new Set(allViews),new Set(Object.keys(views)));
    for(const role of ['analyst','reviewer','case-operator']){
      await page.getByLabel('Demo identity',{exact:true}).selectOption(role);
      for(const key of allViews){
        await page.locator('#show-'+key).click();
        const panel=page.locator('#'+views[key]);
        await panel.waitFor();
        await panel.locator('h2').first().waitFor();
        assert.equal(await page.locator('#show-'+key).getAttribute('aria-current'),'true');
        const disclosure=panel.locator('summary:visible');
        for(let i=0,n=await disclosure.count();i<n;i++){
          const item=disclosure.nth(i);
          if(!await item.evaluate(e=>e.parentElement.open))await item.click();
          assert.equal(await item.evaluate(e=>e.parentElement.open),true);
        }
        const controls=await panel.locator('button:visible,a[href]:visible,input:visible,select:visible,textarea:visible,summary:visible').evaluateAll(elements=>elements.map(element=>{
          const labels=element.labels;
          const name=(element.getAttribute('aria-label')||[...(labels||[])].map(l=>l.cloneNode(true)).map(l=>{
            l.querySelectorAll('select,input,textarea').forEach(x=>x.remove());return l.textContent;
          }).join(' ')||(element.textContent||'')).trim().replace(/\s+/g,' ');
          return {element:element.tagName.toLowerCase(),name,type:element.getAttribute('type')||undefined,
            disabled:element.disabled||undefined,href:element.getAttribute('href')||undefined,
            download:element.hasAttribute('download')||undefined,
            verification:element.tagName==='SUMMARY'?'expanded':element.disabled?'disabled-observed':'observed-not-exercised'};
        }));
        if(role==='analyst'){
          for(const anchor of await panel.locator('a[download]:visible').all()){
            const href=await anchor.getAttribute('href');
            assert.ok(href?.startsWith('/api/'),href);
            if(links.has(href))continue;
            const [download]=await Promise.all([page.waitForEvent('download'),anchor.click()]);
            const chunks=[];for await(const c of await download.createReadStream())chunks.push(c);
            const value=Buffer.concat(chunks).toString('utf8');
            const csv=download.suggestedFilename().endsWith('.csv');
            if(csv)assert.match(value,/workflow|stage|outcome/i);
            else assert.equal(typeof JSON.parse(value),'object');
            links.add(href);
            for(const item of controls)if(item.href===href)item.verification=csv?'activated-and-csv-checked':'activated-and-json-parsed';
          }
        }
        inventory.push({role,view:key,navigation:'activated-and-rendered',controls});
      }
    }
    const shell=page.locator('#audit-export');
    const [download]=await Promise.all([page.waitForEvent('download'),shell.click()]);
    const archive=[];for await(const c of await download.createReadStream())archive.push(c);
    assert.ok(Array.isArray(JSON.parse(Buffer.concat(archive).toString('utf8')).audit));
    assert.ok(links.size>=5,'Expected all baseline in-page JSON downloads');
    assert.deepEqual(errors,[]);
    const result={source:'local synthetic demo fixture',capturedAt:new Date().toISOString(),rows:inventory,
      independentlyExercisedGlobal:['Export audit JSON'],uncoveredByInventory:[
        'Actions only created by populated records, permissions or status transitions',
        'File input, upload, rejection, byte-exact download and deletion are covered by the dedicated governance attachment journeys, not by this inventory',
        'Separate requester, employee and visitor portal states'
      ]};
    if(process.env.QA_INVENTORY_FILE)await writeFile(process.env.QA_INVENTORY_FILE,JSON.stringify(result,null,2)+'\n','utf8');
    t.diagnostic(JSON.stringify({roleViewCombinations:inventory.length,visibleControls:inventory.reduce((n,x)=>n+x.controls.length,0),
      disclosuresExpanded:inventory.flatMap(x=>x.controls).filter(x=>x.verification==='expanded').length,
      downloadsParsed:links.size+1}));
  }finally{await browser.close()}
});

test('browser accessibility: signed-out skip link focuses visible sign-in rather than hidden workspace',browserOnly,async t=>{
  const code=randomBytes(32).toString('base64url');
  const {browser,url}=await setup(t,{
    workspaces:[{id:'synthetic',label:'Synthetic accessibility workspace'}],
    accounts:[{id:'qa-analyst',codeHash:codeHash(code),memberships:{synthetic:'analyst'}}]
  });
  try{
    const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
    page.setDefaultTimeout(6000);
    await page.goto(url);
    await page.getByRole('heading',{name:'Sign in to a local workspace',exact:true}).waitFor();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('href')),'#local-signin');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(()=>document.activeElement?.id),'local-signin');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('name')),'account');
  }finally{await browser.close()}
});

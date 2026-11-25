'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createServer}=require('../server');
const enabled={skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Requires an installed Playwright and Chromium',timeout:35000};

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'mvw-customer-journey-'));
  const s=createServer({dataFile:join(root,'state.json')}).listen(0,'127.0.0.1');
  await once(s,'listening');
  t.after(async()=>{s.closeAllConnections();await new Promise(r=>s.close(r));await rm(root,{recursive:true,force:true})});
  const {chromium}=require('playwright');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:950},acceptDownloads:true});
  page.setDefaultTimeout(6500);
  const errors=[],evidence=[];
  page.on('pageerror',err=>errors.push(err.message));
  await page.goto('http://127.0.0.1:'+s.address().port);
  await page.getByRole('heading',{name:'Assessment workspace',level:1}).waitFor();
  async function action(scope,name,outcome,witness){
    await scope.getByRole('button',{name,exact:true}).click();
    await witness();
    evidence.push({control:name,outcome});
  }
  async function disclosure(scope,name){
    const summary=scope.locator('summary').filter({hasText:new RegExp('^'+name+'$')});
    await summary.click();
    assert.equal(await summary.evaluate(e=>e.parentElement.open),true);
    evidence.push({control:name,outcome:'Disclosure expanded'});
    return scope.locator('details[open]').filter({has:page.locator('summary').filter({hasText:new RegExp('^'+name+'$')})});
  }
  const role=async value=>{
    const field=page.getByLabel('Demo identity',{exact:true});
    await field.selectOption(value);
    assert.equal(await field.inputValue(),value);
    evidence.push({control:'Demo identity',outcome:value+' selected'});
  };
  const nav=async(view,pane)=>action(page,view,'Target panel opened',()=>page.locator(pane).waitFor());
  const seen=(scope,text)=>scope.getByText(text,{exact:true}).waitFor();
  async function fill(scope,label,value){
    const control=scope.getByLabel(label,{exact:true});
    await control.fill(value);
    assert.equal(await control.inputValue(),value);
    evidence.push({control:label,outcome:'Fictional input entered'});
  }
  async function select(scope,label,value){
    const control=scope.getByLabel(label);
    await control.selectOption(value);
    assert.equal(await control.inputValue(),value);
    evidence.push({control:label,outcome:'Expected option selected'});
  }
  return {page,role,nav,action,disclosure,seen,evidence,fill,select,finish(){assert.deepEqual(errors,[]);t.diagnostic(JSON.stringify(evidence))}};
}
const card=(page,pane,title)=>page.locator(pane+' article').filter({has:page.getByRole('heading',{name:title,exact:true})});

test('browser workflows: notice draft, return, edited resubmission and publication are versioned',enabled,async t=>{
  const {page,role,nav,action,disclosure,seen,fill,select,finish}=await fixture(t);
  const pane='#preferences-view',root=page.locator(pane);
  await nav('Privacy notices',pane);
  const form=await disclosure(root,'Draft privacy notice');
  const title='Fictional disclosure';
  await fill(form,'Fictional scope such as synthetic-portal','synthetic-browser');
  await select(form,'Notice channel','web');
  await fill(form,'Fictional notice title',title);
  await fill(form,'Fictional notice text','Fictional notice draft.');
  const record=card(page,pane,title);
  await action(form,'Create draft','Version one is a draft',()=>seen(record,'draft'));
  await action(record,'Submit for independent review','Version one is in review',()=>seen(record,'review'));
  assert.equal(await record.getByRole('button',{name:'Publish locally',exact:true}).count(),0);
  await role('reviewer');
  const back=await disclosure(record,'Return to draft');
  await fill(back,'Fictional reviewer rationale','Clarify the fictional scope.');
  await action(back,'Return to draft','Reviewer rationale persists on draft',()=>seen(record,'Reviewer: Clarify the fictional scope.'));
  await role('analyst');
  const edit=await disclosure(record,'Edit draft');
  assert.equal(await edit.getByLabel('Fictional notice text',{exact:true}).inputValue(),'Fictional notice draft.');
  await fill(edit,'Fictional notice text','Fictional notice revised after review.');
  await action(edit,'Save draft','Revised text displayed',()=>seen(record,'Fictional notice revised after review.'));
  await action(record,'Submit for independent review','Edited version in review',()=>seen(record,'review'));
  await role('reviewer');
  const pub=await disclosure(record,'Publish locally');
  await fill(pub,'Fictional reviewer rationale','Approved fictional scope.');
  await action(pub,'Publish locally','Approved version is current and locally published',()=>seen(record,'published · current'));
  await role('analyst');
  assert.equal(await record.getByText('Edit draft',{exact:true}).count(),0);
  const next=await disclosure(root,'Draft privacy notice');
  await fill(next,'Fictional scope such as synthetic-portal','synthetic-browser');
  await select(next,'Notice channel','web');
  await fill(next,'Fictional notice title','Fictional disclosure revision two');
  await fill(next,'Fictional notice text','New draft does not replace the approved version.');
  await action(next,'Create draft','Second draft created; published version still current',async()=>{
    await seen(card(page,pane,'Fictional disclosure revision two'),'synthetic-browser · Web · Revision 2');
    await seen(record,'published · current');
  });
  finish();
});

test('browser workflows: retention schedule approval, place and release hold, block and simulate audit-only',enabled,async t=>{
  const {page,role,nav,action,disclosure,seen,fill,select,finish}=await fixture(t);
  const pane='#retention-view',root=page.locator(pane),title='Fictional operations schedule';
  await nav('Retention',pane);
  const draft=await disclosure(root,'Draft a schedule');
  await select(draft,'Category','demo-operations');
  await fill(draft,'Fictional schedule title',title);
  await select(draft,'Date trigger','created');
  await fill(draft,'Retention days','30');
  await select(draft,'Simulated disposition','archive');
  const schedule=card(page,pane,title);
  await action(draft,'Create draft','Retention draft shows v1',()=>seen(schedule,'draft'));
  const edit=await disclosure(schedule,'Edit schedule');
  await fill(edit,'Retention days','60');
  await action(edit,'Save schedule','Updated 60-day rule shown',()=>seen(schedule,'demo-operations · v1 · 60 days from created · archive'));
  await action(schedule,'Submit schedule','Schedule pending independent review',()=>seen(schedule,'review'));
  await role('reviewer');
  const returned=await disclosure(schedule,'Return to draft');
  await fill(returned,'Fictional review note','Confirm retention length before approving.');
  await action(returned,'Return to draft','Schedule returns to author with rationale',
    ()=>seen(schedule,'Review: Confirm retention length before approving.'));
  await role('analyst');
  await action(schedule,'Submit schedule','Returned schedule resubmitted',()=>seen(schedule,'review'));
  await role('reviewer');
  const approve=await disclosure(schedule,'Activate schedule');
  await fill(approve,'Fictional review note','Approved fictional retention schedule.');
  await action(approve,'Activate schedule','Current schedule displayed',()=>seen(schedule,'Current'));
  await role('analyst');
  const fixtureForm=await disclosure(root,'Add fixture');
  const reference='SYN-WORKFLOW01';
  await fill(fixtureForm,'Fixture ID such as SYN-RECORD01',reference);
  await select(fixtureForm,'Fixture category','demo-operations');
  await fill(fixtureForm,'Created UTC date','2023-01-01');
  await action(fixtureForm,'Add fixture','Synthetic fixture added',()=>seen(root,'demo-operations · Created 2023-01-01'));
  const inventory=page.locator(pane+' article').filter({hasText:/Created 2023-01-01/});
  const before=await disclosure(inventory,'Preview disposition');
  await fill(before,'Simulation UTC date','2024-12-31');
  await action(before,'Save disposition preview','Retention preview is eligible',()=>seen(root,'Eligible for audit-only simulation'));
  const hold=await disclosure(inventory,'Add fictional hold');
  await fill(hold,'Fictional hold rationale','Review hold on this fictional fixture.');
  await action(hold,'Place hold','Active hold displayed on original fixture',()=>seen(inventory,'Active hold: Review hold on this fictional fixture.'));
  const eligible=page.locator(pane+' article').filter({hasText:/Simulated date: 2024-12-31/});
  await action(eligible,'Record audit-only simulation','Pre-existing preview blocked after hold placed',
    ()=>page.locator('#notice').filter({hasText:'An active hold blocks this simulation.'}).waitFor());
  const blocked=await disclosure(inventory,'Preview disposition');
  await fill(blocked,'Simulation UTC date','2025-01-01');
  await action(blocked,'Save disposition preview','New preview records active hold',()=>seen(root,'An active hold blocks disposition'));
  await role('reviewer');
  const release=await disclosure(inventory,'Release hold');
  await fill(release,'Fictional release note','Fictional review completed.');
  await action(release,'Release hold','Independent release and note displayed',()=>seen(inventory,'Release note: Fictional review completed.'));
  await role('analyst');
  await action(eligible,'Record audit-only simulation','Audit-only simulation recorded; source fixture unchanged',async()=>{
    await seen(eligible,'Audit-only simulation recorded: archive. No record changed.');
    await seen(inventory,'demo-operations · Created 2023-01-01');
  });
  finish();
});

test('browser workflows: vendor tier, evidence rework, independent approval, change and renewal create linked reassessments',enabled,async t=>{
  const {page,role,nav,action,disclosure,seen,fill,select,evidence:controls,finish}=await fixture(t);
  const pane='#vendor-monitoring-view',root=page.locator(pane),vendor='HarborDesk';
  const record=card(page,pane,vendor);
  await nav('Vendor monitoring',pane);
  const vendorSelect=page.getByLabel('Intake vendor');
  const harbor=await vendorSelect.getByRole('option',{name:/^HarborDesk · /}).getAttribute('value');
  await vendorSelect.selectOption(harbor);
  assert.equal(await vendorSelect.inputValue(),harbor);
  controls.push({control:'Intake vendor',outcome:'Selected existing fictional vendor'});
  await action(root,'Open monitoring case','Initial case collecting',()=>seen(record,'collecting'));
  const score=await disclosure(record,'Update tier inputs');
  await fill(score,'Service criticality','5');
  await fill(score,'Information exposure','5');
  await action(score,'Save tier inputs','Updated factors calculate critical tier',()=>seen(record,'Cycle 1 · initial · critical tier (25)'));
  const evidence=async(ref,text)=>{
    const form=await disclosure(record,'Record due diligence evidence');
    await fill(form,'Fictional evidence reference such as SYN-VENDOR01',ref);
    await fill(form,'Fictional evidence note',text);
    const wrote=page.waitForResponse(res=>res.request().method()==='POST'&&res.url().includes('/api/vendor-monitoring/')&&res.url().endsWith('/evidence')&&res.ok());
    await action(form,'Record evidence','Evidence persisted for '+ref,async()=>{
      const res=await wrote;
      const payload=await res.json();
      assert.equal(payload.cases[0].cycles.at(-1).evidence.at(-1).reference,ref);
    });
  };
  await evidence('SYN-VENDOR001','Fictional evidence for first review.');
  assert.equal(await record.getByRole('button',{name:'Submit for independent review',exact:true}).count(),0);
  async function approveCurrentAssessment(){
    await action(record,'Open linked assessments','Linked vendor assessment opened',()=>page.getByRole('heading',{name:vendor,exact:true}).waitFor());
    const vendorArea=page.locator('#workspace > section').filter({has:page.getByRole('heading',{name:vendor,exact:true})});
    const assessing=vendorArea.locator('.assessment').filter({has:page.getByRole('button',{name:'Submit for review',exact:true})});
    await assessing.getByLabel('Summary').fill('Fictional vendor assessment.');
    await assessing.getByLabel('Safeguards').fill('No real processing; local fictional test.');
    controls.push({control:'Summary and Safeguards',outcome:'Entered linked assessment test inputs'});
    await select(assessing,'Will project data be shared outside your organization?','No');
    await action(assessing,'Submit for review','Linked assessment in independent review',()=>seen(vendorArea,'Waiting for the independent reviewer.'));
    await role('reviewer');
    const review=vendorArea.locator('.assessment').filter({has:page.getByRole('button',{name:'Approve assessment',exact:true})});
    await fill(review,'Decision reason','Approved fictional linked review.');
    await action(review,'Approve assessment','Linked vendor assessment approved',()=>vendorArea.getByText('Reviewer decision: Approved fictional linked review.',{exact:true}).last().waitFor());
    await role('analyst');
    await nav('Vendor monitoring',pane);
    await record.waitFor();
  }
  await approveCurrentAssessment();
  await action(record,'Submit for independent review','Vendor case entered independent review',()=>seen(record,'review'));
  await role('reviewer');
  const back=await disclosure(record,'Return for evidence');
  await fill(back,'Fictional review rationale','Need a second fictional source.');
  await action(back,'Return for evidence','Returned case collecting again',()=>seen(record,'collecting'));
  await role('analyst');
  assert.equal(await record.getByRole('button',{name:'Submit for independent review',exact:true}).count(),0);
  await evidence('SYN-VENDOR002','Second fictional source.');
  await action(record,'Submit for independent review','Additional evidence re-enters review',()=>seen(record,'review'));
  async function approve(){
    await role('reviewer');
    const review=await disclosure(record,'Approve monitoring');
    await fill(review,'Fictional review rationale','Fictional evidence approved.');
    await action(review,'Approve monitoring','Monitoring and renewal date established',async()=>{
      await seen(record,'monitoring');
      await record.getByText(/^Renewal: \d{4}-\d{2}-\d{2} UTC/).waitFor();
    });
    await role('analyst');
  }
  await approve();
  const change=await disclosure(record,'Record a material change');
  await fill(change,'Service criticality','4');
  await fill(change,'Information exposure','4');
  await fill(change,'Fictional material change rationale','Synthetic exposure changed.');
  await action(change,'Start change reassessment','Second cycle opens with independent new assessment',()=>seen(record,'Cycle 2 · change · high tier (16)'));
  await evidence('SYN-VENDOR003','Evidence for material change cycle.');
  await approveCurrentAssessment();
  await action(record,'Submit for independent review','Change cycle is ready for independent review',()=>seen(record,'review'));
  await approve();
  const renew=await disclosure(record,'Start a renewal');
  await fill(renew,'Fictional renewal rationale','Begin synthetic renewal sample.');
  await action(renew,'Start renewal reassessment','Third cycle renewed without overwriting previous cycle',()=>seen(record,'Cycle 3 · renew · high tier (16)'));
  const history=await disclosure(record,'Cycle and evidence history');
  await history.getByText('SYN-VENDOR002: Second fictional source.',{exact:true}).waitFor();
  finish();
});

test('browser workflows: policy links, editable drafts, reviewer return and publication, text download and next revision',enabled,async t=>{
  const {page,role,nav,action,disclosure,seen,evidence,fill,finish}=await fixture(t);
  // Create a real reference target through the risk workspace, not a fake URL or direct store mutation.
  await nav('Risk and controls','#risk-controls-view');
  const riskPanel=page.locator('#risk-controls-view');
  const riskForm=await disclosure(riskPanel,'Add risk');
  const risk='Browser textual document risk';
  await fill(riskForm,'Fictional risk title',risk);
  await fill(riskForm,'Fictional risk scenario','Synthetic workflow linking scenario.');
  await action(riskForm,'Add risk','Risk becomes selectable as typed reference',
    ()=>riskPanel.getByRole('heading',{name:risk,exact:true}).waitFor());
  const pane='#governance-docs-view',root=page.locator(pane);
  await nav('Policies and documents',pane);
  const draft=await disclosure(root,'Draft a document');
  const title='Browser fictional linked policy';
  const originalText='Original synthetic policy text.';
  await fill(draft,'Fictional title',title);
  await fill(draft,'Original fictional text',originalText);
  const links=draft.getByLabel('Linked fictional records');
  await links.selectOption({label:'Risk: '+risk});
  assert.equal(await links.locator('option:checked').textContent(),'Risk: '+risk);
  evidence.push({control:'Linked fictional records',outcome:'Selected real typed fictional risk target'});
  const version=()=>root.locator('article > section').filter({has:page.getByRole('heading',{name:title,exact:true})});
  const binding=version();
  await action(draft,'Create document draft','Policy draft lists the typed linked risk',()=>binding.getByRole('paragraph').filter({hasText:'Risk: '+risk}).waitFor());
  await action(binding,'View fictional text','Exact authored text rendered',()=>binding.locator('pre:visible').filter({hasText:originalText}).waitFor());
  const edit=await disclosure(binding,'Edit draft');
  await action(edit,'Load current text into editor','Editor populated from revision content',async()=>{
    await page.waitForFunction(text=>document.querySelector('#governance-docs-view article details[open] textarea')?.value===text,originalText);
  });
  const finalText='Approved synthetic policy text.';
  await fill(edit,'Original fictional text',finalText);
  await action(edit,'Save draft','Updated text saved; typed link retained',()=>page.locator('#notice').filter({hasText:'Document workspace updated.'}).waitFor());
  await action(binding,'Submit for review','Draft enters review',()=>seen(binding,'review'));
  await role('reviewer');
  const sendBack=await disclosure(binding,'Return to draft');
  await fill(sendBack,'Fictional review rationale','Add the synthetic sample context.');
  await action(sendBack,'Return to draft','Reviewer rationale recorded',()=>seen(binding,'Review: Add the synthetic sample context.'));
  await role('analyst');
  await action(binding,'Submit for review','Returned draft resubmitted',()=>seen(binding,'review'));
  await role('reviewer');
  const pub=await disclosure(binding,'Publish locally');
  await fill(pub,'Fictional review rationale','Verified linked risk in synthetic workspace.');
  await action(pub,'Publish locally','Published revision is current',()=>seen(binding,'Current'));
  const [download]=await Promise.all([page.waitForEvent('download'),binding.getByRole('button',{name:'Download text',exact:true}).click()]);
  let body='';for await(const chunk of await download.createReadStream())body+=chunk.toString('utf8');
  assert.equal(body,finalText);
  assert.match(download.suggestedFilename(),/\.txt$/);
  evidence.push({control:'Download text',outcome:'Downloaded text exactly matches approved content'});
  await role('analyst');
  const next=await disclosure(root,'Draft next revision');
  await fill(next,'Fictional title',title+' v2');
  await fill(next,'Original fictional text','Second synthetic revision is not yet published.');
  await action(next,'Create next revision','New revision remains draft; old revision remains current',async()=>{
    await root.getByRole('heading',{name:title+' v2',exact:true}).waitFor();
    await seen(binding,'Current');
  });
  finish();
});

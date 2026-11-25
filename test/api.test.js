'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtemp, rm, readFile, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('../server');

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), 'privacy-workbench-test-'));
  const dataFile = join(dir, 'state.json');
  let server;
  let url;
  async function stop() {
    if (!server?.listening) return;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  async function start() {
    server = createServer({ dataFile });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = 'http://127.0.0.1:' + server.address().port;
  }
  t.after(async () => {
    await stop();
    await rm(dir, { recursive: true, force: true });
  });
  await start();
  async function request(path, expected, options) {
    const response = await fetch(url + '/api/' + path, options);
    const body = await response.json();
    assert.equal(response.status, expected, JSON.stringify(body));
    return { response, body };
  }
  const get = async () => (await request('state', 200)).body;
  const post = async (path, actor, body = {}, expected = 200) => (await request(path, expected, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Demo-Actor': actor },
    body: JSON.stringify(body),
  })).body;
  return { get, post, request, dataFile, restart: async () => { await stop(); await start(); } };
}

test('fresh synthetic seed contains two vendors and only the AI vendor receives an AI assessment', async t => {
  const { get } = await harness(t);
  const state = await get();
  assert.equal(state.projects.length, 1);
  assert.equal(state.vendors.length, 2);
  const nonAI = state.vendors.find(v => !v.usesAI);
  const vendorAI = state.vendors.find(v => v.usesAI);
  assert.ok(nonAI && vendorAI);
  const types = id => state.assessments.filter(a => a.vendorId === id).map(a => a.type).sort();
  assert.deepEqual(types(nonAI.id), ['privacy']);
  assert.deepEqual(types(vendorAI.id), ['ai', 'privacy']);
  assert.ok(state.assessments.every(a => a.status === 'draft'));
  assert.equal(state.handoff[0].attempts, 0);
});

test('fresh intake, independent decision, failed mock handoff, successful retry and durable export', async t => {
  const { get, post, request, restart } = await harness(t);
  const start = await get();
  await post('projects', 'reviewer', { name: 'Not created' }, 403);
  await post('projects', 'analyst', { name: '  ' }, 422);
  assert.deepEqual(await get(), start);
  let state = await post('projects', 'analyst', { name: 'Northstar QA demo', description: 'Fictional workflow using fabricated records.' });
  const project = state.projects.find(p => p.name === 'Northstar QA demo');
  const handoff = state.handoff.find(p => p.projectId === project.id);
  const path = 'handoff/' + handoff.id;
  await post(path + '/retry', 'analyst', {}, 409);
  await post(path + '/send', 'analyst', {}, 409);
  await post('vendors', 'analyst', { projectId: project.id, name: 'Missing AI answer' }, 422);
  await post('vendors', 'analyst', { projectId: project.id, name: 'Fictional Counting Co.', description: 'Usage counts only.', usesAI: false });
  state = await post('vendors', 'analyst', { projectId: project.id, name: 'Fictional Model Co.', description: 'Synthetic ticket text only.', usesAI: true });
  const assessments = state.assessments.filter(a => a.projectId === project.id);
  const answers = { summary: 'Synthetic test records only.', safeguards: 'Human review before synthetic handoff.' };
  assert.deepEqual(assessments.map(a => a.type).sort(), ['ai', 'privacy', 'privacy']);
  const ai = assessments.find(a => a.type === 'ai');
  const aiPath = 'assessments/' + ai.id;
  assert.equal(ai.workflowDefinitionVersion, 1);
  assert.equal(ai.workflowRevision, 1);
  await post(aiPath + '/submit', 'analyst', { expectedRevision: 0 }, 422);
  await post(aiPath + '/submit', 'reviewer', { ...answers, expectedRevision: 0 }, 403);
  await post(aiPath + '/approve', 'reviewer', { expectedRevision: 0 }, 409);
  await post(aiPath + '/submit', 'analyst', { answers:{...answers,automatedAction:'No'}, expectedRevision: 0 });
  await post(aiPath + '/approve', 'analyst', { reason: 'Self-approval', expectedRevision: 1 }, 403);
  await post(aiPath + '/reject', 'reviewer', { expectedRevision: 1 }, 422);
  await post(aiPath + '/reject', 'reviewer', { reason: 'Document the retention window.', expectedRevision: 1 });
  await post(path + '/send', 'analyst', {}, 409);
  await post(aiPath + '/submit', 'analyst', { answers:{...answers, safeguards: 'Human review and a 7-day synthetic retention window.'}, expectedRevision: 2 });
  await post(aiPath + '/approve', 'reviewer', { reason: 'Safeguards recorded.', expectedRevision: 3 });
  await post(path + '/send', 'analyst', {}, 409);
  for (const item of assessments.filter(a => a.type === 'privacy')) {
    await post('assessments/' + item.id + '/submit', 'analyst', { answers:{...answers,externalSharing:'No'}, expectedRevision: 0 });
    await post('assessments/' + item.id + '/approve', 'reviewer', { reason: 'Synthetic scope verified.', expectedRevision: 1 });
  }
  await post(path + '/send', 'reviewer', {}, 403);
  const failed = (await post(path + '/send', 'analyst')).handoff.find(p => p.id === handoff.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempts, 1);
  assert.match(failed.error, /MOCK_TIMEOUT/);
  assert.equal(failed.receipt, null);
  await post(path + '/send', 'analyst', {}, 409);
  await post('vendors', 'analyst', { projectId: project.id, name: 'Late vendor', usesAI: false }, 409);
  const completed = await post(path + '/retry', 'analyst');
  const sent = completed.handoff.find(p => p.id === handoff.id);
  assert.equal(sent.status, 'sent');
  assert.equal(sent.attempts, 2);
  assert.equal(sent.error, null);
  assert.match(sent.receipt, /^MOCK-/);
  assert.deepEqual(sent.request, failed.request);
  await post(path + '/retry', 'analyst', {}, 409);
  assert.deepEqual(await get(), completed);
  await restart();
  assert.deepEqual(await get(), completed);

  const { response, body } = await request('audit/export', 200);
  assert.match(response.headers.get('content-disposition'), /^attachment/);
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.mode, 'synthetic-demo');
  assert.ok(Number.isFinite(Date.parse(body.exportedAt)));
  assert.deepEqual(body.audit, completed.audit);
  assert.deepEqual(body.audit.map(e => e.sequence), body.audit.map((_, i) => i + 1));
  assert.ok(body.audit.every(e => Number.isFinite(Date.parse(e.at))));
  const handoffEvents = body.audit.filter(e => e.entityId === handoff.id);
  assert.deepEqual(handoffEvents.map(e => e.action), ['handoff.attempted', 'handoff.failed', 'handoff.attempted', 'handoff.sent']);
  assert.deepEqual(handoffEvents.map(e => e.details.attempt), [1, 1, 2, 2]);
  const projectCreated = body.audit.find(e => e.entityId === project.id && e.action === 'project.created');
  assert.equal(projectCreated.details.description, 'Fictional workflow using fabricated records.');
  const vendorCreated = body.audit.find(e => e.projectId === project.id && e.action === 'vendor.created' && e.details.usesAI);
  assert.equal(vendorCreated.details.description, 'Synthetic ticket text only.');
  const decision = body.audit.find(e => e.entityId === ai.id && e.action === 'assessment.approved');
  assert.equal(decision.actor, 'reviewer');
  assert.equal(decision.details.submittedBy, 'analyst');
  assert.equal(decision.details.reason, 'Safeguards recorded.');
});

test('module catalog supports one synthetic lifecycle advance in every workflow area', async t => {
  const { request, post, restart } = await harness(t);
  const catalog = async () => (await request('modules', 200)).body;
  const { modules } = await catalog();
  const expected = [
    'inventory', 'processing', 'rights', 'incidents', 'third-party',
    'risks', 'controls', 'retention', 'policies', 'administration', 'integrations',
  ];
  assert.deepEqual(modules.map(m => m.id).sort(), expected.sort());
  const created = [];
  for (const m of modules) {
    await t.test(m.id, async () => {
      assert.ok(m.name && m.description && m.fields.length && m.statuses.length > 1);
      const title = 'Synthetic QA: ' + m.name;
      const value = field => {
        if (field.options?.length) {
          const option = field.options[0];
          return typeof option === 'string' ? option : option.value;
        }
        if (field.type === 'boolean' || field.type === 'checkbox') return true;
        if (field.type === 'date') return '2026-11-25';
        if (field.type === 'number') return 1;
        if (field.type === 'email') return 'synthetic@example.invalid';
        if (field.type === 'url') return 'https://fixture.invalid/';
        return 'Fictional demo evidence.';
      };
      const fields = Object.fromEntries(m.fields.map(field => [field.key, value(field)]));
      const path = 'modules/' + m.id + '/records';
      if (m.id === 'processing') {
        await post(path, 'analyst', { title, fields }, 409);
        return;
      }
      await post(path, 'analyst', { title, fields });
      const record = (await catalog()).records.find(r => r.moduleId === m.id && r.title === title);
      assert.ok(record);
      assert.equal(record.status, m.statuses[0]);
      const advancePath = path + '/' + record.id + '/advance';
      const transition = { reason: 'Synthetic milestone evidence.' };
      const requiresReview = ['Reviewed', 'Approved', 'Recorded'].includes(m.statuses[1]);
      if (requiresReview) await post(advancePath, 'analyst', transition, 403);
      await post(advancePath, requiresReview ? 'reviewer' : 'analyst', transition);
      const advanced = (await catalog()).records.find(r => r.id === record.id);
      assert.equal(advanced.status, m.statuses[1]);
      created.push(advanced);
    });
  }
  await restart();
  const { records } = await catalog();
  for (const record of created) assert.deepEqual(records.find(r => r.id === record.id), record);
});

test('assessment intake assigns separate forms and routing reasons and enforces conditional answers', async t => {
  const {get,post,request,restart}=await harness(t);
  const initial=await get();
  const projectId=initial.projects[0].id;
  assert.equal(initial.assessments.find(a=>a.vendorId==='harbordesk').routing.id,'privacy');
  await post('vendors','analyst',{projectId,name:'Invalid sensitivity declaration',usesAI:false,handlesSensitiveData:'no'},422);
  let state=await post('vendors','analyst',{projectId,name:'Fictional Sensitive AI',usesAI:true,handlesSensitiveData:true});
  const vendor=state.vendors.find(v=>v.name==='Fictional Sensitive AI');
  const items=state.assessments.filter(a=>a.vendorId===vendor.id);
  assert.equal(items.length,2);
  const [privacy,ai]=['privacy','ai'].map(type=>items.find(a=>a.type===type));
  assert.deepEqual([privacy.questionnaire.id,privacy.questionnaire.version,privacy.routing.workflowId],['sensitive',1,'assessment-enhanced-review']);
  assert.deepEqual([ai.questionnaire.id,ai.questionnaire.version,ai.routing.workflowId],['ai',1,'assessment-ai-review']);
  assert.match(privacy.routing.reason,/sensitive information/i);
  assert.match(ai.routing.reason,/uses AI/);
  for(const a of items) {
    const instance=state.assessmentWorkflow.instances.find(w=>w.id===a.workflowInstanceId);
    assert.equal(instance.definitionId,a.routing.workflowId);
    assert.equal(state.audit.find(e=>e.action==='assessment.created'&&e.entityId===a.id).details.routing.reason,a.routing.reason);
  }
  const url=(a,action)=>'assessments/'+a.id+'/'+action;
  const aRow=(s,a)=>s.assessments.find(x=>x.id===a.id);
  const common={summary:'Fictional support testing.',safeguards:'Fictional access review.'};
  const submit=(a,answers,expectedRevision,expected)=>post(url(a,'submit'),'analyst',{expectedRevision,answers},expected);
  const save=(a,answers,expectedRevision,expected)=>post(url(a,'save'),'analyst',{expectedRevision,answers},expected);
  assert.equal((await submit(ai,common,0,422)).code,'REQUIRED_ANSWER');
  assert.equal((await save(ai,{automatedAction:'maybe'},0,422)).code,'INVALID_ANSWER');
  assert.equal((await save(ai,{externalSharing:'No'},0,422)).code,'UNKNOWN_QUESTION');
  assert.equal((await save(ai,{automatedAction:'No',overridePlan:'Inactive text'},0,422)).code,'HIDDEN_QUESTION');
  assert.equal((await submit(ai,{...common,automatedAction:'Yes'},0,422)).code,'REQUIRED_ANSWER');
  assert.deepEqual(aRow(await get(),ai),ai);
  state=await save(ai,{...common,automatedAction:'Yes',overridePlan:'Synthetic operator (draft)'},0,200);
  assert.equal(aRow(state,ai).answers.overridePlan,'Synthetic operator (draft)');
  state=await save(ai,{automatedAction:'No'},1,200);
  assert.equal(Object.hasOwn(aRow(state,ai).answers,'overridePlan'),false);
  assert.equal((await submit(ai,{automatedAction:'Yes'},2,422)).code,'REQUIRED_ANSWER');
  assert.equal((await submit(ai,{automatedAction:'No'},1,409)).code,'STALE_REVISION');
  state=await submit(ai,{automatedAction:'Yes',overridePlan:'A fictional moderator can disable it.'},2,200);
  assert.equal(aRow(state,ai).status,'in_review');
  assert.equal(aRow(state,ai).answers.overridePlan,'A fictional moderator can disable it.');
  assert.equal((await submit(privacy,{...common,externalSharing:'No'},0,422)).code,'REQUIRED_ANSWER');
  const enhanced={...common,sensitiveControls:'Restricted synthetic review.',externalSharing:'Yes'};
  assert.equal((await submit(privacy,enhanced,0,422)).code,'REQUIRED_ANSWER');
  state=await submit(privacy,{...enhanced,sharingLimits:'Synthetic records stay with one fictional processor.'},0,200);
  assert.equal(aRow(state,privacy).status,'in_review');
  state=await post(url(privacy,'approve'),'reviewer',{expectedRevision:1});
  assert.equal(aRow(state,privacy).status,'approved');
  assert.deepEqual(await restart().then(()=>get()),state);
  const exported=(await request('audit/export',200)).body.audit;
  const lastSubmission=exported.find(e=>e.action==='assessment.submitted'&&e.entityId===ai.id);
  assert.equal(lastSubmission.details.questionnaireVersion,1);
  assert.equal(lastSubmission.details.answers.overridePlan,'A fictional moderator can disable it.');
  assert.equal(lastSubmission.details.routing.id,'ai');
});

test('upgrade from workflow-only records preserves their pinned state, history and two-question contract', async t => {
  const {get,post,restart,dataFile}=await harness(t);
  const seeded=await get();
  const assessment=seeded.assessments.find(a=>a.vendorId==='harbordesk');
  const prior={...seeded,assessments:[assessment]};
  const old=structuredClone(prior.assessments[0]);
  delete old.questionnaire;
  delete old.routing;
  prior.assessments[0]=old;
  await require('node:fs/promises').writeFile(dataFile,JSON.stringify(prior));
  await restart();
  const upgraded=await get();
  assert.deepEqual(upgraded.assessmentWorkflow,prior.assessmentWorkflow);
  assert.deepEqual(upgraded.audit.slice(0,prior.audit.length),prior.audit);
  assert.equal(upgraded.audit.at(-1).action,'assessment.questionnaire-baseline');
  const current=upgraded.assessments[0];
  assert.equal(current.questionnaire.id,'baseline');
  assert.equal(current.questionnaire.version,1);
  assert.equal(current.workflowInstanceId,old.workflowInstanceId);
  assert.equal(current.workflowRevision,old.workflowRevision);
  await restart();
  assert.deepEqual(await get(),upgraded);
  const finished=await post('assessments/'+old.id+'/submit','analyst',{
    expectedRevision:old.revision,summary:'Legacy synthetic summary',safeguards:'Legacy synthetic controls'
  });
  assert.equal(finished.assessments[0].status,'in_review');
  assert.equal(finished.assessments[0].questionnaire.id,'baseline');
});

test('privacy rights: deadline, operator reassignment, independent identity, fulfillment and durable audit', async t => {
  const {post,request,restart}=await harness(t);
  const path='rights/cases';
  const readCases=async()=> (await request(path,200)).body;
  const opened={kind:'access',owner:'analyst',days:7,note:'Synthetic data export exercise.'};
  assert.equal((await post(path,'reviewer',opened,403)).code,'INTAKE_REQUIRED');
  assert.equal((await post(path,'analyst',{...opened,days:0},422)).code,'INVALID_DEADLINE');
  assert.equal((await post(path,'analyst',{...opened,days:1.2},422)).code,'INVALID_DEADLINE');
  assert.equal((await post(path,'analyst',{...opened,owner:'reviewer'},422)).code,'INVALID_CHOICE');
  assert.equal((await post(path,'analyst',{...opened,requester:'Not a supported field'},422)).code,'UNKNOWN_FIELDS');
  assert.equal((await readCases()).cases.length,0);
  const first=(await post(path,'analyst',opened)).cases[0];
  const due=new Date(first.receivedAt);due.setUTCDate(due.getUTCDate()+7);
  assert.equal(first.dueDate,due.toISOString().slice(0,10));
  assert.deepEqual(first.clockPolicy,{version:1,days:7,unit:'UTC calendar days'});
  assert.equal(first.overdue,false);
  const act=(action,actor,payload,status)=>post(path+'/'+first.id+'/'+action,actor,payload,status);
  const note='Fictional case documentation.';
  assert.equal((await act('fulfill','analyst',{expectedRevision:1,note},409)).code,'IDENTITY_REQUIRED');
  assert.equal((await act('verify','analyst',{expectedRevision:1,note},403)).code,'INDEPENDENT_REVIEW_REQUIRED');
  assert.equal((await act('assign','analyst',{owner:'case-operator',note},422)).code,'REVISION_REQUIRED');
  await act('assign','analyst',{expectedRevision:1,owner:'case-operator',note},200);
  assert.equal((await act('verify','reviewer',{expectedRevision:1,note},409)).code,'STALE_REVISION');
  const verified=(await act('verify','reviewer',{expectedRevision:2,note},200)).cases[0];
  assert.equal(verified.identity.status,'verified');
  assert.equal(verified.status,'received');
  assert.equal(verified.identity.reviewedBy,'reviewer');
  assert.equal((await act('begin','analyst',{expectedRevision:3,note},403)).code,'OWNER_REQUIRED');
  assert.equal((await act('fulfill','case-operator',{expectedRevision:3,note},409)).code,'ACTION_OUT_OF_ORDER');
  await act('begin','case-operator',{expectedRevision:3,note},200);
  assert.equal((await act('fulfill','case-operator',{expectedRevision:4,note:' '},422)).code,'NOTE_REQUIRED');
  assert.equal((await act('fulfill','case-operator',{expectedRevision:4,note,releasedData:true},422)).code,'UNKNOWN_FIELDS');
  const fulfilled=(await act('fulfill','case-operator',{expectedRevision:4,note},200)).cases[0];
  assert.equal(fulfilled.id,first.id);
  assert.equal(fulfilled.dueDate,first.dueDate);
  assert.equal(fulfilled.status,'fulfilled');
  assert.deepEqual(fulfilled.completion,{method:'simulation-only',releasedData:false,note,documentedBy:'case-operator',documentedAt:fulfilled.closedAt});
  assert.equal((await act('assign','analyst',{expectedRevision:5,owner:'analyst',note},409)).code,'CASE_CLOSED');
  const latest=(await readCases()).cases[0];
  assert.deepEqual(latest.history.filter(e=>e.action!=='rights.case.refused').map(e=>e.action),[
    'rights.case.opened','rights.case.assign','rights.case.verify','rights.case.begin','rights.case.fulfill'
  ]);
  assert.deepEqual(latest.history.filter(e=>e.action==='rights.case.refused').map(e=>e.details.code),[
    'IDENTITY_REQUIRED','INDEPENDENT_REVIEW_REQUIRED','REVISION_REQUIRED','STALE_REVISION',
    'OWNER_REQUIRED','ACTION_OUT_OF_ORDER','NOTE_REQUIRED','UNKNOWN_FIELDS','CASE_CLOSED'
  ]);
  const before=await readCases();
  await restart();
  assert.deepEqual(await readCases(),before);
  const exported=(await request('audit/export',200)).body.audit;
  assert.deepEqual(exported.filter(e=>e.entityId===first.id),latest.history);
});

test('privacy rights: unverified closure is not fulfillment; legacy register remains separate', async t => {
  const {post,request,restart}=await harness(t);
  const path='rights/cases';
  const note='Synthetic identity could not be confirmed.';
  await post('modules/rights/records','analyst',{title:'Legacy entry',fields:{
    requestType:'Access',requester:'Mock L1',owner:'Fictional',due:'2027-01-01',scope:'Test fixture'
  }});
  const opened=await post(path,'analyst',{kind:'deletion',owner:'analyst',days:15,note:'Fictional request.'});
  assert.equal(opened.legacyRecords.length,1);
  assert.equal(opened.cases.length,1);
  const a=path+'/'+opened.cases[0].id+'/';
  assert.equal((await post(a+'close-unverified','analyst',{expectedRevision:1,note},409)).code,'DENIAL_REQUIRED');
  await post(a+'deny-verification','reviewer',{expectedRevision:1,note});
  assert.equal((await post(a+'begin','analyst',{expectedRevision:2,note},409)).code,'IDENTITY_REQUIRED');
  const closed=(await post(a+'close-unverified','analyst',{expectedRevision:2,note})).cases[0];
  assert.equal(closed.identity.status,'not-verified');
  assert.equal(closed.status,'closed-unverified');
  assert.equal(closed.completion,null);
  assert.equal(closed.history.at(-1).details.outcome,'no-disclosure');
  assert.equal((await post(a+'verify','reviewer',{expectedRevision:3,note},409)).code,'CASE_CLOSED');
  await restart();
  const snapshot=(await request(path,200)).body;
  assert.equal(snapshot.cases[0].status,'closed-unverified');
  assert.equal(snapshot.legacyRecords[0].status,'Received');
});

test('incidents: elevated investigation, independent review, revision checks, mock notice plan and durable closure', async t=>{
  const {post,request,restart}=await harness(t);
  const path='incidents/cases', actor='analyst';
  const note='Fictional investigation exercise only.';
  assert.equal((await post(path,'reviewer',{title:'Synthetic event',scope:note},403)).code,'OWNER_REQUIRED');
  const opened=(await post(path,actor,{title:'Synthetic access event',scope:note})).cases[0];
  assert.equal(opened.stage,'logged');
  const act=(action,who,revision,payload,expected)=>post(path+'/'+opened.id+'/'+action,who,{expectedRevision:revision,...payload},expected);
  assert.equal((await act('close',actor,1,{note},409)).code,'OUT_OF_ORDER');
  const triaged=(await act('triage',actor,1,{severity:'high',note},200)).cases[0];
  assert.equal(triaged.branch,'elevated');
  assert.equal((await act('containment',actor,1,{note},409)).code,'STALE_REVISION');
  await act('containment',actor,2,{note:'Fictional access stopped.'},200);
  await act('findings',actor,3,{note},200);
  assert.equal((await act('evidence',actor,4,{reference:'Invalid example',kind:'general',note},422)).code,'INVALID_REFERENCE');
  await act('evidence',actor,4,{reference:'SYN-CASE01',kind:'general',note},200);
  assert.equal((await act('request-review',actor,5,{},409)).code,'INVESTIGATION_INCOMPLETE');
  assert.equal((await act('evidence',actor,5,{reference:'SYN-CASE01',kind:'impact',note},409)).code,'EVIDENCE_EXISTS');
  const incomplete=(await act('evidence',actor,5,{reference:'SYN-CASE02',kind:'general',note},200)).cases[0];
  assert.equal(incomplete.readyForReview,false);
  const complete=(await act('evidence',actor,6,{reference:'SYN-IMPACT01',kind:'impact',note},200)).cases[0];
  assert.equal(complete.readyForReview,true);
  await act('request-review',actor,7,{},200);
  assert.equal((await act('decide',actor,8,{decision:'required',note},403)).code,'INDEPENDENT_REVIEW_REQUIRED');
  const returned=(await act('decide','reviewer',8,{decision:'more-information',note},200)).cases[0];
  assert.equal(returned.stage,'investigating');
  assert.equal(returned.readyForReview,false);
  assert.equal((await act('request-review',actor,9,{},409)).code,'REVIEW_UPDATE_REQUIRED');
  assert.equal((await act('findings',actor,9,{note},409)).code,'NO_CHANGE');
  await act('findings',actor,9,{note:'Fictional new evidence addressed in updated findings.'},200);
  await act('request-review',actor,10,{},200);
  const reviewed=(await act('decide','reviewer',11,{decision:'required',note},200)).cases[0];
  assert.equal(reviewed.stage,'notice-planning');
  assert.equal(reviewed.review.mode,'simulation-only');
  assert.equal((await act('close',actor,12,{note},409)).code,'OUT_OF_ORDER');
  assert.equal((await act('plan-notice',actor,12,{reference:'SYN-PLAN01',note,sent:true},422)).code,'UNKNOWN_FIELDS');
  await act('plan-notice',actor,12,{reference:'SYN-PLAN01',note},200);
  const closed=(await act('close',actor,13,{note},200)).cases[0];
  assert.equal(closed.id,opened.id);
  assert.equal(closed.stage,'closed');
  assert.equal(closed.noticePlan.sent,false);
  assert.equal(closed.review.by,'reviewer');
  assert.equal((await act('triage',actor,14,{severity:'low',note},409)).code,'CASE_CLOSED');
  const before=(await request(path,200)).body;
  await restart();
  assert.deepEqual((await request(path,200)).body,before);
  assert.deepEqual((await request('audit/export',200)).body.audit.filter(x=>x.entityId===opened.id),before.cases[0].history);
  const refusalCodes=before.cases[0].history.filter(x=>x.action==='incident.case.refused').map(x=>x.details.code);
  assert.deepEqual(refusalCodes,['OUT_OF_ORDER','STALE_REVISION','INVALID_REFERENCE','INVESTIGATION_INCOMPLETE','EVIDENCE_EXISTS',
    'INDEPENDENT_REVIEW_REQUIRED','REVIEW_UPDATE_REQUIRED','NO_CHANGE','OUT_OF_ORDER','UNKNOWN_FIELDS','CASE_CLOSED']);
});

test('incidents: low severity can close without a mock notice after review and legacy register is untouched',async t=>{
  const {post}=await harness(t);
  const path='incidents/cases';
  const note='All information in this record is fictional.';
  await post('modules/incidents/records','analyst',{title:'Legacy sample',fields:{owner:'Demo',severity:'Low',detected:'2026-01-01',scope:note}});
  const logged=await post(path,'analyst',{title:'Fictional finding',scope:note});
  assert.equal(logged.legacyRecords.length,1);
  let current=logged.cases[0];
  const act=async(action,actor,payload)=>{
    const next=await post(path+'/'+current.id+'/'+action,actor,{expectedRevision:current.revision,...payload});
    current=next.cases[0];return next;
  };
  await act('triage','analyst',{severity:'low',note});
  assert.equal(current.branch,'standard');
  await act('containment','analyst',{note});
  await act('findings','analyst',{note});
  await act('evidence','analyst',{note,reference:'SYN-TRACE01',kind:'general'});
  await act('request-review','analyst',{});
  await act('decide','reviewer',{decision:'not-required',note});
  const closed=await act('close','analyst',{note});
  assert.equal(current.stage,'closed');
  assert.equal(current.noticePlan,null);
  assert.deepEqual(closed.legacyRecords,logged.legacyRecords);
});

test('data map: typed active flows, transitive lineage, correct archival, and export survive restart',async t=>{
  const {post,request,restart}=await harness(t);
  const path='data-map', actor='analyst';
  const map=async()=> (await request(path,200)).body;
  const note='Fictional mapped relationship.';
  const getLineage=async id=>(await request(path+'/nodes/'+id+'/lineage',200)).body;
  await post('modules/inventory/records',actor,{title:'Legacy fixture',fields:{
    owner:'Fictional',source:'Mock A',destination:'Mock B',categories:'Synthetic',residency:'Mock region'
  }});
  const empty=await map();
  assert.equal(empty.nodes.length,0);
  assert.equal(empty.legacyRecords.length,1);
  async function add(type,name){
    const next=await post(path+'/nodes',actor,{expectedRevision:(await map()).revision,type,name,owner:'Fictional owner',detail:note});
    return next.nodes.find(n=>n.name===name).id;
  }
  const system=await add('system','Example host A'), raw=await add('dataset','Raw fixture'),
    activity=await add('activity','Fixture activity'), curated=await add('dataset','Curated fixture');
  async function link(type,fromId,toId,expected=200,fromRevision){
    return post(path+'/links',actor,{expectedRevision:fromRevision??(await map()).revision,type,fromId,toId,note},expected);
  }
  assert.equal((await link('hosts',raw,system,422)).code,'INCOMPATIBLE_TYPES');
  assert.equal((await link('hosts',system,'missing',422)).code,'INVALID_ENDPOINT');
  assert.equal((await link('transfers',raw,raw,409)).code,'CYCLE');
  assert.equal((await link(['hosts'],system,raw,422)).code,'INVALID_LINK_TYPE');
  await link('hosts',system,raw);
  assert.equal((await link('hosts',system,raw,409)).code,'DUPLICATE_LINK');
  assert.equal((await link('reads',raw,activity,409,4)).code,'STALE_REVISION');
  await link('reads',raw,activity);
  await link('writes',activity,curated);
  assert.equal((await link('transfers',curated,system,409)).code,'CYCLE');
  const graph=await map();
  assert.equal(graph.revision,7);
  assert.deepEqual(graph.nodes.find(n=>n.id===raw).usage,{incoming:1,outgoing:1});
  assert.deepEqual((await getLineage(system)).downstream.map(n=>n.id),[raw,activity,curated]);
  assert.deepEqual((await getLineage(curated)).upstream.map(n=>n.id),[activity,raw,system]);
  const first=graph.links[0];
  assert.equal((await post(path+'/links/'+first.id+'/archive',actor,{expectedRevision:7,note,fromId:activity},422)).code,'UNKNOWN_FIELDS');
  assert.equal((await post(path+'/nodes/'+system+'/archive',actor,{expectedRevision:7,note},409)).code,'ACTIVE_LINKS');
  assert.equal((await post(path+'/nodes/'+system+'/update','reviewer',{expectedRevision:7,name:'Reviewer edit',owner:'Fictional owner',detail:note},403)).code,'EDITOR_REQUIRED');
  await post(path+'/nodes/'+system+'/update',actor,{expectedRevision:7,name:'Renamed host',owner:'Fictional owner',detail:note});
  const archived=await post(path+'/links/'+first.id+'/archive',actor,{expectedRevision:8,note});
  assert.equal(archived.links[0].fromId,system);
  assert.ok(archived.links[0].archivedAt);
  assert.deepEqual((await getLineage(system)).downstream,[]);
  await post(path+'/nodes/'+system+'/archive',actor,{expectedRevision:9,note});
  assert.equal((await link('hosts',system,raw,422)).code,'INVALID_ENDPOINT');
  assert.equal((await request(path+'/nodes/00000000-0000-0000-0000-000000000000/lineage',404)).body.code,'NODE_NOT_FOUND');
  const before=await map();
  const snapshot=await request(path+'/export',200);
  assert.match(snapshot.response.headers.get('content-disposition'),/attachment/);
  assert.deepEqual(snapshot.body.graph,before);
  assert.equal(snapshot.body.mode,'synthetic-demo');
  assert.equal(snapshot.body.audit.filter(e=>e.action==='data-map.link.created').length,3);
  assert.equal(snapshot.body.audit.filter(e=>e.details.code==='CYCLE').length,2);
  assert.deepEqual(snapshot.body.graph.legacyRecords,empty.legacyRecords);
  await restart();
  assert.deepEqual((await request(path+'/export',200)).body,snapshot.body);
});

test('data map tab and assets are served by the workbench',async t=>{
  const {request}=await harness(t);
  const {response}=await request('data-map',200);
  const base=new URL(response.url).origin;
  const main=await fetch(base+'/');
  assert.equal(main.status,200);
  const html=await main.text();
  assert.match(html,/id="show-data-map"/);
  assert.match(html,/id="data-map-view"/);
  const js=await fetch(base+'/data-map-ui.js');
  assert.match(js.headers.get('content-type'),/text\/javascript/);
  assert.match(await js.text(),/renderDataMap/);
});

test('privacy notices remain independently reviewed, immutable, and durable without consent features',async t=>{
  const {post,request,restart}=await harness(t);
  const root='privacy-notices';
  const model=async()=>(await request(root,200)).body;
  const draft={expectedRevision:0,scope:'synthetic-portal',channel:'web',title:'Fictional notice',content:'Synthetic notice text.'};
  assert.equal((await post(root+'/notices','reviewer',draft,403)).code,'AUTHOR_REQUIRED');
  const ready=await post(root+'/notices','analyst',draft),first=ready.notices[0],path=root+'/notices/'+first.id;
  await post(path+'/submit','analyst',{expectedRevision:1});
  await post(path+'/publish','analyst',{expectedRevision:2,note:'Self review not permitted'},403);
  const published=await post(path+'/publish','reviewer',{expectedRevision:2,note:'Synthetic independent review'});
  assert.equal(published.notices[0].status,'published');
  assert.equal((await post(path+'/edit','analyst',{expectedRevision:3,title:'Changed',content:'Changed'},409)).code,'NOTICE_IMMUTABLE');
  await post(root+'/evaluate','analyst',{},404);
  await post(root+'/events','analyst',{},404);
  await post('modules/consent/records','analyst',{},404);
  await post('modules/cookies/records','analyst',{},404);
  assert.equal((await model()).events,undefined);
  assert.ok((await request('audit/export',200)).body.audit.some(e=>e.action==='privacy-notices.notice.publish'));
  await restart();
  assert.deepEqual((await model()).notices,published.notices);
});

test('retention: versioned approvals, UTC due boundary, active hold at execution and no mutation',async t=>{
  const {post,request,restart}=await harness(t);
  const root='retention';
  const readBook=async()=>(await request(root,200)).body;
  let book=await readBook();
  async function mutate(url,actor,data,expected=200,rev=book.revision){
    const reply=await post(root+'/'+url,actor,{...data,expectedRevision:rev},expected);
    if(expected===200)book=reply;
    return reply;
  }
  const fixture={reference:'SYN-CUST01',category:'demo-customer',createdOn:'2024-02-28'};
  assert.equal((await mutate('records','analyst',{...fixture,createdOn:'2023-02-29'},422)).code,'INVALID_DATE');
  assert.equal((await mutate('records','analyst',{...fixture,closedOn:'2024-02-01'},422)).code,'BAD_ORDER');
  await mutate('records','analyst',fixture);
  const row=book.records[0], note='Fictional policy exercise.';
  assert.equal((await mutate('records','analyst',fixture,409)).code,'DUPLICATE_REFERENCE');
  const preview=async asOf=>(await mutate('previews','analyst',{recordId:row.id,asOf})).previews.at(-1);
  assert.equal((await preview('2024-03-01')).reason,'NO_ACTIVE_SCHEDULE');
  const draft={category:row.category,title:'Synthetic customer series',days:2,trigger:'created',disposition:'delete'};
  assert.equal((await mutate('schedules','analyst',{...draft,days:0},422)).code,'INVALID_PERIOD');
  await mutate('schedules','analyst',draft);
  const sid=book.schedules[0].id, schedule='schedules/'+sid+'/';
  assert.equal((await mutate(schedule+'activate','reviewer',{note},409)).code,'OUT_OF_ORDER');
  await mutate(schedule+'submit','analyst',{});
  assert.equal((await mutate(schedule+'activate','analyst',{note},403)).code,'INDEPENDENT_REVIEW_REQUIRED');
  await mutate(schedule+'return','reviewer',{note});
  const {category,...editable}=draft;
  await mutate(schedule+'edit','analyst',{...editable,title:'Corrected fictional schedule'});
  await mutate(schedule+'submit','analyst',{});
  await mutate(schedule+'activate','reviewer',{note});
  const activated=structuredClone(book.schedules[0]);
  assert.equal((await mutate(schedule+'edit','analyst',editable,409)).code,'SCHEDULE_IMMUTABLE');
  const early=await preview('2024-02-29');
  assert.equal(early.dueOn,'2024-03-01');
  assert.equal(early.reason,'BEFORE_DUE_DATE');
  assert.equal((await mutate('previews/'+early.id+'/simulate','analyst',{},409)).code,'PREVIEW_NOT_ELIGIBLE');
  const ready=await preview('2024-03-01');
  assert.equal(ready.eligible,true);
  assert.equal((await mutate('holds','analyst',{recordId:row.id,note},409,0)).code,'STALE_REVISION');
  await mutate('holds','analyst',{recordId:row.id,note});
  const hold=book.holds[0].id;
  const holdPreview=await preview('2024-03-01');
  assert.equal(holdPreview.reason,'ACTIVE_HOLD');
  assert.deepEqual(holdPreview.holdIds,[hold]);
  const simulate='previews/'+ready.id+'/simulate';
  assert.equal((await mutate(simulate,'analyst',{},409)).code,'ACTIVE_HOLD');
  assert.equal((await mutate('holds/'+hold+'/release','analyst',{note},403)).code,'INDEPENDENT_REVIEW_REQUIRED');
  await mutate('holds/'+hold+'/release','reviewer',{note});
  await mutate('schedules','analyst',{...draft,days:5});
  const v2='schedules/'+book.schedules[1].id+'/';
  await mutate(v2+'submit','analyst',{});
  await mutate(v2+'activate','reviewer',{note});
  assert.equal((await mutate(simulate,'analyst',{},409)).code,'PREVIEW_OUTDATED');
  const newPreview=await preview('2024-03-04');
  assert.equal(newPreview.scheduleVersion,2);
  assert.equal(newPreview.eligible,true);
  const newSimulate='previews/'+newPreview.id+'/simulate';
  await mutate(newSimulate,'analyst',{});
  assert.equal((await mutate(newSimulate,'analyst',{},409)).code,'ALREADY_SIMULATED');
  const again=await preview('2024-03-05');
  assert.equal((await mutate('previews/'+again.id+'/simulate','analyst',{},409)).code,'ALREADY_SIMULATED');
  assert.deepEqual(book.records,[row]);
  assert.deepEqual(book.schedules[0],activated);
  assert.equal(book.runs[0].deleted,false);
  assert.equal(book.runs[0].changedRecord,false);
  const snapshot=await readBook();
  await restart();
  assert.deepEqual(await readBook(),snapshot);
  const audit=(await request('audit/export',200)).body.audit;
  assert.equal(audit.filter(e=>e.action==='retention.previews.simulate').length,1);
  assert.equal(audit.filter(e=>e.details?.code==='ACTIVE_HOLD').length,1);
  assert.equal(audit.find(e=>e.action==='retention.previews.simulate').details.mode,'audit-only');
});

test('retention: fixture closing trigger and legacy register are isolated from schedule evaluation',async t=>{
  const {post,request}=await harness(t);
  await post('modules/retention/records','analyst',{title:'Legacy fixture',fields:{
    owner:'Synthetic',category:'Demo',trigger:'Creation',period:'30 days',disposition:'Delete',rationale:'Fictional scenario'
  }});
  const root='retention';
  let view=(await request(root,200)).body;
  assert.equal(view.legacyRecords.length,1);
  assert.equal(view.schedules.length,0);
  const act=async(url,actor,body)=>{view=await post(root+'/'+url,actor,{...body,expectedRevision:view.revision})};
  await act('schedules','analyst',{category:'demo-employee',title:'Fictional archive',days:5,trigger:'closed',disposition:'archive'});
  const schedule='schedules/'+view.schedules[0].id+'/';
  await act(schedule+'submit','analyst',{});
  await act(schedule+'activate','reviewer',{note:'Synthetic and independent.'});
  await act('records','analyst',{reference:'SYN-OPEN01',category:'demo-employee',createdOn:'2024-01-01'});
  await act('previews','analyst',{recordId:view.records[0].id,asOf:'2030-01-01'});
  assert.equal(view.previews[0].reason,'TRIGGER_NOT_RECORDED');
  assert.equal(view.legacyRecords[0].status,'Draft');
  const base=(await request(root,200)).response.url;
  const main=await fetch(new URL('/',base));
  assert.match(await main.text(),/id="show-retention"/);
  const js=await fetch(new URL('/retention-ui.js',base));
  assert.equal(js.status,200);
  assert.match(await js.text(),/renderRetention/);
});

test('risk controls: residual scores count only independently verified links and latest accepted passing evidence',async t=>{
  const {post,request,restart}=await harness(t);
  const root='risk-controls', read=async()=>(await request(root,200)).body;
  let view=await read();
  async function run(url,actor,body,expected=200,revision=view.revision){
    const result=await post(root+'/'+url,actor,{...body,expectedRevision:revision},expected);
    if(expected===200)view=result;
    return result;
  }
  const note='Fictional methodology exercise.';
  const risk={title:'Fictional access mistake',scenario:note,likelihood:5,impact:4};
  assert.equal((await run('risks','analyst',{...risk,impact:6},422)).code,'INVALID_SCORE');
  await run('risks','analyst',risk);
  const r=()=>view.risks[0], riskId=r().id;
  assert.deepEqual(r().inherent,{likelihood:5,impact:4,value:20,tier:'critical'});
  await run('controls','analyst',{title:'Fictional staff review',intent:note});
  await run('controls','analyst',{title:'Fictional release check',intent:note});
  const [c1,c2]=view.controls;
  const link={riskId,controlId:c1.id,likelihoodReduction:2,impactReduction:1,note};
  assert.equal((await run('links','analyst',{...link,controlId:'missing'},404)).code,'RECORD_NOT_FOUND');
  await run('links','analyst',link);
  const l1=r().links[0];
  assert.equal((await run('links','analyst',link,409)).code,'LINK_EXISTS');
  const result={controlId:c1.id,outcome:'pass',evidenceReference:'SYN-CHECK01',note};
  assert.equal((await run('tests','analyst',{...result,evidenceReference:'https://example.org'},422)).code,'INVALID_EVIDENCE');
  await run('tests','analyst',result);
  const first=view.tests[0];
  assert.equal((await run('tests/'+first.id+'/accept','analyst',{note},403)).code,'INDEPENDENT_REVIEW_REQUIRED');
  await run('tests/'+first.id+'/accept','reviewer',{note});
  assert.equal(r().residual.value,20);
  assert.equal(r().links[0].reason,'link-awaiting-review');
  await run('links/'+l1.id+'/verify','reviewer',{note});
  assert.equal(r().residual.value,9);
  assert.deepEqual(r().reduction,{likelihood:2,impact:1});
  await run('links','analyst',{...link,controlId:c2.id,likelihoodReduction:1});
  await run('links/'+r().links[1].id+'/verify','reviewer',{note});
  await run('tests','analyst',{...result,controlId:c2.id,evidenceReference:'SYN-CHECK02'});
  assert.equal(r().links[1].reason,'awaiting-independent-review');
  await run('tests/'+view.tests.at(-1).id+'/accept','reviewer',{note});
  assert.equal(r().residual.value,9);
  await run('tests','analyst',{...result,outcome:'fail',evidenceReference:'SYN-CHECK03'});
  assert.equal(r().residual.value,12);
  assert.equal(r().links[0].reason,'latest-test-failed');
  await run('tests','analyst',{...result,evidenceReference:'SYN-CHECK04'});
  const changed=view.tests.at(-1);
  assert.equal((await run('tests/'+view.tests.at(-2).id+'/accept','reviewer',{note},409)).code,'SUPERSEDED_TEST');
  await run('tests/'+changed.id+'/reject','reviewer',{note});
  assert.equal(r().links[0].reason,'review-rejected');
  assert.equal((await run('tests/'+changed.id+'/accept','reviewer',{note},409)).code,'TEST_IMMUTABLE');
  assert.equal((await run('risks/'+riskId+'/score','analyst',{likelihood:2,impact:2,note},409,1)).code,'STALE_REVISION');
  await run('risks/'+riskId+'/score','analyst',{likelihood:2,impact:2,note});
  assert.equal(r().residual.value,1);
  await run('links/'+r().links[1].id+'/unlink','analyst',{note});
  assert.equal(r().residual.value,4);
  const expected=await read();
  const exported=await request(root+'/export',200);
  assert.match(exported.response.headers.get('content-disposition'),/attachment/);
  assert.deepEqual(exported.body.program,expected);
  assert.ok(exported.body.audit.filter(e=>e.action==='risk-controls.refused').every(e=>e.details.scoreRuleVersion===1));
  assert.equal(exported.body.audit.filter(e=>e.action==='risk-controls.links.verify').length,2);
  await restart();
  assert.deepEqual(await read(),expected);
});

test('risk and controls: legacy register and new workbench assets stay distinct',async t=>{
  const {post,request}=await harness(t);
  await post('modules/risks/records','analyst',{title:'Historical fictional risk',fields:{
    owner:'Fictional',rating:'High',scenario:'Example',plan:'Example'
  }});
  const {body,response}=await request('risk-controls',200);
  assert.equal(body.legacyRecords.length,1);
  assert.equal(body.risks.length,0);
  const html=await fetch(new URL('/',response.url));
  assert.match(await html.text(),/id="show-risk-controls"/);
  const js=await fetch(new URL('/risk-controls-ui.js',response.url));
  assert.equal(js.status,200);
  assert.match(await js.text(),/renderRiskControls/);
});

test('vendor monitoring: exact assessment approvals, independent evidence review and fresh reassessment',async t=>{
  const {get,post,request,restart}=await harness(t);
  const root='vendor-monitoring',read=async()=>(await request(root,200)).body;
  let view=await read();
  async function call(route,actor,payload,expected=200,rev=view.revision){
    const out=await post(root+'/'+route,actor,{...payload,expectedRevision:rev},expected);
    if(expected===200)view=out;
    return out;
  }
  const note='Fictional due diligence test.', vendor=view.vendors.find(v=>v.usesAI);
  const input={vendorId:vendor.id,criticality:4,exposure:3};
  assert.equal((await call('cases','analyst',{...input,vendorId:'absent'},404)).code,'VENDOR_NOT_FOUND');
  assert.equal((await call('cases','analyst',{...input,criticality:6},422)).code,'INVALID_FACTOR');
  await call('cases','analyst',input);
  const cur=()=>view.cases[0],cycle=()=>cur().cycles.at(-1), path='cases/'+cur().id+'/';
  const act=(action,body={},actor='analyst',expected=200)=>call(path+action,actor,body,expected);
  assert.equal(cycle().factors.score,14);
  assert.equal(cycle().factors.tier,'high');
  assert.equal((await call('cases','analyst',input,409)).code,'VENDOR_ALREADY_TRACKED');
  assert.equal((await act('submit',{},'analyst',422)).code,'EVIDENCE_REQUIRED');
  assert.equal((await act('evidence',{reference:'real-looking.invalid',note},'analyst',422)).code,'INVALID_EVIDENCE');
  await act('evidence',{reference:'SYN-VENDOR01',note});
  assert.equal((await act('submit',{},'analyst',409)).code,'ASSESSMENTS_NOT_APPROVED');
  async function approveAssessment(a){
    const p='assessments/'+a.id+'/';
    await post(p+'submit','analyst',{expectedRevision:a.revision,answers:{
      summary:'Fictional summary',safeguards:'Fictional controls',
      ...(a.type==='ai'?{automatedAction:'No'}:{externalSharing:'No'})
    }});
    await post(p+'approve','reviewer',{expectedRevision:a.revision+1,note});
  }
  const originals=(await get()).assessments.filter(a=>a.vendorId===vendor.id);
  await approveAssessment(originals[0]);
  assert.equal((await act('submit',{},'analyst',409)).code,'ASSESSMENTS_NOT_APPROVED');
  await approveAssessment(originals[1]);
  await act('submit');
  assert.equal((await act('approve',{note},'analyst',403)).code,'INDEPENDENT_REVIEW_REQUIRED');
  await act('return',{note},'reviewer');
  assert.equal((await act('submit',{},'analyst',409)).code,'FRESH_EVIDENCE_REQUIRED');
  await act('evidence',{reference:'SYN-VENDOR02',note});
  await act('submit');
  await act('approve',{note},'reviewer');
  assert.equal(cur().status,'monitoring');
  const priorCycle=structuredClone(cycle());
  const expectedDue=new Date(priorCycle.review.at);
  expectedDue.setUTCDate(expectedDue.getUTCDate()+90);
  assert.equal(cur().renewalDueDate,expectedDue.toISOString().slice(0,10));
  assert.deepEqual(cycle().assessmentSnapshot.map(x=>x.id),originals.map(x=>x.id));
  await act('change',{criticality:5,exposure:5,note});
  assert.equal(cur().status,'collecting');
  assert.equal(cur().renewalDueDate,null);
  assert.equal(cycle().factors.tier,'critical');
  assert.deepEqual(cur().cycles[0],priorCycle);
  assert.ok(cur().assessmentStatus.every(a=>a.status==='draft'&&!originals.some(old=>old.id===a.id)));
  await act('evidence',{reference:'SYN-VENDOR03',note});
  assert.equal((await act('submit',{},'analyst',409)).code,'ASSESSMENTS_NOT_APPROVED');
  const fresh=(await get()).assessments.filter(a=>a.monitoringCycleId===cycle().assessmentCycleId);
  assert.equal(fresh.length,2);
  for(const a of fresh)await approveAssessment(a);
  await act('submit');
  await act('approve',{note},'reviewer');
  assert.equal(cur().status,'monitoring');
  assert.deepEqual(cycle().assessmentSnapshot.map(x=>x.id),fresh.map(x=>x.id));
  const before=await read();
  const audit=(await request('audit/export',200)).body.audit;
  assert.equal(audit.filter(e=>e.action==='vendor-monitoring.approve').length,2);
  assert.match(audit.find(e=>e.action==='vendor-monitoring.refused'&&e.details.code==='FRESH_EVIDENCE_REQUIRED').projectId,/demo/);
  await restart();
  assert.deepEqual(await read(),before);
});

test('vendor monitoring tab and script are served by the workbench',async t=>{
  const {request}=await harness(t);
  const result=await request('vendor-monitoring',200);
  const base=result.response.url;
  assert.match(await (await fetch(new URL('/',base))).text(),/id="show-vendor-monitoring"/);
  const js=await fetch(new URL('/vendor-monitoring-ui.js',base));
  assert.equal(js.status,200);
  assert.match(await js.text(),/renderVendorMonitoring/);
});

test('work queue: role and workflow filters, live transitions, stable task IDs and scoped download',async t=>{
  const {get,post,request,restart,dataFile}=await harness(t);
  const queue=async(query='')=>(await request('work-queue'+query,200)).body;
  const note='Fictional work queue exercise.';
  const record=(await post('rights/cases','analyst',{kind:'access',owner:'case-operator',days:5,note})).cases[0];
  const a=(await get()).assessments.find(x=>x.vendorId==='harbordesk');
  const ap='assessments/'+a.id+'/';
  await post(ap+'submit','analyst',{expectedRevision:0,answers:{summary:note,safeguards:note,externalSharing:'No'}});
  await post('incidents/cases','analyst',{title:'Fictional queue event',scope:note});
  await post('vendor-monitoring/cases','analyst',{vendorId:'harbordesk',criticality:3,exposure:3,expectedRevision:0});
  const n=(await post('privacy-notices/notices','analyst',{expectedRevision:0,scope:'synthetic-queue',channel:'web',
    title:'Fictional work notice',content:note})).notices[0];
  await post('privacy-notices/notices/'+n.id+'/submit','analyst',{expectedRevision:1});
  const s=(await post('retention/schedules','analyst',{expectedRevision:0,category:'demo-customer',title:'Fictional queue schedule',
    days:5,trigger:'created',disposition:'archive'})).schedules[0];
  await post('retention/schedules/'+s.id+'/submit','analyst',{expectedRevision:1});
  const c=(await post('risk-controls/controls','analyst',{expectedRevision:0,title:'Fictional queue control',intent:note})).controls[0];
  const r=(await post('risk-controls/tests','analyst',{expectedRevision:1,controlId:c.id,outcome:'pass',
    evidenceReference:'SYN-QUEUE01',note})).tests[0];
  const dataset=await get();
  // Move only the synthetic fixture's date into the past to verify overdue output.
  dataset.rightsCases[0].dueDate='2001-01-01';
  await require('node:fs/promises').writeFile(dataFile,JSON.stringify(dataset));
  await restart();
  const all=await queue();
  assert.deepEqual(new Set(all.tasks.map(x=>x.workflow)),new Set(['assessments','rights','incidents','vendor-monitoring','preferences','retention','risk-controls']));
  assert.equal(all.tasks[0].sourceId,record.id);
  assert.equal(all.tasks[0].timing,'overdue');
  assert.equal(all.counts.overdue,1);
  const reviewer=await queue('?owner=reviewer');
  assert.equal(reviewer.counts.total,5);
  assert.ok(reviewer.tasks.every(x=>x.owner==='reviewer'));
  const narrow='?owner=reviewer&workflow=rights&timing=overdue';
  const right=await queue(narrow);
  assert.deepEqual(right.tasks.map(x=>x.id),['rights:'+record.id+':verify']);
  const {body:download,response}=await request('work-queue/export'+narrow,200);
  assert.match(response.headers.get('content-disposition'),/attachment/);
  assert.deepEqual(download,{schemaVersion:1,...right});
  assert.equal((await request('work-queue?owner=wrong',422)).body.code,'INVALID_QUEUE_FILTER');
  assert.equal((await request('work-queue?owner=analyst&owner=reviewer',422)).body.code,'INVALID_QUEUE_FILTER');
  assert.equal((await request('work-queue?unsupported=yes',422)).body.code,'INVALID_QUEUE_FILTER');
  const current=await queue();
  assert.deepEqual(current.tasks.map(x=>x.id),all.tasks.map(x=>x.id));
  assert.equal(Object.hasOwn(await get(),'workQueue'),false);
  await post(ap+'approve','reviewer',{expectedRevision:1});
  await post('retention/schedules/'+s.id+'/activate','reviewer',{expectedRevision:2,note});
  await post('privacy-notices/notices/'+n.id+'/publish','reviewer',{expectedRevision:2,note});
  await post('risk-controls/tests/'+r.id+'/accept','reviewer',{expectedRevision:2,note});
  await post('rights/cases/'+record.id+'/verify','reviewer',{expectedRevision:1,note});
  assert.equal((await queue('?owner=reviewer')).tasks.length,0);
  const own=await queue('?owner=case-operator');
  assert.equal(own.tasks[0].action,'begin');
  await post('rights/cases/'+record.id+'/begin','case-operator',{expectedRevision:2,note});
  assert.equal((await queue('?owner=case-operator')).tasks[0].action,'fulfill');
  await post('rights/cases/'+record.id+'/fulfill','case-operator',{expectedRevision:3,note});
  assert.equal((await queue('?owner=case-operator')).tasks.length,0);
  assert.equal((await queue('?timing=overdue')).tasks.length,0);
  const base=response.url;
  assert.match(await (await fetch(new URL('/',base))).text(),/id="show-queue"/);
  assert.match(await (await fetch(new URL('/work-queue-ui.js',base))).text(),/focusWorkRecord/);
});

test('governance documents: immutable publication, typed links, scoped access and durable evidence trail',async t=>{
  const {get,post,request,restart}=await harness(t);
  const root='governance-documents', text='Original fictional text unique to the document fixture.';
  const readonly=async actor=>(await request(root,200,{headers:{'X-Demo-Actor':actor}})).body;
  await request(root,403);
  const right=(await post('rights/cases','analyst',{kind:'access',owner:'case-operator',days:2,note:'Fictional rights action.'})).cases[0];
  const incident=(await post('incidents/cases','analyst',{title:'Fictional case',scope:'Fictional scope'})).cases[0];
  const input={kind:'evidence',title:'Fictional document',content:text,links:[{type:'rights-case',id:right.id}]};
  let view=await readonly('analyst');
  async function run(path,actor,body,expected=200){
    const out=await post(root+'/'+path,actor,{...body,expectedRevision:view.revision},expected);
    if(expected===200&&Object.hasOwn(out,'documents'))view=out;
    return out;
  }
  assert.equal((await run('records','case-operator',input,403)).code,'AUTHOR_REQUIRED');
  assert.equal((await run('records','analyst',{...input,links:[]},422)).code,'LINKS_REQUIRED');
  assert.equal((await run('records','analyst',{...input,links:[{type:'incident',id:right.id}]},422)).code,'INVALID_LINK');
  assert.equal((await run('records','analyst',{...input,links:[...input.links,...input.links]},409)).code,'DUPLICATE_LINK');
  await run('records','analyst',input);
  let d=view.documents[0], v=d.revisions[0];
  const rootDoc='records/'+d.id+'/', p=rootDoc+'revisions/'+v.id+'/';
  assert.equal(Object.hasOwn(v,'content'),false);
  assert.deepEqual((await readonly('case-operator')).documents,[]);
  assert.equal((await run(p+'read','case-operator',{},403)).code,'DOCUMENT_READ_DENIED');
  assert.equal((await run(p+'publish','reviewer',{note:'Fictional basis'},409)).code,'OUT_OF_ORDER');
  await run(p+'submit','analyst',{});
  assert.equal((await run(p+'publish','analyst',{note:'Fictional basis'},403)).code,'INDEPENDENT_REVIEW_REQUIRED');
  assert.equal((await run(p+'read','reviewer',{})).text,text);
  await run(p+'return','reviewer',{note:'Clarify the fixture.'});
  const edited='Revised '+text;
  await run(p+'edit','analyst',{title:input.title,content:edited,links:input.links});
  await run(p+'submit','analyst',{});
  await run(p+'publish','reviewer',{note:'Independent fictional review.'});
  v=view.documents[0].revisions[0];
  const hash=require('node:crypto').createHash('sha256').update(edited).digest('hex');
  assert.equal(v.contentHash,hash);
  assert.equal((await run(p+'edit','analyst',{title:input.title,content:text,links:input.links},409)).code,'IMMUTABLE_REVISION');
  assert.equal((await readonly('case-operator')).documents[0].currentRevisionId,v.id);
  const downloaded=await run(p+'download','case-operator',{});
  assert.equal(downloaded.filename,'synthetic-evidence-v1.txt');
  assert.equal(downloaded.text,edited);
  await run(rootDoc+'revise','analyst',{title:'Fictional revision two',content:'Other original fiction.',
    links:[{type:'incident',id:incident.id}]});
  d=view.documents[0];
  const v2=d.revisions[1], p2=rootDoc+'revisions/'+v2.id+'/';
  await run(p2+'submit','analyst',{});
  await run(p2+'publish','reviewer',{note:'Reviewed the fictional incident evidence.'});
  assert.equal(view.documents[0].currentRevisionId,v2.id);
  assert.deepEqual(view.documents[0].revisions[0],v);
  assert.equal((await run(p2+'read','case-operator',{},403)).code,'DOCUMENT_READ_DENIED');
  assert.equal((await run(p+'read','case-operator',{})).text,edited);
  const global=await get();
  assert.equal(Object.hasOwn(global,'governanceDocuments'),false);
  assert.doesNotMatch(JSON.stringify(global),/unique to the document fixture/);
  assert.doesNotMatch(JSON.stringify(await post('projects','analyst',{name:'Unrelated extra fictional project'})),/unique to the document fixture/);
  const audit=(await request('audit/export',200)).body.audit;
  assert.doesNotMatch(JSON.stringify(audit),/unique to the document fixture/);
  assert.equal(audit.filter(e=>e.action==='governance-documents.refused'&&e.details.code==='DOCUMENT_READ_DENIED').length,2);
  assert.equal(audit.find(e=>e.action==='governance-documents.download').details.hash,hash);
  const prior=view;
  await restart();
  assert.deepEqual(await readonly('analyst'),prior);
});

test('governance policy workbench serves typed policy and evidence view without exposing drafts to operators',async t=>{
  const {post,request}=await harness(t);
  const root='governance-documents';
  const result=await request(root,200,{headers:{'X-Demo-Actor':'case-operator'}});
  const base=result.response.url;
  assert.equal(result.body.documents.length,0);
  assert.match(await (await fetch(new URL('/',base))).text(),/id="show-governance-docs"/);
  assert.match(await (await fetch(new URL('/governance-docs-ui.js',base))).text(),/renderDocs/);
  const first=await post(root+'/records','analyst',{expectedRevision:0,kind:'policy',title:'Fictional policy',content:'Local fictional study.',links:[]});
  const d=first.documents[0], v=d.revisions[0], sub=root+'/records/'+d.id+'/revisions/'+v.id;
  await post(sub+'/submit','analyst',{expectedRevision:1});
  await post(sub+'/publish','reviewer',{expectedRevision:2,note:'Fictional approval.'});
  assert.equal((await post(sub+'/read','case-operator',{})).text,'Local fictional study.');
});

test('legacy tracker and consent records are not exposed by the current app',async t=>{
  const {dataFile,restart,get,request}=await harness(t);
  const old=JSON.parse(await readFile(dataFile,'utf8'));
  old.moduleRecords=[{moduleId:'cookies',title:'HIDDEN_LEGACY'},{moduleId:'consent',title:'HIDDEN_LEGACY'}];
  old.privacyPreferences={revision:0,notices:[],events:[{subject:'HIDDEN_LEGACY'}]};
  old.audit.push({action:'privacy-preferences.consent.granted',details:{subject:'HIDDEN_LEGACY'}});
  await writeFile(dataFile,JSON.stringify(old));
  await restart();
  for(const data of [await get(),(await request('modules',200)).body,(await request('privacy-notices',200)).body,(await request('audit/export',200)).body])
    assert.doesNotMatch(JSON.stringify(data),/HIDDEN_LEGACY/);
  assert.match(await readFile(dataFile,'utf8'),/HIDDEN_LEGACY/);
});

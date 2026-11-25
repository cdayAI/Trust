'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const test=require('node:test');
const {createWorkflowEngine,syntheticDefinition}=require('../workflow-engine');

const publisher={id:'pat',role:'publisher'};
const initiator={id:'izzy',role:'initiator'};
const reviewer={id:'rene',role:'reviewer'};
const model=()=>structuredClone(syntheticDefinition);
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-engine-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'workflow.json');
  return ()=>createWorkflowEngine({
    load(){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT') throw e;}},
    save(next){const temp=file+'.temp';fs.writeFileSync(temp,JSON.stringify(next));fs.renameSync(temp,file);}
  });
}
function start(engine){
  const result=engine.publish({actor:publisher,definition:model(),expectedVersion:0});
  assert.equal(result.ok,true);
  const initiated=engine.start({actor:initiator,definitionId:result.definition.id,title:'Synthetic decision package'});
  assert.equal(initiated.ok,true);
  return initiated.instance.id;
}

test('published versions are immutable, incarnation pins version, stale publication is refused',t=>{
  const reopen=fixture(t),engine=reopen(),id=start(engine);
  const rev2=model();
  rev2.states[2].label='Approved v2';
  rev2.transitions[1].requiredFields.push('evidence');
  assert.equal(engine.publish({actor:publisher,definition:rev2,expectedVersion:0}).code,'STALE_DEFINITION');
  const newVersion=engine.publish({actor:publisher,definition:rev2,expectedVersion:1});
  assert.equal(newVersion.definition.version,2);
  newVersion.definition.states[2].label='Changed return value';
  rev2.states[2].label='Changed input';
  assert.equal(reopen().getDefinition('synthetic-review',1).states[2].label,'Approved');
  assert.equal(reopen().getDefinition('synthetic-review').states[2].label,'Approved v2');
  assert.equal(reopen().getInstance(id).definitionVersion,1);
  assert.equal(engine.advance({actor:initiator,instanceId:id,transitionId:'submit-for-review',expectedRevision:1,fields:{summary:'Synthetic input'}}).ok,true);
  assert.equal(engine.advance({actor:reviewer,instanceId:id,transitionId:'approve',expectedRevision:2,fields:{reason:'Synthetic v1 rationale'}}).ok,true);
});

test('enforces explicit action, fields, revision, role and independence; audits every refusal',t=>{
  const reopen=fixture(t),engine=reopen(),id=start(engine);
  const advance=(actor,transitionId,expectedRevision,fields)=>engine.advance({actor,instanceId:id,transitionId,expectedRevision,fields});
  assert.equal(advance(reviewer,'approve',1,{reason:'Premature'}).code,'TRANSITION_NOT_AVAILABLE');
  assert.equal(advance(initiator,'submit-for-review',undefined,{summary:'Missing revision'}).code,'INVALID_EXPECTED_REVISION');
  assert.equal(advance(initiator,'submit-for-review',1,{}).code,'MISSING_FIELDS');
  assert.equal(advance(initiator,'submit-for-review',1,{summary:'Ready'}).instance.state,'awaiting-review');
  assert.equal(advance(initiator,'approve',2,{reason:'Wrong role'}).code,'ROLE_REQUIRED');
  assert.equal(advance({id:initiator.id,role:'reviewer'},'approve',2,{reason:'Same person'}).code,'INDEPENDENCE_REQUIRED');
  const before=reopen().getInstance(id);
  assert.equal(advance(reviewer,'return-for-changes',1,{reason:'Old snapshot'}).code,'STALE_REVISION');
  assert.deepEqual(reopen().getInstance(id),before);
  assert.equal(advance(reviewer,'return-for-changes',2,{reason:'Clarify synthetic evidence'}).instance.revision,3);
  assert.equal(advance(initiator,'submit-for-review',3,{summary:'Revised'}).instance.revision,4);
  assert.equal(advance(reviewer,'approve',4,{reason:'Verified'}).instance.state,'approved');
  assert.equal(advance(reviewer,'approve',4,{reason:'Replay same command'}).code,'STALE_REVISION');
  assert.equal(reopen().getInstance(id).revision,5);
  const events=reopen().audit();
  assert.equal(events.filter(e=>e.outcome==='refused').length,7);
  assert.deepEqual(events.map(e=>e.sequence),Array.from({length:events.length},(_,i)=>i+1));
  assert.equal(new Set(events.map(e=>e.id)).size,events.length);
  assert.equal(events.at(-1).instanceId,id);
});

test('every unreviewed contributor is excluded from independent review',t=>{
  const engine=fixture(t)();
  engine.publish({actor:publisher,expectedVersion:0,definition:{
    id:'synthetic-multi',initial:'draft',states:[{id:'draft',label:'Draft'},{id:'evidence',label:'Evidence'},{id:'review',label:'Review'},{id:'done',label:'Done'}],
    transitions:[
      {id:'contribute',from:'draft',to:'evidence',roles:['reviewer']},
      {id:'submit',from:'evidence',to:'review',roles:['initiator']},
      {id:'decide',from:'review',to:'done',roles:['reviewer'],independent:true}
    ]
  }});
  const id=engine.start({actor:initiator,definitionId:'synthetic-multi',title:'Synthetic multicollaborator case'}).instance.id;
  const advance=(actor,transitionId,expectedRevision)=>engine.advance({actor,instanceId:id,transitionId,expectedRevision});
  assert.equal(advance(reviewer,'contribute',1).ok,true);
  assert.equal(advance(initiator,'submit',2).ok,true);
  assert.equal(advance(reviewer,'decide',3).code,'INDEPENDENCE_REQUIRED');
  assert.equal(advance({id:'alex',role:'reviewer'},'decide',3).ok,true);
});

test('invalid definitions never publish and refusal persists',t=>{
  const reopen=fixture(t),engine=reopen(),bad=model();
  bad.transitions[0].to='unknown';
  assert.equal(engine.publish({actor:publisher,expectedVersion:0,definition:bad}).code,'INVALID_DEFINITION');
  assert.equal(engine.publish({actor:reviewer,expectedVersion:0,definition:model()}).code,'ROLE_REQUIRED');
  assert.equal(reopen().getDefinition('synthetic-review'),undefined);
  assert.deepEqual(reopen().audit().map(e=>e.code),['INVALID_DEFINITION','ROLE_REQUIRED']);
});

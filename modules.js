'use strict';
const {randomUUID}=require('node:crypto');
const t=(key,label,required=true,type='text')=>({key,label,type,required});
const e=(key,label,...options)=>({key,label,type:'select',required:true,options});
const long=(key,label,required=true)=>t(key,label,required,'textarea');
const date=(key,label,required=true)=>t(key,label,required,'date');
const definitions=[
 ['inventory','Data inventory','Catalog datasets, data locations and flow destinations.',['Draft','Mapped','Reviewed'],[t('owner','Data owner'),t('source','Source system'),t('destination','Destination system'),long('categories','Data categories'),t('residency','Storage region'),t('related','Processing-activity reference',false)]],
 ['processing','Processing activities','Document processing purpose, scope and accountability.',['Draft','Review','Recorded'],[t('owner','Activity owner'),long('purpose','Purpose'),t('subjects','Data subjects'),t('basis','Documented legal basis'),t('recipients','Recipients'),t('retention','Retention reference')]],
 ['rights','Privacy rights','Track synthetic rights requests without contacting requesters.',['Received','Verified','In progress','Closed'],[e('requestType','Request type','Access','Deletion','Correction','Portability','Opt-out','Other'),t('requester','Mock requester reference'),t('owner','Case owner'),date('due','Target response date'),long('scope','Request scope')]],
 ['incidents','Privacy incidents','Log, triage and close synthetic incidents without sending notices.',['Logged','Triaged','Investigating','Closed'],[t('owner','Incident owner'),e('severity','Severity','Low','Moderate','High','Critical','Undetermined'),date('detected','Discovery date'),long('scope','Affected scope'),long('containment','Containment note',false)]],
 ['third-party','Third-party risk','Maintain due diligence records alongside vendor assessment workflows.',['Intake','Due diligence','Reviewed','Monitoring'],[t('vendor','Vendor or assessment reference'),t('owner','Risk owner'),long('processing','Service and processing scope'),e('tier','Risk tier','Low','Moderate','High','Undetermined'),long('evidence','Due diligence notes',false)]],
 ['risks','Risk register','Track privacy risks and planned mitigations.',['Identified','Assessed','Mitigating','Closed'],[t('owner','Risk owner'),e('rating','Risk rating','Low','Moderate','High','Critical'),long('scenario','Risk scenario'),long('plan','Mitigation plan'),date('due','Target date',false)]],
 ['controls','Control library','Track control ownership, test evidence and approval.',['Designed','Implemented','Tested','Reviewed'],[t('owner','Control owner'),t('risk','Risk reference'),long('design','Control design'),t('frequency','Test frequency'),long('evidence','Evidence note',false)]],
 ['retention','Retention schedules','Record retention and disposal rules without deleting data.',['Draft','Review','Active','Retired'],[t('owner','Schedule owner'),t('category','Record category'),t('trigger','Retention trigger'),t('period','Retention period'),e('disposition','Disposition','Delete','Anonymize','Archive','Hold'),long('rationale','Rationale')]],
 ['policies','Policies and governance','Track policy owners, versions and review status.',['Draft','Review','Approved','Retired'],[t('owner','Policy owner'),t('version','Version'),long('scope','Scope'),long('text','Policy summary'),date('review','Next review date',false)]],
 ['administration','Administration','Record demo configuration and access proposals; does not grant access.',['Proposed','Reviewed','Recorded'],[e('category','Configuration area','Access','Workflow','Taxonomy','Other'),t('owner','Owner'),t('subject','Setting or demo identity'),long('change','Proposed change')]],
 ['integrations','Integration registry','Track mock or offline integrations; never connect or store credentials.',['Proposed','Reviewed','Mock configured','Retired'],[t('owner','Owner'),t('system','System name'),e('mode','Operating mode','Mock','Offline'),long('purpose','Data flow and purpose'),long('constraints','Safety constraints')]]
].map(([id,name,description,statuses,fields])=>({id,name,description,statuses,fields}));
function model(state) {return {modules:definitions,records:(state.moduleRecords??[]).filter(r=>definitions.some(d=>d.id===r.moduleId))};}
function fail(status,message) {throw Object.assign(new Error(message),{status});}
function string(value,label,max=2000,required=true) {
 if (!required && (value===undefined||value==='')) return '';
 if(typeof value!=='string'||value.trim().length>max||(required&&!value.trim())) fail(422,label+' must '+(required?'contain 1 to ':'contain at most ')+max+' characters.');
 return value.trim();
}
function validate(module,body) {
 if (!body.fields || typeof body.fields!=='object'||Array.isArray(body.fields)) fail(422,'Provide a fields object.');
 const fields=Object.create(null);
 for (const f of module.fields) {
  const v=string(body.fields[f.key],f.label,f.type==='textarea'?4000:250,f.required);
  if (v && f.type==='select' && !f.options.includes(v)) fail(422,'Select a valid '+f.label.toLowerCase()+'.');
  if (v && f.type==='date') {
   if(!/^\d{4}-\d{2}-\d{2}$/.test(v)) fail(422,f.label+' must be a valid date.');
   const d=new Date(v+'T00:00:00Z');
   if(Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==v) fail(422,f.label+' must be a valid date.');
  }
  fields[f.key]=v;
 }
 return {title:string(body.title,'Title',160),fields};
}
function change(state,parts,actor,body,event) {
 const module=definitions.find(m=>m.id===parts[1]);
 if(!module || parts[2]!=='records') fail(404,'Unknown privacy module endpoint.');
 const records=state.moduleRecords??=([]);
 const now=new Date().toISOString();
 if(parts.length===3) {
  if(actor!=='analyst') fail(403,'Only the intake analyst can create records.');
  const row={id:randomUUID(),moduleId:module.id,...validate(module,body),status:module.statuses[0],createdAt:now,updatedAt:now,createdBy:actor,updatedBy:actor,revision:1};
  records.push(row);
  event(state,actor,module.id+'.created',null,row.id,{title:row.title,fields:{...row.fields},status:row.status});
  return;
 }
 const row=records.find(r=>r.moduleId===module.id&&r.id===parts[3]);
 if(!row||parts.length!==5) fail(404,'Record not found.');
 if(body.revision!==undefined&&body.revision!==row.revision) fail(409,'This record changed. Reload and try again.');
 if(parts[4]==='update') {
  if(actor!=='analyst') fail(403,'Only the intake analyst can edit records.');
  if (module.statuses.indexOf(row.status)===module.statuses.length-1) fail(409,'Completed records cannot be edited.');
  Object.assign(row,validate(module,body));
  event(state,actor,module.id+'.updated',null,row.id,{title:row.title,fields:{...row.fields},status:row.status});
 } else if(parts[4]==='advance') {
  const from=row.status;
  const next=module.statuses[module.statuses.indexOf(from)+1];
  if(!next) fail(409,'This record is already at its final status.');
  if (['Reviewed','Approved','Recorded'].includes(next)&&actor!=='reviewer') fail(403,'A demo reviewer must complete this review step.');
  const reason=string(body.reason,'Transition note',2000,false);
  row.status=next;
  event(state,actor,module.id+'.advanced',null,row.id,{title:row.title,from,to:next,reason});
 } else fail(404,'Action not found.');
 row.updatedAt=now;row.updatedBy=actor;row.revision++;
}
module.exports={model,change};

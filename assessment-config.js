'use strict';
const {isDeepStrictEqual}=require('node:util');
const workflows=Object.freeze({pia:'assessment-review',dpia:'assessment-enhanced-review'});
const labels={pia:'Privacy impact assessment (PIA)',dpia:'Data protection impact assessment (DPIA)'};
const dimensions=['handlesSensitiveData','usesAI'];
const combinations=[false,true].flatMap(handlesSensitiveData=>[false,true].map(usesAI=>({handlesSensitiveData,usesAI})));
const key=/^[a-z][a-z0-9-]{0,39}$/;
const baseQuestions=[
  {id:'summary',label:'Summary',kind:'text',required:true},
  {id:'safeguards',label:'Safeguards',kind:'text',required:true}
];
const empty={revision:0,releases:[]};
const initial={title:'Synthetic impact assessment routing',forms:{
  pia:{label:labels.pia,questions:[]},dpia:{label:labels.dpia,questions:[]}},rules:[
    {id:'sensitive-review',form:'dpia',match:{handlesSensitiveData:true},reason:'Intake declares sensitive information.'},
    {id:'standard-review',form:'pia',match:{},reason:'Standard privacy impact assessment.'}
  ]};
function fail(status,code,message){throw Object.assign(Error(message),{status,code})}
function invalid(message){fail(422,'INVALID_ASSESSMENT_CONFIGURATION',message)}
function shape(value,keys,label){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))invalid(label+' contains unsupported fields.');
  return value;
}
function string(value,max,label){
  if(typeof value!=='string'||!value.trim()||value.trim().length>max)invalid(label+' must contain 1 to '+max+' characters.');
  return value.trim();
}
function identifier(value,label){if(typeof value!=='string'||!key.test(value))invalid(label+' must start with a lowercase letter and use up to 40 lowercase letters, digits, or hyphens.');return value}
function list(rows,min,max,label){if(!Array.isArray(rows)||rows.length<min||rows.length>max)invalid(label+' must contain '+min+' to '+max+' entries.');return rows}
function normalize(payload){
  shape(payload,['title','forms','rules'],'Release');
  shape(payload.forms,['pia','dpia'],'Questionnaires');
  const forms={};
  for(const type of Object.keys(workflows)){
    const form=shape(payload.forms[type],['label','questions'],labels[type]);
    const seen=new Map(baseQuestions.map(q=>[q.id,q])),questions=[];
    for(const item of list(form.questions,0,16,labels[type]+' custom questions')){
      shape(item,['id','label','kind','required','options','when'],'Question');
      const id=identifier(item.id,'Question key');
      if(seen.has(id)||['constructor','prototype'].includes(id))invalid('Duplicate or reserved question key: '+id+'.');
      if(!['text','choice','integer'].includes(item.kind)||typeof item.required!=='boolean')invalid('Set a supported question type and required flag for '+id+'.');
      const q={id,label:string(item.label,160,'Question label'),kind:item.kind,required:item.required};
      if(q.kind==='choice'){
        q.options=list(item.options,2,8,'Choices for '+id).map(value=>string(value,80,'Choice'));
        if(new Set(q.options).size!==q.options.length)invalid('Choices must be unique for '+id+'.');
      }else if(Object.hasOwn(item,'options'))invalid('Only choice questions can have options.');
      if(Object.hasOwn(item,'when')){
        shape(item.when,['question','equals'],'Branch condition');
        const parent=seen.get(item.when.question);
        if(parent?.kind!=='choice'||!parent.options.includes(item.when.equals))
          invalid('A condition must match an option from an earlier choice question: '+id+'.');
        q.when={question:parent.id,equals:item.when.equals};
      }
      seen.set(id,q);questions.push(q);
    }
    forms[type]={label:string(form.label,120,labels[type]+' title'),questions};
  }
  const open=[...combinations],ids=new Set();
  const rules=list(payload.rules,1,4,'Routing rules').map(item=>{
    shape(item,['id','form','match','reason'],'Routing rule');
    const id=identifier(item.id,'Rule key');
    if(ids.has(id))invalid('Duplicate routing rule key: '+id+'.');
    ids.add(id);
    if(typeof item.form!=='string'||!Object.hasOwn(workflows,item.form))invalid('Choose PIA or DPIA for routing rule '+id+'.');
    shape(item.match,dimensions,'Routing conditions');
    const match={};
    for(const dimension of dimensions)if(Object.hasOwn(item.match,dimension)){
      if(typeof item.match[dimension]!=='boolean')invalid('Routing conditions use true or false, or omit the field to match either.');
      match[dimension]=item.match[dimension];
    }
    const covered=open.filter(input=>matches(match,input));
    if(!covered.length)invalid('Rule '+id+' is unreachable because earlier rules cover those inputs.');
    if(item.form==='pia'&&covered.some(input=>input.handlesSensitiveData))invalid('Sensitive intake must use a DPIA or the built-in enhanced privacy review.');
    for(const input of covered)open.splice(open.indexOf(input),1);
    return {id,form:item.form,match,reason:string(item.reason,240,'Routing explanation')};
  });
  return {title:string(payload.title,120,'Release title'),forms,rules};
}
function matches(match,input){return dimensions.every(key=>!Object.hasOwn(match,key)||(input[key]===true)===match[key])}
function routedRule(release,vendor){return release.configuration.rules.find(rule=>matches(rule.match,vendor))}
function pinned(release,rule){
  const form=release.configuration.forms[rule.form];
  return {questionnaire:{id:'configured-'+rule.form,version:release.version,label:form.label,questions:structuredClone([...baseQuestions,...form.questions])},
    routing:{id:'configured-'+rule.id,workflowId:workflows[rule.form],reason:rule.reason,configurationVersion:release.version,ruleId:rule.id,form:rule.form}};
}
function assignment(state,type,vendor){
  if(type!=='privacy')return null;
  const release=state.assessmentConfiguration?.releases.findLast(item=>item.status==='published');
  const rule=release&&routedRule(release,vendor);
  return rule?pinned(release,rule):null;
}
function verifyPinned(state,a){
  const release=state.assessmentConfiguration?.releases.find(item=>item.version===a.routing.configurationVersion&&item.status==='published');
  const vendor=state.vendors.find(item=>item.id===a.vendorId&&item.projectId===a.projectId);
  const rule=release&&vendor&&routedRule(release,vendor);
  const expected=rule&&pinned(release,rule);
  if(a.type!=='privacy'||!expected||!isDeepStrictEqual(a.questionnaire,expected.questionnaire)||!isDeepStrictEqual(a.routing,expected.routing))
    throw Error('Configured assessment questionnaire or routing linkage is inconsistent.');
}
function verifyBook(state){
  const book=state.assessmentConfiguration;
  if(book===undefined)return;
  if(!book||!Number.isSafeInteger(book.revision)||!Array.isArray(book.releases)||book.revision<book.releases.length||
    book.releases.some((r,i)=>r.version!==i+1||!['draft','in_review','returned','published'].includes(r.status)||
      r.status!=='published'&&i!==book.releases.length-1||
      !Array.isArray(r.contributors)||!r.contributors.includes(r.createdBy)||new Set(r.contributors).size!==r.contributors.length||
      ['in_review','published','returned'].includes(r.status)&&(!r.submittedBy||!r.contributors.includes(r.submittedBy))||
      r.status==='published'&&(!r.decidedBy||r.contributors.includes(r.decidedBy)||!r.decidedAt)||
      !isDeepStrictEqual(normalize(r.configuration),r.configuration)))throw Error('Assessment configuration history is inconsistent.');
}
function view(state){
  const book=state.assessmentConfiguration??empty;
  return {...structuredClone(book),activeVersion:book.releases.findLast(r=>r.status==='published')?.version??null,
    releases:book.releases.map(release=>({...structuredClone(release),preview:combinations.map(input=>{
      const rule=routedRule(release,input);
      return {...input,rule:rule?.id??null,form:rule?.form??null,label:rule?release.configuration.forms[rule.form].label:
        (input.handlesSensitiveData?'Built-in enhanced privacy review':'Built-in standard privacy review')};
    })}))};
}
function change(state,parts,actor,body,emit,_unused,account){
  const action=parts[1];
  if(parts.length!==2||!['create','edit','submit','return','publish'].includes(action))fail(404,'NOT_FOUND','Assessment configuration action not found.');
  const analyst=['create','edit','submit'].includes(action);
  if(actor!==(analyst?'analyst':'reviewer'))fail(403,'ASSESSMENT_CONFIG_ROLE_REQUIRED','This action requires the '+(analyst?'intake analyst':'independent reviewer')+'.');
  const identity=account??actor,book=state.assessmentConfiguration??=structuredClone(empty);
  const keys=action==='edit'?['expectedRevision','configuration']:['return','publish'].includes(action)?['expectedRevision','note']:['expectedRevision'];
  shape(body,keys,'Configuration action');
  if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)fail(422,'INVALID_EXPECTED_REVISION','Provide the current configuration revision.');
  if(body.expectedRevision!==book.revision)fail(409,'STALE_REVISION','The assessment configuration changed. Reload before retrying.');
  let release=book.releases.at(-1);
  const now=new Date().toISOString();
  if(action==='create'){
    if(release&&release.status!=='published')fail(409,'ACTIVE_DRAFT','Finish the open release before starting a new version.');
    if(book.releases.length>=100)fail(409,'RELEASE_LIMIT','This synthetic workspace has reached its 100-release limit.');
    release={version:book.releases.length+1,configuration:structuredClone(release?.configuration??initial),
      status:'draft',createdBy:identity,createdAt:now,contributors:[identity]};
    book.releases.push(release);
  }else if(!release)fail(404,'NOT_FOUND','No assessment configuration draft exists.');
  else if(action==='edit'||action==='submit'){
    if(!['draft','returned'].includes(release.status))fail(409,'INVALID_TRANSITION','Only a draft or returned release can be edited or submitted.');
    if(!release.contributors.includes(identity))release.contributors.push(identity);
    if(action==='edit')release.configuration=normalize(body.configuration);
    else {
      release.status='in_review';release.submittedBy=identity;release.submittedAt=now;
      delete release.decidedBy;delete release.decidedAt;delete release.decisionNote;
    }
  }else{
    if(release.status!=='in_review')fail(409,'INVALID_TRANSITION','Only a submitted release can receive a review decision.');
    if(release.contributors.includes(identity))fail(403,'INDEPENDENCE_REQUIRED','An account that drafted or submitted the release cannot decide it.');
    release.status=action==='publish'?'published':'returned';
    release.decidedBy=identity;release.decidedAt=now;release.decisionNote=string(body.note,500,'Review decision note');
  }
  book.revision++;
  emit(state,actor,'assessment-config.'+action,null,'assessment-release-'+release.version,{version:release.version,revision:book.revision,identity,
    status:release.status,...(['return','publish'].includes(action)?{note:release.decisionNote}:{})});
}
module.exports={assignment,verifyPinned,verifyBook,view,change};

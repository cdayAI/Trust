'use strict';
const rust=require('./rust-core');
const {isDeepStrictEqual}=require('node:util');

const baseQuestions=[
  {id:'summary',label:'Summary',kind:'text',required:true},
  {id:'safeguards',label:'Safeguards',kind:'text',required:true}
];
const templates={
  'baseline:1':{id:'baseline',version:1,label:'Original assessment',questions:baseQuestions},
  'privacy:1':{id:'privacy',version:1,label:'Standard privacy review',questions:[
    ...baseQuestions,
    {id:'externalSharing',label:'Will project data be shared outside your organization?',kind:'choice',required:true,options:['Yes','No']},
    {id:'sharingLimits',label:'Describe the recipients and limits on sharing',kind:'text',required:true,when:{question:'externalSharing',equals:'Yes'}}
  ]},
  'sensitive:1':{id:'sensitive',version:1,label:'Enhanced privacy review',questions:[
    ...baseQuestions,
    {id:'sensitiveControls',label:'Describe controls for the sensitive information',kind:'text',required:true},
    {id:'externalSharing',label:'Will project data be shared outside your organization?',kind:'choice',required:true,options:['Yes','No']},
    {id:'sharingLimits',label:'Describe the recipients and limits on sharing',kind:'text',required:true,when:{question:'externalSharing',equals:'Yes'}}
  ]},
  'ai:1':{id:'ai',version:1,label:'AI risk review',questions:[
    ...baseQuestions,
    {id:'automatedAction',label:'Can the system take consequential action without a human decision?',kind:'choice',required:true,options:['Yes','No']},
    {id:'overridePlan',label:'Describe who can stop or override the automated action',kind:'text',required:true,when:{question:'automatedAction',equals:'Yes'}}
  ]}
};
const legacyRoute={id:'legacy',workflowId:'assessment-review',reason:'Preserved the workflow originally assigned to this assessment.'};
function assignment(type,vendor) {
  // First matching rule wins. AI review is separate; enhanced privacy never
  // replaces the AI assessment when both intake declarations apply.
  const rules=[
    [type==='ai','ai','assessment-ai-review','Intake declares that the vendor uses AI.'],
    [type==='privacy'&&vendor.handlesSensitiveData,'sensitive','assessment-enhanced-review','Intake declares that the vendor handles sensitive information.'],
    [type==='privacy','privacy','assessment-review','Standard privacy review: the intake does not declare sensitive information.']
  ];
  const rule=rules.find(([matches])=>matches);
  if(!rule)throw Error('No matching assessment route.');
  const [,id,workflowId,reason]=rule;
  return {questionnaire:structuredClone(templates[id+':1']),routing:{id,workflowId,reason}};
}
function legacy() {
  return {questionnaire:structuredClone(templates['baseline:1']),routing:{...legacyRoute}};
}
function verify(a) {
  const {questionnaire:q,routing:r}=a;
  const known=q && templates[q.id+':'+q.version];
  const expected=r?.id==='legacy'?legacy():assignment(a.type,{handlesSensitiveData:r?.id==='sensitive'});
  if(!known||!q||!r||!isDeepStrictEqual(q,known)||
     !isDeepStrictEqual(r,expected.routing)||q.id!==expected.questionnaire.id)
    throw Error('Assessment questionnaire or route linkage is inconsistent.');
}
function evaluate(questionnaire, previous, updates, submitting) {
  const fail=(code,message)=>({code,message});
  if(updates!=null&&(!updates||typeof updates!=='object'||Array.isArray(updates)))return fail('INVALID_ANSWERS','Answers must be an object.');
  const payload=updates??{};
  const questions=questionnaire.questions;
  if(Object.keys(payload).some(id=>!questions.some(q=>q.id===id)))return fail('UNKNOWN_QUESTION','An answer is not part of this questionnaire version.');
  const answers={};
  for(const q of questions) {
    if(rust.enabled){
      const active=!q.when||answers[q.when.question]===q.when.equals;
      const provided=Object.hasOwn(payload,q.id);
      const input=provided?payload[q.id]:(previous[q.id]??'');
      const result=rust.questionnaireAnswer(q,input,active,provided,submitting);
      if(result.status===6)continue;
      if(result.status===1)return fail('HIDDEN_QUESTION','This question is not active: '+q.label+'.');
      if(result.status===2)return fail('INVALID_ANSWER',q.label+' must be text of at most 2,000 characters.');
      if(result.status===3)return fail('INVALID_ANSWER',q.label+' must be a whole number between -999,999,999 and 999,999,999.');
      if(result.status===4)return fail('INVALID_ANSWER',q.label+' must match a listed choice.');
      if(result.status===5)return fail('REQUIRED_ANSWER','Answer required: '+q.label+'.');
      answers[q.id]=result.value;
      continue;
    }
    if(q.when&&answers[q.when.question]!==q.when.equals) {
      if(Object.hasOwn(payload,q.id)&&payload[q.id]!=='')return fail('HIDDEN_QUESTION','This question is not active: '+q.label+'.');
      // Answers from a closed branch cannot silently survive into review.
      continue;
    }
    const input=Object.hasOwn(payload,q.id)?payload[q.id]:(previous[q.id]??'');
    if(typeof input!=='string'||input.length>2000)return fail('INVALID_ANSWER',q.label+' must be text of at most 2,000 characters.');
    const value=input.trim();
    if(q.kind==='integer'&&value&&(!/^(?:0|-?[1-9][0-9]{0,8})$/.test(value)))return fail('INVALID_ANSWER',q.label+' must be a whole number between -999,999,999 and 999,999,999.');
    if(q.kind==='choice'&&value&&!q.options.includes(value))return fail('INVALID_ANSWER',q.label+' must match a listed choice.');
    if(submitting&&q.required&&!value)return fail('REQUIRED_ANSWER','Answer required: '+q.label+'.');
    answers[q.id]=value;
  }
  return {answers};
}
module.exports={assignment,legacy,verify,evaluate};

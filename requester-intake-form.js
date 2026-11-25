'use strict';

const slug=/^[a-z][a-z0-9-]{0,47}$/;
const limit=50;
const catalog=Object.freeze({
  'sample-area':{key:'sample-area',type:'choice',label:'Fictional service area',options:[
    {value:'sample-desk',label:'Sample desk'},{value:'sample-portal',label:'Sample portal'},{value:'sample-center',label:'Sample center'}
  ]},
  'sample-count':{key:'sample-count',type:'integer',label:'Fictional record count',min:0,max:99},
  'sample-example':{key:'sample-example',type:'boolean',label:'Include a fictional example'}
});
const returnReasons=['correction','too-many-fields','clarify-required-fields'];
const failure=(status,code,message)=>{throw Object.assign(Error(message),{status,code});};
const stale=()=>failure(409,'STALE_INTAKE_FORM','This request form changed. Reload the current form and review it before submitting.');
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const member=value=>typeof value==='string'&&slug.test(value);
function validFields(fields){
  return Array.isArray(fields)&&fields.length>=1&&fields.length<=3&&fields.every(f=>exact(f,['key','required'])&&
    typeof f.key==='string'&&Object.hasOwn(catalog,f.key)&&typeof f.required==='boolean')&&
    new Set(fields.map(f=>f.key)).size===fields.length;
}
function read(state){
  const board=state.requesterIntakeForm;
  if(board===undefined)return {schema:1,revision:0,published:[],draft:null};
  const validActors=actors=>Array.isArray(actors)&&actors.length>=1&&actors.length<=64&&
    new Set(actors).size===actors.length&&actors.every(member);
  const version=(row,number)=>row?.number===number&&validFields(row.fields)&&validActors(row.contributors);
  if(board?.schema!==1||!Number.isSafeInteger(board.revision)||board.revision<0||
    !Array.isArray(board.published)||board.published.length>limit||board.published.some((row,i)=>
      !version(row,i+1)||!member(row.approvedBy)||row.contributors.includes(row.approvedBy))||
    (board.draft!==null&&(!version(board.draft,board.published.length+1)||!['draft','review'].includes(board.draft.status)||
      (board.draft.status==='review'&&!board.draft.contributors.includes(board.draft.submittedBy)))))
    throw Error('Invalid requester intake form state.');
  return board;
}
function settings(state,ctx){
  if(!ctx?.intakeEnabled||!['analyst','reviewer'].includes(ctx.role))return undefined;
  const {revision,published,draft}=read(state);
  const options=Object.values(catalog).map(({key,type,label})=>({key,type,label}));
  const author=ctx.role==='analyst';
  const history=published.map(({number,fields,approvedBy,publishedAt})=>({number,fields,approvedBy,publishedAt}));
  const allowed=author?(!draft&&published.length>=limit?[]:draft?.status==='review'?[]:draft?['save','submit']:['save']):
    (draft?.status==='review'&&!draft.contributors.includes(ctx.account)?['return','publish']:[]);
  return {revision,history,draft,options,allowed,returnReasons};
}
function change(state,ctx,action,body,event){
  const analyst=['save','submit'].includes(action),expectedRole=analyst?'analyst':'reviewer';
  if(!ctx?.intakeEnabled||ctx.role!==expectedRole||!member(ctx.account))
    failure(403,'INTAKE_FORM_AUTHORITY','This staff role cannot change the requester intake form.');
  if(!['save','submit','return','publish'].includes(action)||
    !exact(body,['expectedRevision',...(action==='save'?['fields']:action==='return'?['reason']:[])])||
    !Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0||
    (action==='save'&&!validFields(body.fields))||(action==='return'&&!returnReasons.includes(body.reason)))
    failure(422,'INVALID_INTAKE_FORM','Provide the current form revision and choose supported synthetic fields.');
  const board=read(state),draft=board.draft;
  if(board.revision!==body.expectedRevision)stale();
  if(action==='save'){
    if(draft?.status==='review'||(!draft&&board.published.length>=limit))
      failure(409,'INTAKE_FORM_NOT_EDITABLE','The form is under review or at its local version limit.');
    const next=draft??{number:board.published.length+1,status:'draft',contributors:[]};
    next.fields=structuredClone(body.fields);
    if(!next.contributors.includes(ctx.account))next.contributors.push(ctx.account);
    if(next.contributors.length>64)failure(409,'INTAKE_FORM_CONTRIBUTOR_LIMIT','The local form contributor limit was reached.');
    board.draft=next;
  }else if(action==='submit'){
    if(draft?.status!=='draft')failure(409,'INTAKE_FORM_NOT_DRAFT','Save a draft before requesting review.');
    if(!draft.contributors.includes(ctx.account))draft.contributors.push(ctx.account);
    if(draft.contributors.length>64)failure(409,'INTAKE_FORM_CONTRIBUTOR_LIMIT','The local form contributor limit was reached.');
    draft.status='review';draft.submittedBy=ctx.account;delete draft.returnReason;
  }else{
    if(draft?.status!=='review')failure(409,'INTAKE_FORM_NOT_IN_REVIEW','This form is not in review.');
    if(draft.contributors.includes(ctx.account))
      failure(403,'INDEPENDENT_INTAKE_FORM_REVIEW_REQUIRED','A different account must review this form.');
    if(action==='return'){
      draft.status='draft';draft.returnReason=body.reason;delete draft.submittedBy;
    }else{
      const {number,fields,contributors}=draft;
      board.published.push({number,fields,contributors,approvedBy:ctx.account,publishedAt:new Date(ctx.at).toISOString()});
      board.draft=null;
    }
  }
  board.revision++;
  if(!Number.isSafeInteger(board.revision))throw Error('Intake form revision overflow.');
  state.requesterIntakeForm=board;
  const number=action==='publish'?board.published.at(-1).number:board.draft.number;
  event(state,ctx.role,'requester-intake-form.'+action,null,null,{
    formVersion:number,revision:board.revision,...(action==='return'?{reason:body.reason}:{})
  });
}
function publicForm(state){
  const active=read(state).published.at(-1);
  return active?{version:active.number,fields:active.fields.map(({key,required})=>({...catalog[key],required}))}:undefined;
}
function pin(state,request,previous){
  const active=read(state).published.at(-1),provided=Object.hasOwn(request,'formVersion');
  if(!active&&!previous&&!provided)return undefined;
  if(previous===null){
    if(provided)failure(409,'REQUEST_ALREADY_SUBMITTED','This code already submitted a legacy request.');
    return undefined;
  }
  const published=previous?read(state).published.find(row=>row.number===previous.version):active;
  if(!provided||!published||!Number.isSafeInteger(request.formVersion)||request.formVersion!==published.number){
    if(previous)failure(409,'REQUEST_ALREADY_SUBMITTED','This code already submitted a different version of the request.');
    stale();
  }
  const answers=request.answers;
  if(!answers||typeof answers!=='object'||Array.isArray(answers)||Object.keys(answers).length>published.fields.length||
    Object.keys(answers).some(key=>!published.fields.some(f=>f.key===key)))
    failure(422,'REQUESTER_ANSWERS','Use only the optional or required fields shown by the current form.');
  const safe={};
  for(const {key,required} of published.fields){
    if(!Object.hasOwn(answers,key)){
      if(required)failure(422,'REQUESTER_ANSWERS','Complete the required fictional fields.');
      continue;
    }
    const field=catalog[key],value=answers[key];
    const valid=field.type==='boolean'?typeof value==='boolean':field.type==='integer'?
      Number.isSafeInteger(value)&&field.min<=value&&value<=field.max:field.options.some(option=>option.value===value);
    if(!valid)failure(422,'REQUESTER_ANSWERS','Use only the permitted typed fictional values.');
    safe[key]=value;
  }
  if(previous&&JSON.stringify(safe)!==JSON.stringify(previous.answers))
    failure(409,'REQUEST_ALREADY_SUBMITTED','This code already submitted a request; answers cannot be changed.');
  return {version:published.number,answers:safe};
}
module.exports={settings,change,publicForm,pin};

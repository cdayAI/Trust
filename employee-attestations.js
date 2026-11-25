'use strict';
const {createHash,createHmac,randomUUID}=require('node:crypto');
const {policyEdition,listPolicyEditions}=require('./governance-documents');
const digest=code=>createHash('sha256').update(code).digest('hex');
const codePattern=/^[A-Za-z0-9_-]{43}$/;
const uuidPattern=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hashPattern=/^[a-f0-9]{64}$/;
const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code})};
const collection=state=>state.employeeAttestations??[];
function only(body,fields){
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==fields.length||!fields.every(x=>Object.hasOwn(body,x)))
    fail(422,'ATTESTATION_FIELDS','Send only the required attestation fields.');
}
function provision({grants,key,workspaces,accounts,requesters=[],now=Date.now}){
  if(!Array.isArray(grants)||!grants.length||grants.length>64||typeof key!=='string'||!hashPattern.test(key)||typeof now!=='function')
    throw Error('Invalid synthetic employee provisioning.');
  const spaces=new Set(workspaces.map(x=>x.id)),ids=new Set(),index=new Map(),people=new Map(),used=new Set([...accounts,...requesters].map(x=>x.codeHash));
  for(const {alias,workspace,codeHash,expiresAt} of grants){
    if(typeof alias!=='string'||!/^sample-staff-[a-z0-9-]{1,32}$/.test(alias)||ids.has(alias)||!spaces.has(workspace)||
      typeof codeHash!=='string'||!hashPattern.test(codeHash)||used.has(codeHash)||!Number.isSafeInteger(expiresAt)||expiresAt<=0||expiresAt>now()+604800000)
      throw Error('Invalid synthetic employee seat.');
    ids.add(alias);used.add(codeHash);
    const seat={alias,workspace,expiresAt};
    index.set(codeHash,seat);
    if(!people.has(workspace))people.set(workspace,[]);
    people.get(workspace).push(seat);
  }
  let retries=0,windowEnd=0;
  const signer=payload=>createHmac('sha256',Buffer.from(key,'hex')).update(JSON.stringify(payload)).digest('hex');
  return {
    enabled:workspace=>people.has(workspace),
    staff:workspace=>(people.get(workspace)??[]).filter(x=>x.expiresAt>now()).map(x=>x.alias),
    signer,
    authenticate(action,body){
      only(body,action==='attest'?['code','assignment','edition','hash','confirm']:['code']);
      const time=now();
      if(time>=windowEnd){retries=0;windowEnd=time+60000;}
      const seat=typeof body.code==='string'&&codePattern.test(body.code)?index.get(digest(body.code)):null;
      if(!seat||seat.expiresAt<=time){
        if(++retries>30)fail(429,'EMPLOYEE_WAIT','Wait a minute before retrying a test code.');
        fail(401,'EMPLOYEE_ACCESS_REQUIRED','A valid local synthetic employee code is required.');
      }
      return seat;
    }
  };
}
function operatorView(state,staff){
  return {enabled:true,staff,editions:listPolicyEditions(state),assignments:collection(state)};
}
function assign(state,staff,actor,account,body,event){
  try{
    if(actor!=='analyst')fail(403,'ATTESTATION_ANALYST','Only the local analyst can assign policies.');
    only(body,['employee','document','edition','hash']);
    if(!staff.includes(body.employee))fail(404,'EMPLOYEE_NOT_FOUND','The synthetic employee is not provisioned for this workspace.');
    const edition=policyEdition(state,body.document,body.edition);
    if(!edition)fail(404,'EDITION_NOT_FOUND','Select a published policy edition in this workspace.');
    if(body.hash!==edition.hash)fail(409,'EDITION_MISMATCH','The edition digest differs; reload the published policy.');
    const entries=collection(state);
    if(entries.some(x=>x.employee===body.employee&&x.edition===edition.edition))return false;
    if(entries.length>=500)fail(409,'ASSIGNMENT_LIMIT','The local assignment limit has been reached.');
    const row={id:randomUUID(),employee:body.employee,document:edition.document,edition:edition.edition,number:edition.number,
      hash:edition.hash,title:edition.title,assignedAt:new Date().toISOString(),receipt:null};
    (state.employeeAttestations??=[]).push(row);
    event(state,actor,'employee-attestations.assigned',null,row.id,{account,employee:row.employee,edition:row.edition,hash:row.hash});
    return true;
  }catch(error){
    if(error.status){
      event(state,actor,'employee-attestations.refused',null,null,{account,operation:'assign',code:error.code});
      error.persistRefusal=true;
    }
    throw error;
  }
}
function employeeView(state,seat){
  const assignments=collection(state).filter(x=>x.employee===seat.alias).map(row=>{
    const edition=policyEdition(state,row.document,row.edition);
    if(!edition||row.hash!==edition.hash)fail(409,'EDITION_UNAVAILABLE','An assigned edition is no longer available.');
    return {assignment:row.id,edition:row.edition,version:row.number,title:edition.title,text:edition.text,hash:row.hash,receipt:row.receipt};
  });
  return {mode:'synthetic-employee',assignments};
}
function attest(state,seat,body,sign,event){
  if(typeof body.assignment!=='string'||!uuidPattern.test(body.assignment))fail(404,'ASSIGNMENT_NOT_FOUND','The assignment was not found.');
  const row=collection(state).find(x=>x.employee===seat.alias&&x.id===body.assignment);
  if(!row)fail(404,'ASSIGNMENT_NOT_FOUND','The assignment was not found.');
  const edition=policyEdition(state,row.document,row.edition);
  if(!edition||body.edition!==row.edition||body.hash!==row.hash||row.hash!==edition.hash)
    fail(409,'EDITION_MISMATCH','The confirmed edition does not match the assigned policy.');
  if(body.confirm!==true)fail(422,'CONFIRM_REQUIRED','Explicitly attest the assigned policy edition.');
  if(row.receipt)return false;
  const signed={receipt:randomUUID(),assignment:row.id,employee:seat.alias,edition:row.edition,hash:row.hash,acknowledgedAt:new Date().toISOString()};
  row.receipt={receipt:signed.receipt,acknowledgedAt:signed.acknowledgedAt,signature:sign(signed)};
  event(state,'synthetic-employee','employee-attestations.acknowledged',null,row.id,{employee:seat.alias,edition:row.edition,hash:row.hash,
    receipt:row.receipt.receipt,signature:row.receipt.signature});
  return true;
}
module.exports={provision,operatorView,assign,employeeView,attest};

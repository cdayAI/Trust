'use strict';
const {mkdtempSync,writeFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {randomBytes}=require('node:crypto');
const {createServer}=require('./server');
const {launchLocalServer}=require('./operational-health');
const {codeHash}=require('./workspace-access');
launchLocalServer(()=>{
const enableIdentityAdmin=process.env.TRUST_ENABLE_LOCAL_IDENTITY_ADMIN==='1';
const enableGroupGovernance=process.env.TRUST_ENABLE_LOCAL_GROUP_GOVERNANCE==='1';
const enableDirectoryLifecycle=process.env.TRUST_ENABLE_LOCAL_DIRECTORY_LIFECYCLE==='1';
if(enableDirectoryLifecycle&&!enableIdentityAdmin)throw Error('Enable TRUST_ENABLE_LOCAL_IDENTITY_ADMIN first for local directory reconciliation.');
const attachmentReviewSetting=process.env.TRUST_ATTACHMENT_REVIEW;
if(attachmentReviewSetting!==undefined&&attachmentReviewSetting!=='manual')throw Error('TRUST_ATTACHMENT_REVIEW must be manual or unset.');
const largePdfSetting=process.env.TRUST_LARGE_PDF_BATCH;
if(largePdfSetting!==undefined&&largePdfSetting!=='1')throw Error('TRUST_LARGE_PDF_BATCH must be 1 or unset.');
if(largePdfSetting&&(!process.env.TRUST_SQLITE_FILE||attachmentReviewSetting!=='manual'))
  throw Error('Larger PDF batches require TRUST_SQLITE_FILE and TRUST_ATTACHMENT_REVIEW=manual.');
const discoveryRunSetting=process.env.TRUST_DISCOVERY_REHEARSAL;
if(discoveryRunSetting!==undefined&&discoveryRunSetting!=='1')throw Error('TRUST_DISCOVERY_REHEARSAL must be 1 or unset.');
if(discoveryRunSetting&&!process.env.TRUST_SQLITE_FILE)throw Error('Discovery rehearsals require TRUST_SQLITE_FILE.');
const enableRecordScope=process.env.TRUST_ENABLE_LOCAL_RECORD_SCOPE==='1';
if(enableRecordScope&&!enableIdentityAdmin)throw Error('Enable TRUST_ENABLE_LOCAL_IDENTITY_ADMIN first to opt into local document access scope.');
if(enableGroupGovernance&&!enableIdentityAdmin)throw Error('Enable TRUST_ENABLE_LOCAL_IDENTITY_ADMIN first to opt into local group governance.');
const root=mkdtempSync(join(tmpdir(),'trust-synthetic-'));
const codes=join(root,'local-access.json');
const requesterCodes=join(root,'requester-access.json');
const employeeCodes=join(root,'employee-access.json');
const trainingCodes=join(root,'training-access.json');
const seats=[
  ['sample-intake',{harbor:'analyst',orchard:'reviewer'}],
  ['sample-review',{harbor:'reviewer'}],
  ['sample-publisher',{harbor:'publisher',orchard:'publisher'}],
  ['sample-orchard',{orchard:'analyst'}],
  ['sample-ethics-investigator',{harbor:'ethics-investigator'}],
  ['sample-ethics-reviewer',{harbor:'ethics-reviewer'}],
  ['sample-case-operator',{harbor:'case-operator',orchard:'case-operator'}],
];
if(enableIdentityAdmin)seats.push(['sample-identity-admin',{harbor:'identity-admin',orchard:'identity-admin'}]);
const accounts=seats.map(([id,memberships])=>({id,memberships,code:randomBytes(32).toString('base64url')}));
writeFileSync(codes,JSON.stringify(accounts,null,2)+'\n',{flag:'wx',mode:0o600});
const requesters=['harbor','orchard'].map(workspace=>({
  id:'request-'+workspace,alias:'sample-reader-'+workspace,workspace,
  code:randomBytes(32).toString('base64url'),expiresAt:Date.now()+8*3600000
}));
writeFileSync(requesterCodes,JSON.stringify(requesters,null,2)+'\n',{flag:'wx',mode:0o600});
const employees=['harbor','orchard'].map(workspace=>({
  alias:'sample-staff-'+workspace,workspace,code:randomBytes(32).toString('base64url'),expiresAt:Date.now()+8*3600000
}));
writeFileSync(employeeCodes,JSON.stringify(employees,null,2)+'\n',{flag:'wx',mode:0o600});
const learners=['harbor','orchard'].map(workspace=>({
  alias:'sample-learner-'+workspace,workspace,code:randomBytes(32).toString('base64url'),expiresAt:Date.now()+8*3600000
}));
writeFileSync(trainingCodes,JSON.stringify(learners,null,2)+'\n',{flag:'wx',mode:0o600});
const server=createServer({sqliteFile:process.env.TRUST_SQLITE_FILE,operationalEvents:true,isolated:{
  root:join(root,'workspaces'),enableIdentityAdmin,
  workspaces:[{id:'harbor',label:'Fictional Harbor'},{id:'orchard',label:'Fictional Orchard'}],
  ...(discoveryRunSetting?{discoveryRunWorkspaces:['harbor','orchard']}:{}),
  ...(largePdfSetting?{largePdfAttachmentWorkspaces:['harbor','orchard']}:{}),
  ...(attachmentReviewSetting?{attachmentReviewWorkspaces:['harbor','orchard']}:{}),
  ...(process.env.TRUST_ENABLE_LOCAL_RIGHTS_CASE_SCOPE==='1'?{rightsCaseScopeWorkspaces:['harbor','orchard']}:{}),
  ...(enableRecordScope?{documentScopeWorkspaces:['harbor','orchard']}:{}),
  ...(enableDirectoryLifecycle?{directoryLifecycleWorkspaces:['harbor','orchard']}:{}),
  ...(enableGroupGovernance?{groupApplications:['harbor','orchard'].map(workspace=>({workspace,applications:[
    {id:'sample-case-reference',name:'Sample Case Reference',summary:'Fictional reference application for the scoped access walkthrough.'},
    {id:'sample-service-register',name:'Sample Service Register',summary:'Fictional service summary. This is not connected to an external system.'}
  ]}))}:{}),
  employeeGrants:employees.map(({code,...seat})=>({...seat,codeHash:codeHash(code)})),
  employeeSigningKey:randomBytes(32).toString('hex'),
  trainingGrants:learners.map(({code,...seat})=>({...seat,codeHash:codeHash(code)})),
  trainingSigningKey:randomBytes(32).toString('hex'),
  trustCenters:[{slug:'sample-harbor',workspace:'harbor'},{slug:'sample-orchard',workspace:'orchard'}],
  requesterGrants:requesters.map(({code,...grant})=>({...grant,codeHash:codeHash(code)})),
  accounts:accounts.map(({id,memberships,code})=>({id,memberships,codeHash:codeHash(code)}))
}});
return {server,onListening:()=>{
  console.log('Synthetic isolated workbench: http://127.0.0.1:'+server.address().port);
  console.log('Local test access file (private; contains generated codes): '+codes);
  console.log('Synthetic requester portal: http://127.0.0.1:'+server.address().port+'/requester');
  console.log('Local requester access file (private; contains generated codes): '+requesterCodes);
  console.log('Synthetic employee portal: http://127.0.0.1:'+server.address().port+'/employee');
  console.log('Local employee access file (private; contains generated codes): '+employeeCodes);
  console.log('Synthetic training portal: http://127.0.0.1:'+server.address().port+'/training');
  console.log('Local training access file (private; contains generated codes): '+trainingCodes);
}};
});

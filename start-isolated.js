'use strict';
const {mkdtempSync,writeFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {randomBytes}=require('node:crypto');
const {createServer}=require('./server');
const {codeHash}=require('./workspace-access');
const requested=Number(process.env.PORT??4173);
if(!Number.isInteger(requested)||requested<0||requested>65535)throw Error('Use a valid loopback port.');
const root=mkdtempSync(join(tmpdir(),'trust-synthetic-'));
const codes=join(root,'local-access.json');
const requesterCodes=join(root,'requester-access.json');
const employeeCodes=join(root,'employee-access.json');
const seats=[
  ['sample-intake',{harbor:'analyst',orchard:'reviewer'}],
  ['sample-review',{harbor:'reviewer'}],
  ['sample-publisher',{harbor:'publisher',orchard:'publisher'}],
  ['sample-orchard',{orchard:'analyst'}],
];
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
const server=createServer({isolated:{
  root:join(root,'workspaces'),
  workspaces:[{id:'harbor',label:'Fictional Harbor'},{id:'orchard',label:'Fictional Orchard'}],
  employeeGrants:employees.map(({code,...seat})=>({...seat,codeHash:codeHash(code)})),
  employeeSigningKey:randomBytes(32).toString('hex'),
  trustCenters:[{slug:'sample-harbor',workspace:'harbor'},{slug:'sample-orchard',workspace:'orchard'}],
  requesterGrants:requesters.map(({code,...grant})=>({...grant,codeHash:codeHash(code)})),
  accounts:accounts.map(({id,memberships,code})=>({id,memberships,codeHash:codeHash(code)}))
}});
server.listen(requested,'127.0.0.1',()=>{
  console.log('Synthetic isolated workbench: http://127.0.0.1:'+server.address().port);
  console.log('Local test access file (private; contains generated codes): '+codes);
  console.log('Synthetic requester portal: http://127.0.0.1:'+server.address().port+'/requester');
  console.log('Local requester access file (private; contains generated codes): '+requesterCodes);
  console.log('Synthetic employee portal: http://127.0.0.1:'+server.address().port+'/employee');
  console.log('Local employee access file (private; contains generated codes): '+employeeCodes);
});

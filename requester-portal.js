'use strict';
const {createHash}=require('node:crypto');
const ident=/^[a-z][a-z0-9-]{0,47}$/;
const accessCode=/^[A-Za-z0-9_-]{43}$/;
const digest=code=>createHash('sha256').update(code).digest('hex');
const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code})};
function createPortal({grants,workspaces,accounts,now=Date.now}){
  if(!Array.isArray(grants)||grants.length>64||typeof now!=='function')throw Error('Invalid local requester provisioning.');
  const ids=new Set(),entries=new Map(),aliases=new Set(),known=new Set(workspaces.map(x=>x.id));
  const operatorHashes=new Set(accounts.map(a=>a.codeHash));
  for(const g of grants){
    const {id,alias,workspace,codeHash,expiresAt}=g;
    if(typeof id!=='string'||!ident.test(id)||ids.has(id)||typeof alias!=='string'||!/^sample-[a-z0-9-]{1,32}$/.test(alias)||
        aliases.has(alias)||!known.has(workspace)||typeof codeHash!=='string'||!/^[a-f0-9]{64}$/.test(codeHash)||entries.has(codeHash)||operatorHashes.has(codeHash)||
        !Number.isSafeInteger(expiresAt)||expiresAt<=0||expiresAt>now()+604800000)throw Error('Invalid synthetic requester grant.');
    ids.add(id);aliases.add(alias);entries.set(codeHash,{id,alias,workspace,expiresAt});
  }
  let rejected=0,windowUntil=0;
  return {
    allow(operation,body){
      const time=now();
      if(time>=windowUntil){windowUntil=time+60000;rejected=0;}
      if(!body||typeof body!=='object'||Array.isArray(body))fail(422,'PORTAL_FIELDS','Use the synthetic portal form.');
      const allowed=operation==='intake'?['code','kind']:['code'];
      if(Object.keys(body).length!==allowed.length||!allowed.every(k=>Object.hasOwn(body,k)))fail(422,'PORTAL_FIELDS','Use only the fields in the synthetic portal form.');
      const grant=typeof body.code==='string'&&accessCode.test(body.code)?entries.get(digest(body.code)):null;
      if(!grant||grant.expiresAt<=time){
        if(++rejected>30)fail(429,'PORTAL_TRY_LATER','Wait a minute before trying another synthetic code.');
        fail(401,'PORTAL_ACCESS_REQUIRED','A valid local synthetic access code is required.');
      }
      return grant;
    },
  };
}
module.exports={createPortal};

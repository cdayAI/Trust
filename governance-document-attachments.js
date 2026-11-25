'use strict';
const {createHash, randomUUID}=require('node:crypto');
const rules=Object.freeze({
  extension:'.txt',
  mediaType:'text/plain',
  maxFileBytes:16*1024,
  maxFilesPerRevision:4,
  maxWorkspaceBytes:2*1024*1024,
  maxFilesPerWorkspace:256
});
const maxEncodedLength=Math.ceil(rules.maxFileBytes/3)*4;
const encoding=/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const idPattern=/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/u;
const shaPattern=/^[a-f\d]{64}$/u;
const utf8=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
function fail(status,code,message){throw Object.assign(new Error(message),{status,code});}
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

function cleanName(name){
  if(typeof name!=='string'||!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,91}\.txt$/iu.test(name))
    fail(422,'INVALID_ATTACHMENT_FILENAME','Use a .txt filename with up to 96 letters, numbers, spaces, periods, dashes, or underscores.');
  const base=name.slice(0,-4).replace(/ +/g,' ').trimEnd();
  if(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(base))fail(422,'INVALID_ATTACHMENT_FILENAME','Use a regular .txt filename.');
  return base+'.txt';
}
function rawBytes(data){
  if(typeof data!=='string'||!data)fail(422,'ATTACHMENT_REQUIRED','Choose a nonempty fictional text file.');
  if(data.length>maxEncodedLength)fail(413,'ATTACHMENT_TOO_LARGE','An attachment cannot exceed 16 KiB.');
  if(!encoding.test(data))fail(422,'INVALID_ATTACHMENT_ENCODING','The attachment encoding is invalid.');
  const bytes=Buffer.from(data,'base64');
  if(bytes.length>rules.maxFileBytes)fail(413,'ATTACHMENT_TOO_LARGE','An attachment cannot exceed 16 KiB.');
  if(!bytes.length||bytes.toString('base64')!==data)fail(422,'INVALID_ATTACHMENT_ENCODING','The attachment encoding is invalid.');
  return bytes;
}
function checkText(bytes){
  let text;
  try{text=utf8.decode(bytes);}
  catch{fail(415,'ATTACHMENT_NOT_TEXT','Attachments must be valid UTF-8 plain text.');}
  text=text.replace(/^\uFEFF/u,'');
  const printable=text.replace(/[\r\n\t]/gu,'');
  // Reject non-text controls and markup at the start. No uploaded content is rendered inline.
  if(!text.trim()||/\p{C}/u.test(printable)||/^\s*<(?:[!?]|\/?[A-Za-z])/u.test(text)||/^\s*\{\\rtf/u.test(text))
    fail(415,'ATTACHMENT_NOT_TEXT','Attachments must be nonempty, printable UTF-8 plain text, not markup or binary files.');
}
function attachment(body,book,version){
  if(body.mediaType!==rules.mediaType)fail(415,'ATTACHMENT_TYPE_UNSUPPORTED','Only UTF-8 .txt attachments are accepted.');
  const name=cleanName(body.filename), bytes=rawBytes(body.data);
  checkText(bytes);
  if((version.attachments??[]).length>=rules.maxFilesPerRevision)
    fail(409,'ATTACHMENT_REVISION_LIMIT','A revision can contain at most four attachments.');
  let count=0,total=0;
  for(const document of book.documents)for(const revision of document.revisions)for(const row of revision.attachments??[]){
    count++;total+=row.size;
  }
  if(count>=rules.maxFilesPerWorkspace||total+bytes.length>rules.maxWorkspaceBytes)
    fail(409,'ATTACHMENT_WORKSPACE_LIMIT','This workspace has reached its attachment storage limit.');
  return {id:randomUUID(),name,mediaType:rules.mediaType,size:bytes.length,sha256:digest(bytes),data:bytes.toString('base64')};
}
function metadata(row){
  const {id,name,mediaType,size,sha256}=row;
  return {id,name,mediaType,size,sha256};
}
function download(row){
  try{
    if(!idPattern.test(row.id)||!shaPattern.test(row.sha256)||row.mediaType!==rules.mediaType||cleanName(row.name)!==row.name)
      throw new Error('Stored metadata mismatch.');
    const bytes=rawBytes(row.data);
    if(bytes.length!==row.size||digest(bytes)!==row.sha256)throw new Error('Stored bytes mismatch.');
    checkText(bytes);
    return {filename:row.name,bytes};
  }catch{
    fail(409,'ATTACHMENT_UNAVAILABLE','The stored attachment failed its integrity check.');
  }
}
module.exports={rules,attachment,metadata,download};

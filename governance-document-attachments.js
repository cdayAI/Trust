'use strict';
const {createHash, randomUUID}=require('node:crypto');
const {maxBytes:largePdfMaxBytes}=require('./attachment-binary-batch');
const {formats,catalog}=require('./document-attachment-formats');
const rules=Object.freeze({
  formats:catalog,
  maxFileBytes:Math.max(...catalog.map(format=>format.maxFileBytes)),
  maxFilesPerRevision:4,
  maxFilesPerBatch:4,
  maxBatchBytes:4*1024*1024,
  maxWorkspaceBytes:8*1024*1024,
  maxFilesPerWorkspace:256
});
const uploadRequestBytes=Math.ceil(rules.maxFileBytes/3)*4+1024;
// Each file is padded separately. Reserve bounded JSON and metadata overhead.
const batchUploadRequestBytes=Math.ceil(rules.maxBatchBytes/3)*4+rules.maxFilesPerBatch*8+4096;
const idPattern=/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/u;
const shaPattern=/^[a-f\d]{64}$/u;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function fail(status,code,message){throw Object.assign(new Error(message),{status,code});}

function cleanName(name){
  if(typeof name!=='string'||name.length>96||!/^[A-Za-z0-9][A-Za-z0-9 _.-]*\.[A-Za-z0-9]{2,8}$/u.test(name))
    fail(422,'INVALID_ATTACHMENT_FILENAME','Use a filename of up to 96 letters, numbers, spaces, periods, dashes, or underscores.');
  const dot=name.lastIndexOf('.');
  const base=name.slice(0,dot).replace(/ +/g,' ').trimEnd();
  if(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(base))
    fail(422,'INVALID_ATTACHMENT_FILENAME','Use a regular filename.');
  return base+name.slice(dot).toLowerCase();
}
function rawBytes(data,limit,binary=false){
  const tooLarge=()=>fail(413,'ATTACHMENT_TOO_LARGE',
    'This file format cannot exceed '+(limit>=1024*1024?limit/(1024*1024)+' MiB':limit/1024+' KiB')+'.');
  if(binary){
    if(!Buffer.isBuffer(data)||!data.length)fail(422,'ATTACHMENT_REQUIRED','Choose a nonempty fictional file.');
    if(data.length>limit)tooLarge();
    return data;
  }
  if(typeof data!=='string'||!data)fail(422,'ATTACHMENT_REQUIRED','Choose a nonempty fictional file.');
  if(data.length>Math.ceil(limit/3)*4)tooLarge();
  if(data.length%4||/[^A-Za-z0-9+/=]/u.test(data))fail(422,'INVALID_ATTACHMENT_ENCODING','The attachment encoding is invalid.');
  const bytes=Buffer.from(data,'base64');
  if(bytes.length>limit)tooLarge();
  if(!bytes.length||bytes.toString('base64')!==data)fail(422,'INVALID_ATTACHMENT_ENCODING','The attachment encoding is invalid.');
  return bytes;
}
function namedFormat(name){
  const format=formats.get(name.slice(name.lastIndexOf('.')));
  if(!format)fail(415,'ATTACHMENT_TYPE_UNSUPPORTED','Choose a supported PDF, modern Office, static OpenDocument, plain fictional EML, text/data, or raster image file.');
  return format;
}
function prepare(body,binary=false){
  const name=cleanName(body.filename), format=namedFormat(name);
  if(typeof body.mediaType!=='string'||(body.mediaType&&body.mediaType!==format.mediaType&&!format.aliases.includes(body.mediaType)))
    fail(415,'ATTACHMENT_TYPE_MISMATCH','The selected file type does not match the filename.');
  const extended=binary&&format.extension==='.pdf';
  const bytes=rawBytes(body.data,extended?largePdfMaxBytes:format.maxFileBytes,binary);
  format.check(bytes);
  return {id:randomUUID(),name,mediaType:format.mediaType,size:bytes.length,sha256:digest(bytes),
    data:binary?bytes.toString('base64'):body.data,...(extended&&bytes.length>format.maxFileBytes?{payloadProfile:'large-pdf-v1'}:{})};
}
function capacity(addedCount,addedBytes,book,version){
  if((version.attachments??[]).length+addedCount>rules.maxFilesPerRevision)
    fail(409,'ATTACHMENT_REVISION_LIMIT','A revision can contain at most four attachments.');
  let count=0,total=0;
  for(const document of book.documents)for(const revision of document.revisions)for(const row of revision.attachments??[]){
    count++;total+=row.size;
  }
  if(count+addedCount>rules.maxFilesPerWorkspace||total+addedBytes>rules.maxWorkspaceBytes)
    fail(409,'ATTACHMENT_WORKSPACE_LIMIT','The selected files exceed the workspace attachment storage limit.');
}
function attachment(body,book,version){
  const row=prepare(body);
  capacity(1,row.size,book,version);
  return row;
}
function batch(files,book,version,binary=false){
  if(!Array.isArray(files)||files.length===0||files.length>rules.maxFilesPerBatch)
    fail(422,'ATTACHMENT_BATCH_COUNT','Select between one and '+rules.maxFilesPerBatch+' attachments.');
  capacity(files.length,0,book,version);
  const rows=[], fileErrors=[];
  let status=0,total=0;
  for(const [index,file] of files.entries()){
    try{
      if(!file||typeof file!=='object'||Array.isArray(file)||Object.keys(file).length!==3||
        !['filename','mediaType','data'].every(key=>Object.hasOwn(file,key)))
        fail(422,'INVALID_ATTACHMENT_FIELDS','Send exactly a filename, media type, and file bytes.');
      const row=prepare(file,binary);
      rows.push(row);total+=row.size;
    }catch(error){
      if(!error.status)throw error;
      if(!status||error.status===413)status=error.status;
      fileErrors.push({index,code:error.code,message:error.message});
    }
  }
  if(fileErrors.length)
    throw Object.assign(new Error('No attachments were uploaded. Fix the files listed below and retry.'),
      {status,code:'ATTACHMENT_BATCH_INVALID',fileErrors});
  if(total>rules.maxBatchBytes)fail(413,'ATTACHMENT_BATCH_TOO_LARGE','The batch cannot exceed 4 MiB total.');
  capacity(rows.length,total,book,version);
  return rows;
}
const reviewPolicy='manual-v1';
const accountPattern=/^[a-z][a-z0-9-]{0,47}$/u;
const isAccount=value=>typeof value==='string'&&accountPattern.test(value);
function queryPolicy(book){
  if(book.attachmentReview===undefined)return false;
  if(book.attachmentReview!==reviewPolicy)throw Error('Unsupported attachment review policy.');
  return true;
}
function status(row,required){
  const q=row.quarantine;
  // Even when settings change, a staged row never acts like a legacy upload.
  // Extended-size bytes were never accepted without manual review. A
  // missing workspace flag and missing file review cannot make them legacy.
  if(q===undefined)return required||row.payloadProfile!==undefined?'unavailable':null;
  if(!required)return 'unavailable';
  if(!q||typeof q!=='object'||Array.isArray(q)||!isAccount(q.uploader)||!['pending','released','rejected'].includes(q.status))
    return 'unavailable';
  if(q.status!=='pending'&&(!isAccount(q.decidedBy)||q.decidedBy===q.uploader||
    (q.status==='released'&&(typeof q.approvedHash!=='string'||!shaPattern.test(q.approvedHash)||q.approvedHash!==row.sha256))))return 'unavailable';
  return q.status;
}
function stage(row,account){
  if(!isAccount(account))
    fail(403,'ATTACHMENT_REVIEW_IDENTITY_REQUIRED','A signed-in analyst is required for quarantined uploads.');
  return {...row,quarantine:{status:'pending',uploader:account}};
}
function assertAvailable(row,required){
  const current=status(row,required);
  if(current!==null&&current!=='released')
    fail(409,'ATTACHMENT_QUARANTINED','This attachment is not released for download.');
}
function decide(row,required,account,body){
  if(!isAccount(account)||row.quarantine?.uploader===account)
    fail(403,'ATTACHMENT_INDEPENDENT_REVIEW','A separate signed-in reviewer must decide.');
  if(!required||status(row,required)!=='pending')
    fail(409,'ATTACHMENT_NOT_PENDING','This attachment is not pending quarantine review.');
  if(body.operation==='release'){
    if(typeof body.sha256!=='string'||!shaPattern.test(body.sha256)||body.sha256!==row.sha256)
      fail(422,'ATTACHMENT_REVIEW_DIGEST','Enter the matching SHA-256 from the independently verified original.');
    download(row);
    row.quarantine={...row.quarantine,status:'released',decidedBy:account,approvedHash:row.sha256};
  }else if(body.operation==='reject'&&body.sha256===undefined){
    row.quarantine={...row.quarantine,status:'rejected',decidedBy:account};
  }else fail(422,'ATTACHMENT_REVIEW_OPERATION','Choose release with its exact SHA-256, or reject without a digest.');
  return row.quarantine.status;
}
function metadata(row,required){
  const {id,name,mediaType,size,sha256}=row;
  const reviewStatus=status(row,required);
  return {id,name,mediaType,size,sha256,...(reviewStatus===null?{}:{reviewStatus})};
}
function verifiedBytes(row){
  const name=cleanName(row.name),format=namedFormat(name);
  if(typeof row.id!=='string'||!idPattern.test(row.id)||typeof row.sha256!=='string'||!shaPattern.test(row.sha256)||
    row.mediaType!==format.mediaType||name!==row.name)
    throw new Error('Stored metadata mismatch.');
  if(row.payloadProfile!==undefined&&(row.payloadProfile!=='large-pdf-v1'||format.extension!=='.pdf'||
    row.size<=format.maxFileBytes||row.size>largePdfMaxBytes))throw Error('Stored attachment profile mismatch.');
  const bytes=rawBytes(row.data,row.payloadProfile==='large-pdf-v1'?largePdfMaxBytes:format.maxFileBytes);
  if(bytes.length!==row.size||digest(bytes)!==row.sha256)throw new Error('Stored bytes mismatch.');
  return {name,format,bytes};
}
function verifyStored(row,required,{draft=false}={}){
  if(!row||typeof row!=='object'||Array.isArray(row))
    fail(409,'ATTACHMENT_UNAVAILABLE','The stored attachment failed its integrity check.');
  const disposition=status(row,required);
  if(disposition==='unavailable'||(!draft&&disposition!==null&&disposition!=='released'))
    fail(409,'ATTACHMENT_QUARANTINED','This attachment is not released for download.');
  try{verifiedBytes(row);}
  catch{fail(409,'ATTACHMENT_UNAVAILABLE','The stored attachment failed its integrity check.');}
}
function download(row){
  try{
    const {name,format,bytes}=verifiedBytes(row);
    // On access apply current format structure rules. Backups verify byte
    // integrity without treating today's upload format policy as a migration.
    format.check(bytes);
    return {filename:name,bytes};
  }catch{
    fail(409,'ATTACHMENT_UNAVAILABLE','The stored attachment failed its integrity check.');
  }
}
module.exports={rules,uploadRequestBytes,batchUploadRequestBytes,attachment,batch,metadata,download,queryPolicy,reviewPolicy,stage,assertAvailable,decide,verifyStored};

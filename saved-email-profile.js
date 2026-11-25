'use strict';

// This is a deliberately narrow local fixture profile, not a general
// RFC 5322/MIME parser. The application never interprets routing or sends mail.
const maxFileBytes=32*1024;
const required=['from','to','date','subject','mime-version','content-type','content-transfer-encoding'];
const allowed=new Set([...required,'message-id']);
const weekdays=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fictionalAddress=/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*@(?:[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\.)+invalid$/iu;
function invalid(message='Use a single-part, 7-bit plain-text EML with fictional .invalid addresses.'){
  throw Object.assign(Error(message),{status:415,code:'ATTACHMENT_CONTENT_INVALID'});
}
function utcDate(value){
  const match=/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (20\d{2}|21\d{2}) (\d{2}):(\d{2}):(\d{2}) \+0000$/u.exec(value);
  if(!match)return false;
  const [,weekday,ds,month,ys,hs,ms,ss]=match;
  const d=Number(ds),y=Number(ys),h=Number(hs),m=Number(ms),s=Number(ss),mo=months.indexOf(month);
  const date=new Date(Date.UTC(y,mo,d,h,m,s));
  return date.getUTCFullYear()===y&&date.getUTCMonth()===mo&&date.getUTCDate()===d&&
    date.getUTCHours()===h&&date.getUTCMinutes()===m&&date.getUTCSeconds()===s&&weekdays[date.getUTCDay()]===weekday;
}
function prose(line){
  // A conservative alphabet excludes markup, URL/email/path delimiters,
  // encoded words, escape encodings and Markdown-style link syntax.
  return /^[A-Za-z0-9 \t.,!?;'"()\-]*$/u.test(line)&&
    !/\.[A-Za-z0-9-]|^[ \t]*(?:--|From[ \t])|(?:\d[\t .()-]*){7}|[A-Za-z0-9]{64}/u.test(line);
}
function checkSavedEmail(bytes){
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>maxFileBytes)invalid();
  const input=bytes.toString('latin1');
  if(/[^\t\r\n\x20-\x7E]|\r(?!\n)/u.test(input))invalid();
  const crlf=input.includes('\r\n');
  if(crlf&&input.replaceAll('\r\n','').includes('\n'))invalid('EML line endings must be consistent.');
  const newline=crlf?'\r\n':'\n',separator=newline+newline,cut=input.indexOf(separator);
  if(cut<1||cut>4096)invalid('EML must have a short unambiguous header block and a separate plain-text body.');
  const headers=new Map();
  for(const line of input.slice(0,cut).split(newline)){
    const match=/^([A-Za-z][A-Za-z-]*): ([\x20-\x7E]+)$/u.exec(line);
    if(!match||line.length>512||match[2]!==match[2].trim())invalid('EML headers cannot be folded or malformed.');
    const key=match[1].toLowerCase();
    if(!allowed.has(key)||headers.has(key))invalid('EML contains an unsupported or duplicate header.');
    headers.set(key,match[2]);
  }
  if(required.some(key=>!headers.has(key)))invalid('EML is missing one or more required fixture headers.');
  const address=value=>value.length<=128&&fictionalAddress.test(value);
  const messageId=headers.get('message-id');
  if(!address(headers.get('from'))||!address(headers.get('to'))||
    (messageId!==undefined&&(!/^<[^<>]+>$/u.test(messageId)||!address(messageId.slice(1,-1)))))
    invalid('Use one bare fictional .invalid address per address header.');
  if(!utcDate(headers.get('date')))invalid('Use a valid UTC EML date with a matching weekday and +0000 offset.');
  if(headers.get('mime-version')!=='1.0'||
    !/^text\/plain; charset=(?:us-ascii|"us-ascii")$/iu.test(headers.get('content-type'))||
    !/^7bit$/iu.test(headers.get('content-transfer-encoding')))
    invalid('Only single-part US-ASCII text/plain with 7bit transfer encoding is accepted.');
  const subject=headers.get('subject'),body=input.slice(cut+separator.length);
  const lines=body.split(newline);
  if(subject.length>120||!prose(subject)||!body.trim()||lines.length>512||
    lines.some(line=>line.length>998||!prose(line)))
    invalid('EML subject and body must be short plain prose without markup, links, email addresses, or encoded content.');
}

module.exports={checkSavedEmail,maxFileBytes};

'use strict';
const rust=require('./rust-core');
const {inflateRawSync,crc32}=require('node:zlib');
const {posix}=require('node:path');
const {odfTypes,checkOpenDocument}=require('./opendocument-attachment-profile');
const {checkSavedEmail,maxFileBytes:emlLimit}=require('./saved-email-profile');
const KiB=1024, MiB=1024*KiB;
const utf8=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
const ascii=(buffer,start,end)=>buffer.toString('latin1',start,end);
const prefix=(buffer,value)=>buffer.subarray(0,value.length).equals(Buffer.from(value,'latin1'));
const imageBounds=(width,height)=>width>0&&height>0&&width<=20000&&height<=20000&&width*height<=50_000_000;
function invalid(message='The file bytes do not match its supported format.'){
  throw Object.assign(new Error(message),{status:415,code:'ATTACHMENT_CONTENT_INVALID'});
}
function text(bytes){
  let value;
  try{value=utf8.decode(bytes).replace(/^\uFEFF/u,'');}
  catch{invalid('Text and delimited files must be valid UTF-8.');}
  if(!value.trim()||/\p{C}/u.test(value.replace(/[\r\n\t]/gu,''))||
    /^\s*<(?:[!?]|\/?[A-Za-z])/u.test(value)||/^\s*\{\\rtf/iu.test(value))
    invalid('Text files must be nonempty printable UTF-8, not markup or binary files.');
  return value;
}
function parsedJson(value,message){
  try{return JSON.parse(value);}
  catch{invalid(message);}
}
function json(bytes){
  const value=parsedJson(text(bytes),'JSON attachments must contain valid UTF-8 JSON.');
  if(value===null||typeof value!=='object')invalid('JSON attachments must contain a top-level object or array.');
}
function jsonLines(bytes){
  const value=text(bytes);
  let start=0,count=0;
  while(start<value.length){
    const newline=value.indexOf('\n',start),end=newline<0?value.length:newline;
    if(++count>10000)invalid('JSON Lines attachments support up to 10,000 records.');
    const record=parsedJson(value.slice(start,end),'Each JSON Lines entry must be a valid UTF-8 JSON object, with no blank lines.');
    if(record===null||typeof record!=='object'||Array.isArray(record))invalid('Each JSON Lines entry must be a JSON object.');
    start=end+1;
  }
}
function markdown(bytes){
  const value=text(bytes);
  // Only plain-style Markdown is accepted. The app never interprets it or fetches a resource.
  if(/<(?:[!?]|\/?[A-Za-z])/u.test(value)||/!\s*\[|\]\s*[(\[]|^[ \t]*\[[^\]\r\n]+\]:/mu.test(value))
    invalid('Markdown attachments cannot contain raw HTML, links or embedded images.');
}
function delimited(bytes,separator){
  const value=text(bytes);
  let quoted=false, closed=false, start=0;
  function cell(end){
    const content=value.slice(start+(closed?1:0),end-(closed?1:0)).trimStart();
    if(/^[=+@-]/u.test(content)&&!/^(?:[+-]\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?)$/u.test(content.trimEnd()))
      invalid('Delimited files cannot contain formula-like cells.');
    start=end+1;closed=false;
  }
  for(let i=0;i<value.length;i++){
    const c=value[i];
    if(quoted){
      if(c==='"'){
        if(value[i+1]==='"')i++;
        else{quoted=false;closed=true;}
      }
    }else if(c===separator||c==='\r'||c==='\n'){
      cell(i);
      if(c==='\r'&&value[i+1]==='\n')start=++i+1;
    }else if(closed)invalid('Delimited text contains an invalid quoted field.');
    else if(c==='"'){
      if(i!==start)invalid('Delimited text contains an invalid quoted field.');
      quoted=true;
    }
  }
  if(quoted)invalid('Delimited text contains an unclosed quoted field.');
  cell(value.length);
}
function pdf(bytes){
  if(bytes.length<80||!/^%PDF-(?:1\.[0-7]|2\.0)(?:\r\n|\n|\r)/u.test(ascii(bytes,0,12)))invalid();
  const trailer=/startxref[\t\r\n ]+(\d{1,10})[\t\r\n ]+%%EOF[\t\r\n ]*$/u.exec(ascii(bytes,Math.max(0,bytes.length-2048)));
  const offset=Number(trailer?.[1]);
  if(!Number.isSafeInteger(offset)||offset<9||offset>=bytes.length-20||
    !/^(?:xref[\t\r\n ]|\d+ +\d+ +obj\b)/u.test(ascii(bytes,offset,offset+64)))invalid();
  // Only a conservative coarse filter. PDF streams are never decoded or rendered.
  if(/\/(?:JavaScript|JS|Launch|EmbeddedFile|RichMedia|OpenAction|AA)(?=[\s/<>()\[\]{}%]|$)/u.test(ascii(bytes)))
    invalid('PDF files with visible active actions or embedded files are not supported.');
}
function png(bytes){
  if(bytes.length<45||!prefix(bytes,'\x89PNG\r\n\x1a\n'))invalid();
  let idat=false,at=8,count=0;
  while(at+12<=bytes.length&&++count<=1024){
    const length=bytes.readUInt32BE(at),end=at+8+length,type=ascii(bytes,at+4,at+8);
    if(end+4>bytes.length||!/^[A-Za-z]{4}$/u.test(type)||crc32(bytes.subarray(at+4,end))!==bytes.readUInt32BE(end))invalid();
    if(count===1&&(type!=='IHDR'||length!==13||!imageBounds(bytes.readUInt32BE(at+8),bytes.readUInt32BE(at+12))))invalid();
    if(count!==1&&type==='IHDR')invalid();
    if(type==='IDAT'&&length)idat=true;
    if(type==='IEND'){
      if(idat&&!length&&end+4===bytes.length)return;
      invalid();
    }
    at=end+4;
  }
  invalid();
}
function jpeg(bytes){
  if(bytes.length<16||bytes.readUInt16BE(0)!==0xffd8||bytes.readUInt16BE(bytes.length-2)!==0xffd9)invalid();
  let at=2,frame=false;
  while(at+4<bytes.length){
    if(bytes[at++]!==0xff)invalid();
    while(bytes[at]===0xff)at++;
    const marker=bytes[at++];
    if(!marker||marker===0xd8||marker===0xd9||at+2>=bytes.length)invalid();
    const length=bytes.readUInt16BE(at);
    if(length<2||at+length>=bytes.length-2)invalid();
    if([0xc0,0xc1,0xc2].includes(marker)){
      if(length<8||!imageBounds(bytes.readUInt16BE(at+5),bytes.readUInt16BE(at+3)))invalid();
      frame=true;
    }
    if(marker===0xda){if(frame&&length>=6)return;invalid();}
    at+=length;
  }
  invalid();
}
function gif(bytes){
  if(bytes.length<14||!/^GIF8[79]a$/u.test(ascii(bytes,0,6))||!imageBounds(bytes.readUInt16LE(6),bytes.readUInt16LE(8)))invalid();
  let at=13,images=0;
  if(bytes[10]&128)at+=3*(2**((bytes[10]&7)+1));
  function subblocks(){
    while(at<bytes.length){
      const n=bytes[at++];if(!n)return;
      at+=n;
    }
    invalid();
  }
  while(at<bytes.length){
    const type=bytes[at++];
    if(type===0x3b){if(images&&at===bytes.length)return;invalid();}
    if(type===0x21){if(at>=bytes.length)invalid();at++;subblocks();}
    else if(type===0x2c){
      if(at+10>=bytes.length||!imageBounds(bytes.readUInt16LE(at+4),bytes.readUInt16LE(at+6)))invalid();
      const flags=bytes[at+8];at+=9;
      if(flags&128)at+=3*(2**((flags&7)+1));
      if(bytes[at]<2||bytes[at]>8)invalid();
      at++;subblocks();images++;
    }else invalid();
  }
  invalid();
}
function webp(bytes){
  if(bytes.length<25||ascii(bytes,0,4)!=='RIFF'||ascii(bytes,8,12)!=='WEBP'||bytes.readUInt32LE(4)!==bytes.length-8)invalid();
  let image=false,at=12,count=0;
  while(at+8<=bytes.length&&++count<=1024){
    const tag=ascii(bytes,at,at+4),length=bytes.readUInt32LE(at+4),start=at+8,end=start+length;
    if(end+(length%2)>bytes.length||(length%2&&bytes[end]!==0))invalid();
    if(tag==='VP8 '){
      if(length<11||ascii(bytes,start+3,start+6)!=='\x9d\x01\x2a'||
        !imageBounds(bytes.readUInt16LE(start+6)&0x3fff,bytes.readUInt16LE(start+8)&0x3fff))invalid();
      image=true;
    }else if(tag==='VP8L'){
      if(length<6||bytes[start]!==0x2f)invalid();
      const details=bytes.readUInt32LE(start+1);
      if((details>>>29)!==0||!imageBounds((details&0x3fff)+1,((details>>>14)&0x3fff)+1))invalid();
      image=true;
    }else if(tag==='VP8X'){
      if(length!==10||at!==12||(bytes[start]&2)||!imageBounds(bytes.readUIntLE(start+4,3)+1,bytes.readUIntLE(start+7,3)+1))
        invalid('Only nonanimated WebP files are supported.');
    }else if(!['ALPH','ICCP','EXIF','XMP '].includes(tag))invalid();
    at=end+(length%2);
  }
  if(!image||at!==bytes.length)invalid();
}
function bmp(bytes){
  if(bytes.length<54||!prefix(bytes,'BM')||bytes.readUInt32LE(2)!==bytes.length||bytes.readUInt32LE(6)!==0)invalid();
  const offset=bytes.readUInt32LE(10),header=bytes.readUInt32LE(14),width=bytes.readInt32LE(18),height=Math.abs(bytes.readInt32LE(22));
  const planes=bytes.readUInt16LE(26),bits=bytes.readUInt16LE(28),compression=bytes.readUInt32LE(30);
  if(![40,108,124].includes(header)||offset<14+header||!imageBounds(width,height)||planes!==1||
    ![1,4,8,16,24,32].includes(bits)||compression!==0||offset+4*Math.ceil(width*bits/32)*height!==bytes.length)invalid();
}
function tiff(bytes){
  if(bytes.length<14)invalid();
  const little=prefix(bytes,'II\x2a\x00');
  if(!little&&!prefix(bytes,'MM\x00\x2a'))invalid();
  const u16=(at)=>little?bytes.readUInt16LE(at):bytes.readUInt16BE(at);
  const u32=(at)=>little?bytes.readUInt32LE(at):bytes.readUInt32BE(at);
  const widths=[0,1,1,2,4,8,1,1,2,4,8,4,8];
  let at=u32(4),images=0;
  while(at!==0&&++images<=32){
    if(at<8||at+6>bytes.length||at%2)invalid();
    const n=u16(at),end=at+2+n*12;
    if(!n||n>256||end+4>bytes.length)invalid();
    let width,height,hasPixels=false;
    for(let i=at+2;i<end;i+=12){
      const tag=u16(i),type=u16(i+2),items=u32(i+4),size=items*widths[type];
      if(!size||size>bytes.length||(size>4&&(u32(i+8)<8||u32(i+8)+size>bytes.length)))invalid();
      if(items===1&&(type===3||type===4)){
        const datum=type===3?u16(i+8):u32(i+8);
        if(tag===256)width=datum;
        if(tag===257)height=datum;
      }
      if([273,324].includes(tag)&&[3,4].includes(type)){
        const start=size<=4?i+8:u32(i+8);
        if(items>8192)invalid();
        for(let j=0;j<items;j++){
          const pixelOffset=type===3?u16(start+j*2):u32(start+j*4);
          if(pixelOffset<8||pixelOffset>=bytes.length)invalid();
        }
        hasPixels=true;
      }
    }
    if(!hasPixels||!imageBounds(width,height))invalid();
    const next=u32(end);
    if(next&&next<=at)invalid();
    at=next;
  }
  if(!images||at!==0)invalid();
}

const ZIP_MAX_ENTRIES=256, ZIP_MAX_EXPANDED=8*MiB, ZIP_MAX_PART=2*MiB;
const forbiddenOffice=/(?:macro|vbaproject|activex|externalLink|oleobject|embeddings?|attachedtemplate|connections|customUI|taskpanes|webextensions|printerSettings|digital-signature)/iu;
const dangerousXml=/<!\s*(?:DOCTYPE|ENTITY)\b|<\?(?!xml\s)|<\s*(?:[\w.-]+:)?(?:altChunk|object|oleObject|control|DDE|ddeLink|oleLink|externalLink)\b|\bDDE(?:AUTO)?\s*[^\s<]/iu;
const officeNamespace='http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const strictOfficeNamespace='http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument';
const officeRules={
  '.docx':['word/','word/document.xml','application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml','document',/wordprocessingml\/(?:20\d{2}\/)?main/u],
  '.xlsx':['xl/','xl/workbook.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml','workbook',/spreadsheetml\/(?:20\d{2}\/)?main/u],
  '.pptx':['ppt/','ppt/presentation.xml','application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml','presentation',/presentationml\/(?:20\d{2}\/)?main/u]
};
function boundedZip(bytes,reject,allowEntry){
  const finish=bytes.length-22;
  if(finish<30||bytes.readUInt32LE(finish)!==0x06054b50||!prefix(bytes,'PK\x03\x04')||
    bytes.readUInt32LE(finish+4)!==0||bytes.readUInt16LE(finish+20)!==0)reject();
  const n=bytes.readUInt16LE(finish+10),middle=bytes.readUInt32LE(finish+16);
  if(!n||n>ZIP_MAX_ENTRIES||bytes.readUInt16LE(finish+8)!==n||middle>=finish||middle<30||
    middle+bytes.readUInt32LE(finish+12)!==finish)reject();
  function extraOK(from,to){
    if(to-from>512)return false;
    while(from<to){
      if(from+4>to)return false;
      const kind=bytes.readUInt16LE(from),len=bytes.readUInt16LE(from+2);
      if([0x0001,0x7075,0x9901].includes(kind)||from+4+len>to)return false;
      from+=4+len;
    }
    return from===to;
  }
  const folded=new Set(),parts=new Map(),spans=[];
  let at=middle, expanded=0;
  for(let i=0;i<n;i++){
    if(at+46>finish||bytes.readUInt32LE(at)!==0x02014b50)reject();
    const flags=bytes.readUInt16LE(at+8),method=bytes.readUInt16LE(at+10);
    const crc=bytes.readUInt32LE(at+16),compressed=bytes.readUInt32LE(at+20),size=bytes.readUInt32LE(at+24);
    const nameBytes=bytes.readUInt16LE(at+28),extraBytes=bytes.readUInt16LE(at+30),comment=bytes.readUInt16LE(at+32);
    const unixMode=(bytes.readUInt32LE(at+38)>>>16)&0xf000,loc=bytes.readUInt32LE(at+42);
    const nameAt=at+46,extraAt=nameAt+nameBytes,next=extraAt+extraBytes+comment;
    if(next>finish||!nameBytes||nameBytes>180||comment>128||!extraOK(extraAt,extraAt+extraBytes)||
      bytes.readUInt16LE(at+34)!==0||![0,0x4000,0x8000].includes(unixMode)||
      (flags&~0x080e)||![0,8].includes(method)||(!method&&(flags&6))||
      size>ZIP_MAX_PART||(expanded+=size)>ZIP_MAX_EXPANDED||compressed>middle||loc+30>middle)reject();
    const name=ascii(bytes,nameAt,extraAt),directory=name.endsWith('/'),stem=directory?name.slice(0,-1):name;
    if(!/^[A-Za-z0-9 _.\[\]/-]+$/u.test(stem)||stem.split('/').some(p=>!p||p==='.'||p==='..'||p.endsWith('.')||p!==p.trim())||
      folded.has(stem.toLowerCase())||/[\u0000-\u001f\u007f]/u.test(name)||
      (directory?(size!==0||unixMode===0x8000):(!size||unixMode===0x4000)))reject();
    folded.add(stem.toLowerCase());
    if(bytes.readUInt32LE(loc)!==0x04034b50||bytes.readUInt16LE(loc+6)!==flags||bytes.readUInt16LE(loc+8)!==method||
      bytes.readUInt16LE(loc+26)!==nameBytes)reject();
    const localName=loc+30,localExtra=localName+nameBytes,localExtras=bytes.readUInt16LE(loc+28);
    const start=localExtra+localExtras,end=start+compressed;
    if(end>middle||!extraOK(localExtra,start)||ascii(bytes,localName,localExtra)!==name||
      !allowEntry({name,directory,loc,method,flags,localExtras,centralExtras:extraBytes}))reject();
    for(const [off,val] of [[14,crc],[18,compressed],[22,size]]){
      const local=bytes.readUInt32LE(loc+off);
      if(local!==val&&(!((flags&8)&&local===0)))reject();
    }
    let dataEnd=end;
    if(flags&8){
      if(dataEnd+4<=middle&&bytes.readUInt32LE(dataEnd)===0x08074b50)dataEnd+=4;
      if(dataEnd+12>middle||bytes.readUInt32LE(dataEnd)!==crc||
        bytes.readUInt32LE(dataEnd+4)!==compressed||bytes.readUInt32LE(dataEnd+8)!==size)reject();
      dataEnd+=12;
    }
    spans.push([loc,dataEnd]);at=next;
    let decoded;
    if(method===0){if(compressed!==size)reject();decoded=bytes.subarray(start,end);}
    else{
      try{
        const result=inflateRawSync(bytes.subarray(start,end),{maxOutputLength:Math.max(1,size),info:true});
        if(result.engine.bytesWritten!==compressed)reject();
        decoded=result.buffer;
      }catch{reject();}
    }
    if(decoded.length!==size||crc32(decoded)!==crc)reject();
    if(!directory)parts.set(name,decoded);
  }
  spans.sort((a,b)=>a[0]-b[0]);
  let covered=0;
  for(const [start,end] of spans){if(start!==covered)reject();covered=end;}
  if(at!==finish||covered!==middle)reject();
  return parts;
}
function office(bytes,extension){
  const [folder,main,mainMime,rootName,rootNamespace]=officeRules[extension];
  const reject=()=>invalid('Office files require a bounded, macro-free DOCX, XLSX, or PPTX package without external links or embedded objects.');
  const parts=boundedZip(bytes,reject,({name})=>!forbiddenOffice.test(name)&&
    (name==='[Content_Types].xml'||name==='_rels/.rels'||[folder,'docProps/','customXml/','_rels/'].some(p=>name.startsWith(p))));
  if(!parts.has(main)||!parts.has('[Content_Types].xml')||!parts.has('_rels/.rels'))reject();
  const xmlParts=new Map();
  const raster={'.png':png,'.jpg':jpeg,'.jpeg':jpeg,'.gif':gif,'.webp':webp,'.bmp':bmp,'.tif':tiff,'.tiff':tiff};
  for(const [name,body] of parts){
    const ext=name==='_rels/.rels'?'.rels':posix.extname(name).toLowerCase();
    if(ext==='.xml'||ext==='.rels'){
      const xml=textXml(body,reject);
      if(dangerousXml.test(xml))reject();
      xmlParts.set(name,xml);
    }else if(name===folder+'media/'+posix.basename(name)||name.startsWith('docProps/thumbnail.')){
      if(!Object.hasOwn(raster,ext))reject();
      const image=ext==='.jpeg'&&name==='docProps/thumbnail.jpeg'&&body.at(-1)===0?body.subarray(0,-1):body;
      raster[ext](image);
    }else reject();
  }
  function entries(xml,rootTag,ns,schema){
    const header=xml.replace(/^\s*(?:<\?xml[^?]*\?>\s*)?/u,'');
    const container=new RegExp('^<(?:(?<prefix>[A-Za-z][\\w.-]*):)?'+rootTag+
      '(?<attrs>[^<>]*?)(?:>(?<content>[\\s\\S]*)</(?:\\k<prefix>:)?'+rootTag+'\\s*>|/>)\\s*$','u').exec(header);
    if(!container)reject();
    function attrs(raw){
      const result=Object.create(null);
      let index=0;
      const token=/\s+([A-Za-z][\w.:-]*)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/uy;
      while(index<raw.length){
        if(!raw.slice(index).trim())break;
        token.lastIndex=index;
        const attr=token.exec(raw);
        if(!attr||Object.hasOwn(result,attr[1]))reject();
        result[attr[1]]=attr[2]??attr[3];
        index=token.lastIndex;
      }
      return result;
    }
    const rootAttrs=attrs(container.groups.attrs),prefix=container.groups.prefix;
    if(rootAttrs[prefix?'xmlns:'+prefix:'xmlns']!==ns||Object.keys(rootAttrs).some(key=>!/^xmlns(?::[A-Za-z][\w.-]*)?$/u.test(key)))reject();
    const content=container.groups.content??'',rows=[];
    const element=/\s*<(?:(?<prefix>[A-Za-z][\w.-]*):)?(?<name>[A-Za-z][\w.-]*)(?<attrs>[^<>]*?)\/>/uy;
    let at=0;
    while(at<content.length){
      if(!content.slice(at).trim())break;
      element.lastIndex=at;
      const match=element.exec(content);
      if(!match||match.groups.prefix!==prefix||!Object.hasOwn(schema,match.groups.name))reject();
      const data=attrs(match.groups.attrs),[required,optional]=schema[match.groups.name];
      if(required.some(k=>!data[k])||Object.keys(data).some(k=>![...required,...optional].includes(k)))reject();
      rows.push({tag:match.groups.name,...data});
      at=element.lastIndex;
    }
    return rows;
  }
  const catalog=xmlParts.get('[Content_Types].xml'),types=new Map(),defaults=new Map();
  for(const row of entries(catalog,'Types','http://schemas.openxmlformats.org/package/2006/content-types',
    {Default:[['Extension','ContentType'],[]],Override:[['PartName','ContentType'],[]]})){
    if(!isOfficeMime(row.ContentType))reject();
    if(row.tag==='Default'){
      if(!/^[A-Za-z0-9]{1,12}$/u.test(row.Extension)||defaults.has(row.Extension.toLowerCase()))reject();
      defaults.set(row.Extension.toLowerCase(),row.ContentType);
    }else{
      const part=decodePart(row.PartName,reject);
      if(!part.startsWith('/')||!parts.has(part.slice(1))||types.has(part.slice(1)))reject();
      types.set(part.slice(1),row.ContentType);
    }
  }
  if(types.get(main)!==mainMime)reject();
  for(const [name,body] of xmlParts){
    if(name==='[Content_Types].xml')continue;
    if(!name.endsWith('.rels'))continue;
    const base=name==='_rels/.rels'?'':name.replace(/(?:^|\/)_rels\/[^/]+\.rels$/u,'');
    if(name!=='_rels/.rels'&&(!/(?:^|\/)_rels\/[^/]+\.rels$/u.test(name)||!parts.has(posix.join(base,posix.basename(name,'.rels')))))reject();
    const rels=entries(body,'Relationships','http://schemas.openxmlformats.org/package/2006/relationships',
      {Relationship:[['Id','Type','Target'],['TargetMode']]}),ids=new Set();
    let officeMain=0;
    for(const row of rels){
      if(ids.has(row.Id)||(row.TargetMode&&row.TargetMode!=='Internal')||forbiddenOffice.test(row.Type)||
        !/^https?:\/\/(?:schemas\.openxmlformats\.org|schemas\.microsoft\.com|purl\.oclc\.org)\//u.test(row.Type))reject();
      ids.add(row.Id);
      const relative=decodePart(row.Target,reject);
      const destination=relative.startsWith('/')?posix.normalize(relative.slice(1)):posix.normalize(posix.join(base,relative));
      if(!parts.has(destination))reject();
      if(name==='_rels/.rels'&&[officeNamespace,strictOfficeNamespace].includes(row.Type)){
        if(destination!==main)reject();
        officeMain++;
      }
    }
    if(name==='_rels/.rels'&&officeMain!==1)reject();
  }
  const root=xmlParts.get(main);
  if(!new RegExp('^\\s*(?:<\\?xml[^?]*\\?>\\s*)?<(?:[\\w.-]+:)?'+rootName+'(?=\\s|>)','u').test(root)||!rootNamespace.test(root))reject();
  for(const name of parts.keys()){
    if(name==='[Content_Types].xml')continue;
    const ext=name==='_rels/.rels'?'rels':posix.extname(name).slice(1).toLowerCase();
    const mime=types.get(name)??defaults.get(ext);
    if(!mime||(ext==='rels'&&mime!=='application/vnd.openxmlformats-package.relationships+xml')||
      (ext==='xml'&&!mime.endsWith('xml'))||
      (ext!=='xml'&&ext!=='rels'&&!Array.from(formats.values()).some(x=>x.extension==='.'+ext&&x.mediaType===mime)))reject();
  }
}
function textXml(buffer,reject){
  let xml;
  try{xml=utf8.decode(buffer).replace(/^\uFEFF/u,'');}catch{reject();}
  if(!/^\s*</u.test(xml)||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(xml))reject();
  return xml;
}
function decodePart(path,reject){
  let decoded;
  try{decoded=decodeURIComponent(path);}catch{reject();}
  if(!/^[A-Za-z0-9 _.\[\]/-]+$/u.test(decoded)||decoded.startsWith('//'))reject();
  return decoded;
}
function isOfficeMime(mime){
  return !forbiddenOffice.test(mime)&&/^(?:application\/(?:xml|vnd\.(?:openxmlformats-officedocument|openxmlformats-package|ms-(?:excel|word|powerpoint)|ms-office)[a-z0-9.-]*\+xml)|text\/xml|image\/(?:png|jpeg|gif|webp|bmp|tiff))$/iu.test(mime);
}
function rasterCheck(kind,reference){
  return bytes=>{
    if(!rust.enabled)return reference(bytes);
    const result=rust.raster(kind,bytes);
    if(result===1)return;
    if(result===2)invalid('Only nonanimated WebP files are supported.');
    invalid();
  };
}
const formats=new Map();
function add(extensions,mediaType,label,check,maxFileBytes=MiB,aliases=[]){
  for(const extension of extensions)formats.set(extension,Object.freeze({extension,mediaType,label,check,maxFileBytes,aliases}));
}
add(['.txt'],'text/plain','Plain text',text,16*KiB);
add(['.csv'],'text/csv','CSV',bytes=>delimited(bytes,','),MiB,['application/csv','application/vnd.ms-excel','text/plain']);
add(['.tsv'],'text/tab-separated-values','TSV',bytes=>delimited(bytes,'\t'),MiB,['text/plain']);
add(['.json'],'application/json','JSON',json,MiB,['text/json','text/plain']);
add(['.jsonl','.ndjson'],'application/x-ndjson','JSON Lines',jsonLines,MiB,['application/jsonl','application/json','application/ndjson','text/jsonl','text/plain']);
add(['.md','.markdown'],'text/markdown','Markdown',markdown,MiB,['text/x-markdown','text/plain']);
add(['.log'],'text/plain','Plain log',text,MiB,['text/x-log']);
add(['.eml'],'message/rfc822','Plain fictional saved email',checkSavedEmail,emlLimit,['text/plain']);
add(['.pdf'],'application/pdf','PDF',pdf);
for(const [extension,[,,,name]] of Object.entries(officeRules)){
  const kind={document:'Word',workbook:'Excel',presentation:'PowerPoint'}[name];
  const type={document:'wordprocessingml.document',workbook:'spreadsheetml.sheet',presentation:'presentationml.presentation'}[name];
  add([extension],'application/vnd.openxmlformats-officedocument.'+type,kind,bytes=>office(bytes,extension));
}
for(const [extension,{mediaType,label}] of Object.entries(odfTypes)){
  add([extension],mediaType,label,bytes=>checkOpenDocument(bytes,extension,boundedZip,invalid),MiB);
}
add(['.png'],'image/png','PNG',rasterCheck(1,png));
add(['.jpg','.jpeg'],'image/jpeg','JPEG',rasterCheck(2,jpeg));
add(['.gif'],'image/gif','GIF',rasterCheck(3,gif));
add(['.webp'],'image/webp','WebP',rasterCheck(4,webp));
add(['.bmp'],'image/bmp','BMP',rasterCheck(5,bmp),MiB,['image/x-ms-bmp']);
add(['.tif','.tiff'],'image/tiff','TIFF',rasterCheck(6,tiff));
const catalog=Object.freeze(Array.from(formats.values(),({check,...format})=>Object.freeze(format)));
module.exports={formats,catalog};

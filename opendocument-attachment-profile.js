'use strict';

// Strict, deliberately incomplete passive ODF 1.2/1.3 attachment profile.
// The XML is inspected as bounded text, not interpreted with an XML resolver,
// application, browser, schema loader, or stylesheet engine.
const odfTypes=Object.freeze({
  '.odt':Object.freeze({mediaType:'application/vnd.oasis.opendocument.text',label:'OpenDocument Text',body:'text'}),
  '.ods':Object.freeze({mediaType:'application/vnd.oasis.opendocument.spreadsheet',label:'OpenDocument Spreadsheet',body:'spreadsheet'}),
  '.odp':Object.freeze({mediaType:'application/vnd.oasis.opendocument.presentation',label:'OpenDocument Presentation',body:'presentation'})
});
const rootPrefix='urn:oasis:names:tc:opendocument:xmlns:';
const namespaceUris=new Map([
  ...Object.entries({office:'office',style:'style',text:'text',table:'table',draw:'drawing',presentation:'presentation',
    number:'datastyle',meta:'meta',manifest:'manifest',fo:'xsl-fo-compatible',svg:'svg-compatible'})
    .map(([key,value])=>[rootPrefix+value+':1.0',key]),
  ['http://purl.org/dc/elements/1.1/','dc'],
  ['http://www.w3.org/XML/1998/namespace','xml']
]);
const vocabulary=Object.fromEntries(Object.entries({
  office:'document-content document-styles document-meta scripts font-face-decls automatic-styles body text spreadsheet presentation styles master-styles meta',
  style:'style default-style font-face page-layout page-layout-properties header-style footer-style header-footer-properties master-page paragraph-properties text-properties table-properties table-column-properties table-row-properties table-cell-properties section-properties graphic-properties drawing-page-properties presentation-page-layout tab-stops tab-stop columns column column-sep list-level-properties header footer header-left footer-left',
  text:'p h span s tab line-break soft-page-break section list list-item list-header list-style list-level-style-bullet list-level-style-number page-number page-count',
  table:'table table-column table-row table-cell covered-table-cell table-header-rows table-header-columns table-rows table-columns table-column-group table-row-group',
  draw:'page frame text-box rect line ellipse circle polygon polyline regular-polygon g custom-shape enhanced-geometry path',
  presentation:'placeholder notes',
  number:'number-style date-style time-style percentage-style boolean-style currency-style text-style number scientific-number fraction text year month day day-of-week week-of-year quarter hours minutes seconds am-pm currency-symbol text-content boolean embedded-text',
  meta:'generator initial-creator creation-date editing-duration editing-cycles document-statistic user-defined keyword printed-by print-date',
  dc:'title subject description creator date language',
  manifest:'manifest file-entry'
}).map(([key,values])=>[key,new Set(values.split(' '))]));
// Attribute namespaces are separately bound to URI. No href, resource source,
// actions, sheet formulas, or active properties, even in recognized namespaces.
const activeAttribute=/(?:href|url|(?:^|-)uri(?:-|$)|external|script|macro|command|action|event|listener|password|encrypt|checksum|algorithm|formula|(?:^|-)source(?:-|$)|(?:^|-)target(?:-|$)|(?:^|-)link(?:-|$)|(?:^|-)(?:src|include|file|address|service)(?:-|$)|binary|base64|background-image|fill-image|(?:^|-)filter(?:-|$)|digital-signature)/iu;
const activeValue=/(?:\burl\s*\(|(?:^|\s)(?:javascript|vbscript|file|data|https?|ftp|smb):|\\{2}|^\/\/)/iu;
const namedEntities={amp:'&',lt:'<',gt:'>',apos:"'",quot:'"'};
const entities=/&([^;\s<&]{1,12});|&/gu;
function decodeEntities(value){
  return value.replace(entities,(_match,key)=>{
    if(Object.hasOwn(namedEntities,key))return namedEntities[key];
    const hex=key[1]==='x';
    return String.fromCodePoint(parseInt(key.slice(hex?2:1),hex?16:10));
  });
}
const versionPattern=/^1\.[23]$/u;
const whites=/^[\t\r\n ]*$/u;
const utf8=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
const xmlMembers=new Map([['content.xml','document-content'],['styles.xml','document-styles'],['meta.xml','document-meta']]);
const manifestMember='META-INF/manifest.xml';
function validateEntities(value,reject){
  if(value.includes(']]>'))reject();
  for(const match of value.matchAll(entities)){
    const key=match[1];
    if(Object.hasOwn(namedEntities,key))continue;
    if(!key||!/^#(?:[0-9]{1,7}|x[0-9a-fA-F]{1,6})$/u.test(key))reject();
    const hex=key[1]==='x',code=parseInt(key.slice(hex?2:1),hex?16:10);
    if(code!==9&&code!==10&&code!==13&&!(code>=32&&code<=0xd7ff)&&!(code>=0xe000&&code<=0xfffd)&&
      !(code>=0x10000&&code<=0x10ffff))reject();
  }
}
function inspectXml(bytes,reject,visit,textNodes){
  let xml;
  try{xml=utf8.decode(bytes).replace(/^\uFEFF/u,'');}catch{reject();}
  if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufffe\uffff]/u.test(xml))reject();
  let at=0,count=0,rootSeen=false;
  if(xml.startsWith('<?xml')){
    const declaration=/^<\?xml[\t\r\n ]+version[\t\r\n ]*=[\t\r\n ]*(?:"1\.0"|'1\.0')(?:[\t\r\n ]+encoding[\t\r\n ]*=[\t\r\n ]*(?:"[Uu][Tt][Ff]-8"|'[Uu][Tt][Ff]-8'))?(?:[\t\r\n ]+standalone[\t\r\n ]*=[\t\r\n ]*(?:"(?:yes|no)"|'(?:yes|no)'))?[\t\r\n ]*\?>/u.exec(xml);
    if(!declaration)reject();
    at=declaration[0].length;
  }
  const stack=[],prefixes=new Map([['xml','http://www.w3.org/XML/1998/namespace']]);
  const namePattern=/[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?/uy;
  const attrPattern=/[\t\r\n ]+([A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?)[\t\r\n ]*=[\t\r\n ]*(?:"([^"<]*)"|'([^'<]*)')/uy;
  const endPattern=/[\t\r\n ]*(\/?>)/uy;
  const closePattern=/[\t\r\n ]*>/uy;
  function read(pattern,position){
    pattern.lastIndex=position;
    return pattern.exec(xml);
  }
  function resolve(raw,attribute){
    const colon=raw.indexOf(':'),prefix=colon<0?'':raw.slice(0,colon),name=colon<0?raw:raw.slice(colon+1);
    if(attribute&&!prefix)reject();
    const ns=namespaceUris.get(prefixes.get(prefix));
    if(!ns)reject();
    return {ns,name,qname:raw,key:ns+':'+name};
  }
  while(at<xml.length){
    if(xml[at]!=='<'){
      const next=xml.indexOf('<',at),end=next<0?xml.length:next,value=xml.slice(at,end);
      if(!stack.length&&!whites.test(value))reject();
      validateEntities(value,reject);
      textNodes(value,stack);
      at=end;continue;
    }
    if(xml.startsWith('<!--',at)){
      const end=xml.indexOf('-->',at+4);
      if(end<0||xml.slice(at+4,end).includes('--')||xml[end-1]==='-')reject();
      at=end+3;continue;
    }
    // All PIs after the declaration, DOCTYPE, entity declarations and CDATA are unsupported.
    if(++count>40_000||xml[at+1]==='!'||xml[at+1]==='?')reject();
    const closing=xml[at+1]==='/',start=at+(closing?2:1);
    const match=read(namePattern,start);
    if(!match||match[0].length>96)reject();
    const qname=match[0];
    at=namePattern.lastIndex;
    if(closing){
      if(!read(closePattern,at)||stack.pop()?.qname!==qname)reject();
      at=closePattern.lastIndex;continue;
    }
    if(!stack.length&&rootSeen)reject();
    if(stack.length>=64)reject();
    const values=new Map(),rawAttrs=new Map();
    let end;
    while(!(end=read(endPattern,at))){
      const item=read(attrPattern,at);
      if(!item||item[1].length>96||rawAttrs.size>=128||rawAttrs.has(item[1]))reject();
      const value=item[2]??item[3];
      if(value.length>32768)reject();
      validateEntities(value,reject);
      rawAttrs.set(item[1],value);
      at=attrPattern.lastIndex;
    }
    at=endPattern.lastIndex;
    for(const [name,value] of rawAttrs){
      if(name!=='xmlns'&&!name.startsWith('xmlns:'))continue;
      const prefix=name==='xmlns'?'':name.slice(6);
      if(rootSeen||!value||value.includes('&')||prefix==='xmlns'||
        (prefix==='xml'&&value!==prefixes.get('xml'))||
        (prefix!=='xml'&&value===prefixes.get('xml'))||
        /[\t\r\n ]/u.test(value))reject();
      prefixes.set(prefix,value);
    }
    for(const [name,value] of rawAttrs){
      if(name==='xmlns'||name.startsWith('xmlns:'))continue;
      const attr=resolve(name,true);
      if(values.has(attr.key))reject();
      values.set(attr.key,value);
    }
    const element=resolve(qname,false);
    if(!vocabulary[element.ns]?.has(element.name))reject();
    rootSeen=true;
    visit(element,values,stack);
    if(end[1]!== '/>')stack.push(element);
  }
  if(!rootSeen||stack.length)reject();
}
function oneOfAttrs(attrs,allowed,reject){
  for(const [key,value] of attrs)if(!allowed.includes(key)||value.includes('&'))reject();
  if(attrs.has('manifest:version')&&!versionPattern.test(attrs.get('manifest:version')))reject();
}
function manifest(bytes,parts,expectedMime,reject){
  const mapped=new Set();
  inspectXml(bytes,reject,(element,attrs,parents)=>{
    if(!parents.length&&element.key==='manifest:manifest'){
      oneOfAttrs(attrs,['manifest:version'],reject);
      return;
    }
    if(parents.length!==1||element.key!=='manifest:file-entry')reject();
    oneOfAttrs(attrs,['manifest:full-path','manifest:media-type','manifest:version'],reject);
    const path=attrs.get('manifest:full-path'),mime=attrs.get('manifest:media-type');
    if(mapped.has(path)||!(path==='/'?mime===expectedMime:xmlMembers.has(path)&&parts.has(path)&&['text/xml','application/xml'].includes(mime)))reject();
    mapped.add(path);
  },value=>{if(!whites.test(value))reject();});
  if(!mapped.has('/')||Array.from(parts.keys()).some(path=>xmlMembers.has(path)&&!mapped.has(path)))reject();
}
function documentXml(bytes,part,body,reject){
  let seenBody=false,seenKind=false,seenMeta=false;
  inspectXml(bytes,reject,(node,attrs,parents)=>{
    const parent=parents.at(-1);
    if(node.ns==='manifest')reject();
    if(!parents.length){
      if(node.key!=='office:'+xmlMembers.get(part)||!versionPattern.test(attrs.get('office:version')))reject();
    }else if(node.name.startsWith('document-')&&node.ns==='office')reject();
    if(node.key==='office:scripts'&&(part!=='content.xml'||parents.length!==1))reject();
    if(parent?.key==='office:scripts')reject();
    if(node.key==='office:body'){
      if(part!=='content.xml'||parents.length!==1||seenBody)reject();
      seenBody=true;
    }else if(parent?.key==='office:body'){
      if(node.key!=='office:'+body||seenKind)reject();
      seenKind=true;
    }else if(['office:text','office:spreadsheet','office:presentation'].includes(node.key))reject();
    if(node.key==='office:meta'){
      if(part!=='meta.xml'||parents.length!==1||seenMeta)reject();
      seenMeta=true;
    }
    // Metadata/style documents must not contain a body or text styles with brand-new
    // resolvers. Namespace allowlisting already excludes forms, XLinks, extensions,
    // RDFa, XML events, XInclude, embedded media and non-ODF vocabularies.
    for(const [key,value] of attrs){
      const [ns,name]=key.split(':');
      if(ns==='manifest'||name==='base'||(ns==='xml'&&!['id','lang','space'].includes(name))||
        activeAttribute.test(name)||activeValue.test(decodeEntities(value)))reject();
      if(ns==='table'&&/^number-(?:rows|columns)-(?:repeated|spanned)$/u.test(name)&&
        (!/^[1-9]\d{0,2}$/u.test(value)||Number(value)>512))reject();
    }
  },(value,parents)=>{
    if(['office:scripts','office:body'].includes(parents.at(-1)?.key)&&!whites.test(value))reject();
  });
  if(part==='content.xml'&&(!seenBody||!seenKind))reject();
  if(part==='meta.xml'&&!seenMeta)reject();
}
function checkOpenDocument(bytes,extension,boundedZip,invalid){
  const type=odfTypes[extension];
  const reject=()=>invalid('Use a static ODT, ODS, or ODP without links, formulas, scripts, encryption, or embedded files. Export unsupported documents as PDF or modern Office.');
  const parts=boundedZip(bytes,reject,({name,directory,loc,method,flags,localExtras,centralExtras})=>{
    if(name==='mimetype')return !directory&&loc===0&&method===0&&!(flags&8)&&localExtras===0&&centralExtras===0;
    if(directory)return name==='META-INF/';
    return name===manifestMember||xmlMembers.has(name);
  });
  if(!parts.get('mimetype')?.equals(Buffer.from(type.mediaType,'ascii'))||!parts.has('content.xml')||!parts.has(manifestMember))reject();
  manifest(parts.get(manifestMember),parts,type.mediaType,reject);
  for(const [part,body] of parts)if(xmlMembers.has(part))documentXml(body,part,type.body,reject);
}
module.exports={odfTypes,checkOpenDocument};

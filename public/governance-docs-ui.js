'use strict';
const docsPane=$('#governance-docs-view'),docsPath='/api/governance-documents';
let docsData,docsSeq=0;
const docsHeaders=()=>({'Content-Type':'application/json','X-Demo-Actor':actor});
async function refreshDocs(){
  const seq=++docsSeq;
  try{
    const data=await read(docsPath,{headers:docsHeaders()});
    if(seq===docsSeq&&!docsPane.hidden){docsData=data;renderDocs()}
  }catch(e){if(seq===docsSeq&&!docsPane.hidden){docsPane.replaceChildren(el('p','Could not load documents.'));notice(e.message,true)}}
}
async function docsPost(path,body,success){
  if(busy)return;
  busy=true;
  const identity=actor,seq=docsSeq;
  try{
    const data=await read(docsPath+path,{method:'POST',headers:docsHeaders(),body:JSON.stringify(body)});
    if(!docsPane.hidden&&actor===identity&&seq===docsSeq)success(data);
  }catch(e){
    if(!docsPane.hidden&&actor===identity){
      notice(e.message,true);
      if(e.status===409&&e.message.includes('Reload')){
        const b=button('Reload documents','button','secondary');b.onclick=async()=>{notice('');await refreshDocs()};
        $('#notice').append(document.createTextNode(' '),b);
      }
    }
  }finally{busy=false}
}
function docsPanel(parent,label){
  const panel=add(el('details'),el('summary',label));parent.append(panel);return panel;
}
function docsForm(parent,path,fields,caption,payload,revision){
  const form=add(el('form'),...fields,button(caption,'submit'));
  form.onsubmit=e=>{
    e.preventDefault();
    docsPost(path,{...payload(new FormData(form)),expectedRevision:revision},data=>{docsData=data;renderDocs();notice('Document workspace updated.')});
  };
  parent.append(form);
}
function documentFields(targets){
  const content=labelled('Original fictional text','content','');
  content.querySelector('textarea').maxLength=5000;
  const links=el('select');links.name='links';links.multiple=true;links.size=4;
  for(const t of targets){
    const o=el('option',docsData.linkKinds[t.type]+': '+t.label);o.value=t.type+':'+t.id;links.append(o);
  }
  return [labelled('Fictional title','title','','input'),content,add(el('label','Linked fictional records'),links)];
}
function documentPayload(form){
  return {title:form.get('title'),content:form.get('content'),links:form.getAll('links').map(value=>{
    const [type,id]=value.split(':');return {type,id};
  })};
}
function downloadDocument(data){
  const link=el('a');
  const url=URL.createObjectURL(new Blob([data.text],{type:'text/plain;charset=utf-8'}));
  link.href=url;link.download=data.filename;document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function renderDocs(){
  const {documents,revision,targets,legacyRecords}=docsData;
  const intro=add(el('section'),heading('Policies and evidence documents'),el('p','Use only original fictional text. Drafts and evidence are role-scoped in this local simulation. Uploads and external publication are not supported.'));
  if(actor==='analyst'){
    const panel=docsPanel(intro,'Draft a document');
    docsForm(panel,'/records',[rightsSelect('Document type','kind',[{value:'policy',label:'Policy'},{value:'evidence',label:'Evidence'}]),...documentFields(targets)],
      'Create document draft',f=>({...documentPayload(f),kind:f.get('kind')}),revision);
  }
  const list=add(el('section'),heading('Document revisions'));
  if(!documents.length)list.append(el('p','No documents are visible to this demo identity.'));
  const byTarget=new Map(targets.map(t=>[t.type+':'+t.id,t.label]));
  for(const d of documents.slice().reverse()){
    const container=add(el('article',undefined,'module-record'),el('p',d.kind+' · '+d.id,'hint'));
    const base='/records/'+d.id;
    const latest=d.revisions.at(-1);
    if(actor==='analyst'&&latest.status==='published'){
      const panel=docsPanel(container,'Draft next revision');
      docsForm(panel,base+'/revise',documentFields(targets),'Create next revision',documentPayload,revision);
    }
    for(const v of d.revisions.slice().reverse()){
      const status=v.status==='published'?(d.currentRevisionId===v.id?'Current':'Superseded'):v.status;
      const card=add(el('section'),add(el('div',undefined,'row'),el('h3',v.title),badge(status)),
        el('p','Revision '+v.number+' · '+v.contentLength+' UTF-8 bytes · SHA-256 '+v.contentHash,'hint'));
      if(v.reviewNote)card.append(el('p','Review: '+v.reviewNote));
      for(const l of v.links)card.append(el('p',docsData.linkKinds[l.type]+': '+(byTarget.get(l.type+':'+l.id)??l.id),'hint'));
      const path=base+'/revisions/'+v.id;
      const output=el('pre');output.hidden=true;
      const readButton=button('View fictional text','button','secondary');
      readButton.onclick=()=>docsPost(path+'/read',{},data=>{output.textContent=data.text;output.hidden=false;notice('Document access recorded.')});
      const download=button('Download text','button','secondary');
      download.onclick=()=>docsPost(path+'/download',{},data=>{downloadDocument(data);notice('Document download recorded.')});
      card.append(readButton,download,output);
      if(actor==='analyst'&&v.status==='draft'){
        const edit=docsPanel(card,'Edit draft');
        const fields=documentFields(targets);
        fields[0].querySelector('input').value=v.title;
        for(const opt of fields[2].querySelector('select').options)opt.selected=v.links.some(l=>opt.value===l.type+':'+l.id);
        const load=button('Load current text into editor','button','secondary');
        load.onclick=()=>docsPost(path+'/read',{},data=>{fields[1].querySelector('textarea').value=data.text;notice('Document access recorded.')});
        edit.append(load);
        docsForm(edit,path+'/edit',fields,'Save draft',documentPayload,revision);
        docsForm(card,path+'/submit',[],'Submit for review',()=>({}),revision);
      }
      if(actor==='reviewer'&&v.status==='review'){
        for(const [action,caption] of [['publish','Publish locally'],['return','Return to draft']])
          docsForm(docsPanel(card,caption),path+'/'+action,[rightsNote('Fictional review rationale')],caption,f=>Object.fromEntries(f),revision);
      }
      container.append(card);
    }
    list.append(container);
  }
  const blocks=[intro,list];
  if(legacyRecords.length){
    const archive=add(el('section'),heading('Legacy policy register'));
    for(const r of legacyRecords)archive.append(el('p',r.title+' · '+r.status));
    blocks.push(archive);
  }
  docsPane.replaceChildren(...blocks);
}
$('#show-governance-docs').onclick=()=>switchView('governance-docs');
$('#actor').addEventListener('change',()=>{if(!docsPane.hidden){docsPane.replaceChildren(el('p','Loading documents…'));refreshDocs()}});

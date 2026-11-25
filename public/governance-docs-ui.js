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
async function docsPost(path,body,success,failure){
  if(busy)return;
  busy=true;
  const identity=actor,seq=docsSeq;
  try{
    const data=await read(docsPath+path,{method:'POST',headers:docsHeaders(),body:JSON.stringify(body)});
    if(!docsPane.hidden&&actor===identity&&seq===docsSeq)success(data);
  }catch(e){
    if(!docsPane.hidden&&actor===identity){
      if(seq===docsSeq)failure?.(e);
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
function saveDocumentFile(blob,filename){
  const link=el('a');
  const url=URL.createObjectURL(blob);
  link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function downloadDocument(data){
  saveDocumentFile(new Blob([data.text],{type:'text/plain;charset=utf-8'}),data.filename);
}
async function downloadAttachment(path,row){
  if(busy)return;
  busy=true;
  const identity=actor,seq=docsSeq;
  try{
    const headers=docsHeaders();
    if(localSession)delete headers['X-Demo-Actor'];
    const response=await fetch(scopeUrl(docsPath+path),{method:'POST',headers,body:'{}'});
    if(!response.ok){
      const data=await response.json();
      if(localSession?.authenticated&&[401,403].includes(response.status))await checkContext();
      throw new Error(data.error||'Attachment could not be downloaded.');
    }
    if(response.headers.get('Content-Type')!=='application/octet-stream')throw new Error('Attachment response type is invalid.');
    const blob=await response.blob();
    if(!docsPane.hidden&&actor===identity&&seq===docsSeq){
      saveDocumentFile(blob,row.name);notice('Attachment download recorded.');
    }
  }catch(error){if(!docsPane.hidden&&actor===identity&&seq===docsSeq)notice(error.message,true);}
  finally{busy=false;}
}
const attachmentSize=limit=>limit>=1024*1024?limit/(1024*1024)+' MiB':limit/1024+' KiB';
function attachmentForm(path,revision,rules,remaining){
  const picker=el('input');
  picker.type='file';picker.accept=rules.formats.map(format=>format.extension).join(',');picker.name='documentAttachment';
  picker.multiple=true;
  const submit=button('Upload attachments','submit');
  const selection=el('ul');
  const status=el('p','','hint');
  status.setAttribute('role','status');
  const drop=add(el('div',undefined,'attachment-drop-zone'),
    add(el('label','Fictional attachments'),picker),
    el('p','Choose files or drop them here. A new selection replaces the previous one.','hint'));
  const form=add(el('form'),drop,el('p','PDF, Word, Excel, PowerPoint, TXT, CSV, TSV, JSON, JSON Lines, Markdown, LOG and common raster images. Up to '+
    attachmentSize(rules.maxFileBytes)+' per file (16 KiB for TXT), '+attachmentSize(rules.maxBatchBytes)+' per upload. '+
    'Four attachments per revision, 8 MiB and 256 files per workspace. Download only.','hint'),status,selection,submit);
  let files=[],preparing=false;
  const max=Math.min(remaining,rules.maxFilesPerBatch);
  function show(fileErrors=[],message){
    const errors=new Map(fileErrors.map(({index,message})=>[index,message]));
    status.textContent=message??(files.length?files.length+' selected. '+remaining+' draft attachment spot'+(remaining===1?'':'s')+' available.':
      'Select up to '+max+' fictional file'+(max===1?'':'s')+'.');
    selection.replaceChildren();
    files.forEach((file,index)=>{
      const line=add(el('li'),el('span',file.name+' · '+file.size+' bytes'+(errors.has(index)?' · '+errors.get(index):'')));
      const remove=button('Remove selected file '+file.name,'button','secondary');
      remove.disabled=preparing;
      remove.onclick=()=>{files.splice(index,1);show();picker.focus()};
      selection.append(add(line,remove));
    });
    picker.disabled=preparing;
    submit.disabled=preparing||!files.length;
  }
  function select(list){
    if(preparing)return;
    if(list.length>max){
      files=[];
      show([],'No files selected. Choose no more than '+max+' file'+(max===1?'':'s')+' for this draft.');
    }else{
      files=[...list];
      show();
    }
  }
  picker.onchange=()=>{select(picker.files);picker.value='';};
  drop.ondragover=e=>{if(e.dataTransfer?.types.includes('Files')){e.preventDefault();drop.classList.add('is-dragover')}};
  drop.ondragleave=()=>drop.classList.remove('is-dragover');
  drop.ondrop=e=>{
    e.preventDefault();drop.classList.remove('is-dragover');
    if(e.dataTransfer?.files.length)select(e.dataTransfer.files);
  };
  form.onsubmit=async e=>{
    e.preventDefault();
    if(busy||preparing||!files.length)return;
    const identity=actor,seq=docsSeq,selected=files.slice(),fileErrors=[];
    const current=()=>actor===identity&&docsSeq===seq&&!docsPane.hidden&&form.isConnected;
    const invalid=(index,message)=>fileErrors.push({index,message});
    let total=0;
    for(const [index,file] of selected.entries()){
      total+=file.size;
      const format=rules.formats.find(format=>file.name.toLowerCase().endsWith(format.extension));
      if(!format)invalid(index,'Choose a supported file format.');
      else if(file.type&&file.type!==format.mediaType&&!format.aliases.includes(file.type))invalid(index,'The file type does not match the filename.');
      else if(!file.size||file.size>format.maxFileBytes)invalid(index,'Choose a nonempty file up to '+attachmentSize(format.maxFileBytes)+'.');
    }
    if(fileErrors.length)return show(fileErrors,'No attachments were uploaded. Fix the files listed below and retry.');
    if(total>rules.maxBatchBytes)return show([],'No attachments were uploaded. Choose no more than '+attachmentSize(rules.maxBatchBytes)+' total.');
    preparing=true;
    show([],'Preparing '+selected.length+' attachment'+(selected.length===1?'':'s')+'…');
    try{
      const payload=[];
      for(const [index,file] of selected.entries()){
        try{
          const bytes=new Uint8Array(await file.arrayBuffer());
          if(!current())return;
          const chunks=[];
          for(let offset=0;offset<bytes.length;offset+=24*1024)chunks.push(btoa(String.fromCharCode(...bytes.subarray(offset,offset+24*1024))));
          payload.push({filename:file.name,mediaType:file.type,data:chunks.join('')});
        }catch{invalid(index,'Could not read this file.');}
      }
      if(!current())return;
      if(!fileErrors.length){
        await docsPost(path+'/attachments/batch',{files:payload,expectedRevision:revision},data=>{
          docsData=data;renderDocs();notice(rules.manualReview?
            selected.length+' attachment'+(selected.length===1?'':'s')+' staged for quarantine review.':
            selected.length===1?'Attachment added to the draft.':selected.length+' attachments added to the draft.');
        },error=>fileErrors.push(...(error.fileErrors??[])));
      }
    }finally{
      preparing=false;
      if(current())show(fileErrors,fileErrors.length?'No attachments were uploaded. Fix the files listed below and retry.':undefined);
    }
  };
  show();
  return form;
}
function attachmentControls(card,path,version,revision,rules){
  const group=add(el('div',undefined,'document-attachments'),el('h4','Attachments'));
  if(rules.manualReview&&['analyst','reviewer'].includes(actor))
    group.append(el('p','Uploads are quarantined until a separate reviewer confirms the exact file. No automatic malware scanning is configured.','hint'));
  if(!version.attachments.length)group.append(el('p','No attachments.'));
  const items=el('ul');
  for(const row of version.attachments){
    const item=add(el('li'),el('span',row.name+' · '+row.size+' bytes'));
    const rowPath=path+'/attachments/'+row.id;
    if(row.reviewStatus)item.append(badge({pending:'Quarantined',released:'Manually released',rejected:'Rejected',unavailable:'Unavailable'}[row.reviewStatus]??'Unavailable'));
    if(!row.reviewStatus||row.reviewStatus==='released'){
      const download=button('Download attachment '+row.name,'button','secondary');
      download.onclick=()=>downloadAttachment(rowPath+'/download',row);
      item.append(download);
    }
    if(actor==='reviewer'&&version.status==='draft'&&row.reviewStatus==='pending'){
      const panel=docsPanel(item,'Review attachment '+row.name);
      panel.append(el('p','Use the SHA-256 of the original file you independently verified outside the app. This is a manual decision, not a malware scan. If you cannot verify it, reject it.','hint'));
      const field=labelled('Verified original SHA-256','sha256','','input');
      const input=field.querySelector('input');
      input.required=true;input.pattern='[a-f0-9]{64}';input.maxLength=64;input.autocomplete='off';input.spellcheck=false;
      docsForm(panel,rowPath+'/review',[field],'Release attachment',f=>({operation:'release',sha256:f.get('sha256')}),revision);
      docsForm(panel,rowPath+'/review',[],'Reject attachment',()=>({operation:'reject'}),revision);
    }
    if(actor==='analyst'&&version.status==='draft'){
      const remove=button('Remove attachment '+row.name,'button','secondary');
      remove.onclick=()=>docsPost(path+'/attachments/'+row.id+'/remove',{expectedRevision:revision},data=>{
        docsData=data;renderDocs();notice('Draft attachment removed.');
      });
      item.append(remove);
    }
    items.append(item);
  }
  if(version.attachments.length)group.append(items);
  if(actor==='analyst'&&version.status==='draft'){
    if(version.attachments.length>=rules.maxFilesPerRevision){
      group.append(el('p','This draft already has '+rules.maxFilesPerRevision+' attachments. Remove one to add another.'));
    }else{
      group.append(attachmentForm(path,revision,rules,rules.maxFilesPerRevision-version.attachments.length));
    }
  }
  card.append(group);
}
function renderDocs(){
  const {documents,revision,targets,legacyRecords,attachmentRules}=docsData;
  const intro=add(el('section'),heading('Policies and evidence documents'),el('p','Use only original fictional text and attachments. Documents are role-scoped; nothing is published outside the local workspace.'));
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
      card.id='work-record-'+v.id;
      if(v.reviewNote)card.append(el('p','Review: '+v.reviewNote));
      for(const l of v.links)card.append(el('p',docsData.linkKinds[l.type]+': '+(byTarget.get(l.type+':'+l.id)??l.id),'hint'));
      const path=base+'/revisions/'+v.id;
      const output=el('pre');output.hidden=true;
      const readButton=button('View fictional text','button','secondary');
      readButton.onclick=()=>docsPost(path+'/read',{},data=>{output.textContent=data.text;output.hidden=false;notice('Document access recorded.')});
      const download=button('Download text','button','secondary');
      download.onclick=()=>docsPost(path+'/download',{},data=>{downloadDocument(data);notice('Document download recorded.')});
      card.append(readButton,download,output);
      attachmentControls(card,path,v,revision,attachmentRules);
      if(actor==='analyst'&&v.status==='draft'){
        const edit=docsPanel(card,'Edit draft');
        const fields=documentFields(targets);
        fields[0].querySelector('input').value=v.title;
        for(const opt of fields[2].querySelector('select').options)opt.selected=v.links.some(l=>opt.value===l.type+':'+l.id);
        const load=button('Load current text into editor','button','secondary');
        load.onclick=()=>docsPost(path+'/read',{},data=>{fields[1].querySelector('textarea').value=data.text;notice('Document access recorded.')});
        edit.append(load);
        docsForm(edit,path+'/edit',fields,'Save draft',documentPayload,revision);
        if(v.attachments.some(row=>row.reviewStatus&&row.reviewStatus!=='released'))
          card.append(el('p','Clear attachment quarantine or remove unavailable files before submitting this revision.','hint'));
        else docsForm(card,path+'/submit',[],'Submit for review',()=>({}),revision);
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
  focusWorkRecord('governance-docs');
}
$('#show-governance-docs').onclick=()=>switchView('governance-docs');
$('#actor').addEventListener('change',()=>{if(!docsPane.hidden){docsPane.replaceChildren(el('p','Loading documents…'));refreshDocs()}});

'use strict';
const centerPane=$('#trust-center-view'),centerPath='/api/trust-center';
let centerData;
async function refreshCenter(){
  try{const next=await read(centerPath);if(!centerPane.hidden){centerData=next;renderCenter()}}
  catch(error){if(!centerPane.hidden)centerPane.replaceChildren(el('p',error.message,'error'))}
}
async function centerWrite(topic,action,revision,values){
  if(busy)return;
  busy=true;
  try{
    const response=await read(centerPath+'/'+topic+'/'+action,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:revision,...values})
    });
    if(!centerPane.hidden){centerData=response;renderCenter();notice('Trust center updated.')}
  }catch(error){if(!centerPane.hidden){notice(error.message,true);if(error.status===409)await refreshCenter()}}
  finally{busy=false}
}
function renderCenter(){
  const intro=add(el('section'),heading('Trust center'),el('p','Review and publish bundled fictional copy to a separate local visitor preview.'));
  if(!centerData.enabled){intro.append(el('p','This workspace has no operator trust center access. Use a provisioned local analyst or reviewer workspace.'));centerPane.replaceChildren(intro);return}
  const previewLink=el('a','Open local visitor preview','button quiet');
  previewLink.href=centerData.visitorPath;previewLink.target='_blank';previewLink.rel='noopener';intro.append(previewLink);
  const panels=[intro];
  for(const [id,category] of Object.entries(centerData.catalog)){
    const row=centerData.topics[id],latest=row?.versions.at(-1),revision=centerData.revision;
    const panel=add(el('section'),heading(category.label),el('p',row?.activeVersion?'Visitor sees version '+row.activeVersion+'.':'No active publication.'));
    function action(caption,operation,version){
      const submit=button(caption);
      submit.onclick=()=>centerWrite(id,operation,revision,{version});
      panel.append(submit);
    }
    function notedAction(caption,operation,version){
      const form=add(el('form'),labelled('Internal fictional note','note','','input'),button(caption,'submit'));
      form.onsubmit=event=>{event.preventDefault();centerWrite(id,operation,revision,{version,note:form.elements.note.value})};
      panel.append(form);
    }
    if(latest){
      panel.append(el('h3','Latest version '+latest.version+' · '+latest.status),el('p',latest.card.description));
      if(latest.review?.note)panel.append(el('p','Internal review note: '+latest.review.note,'hint'));
      if(actor==='analyst'&&latest.status==='draft')action('Send for review','submit',latest.version);
      if(actor==='reviewer'&&latest.status==='in-review'){
        action('Approve this version','approve',latest.version);
        notedAction('Return this version','return',latest.version);
      }
      if(actor==='analyst'&&latest.status==='approved')action('Publish approved version to local preview','publish',latest.version);
    }
    if(actor==='analyst'&&(!latest||!['draft','in-review','approved'].includes(latest.status))){
      const form=add(el('form'),rightsSelect('Bundled fictional copy','option',Object.entries(category.options).map(([value,label])=>({value,label}))),
        button('Draft new version','submit'));
      form.onsubmit=event=>{event.preventDefault();centerWrite(id,'draft',revision,{option:form.elements.option.value})};
      panel.append(form);
    }
    if(actor==='analyst'&&row?.activeVersion)notedAction('Withdraw active version','withdraw',row.activeVersion);
    if(row?.versions.length){
      const past=add(el('details'),el('summary','Version history'));
      for(const version of row.versions.slice().reverse())past.append(el('p','Version '+version.version+' · '+version.status+' · '+version.card.description));
      panel.append(past);
    }
    panels.push(panel);
  }
  centerPane.replaceChildren(...panels);
}
$('#show-trust-center').onclick=()=>switchView('trust-center');

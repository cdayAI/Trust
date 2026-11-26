'use strict';
const centerPane=$('#trust-center-view'),centerPath='/api/trust-center';
let centerData:BrowserCenterModel|undefined;
async function refreshCenter(){
  try{const next=await read<BrowserCenterModel>(centerPath);if(!centerPane.hidden){centerData=next;renderCenter()}}
  catch(error){if(!centerPane.hidden)centerPane.replaceChildren(el('p',error instanceof Error?error.message:String(error),'error'))}
}
async function centerWrite(topic:string,action:BrowserCenterAction,revision:number,values:Record<string,unknown>){
  if(busy)return;
  busy=true;
  try{
    const response=await read<BrowserCenterModel>(centerPath+'/'+topic+'/'+action,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:revision,...values})
    });
    if(!centerPane.hidden){centerData=response;renderCenter();notice('Trust center updated.')}
  }catch(error){if(!centerPane.hidden){notice(error instanceof Error?error.message:String(error),true);if(error instanceof Error&&'status' in error&&error.status===409)await refreshCenter()}}
  finally{busy=false}
}
function renderCenter(){
  if(!centerData)return;
  const data=centerData;
  const intro=add(el('section'),heading('Trust center'),el('p','Review and publish bundled fictional copy to a separate local visitor preview.'));
  if(!data.enabled){intro.append(el('p','This workspace has no operator trust center access. Use a provisioned local analyst or reviewer workspace.'));centerPane.replaceChildren(intro);return}
  const previewLink=el('a','Open local visitor preview','button quiet');
  previewLink.href=data.visitorPath;previewLink.target='_blank';previewLink.rel='noopener';intro.append(previewLink);
  const panels=[intro];
  for(const [id,category] of Object.entries(data.catalog)){
    const row=data.topics[id],latest=row?.versions.at(-1),revision=data.revision;
    const panel=add(el('section'),heading(category.label),el('p',row?.activeVersion?'Visitor sees version '+row.activeVersion+'.':'No active publication.'));
    function action(caption:string,operation:BrowserCenterAction,version:number){
      const submit=button(caption);
      submit.onclick=()=>centerWrite(id,operation,revision,{version});
      panel.append(submit);
    }
    function notedAction(caption:string,operation:BrowserCenterAction,version:number){
      const form=add(el('form'),labelled('Internal fictional note','note','','input'),button(caption,'submit'));
      form.onsubmit=event=>{event.preventDefault();centerWrite(id,operation,revision,{version,note:new FormData(form).get('note')})};
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
      form.onsubmit=event=>{event.preventDefault();centerWrite(id,'draft',revision,{option:new FormData(form).get('option')})};
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

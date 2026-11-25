'use strict';
const codeForm=document.querySelector('#portal-code'),result=document.querySelector('#portal-result'),clear=document.querySelector('#portal-clear');
let localCode,epoch=0;
const make=(tag,content)=>{const n=document.createElement(tag);if(content!==undefined)n.textContent=content;return n};
async function call(operation,body){
  const response=await fetch('/api/requester/'+operation,{method:'POST',credentials:'omit',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok)throw new Error(data.error??'The request could not be completed.');
  return data;
}
function show(data){
  if(data.status==='not-submitted'){
    const form=make('form'),label=make('label','Fictional request type'),select=make('select');
    for(const type of data.requestTypes){
      const option=make('option',type.charAt(0).toUpperCase()+type.slice(1));option.value=type;select.append(option);
    }
    const submit=make('button','Submit synthetic request');submit.type='submit';
    label.append(select);form.append(label,submit);
    result.replaceChildren(make('h2','No request submitted'),form);
    form.onsubmit=async e=>{
      e.preventDefault();
      if(!localCode||submit.disabled)return;
      const current=epoch;submit.disabled=true;
      try{const next=await call('intake',{code:localCode,kind:select.value});if(current===epoch)show(next)}
      catch(error){if(current===epoch){const errorMessage=make('p',error.message);errorMessage.className='error';form.append(errorMessage)}}
      finally{submit.disabled=false}
    };
  }else{
    result.replaceChildren(make('h2',data.status),make('p','Synthetic request type: '+data.requestType),
      make('p','Received (UTC): '+data.receivedDate),make('p','Receipt: '+data.receipt));
    const refresh=make('button','Refresh status');refresh.type='button';refresh.className='secondary';
    refresh.onclick=()=>check(refresh);result.append(refresh);
  }
}
async function check(trigger){
  if(!localCode||trigger.disabled)return;
  const current=epoch;trigger.disabled=true;
  try{const data=await call('status',{code:localCode});if(current===epoch)show(data)}
  catch(error){if(current===epoch){result.replaceChildren(make('p',error.message));localCode=undefined;clear.hidden=true}}
  finally{trigger.disabled=false}
}
codeForm.onsubmit=e=>{
  e.preventDefault();const submit=codeForm.querySelector('button');
  if(submit.disabled)return;
  epoch++;const input=codeForm.elements.code;
  localCode=input.value;input.value='';clear.hidden=false;result.replaceChildren();
  check(submit);
};
clear.onclick=()=>{epoch++;localCode=undefined;codeForm.reset();clear.hidden=true;result.replaceChildren();codeForm.elements.code.focus()};
window.addEventListener('pagehide',()=>{epoch++;localCode=undefined;codeForm.reset();clear.hidden=true;result.replaceChildren()});

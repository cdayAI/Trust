'use strict';
const codeForm=document.querySelector('#portal-code'),result=document.querySelector('#portal-result'),clear=document.querySelector('#portal-clear');
const codeSubmit=codeForm.querySelector('button');
let localCode,epoch=0;
const make=(tag,content)=>{const n=document.createElement(tag);if(content!==undefined)n.textContent=content;return n};
async function call(operation,body){
  const response=await fetch('/api/requester/'+operation,{method:'POST',credentials:'omit',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok)throw Object.assign(new Error(data.error??'The request could not be completed.'),{code:data.code,status:response.status});
  return data;
}
function questionnaireInput(field){
  const caption=make('label',field.label),input=make(field.type==='integer'?'input':'select');
  input.name=field.key;input.required=field.required;
  if(field.type==='integer'){
    input.type='number';input.min=String(field.min);input.max=String(field.max);input.step='1';
  }else{
    const placeholder=make('option',field.required?'Choose one':'Not provided');placeholder.value='';input.append(placeholder);
    const choices=field.type==='boolean'?[{value:'true',label:'Yes'},{value:'false',label:'No'}]:field.options;
    for(const item of choices){const option=make('option',item.label);option.value=item.value;input.append(option);}
  }
  caption.append(input);
  return {caption,input,field};
}
function focusStatus(){
  const heading=result.querySelector('h2');
  if(heading){heading.tabIndex=-1;heading.focus();}
}
function denyAccess(error){
  result.replaceChildren(make('p',error.message));
  localCode=undefined;
  clear.hidden=true;
  codeForm.elements.code.focus();
}
function show(data){
  if(data.status==='not-submitted'){
    const form=make('form'),label=make('label','Fictional request type'),select=make('select');
    for(const type of data.requestTypes){
      const option=make('option',type.charAt(0).toUpperCase()+type.slice(1));option.value=type;select.append(option);
    }
    const submit=make('button','Submit synthetic request');submit.type='submit';
    label.append(select);form.append(label);
    const questions=(data.form?.fields??[]).map(questionnaireInput);
    if(data.form)form.append(make('p','Current fictional form version: '+data.form.version));
    form.append(...questions.map(q=>q.caption),submit);
    const feedback=make('div');feedback.setAttribute('aria-live','polite');form.append(feedback);
    result.replaceChildren(make('h2','No request submitted'),form);
    form.onsubmit=async e=>{
      e.preventDefault();
      if(!localCode||submit.disabled)return;
      const current=epoch;submit.disabled=true;
      feedback.replaceChildren();
      try{
        const body={code:localCode,kind:select.value};
        if(data.form){
          body.formVersion=data.form.version;
          body.answers=Object.fromEntries(questions.filter(q=>q.input.value!=='').map(({input,field})=>[
            field.key,field.type==='integer'?Number(input.value):field.type==='boolean'?input.value==='true':input.value
          ]));
        }
        const next=await call('intake',body);
        if(current===epoch)show(next);
      }catch(error){
        if(current===epoch){
          if(error.status===401||error.status===429){denyAccess(error);return;}
          const message=make('p',error.message);message.className='error';
          feedback.replaceChildren(message);
          if(error.code==='STALE_INTAKE_FORM'){
            const reload=make('button','Load current request form');reload.type='button';reload.className='secondary';
            reload.onclick=()=>check(reload);feedback.append(reload);
            submit.hidden=true;reload.focus();
          }
        }
      }
      finally{submit.disabled=false}
    };
  }else{
    result.replaceChildren(make('h2',data.status),make('p','Synthetic request type: '+data.requestType),
      make('p','Received (UTC): '+data.receivedDate),make('p','Receipt: '+data.receipt));
    if(data.intakeFormVersion)result.append(make('p','Pinned fictional form version: '+data.intakeFormVersion));
    if(data.resultAvailable){
      const open=make('button','View approved fictional result');open.type='button';
      open.onclick=async()=>{
        if(!localCode||open.disabled)return;
        const current=++epoch;open.disabled=true;
        try{
          const payload=await call('result',{code:localCode});
          if(current!==epoch)return;
          if(payload.status!=='available'){show({...data,resultAvailable:false});focusStatus();return;}
          const section=make('section'),list=make('ul'),heading=make('h3',payload.result.title);
          section.className='requester-approved-projection';
          heading.tabIndex=-1;
          section.append(heading,make('p','Fictional examples only. No actual information was released.'),list);
          for(const {label,count} of payload.result.sections)list.append(make('li',label+': '+count));
          open.replaceWith(section);
          heading.focus();
        }catch(error){if(current===epoch)denyAccess(error);}
        finally{open.disabled=false;}
      };
      result.append(open);
    }
    const refresh=make('button','Refresh status');refresh.type='button';refresh.className='secondary';
    refresh.onclick=()=>check(refresh);result.append(refresh);
  }
}
async function check(trigger){
  if(!localCode||trigger.disabled)return;
  const current=++epoch;trigger.disabled=true;
  const concealed=!!result.querySelector('.requester-approved-projection');
  result.querySelector('.requester-approved-projection')?.remove();
  try{
    const data=await call('status',{code:localCode});
    if(current===epoch){show(data);if(concealed)focusStatus();}
  }catch(error){if(current===epoch)denyAccess(error);}

  finally{if(current===epoch)trigger.disabled=false}
}
codeForm.onsubmit=e=>{
  e.preventDefault();
  if(codeSubmit.disabled)return;
  epoch++;const input=codeForm.elements.code;
  localCode=input.value;input.value='';clear.hidden=false;result.replaceChildren();
  check(codeSubmit);
};
function clearAccess(){
  epoch++;localCode=undefined;codeForm.reset();codeSubmit.disabled=false;clear.hidden=true;result.replaceChildren();
}
clear.onclick=()=>{clearAccess();codeForm.elements.code.focus()};
window.addEventListener('pagehide',clearAccess);

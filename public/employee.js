'use strict';
const form=document.querySelector('#employee-code'),list=document.querySelector('#employee-list'),clear=document.querySelector('#employee-clear'),message=document.querySelector('#employee-message');
const codeSubmit=form.querySelector('button');
let localCode,pending;
function n(tag,text){const element=document.createElement(tag);if(text!==undefined)element.textContent=text;return element}
function clearPage(){
  pending=undefined;localCode=undefined;form.reset();codeSubmit.disabled=false;list.replaceChildren();clear.hidden=true;message.textContent='';
}
async function send(action,fields){
  const r=await fetch('/api/employee/'+action,{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({code:localCode,...fields})});
  const data=await r.json();
  if(!r.ok)throw Object.assign(Error(data.error||'Request failed.'),{status:r.status});
  return data;
}
async function run(action,fields){
  if(pending)return;
  const current={};
  pending=current;
  const submitters=[codeSubmit,...list.querySelectorAll('button')];
  for(const submitter of submitters)submitter.disabled=true;
  message.textContent='';
  try{const data=await send(action,fields);if(pending===current)render(data)}
  catch(error){
    if(pending===current){
      if(error.status===401||error.status===429)clearPage();
      message.textContent=error.message;
    }
  }finally{
    if(pending===current){
      pending=undefined;
      for(const submitter of submitters)submitter.disabled=false;
    }
  }
}
function render(data){
  const sections=[];
  for(const row of data.assignments){
    const section=n('section');
    const text=n('p',row.text);text.className='policy-copy';
    section.append(n('h2',row.title),n('p','Policy version '+row.version),text);
    if(row.receipt)section.append(n('p','Acknowledged · receipt '+row.receipt.receipt));
    else{
      const f=n('form'),label=n('label','I acknowledge this exact fictional policy edition.'),check=n('input'),submit=n('button','Record acknowledgment');
      check.type='checkbox';check.required=true;label.prepend(check);f.append(label,submit);section.append(f);
      f.onsubmit=event=>{
        event.preventDefault();if(submit.disabled||!check.checked)return;
        run('attest',{assignment:row.assignment,edition:row.edition,hash:row.hash,confirm:true});
      };
    }
    sections.push(section);
  }
  list.replaceChildren(...(sections.length?sections:[n('p','You have no assigned policy editions.')]));
}
form.onsubmit=event=>{
  event.preventDefault();
  if(codeSubmit.disabled)return;
  localCode=form.elements.code.value;form.reset();list.replaceChildren();clear.hidden=false;
  run('assignments',{});
};
clear.onclick=()=>{clearPage();form.elements.code.focus()};
window.addEventListener('pagehide',clearPage);

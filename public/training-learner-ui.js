'use strict';
const target=document.querySelector('#learner-content'),access=document.querySelector('#learner-access');
const statusLine=document.querySelector('#learner-notice'),clearAccess=document.querySelector('#learner-clear');
let code='',busy=false,requestVersion=0;
const node=(tag,value)=>{const n=document.createElement(tag);if(value!==undefined)n.textContent=value;return n;};
const add=(parent,...children)=>{parent.append(...children);return parent;};
function button(label,type='button'){
  const n=node('button',label);n.type=type;return n;
}
function notice(message,error=false){
  statusLine.textContent=message;statusLine.className=error?'error':'success';
}
async function run(action,fields={},supplied=code){
  if(busy)return;
  busy=true;
  const request=++requestVersion;
  try{
    const response=await fetch('/api/training-learner/'+action,{method:'POST',credentials:'omit',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({code:supplied,...fields})});
    const data=await response.json();
    if(request!==requestVersion)return;
    if(!response.ok){
      if(response.status===401||response.status===429){code='';target.replaceChildren();access.hidden=false;clearAccess.hidden=true;}
      throw new Error(data.error||'Training request failed.');
    }
    code=supplied;access.reset();access.hidden=true;clearAccess.hidden=false;
    render(data);
    notice(action==='complete'&&data.lesson.status==='completed'?'Training completed.':
      action==='complete'?'Score '+data.lesson.lastScore+' of '+data.lesson.questions.length+'.':'');
  }catch(error){if(request===requestVersion)notice(error.message,true);}
  finally{busy=false;}
}
function showReceipt(parent,receipt){
  const details=add(node('details'),node('summary','Completion receipt'),node('p','Receipt ID: '+receipt.id),
    node('p','Completed: '+receipt.completedAt),node('p','Score: '+receipt.score+' / '+receipt.total));
  const download=button('Download completion receipt');
  download.onclick=()=>{
    const url=URL.createObjectURL(new Blob([JSON.stringify(receipt,null,2)+'\n'],{type:'application/json'}));
    const link=node('a');link.href=url;link.download='training-receipt-'+receipt.id+'.json';
    document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  details.append(download);parent.append(details);
}
function render(data){
  const list=add(node('section'),node('h2','Assignments'));
  if(!data.assignments.length)list.append(node('p','No training is assigned to this synthetic learner.'));
  for(const row of data.assignments){
    const open=button('Open '+row.title);
    open.onclick=()=>run('lesson',{assignment:row.id});
    list.append(add(node('article'),node('h3',row.title),node('p',row.status.replaceAll('-',' ')),open));
  }
  target.replaceChildren(list);
  if(!data.lesson)return;
  const lesson=data.lesson;
  const card=add(node('section'),node('h2',lesson.title),node('p',lesson.description));
  card.id='learner-current';
  const policy=add(node('details'),node('summary','Read assigned policy: '+lesson.policy.title+' · edition '+lesson.policy.number),node('pre',lesson.policy.text));
  card.append(policy);
  if(lesson.status==='completed')showReceipt(card,lesson.receipt);
  else if(lesson.status==='retry-required')card.append(node('p','No attempts remain. Ask the local analyst to reset attempts.'));
  else if(lesson.status==='assigned'){
    const b=button('Start exercise');b.onclick=()=>run('start',{assignment:lesson.id,revision:lesson.revision});card.append(b);
  }else{
    const form=node('form');
    form.append(node('p','Attempts remaining: '+lesson.attemptsRemaining));
    lesson.questions.forEach(({prompt,choices},index)=>{
      const group=add(node('fieldset'),node('legend',(index+1)+'. '+prompt));
      choices.forEach((choice,value)=>{
        const input=node('input');input.type='radio';input.name='question-'+index;input.value=String(value);input.required=true;
        group.append(add(node('label'),input,document.createTextNode(' '+choice)));
      });
      form.append(group);
    });
    const confirmed=node('input');confirmed.type='checkbox';confirmed.name='confirm';confirmed.required=true;
    form.append(add(node('label'),confirmed,document.createTextNode(' I read the assigned fictional policy edition.')),button('Submit answers','submit'));
    form.onsubmit=e=>{
      e.preventDefault();
      const f=new FormData(form),answers=lesson.questions.map((_,index)=>f.get('question-'+index));
      if(answers.some(x=>x===null)||!confirmed.checked)return notice('Choose one answer per question and confirm the assigned policy.',true);
      run('complete',{assignment:lesson.id,revision:lesson.revision,answers:answers.map(Number),confirm:true});
    };
    card.append(form);
  }
  target.append(card);
}
access.onsubmit=e=>{e.preventDefault();run('list',{},access.elements.code.value);};
clearAccess.onclick=()=>{
  requestVersion++;code='';access.reset();access.hidden=false;clearAccess.hidden=true;target.replaceChildren();notice('Learner access cleared.');
  access.elements.code.focus();
};

'use strict';
const trainingPane=$('#training-view'), trainingApi='/api/training';
let trainingData,trainingRequest=0;
async function refreshTraining(){
  const tag=++trainingRequest;
  try{
    const next=await read(trainingApi);
    if(!trainingPane.hidden&&trainingRequest===tag){trainingData=next;renderTraining();}
  }catch(error){
    if(!trainingPane.hidden&&trainingRequest===tag){trainingPane.replaceChildren(el('p','Training could not be loaded.'));notice(error.message,true);}
  }
}
async function trainingPost(action,body){
  if(busy)return;
  busy=true;
  const tag=++trainingRequest;
  try{
    const next=await read(trainingApi+'/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Demo-Actor':actor},body:JSON.stringify(body)});
    if(!trainingPane.hidden&&trainingRequest===tag){trainingData=next;renderTraining();notice('Training updated.');}
  }catch(error){
    if(!trainingPane.hidden&&trainingRequest===tag){notice(error.message,true);if(error.status===409)await refreshTraining();}
  }finally{busy=false;}
}
function trainingForm(parent,fields,caption,action,payload){
  const form=add(el('form'),...fields,button(caption,'submit'));
  form.onsubmit=e=>{e.preventDefault();trainingPost(action,payload(new FormData(form)));};
  parent.append(form);
}
function trainingPanel(parent,caption){
  const group=add(el('details'),el('summary',caption));
  parent.append(group);return group;
}
function trainingSelect(text,name,options){
  const label=rightsSelect(text,name,options);
  label.querySelector('select').setAttribute('aria-label',text);
  return label;
}
function courseForm(parent,course,editions,templates){
  const edition=trainingSelect('Published policy edition','edition',editions.map(x=>({value:x.edition,label:x.title+' · edition '+x.number})));
  const template=trainingSelect('Bundled course exercise','template',templates.map(x=>({value:x.id,label:x.title+' · '+x.questions+' questions'})));
  if(course){edition.querySelector('select').value=course.policy.edition;template.querySelector('select').value=course.template;}
  const title=labelled('Fictional course title','title',course?.title??'','input');
  trainingForm(parent,[title,edition,template],course?'Save course draft':'Create course draft',course?'edit':'create',f=>{
    const pinned=editions.find(x=>x.edition===f.get('edition'));
    return pinned?{...(course?{course:course.id,revision:course.revision}:{}),title:f.get('title'),document:pinned.document,
      edition:pinned.edition,hash:pinned.hash,template:f.get('template')}:{};
  });
}
function renderTraining(){
  const intro=add(el('section'),heading('Policy training'),el('p','Publish fictional training linked to a specific approved policy edition. Learners take the bundled exercise in a separate local portal.'));
  if(!trainingData.enabled){
    intro.append(el('p','Training is available only in an isolated workspace with provisioned synthetic learner codes.'));
    trainingPane.replaceChildren(intro);return;
  }
  const {learners,editions,templates,courses,assignments}=trainingData;
  const portal=el('a','Open synthetic learner portal');portal.href='/training';portal.className='button secondary';intro.append(portal);
  if(actor==='analyst'){
    if(editions.length)courseForm(trainingPanel(intro,'Draft a training course'),null,editions,templates);
    else intro.append(el('p','Publish a policy in Policies and documents before creating training.'));
  }
  const list=add(el('section'),heading('Training courses'));
  if(!courses.length)list.append(el('p','No training courses yet.'));
  for(const course of courses.slice().reverse()){
    const card=add(el('article',undefined,'module-record'),add(el('div',undefined,'row'),el('h3',course.title),badge(course.status)),
      el('p',course.policy.title+' · Policy edition '+course.policy.number+' · Course revision '+course.revision,'hint'));
    if(course.review?.note)card.append(el('p','Review: '+course.review.note));
    const payload=()=>({course:course.id,revision:course.revision});
    if(actor==='analyst'&&course.status==='draft'){
      courseForm(trainingPanel(card,'Edit course draft'),course,editions,templates);
      trainingForm(card,[],'Submit course for review','submit',payload);
    }
    if(actor==='reviewer'&&course.status==='review'){
      for(const [action,caption] of [['return','Return course to draft'],['publish','Publish training course']]){
        const note=labelled('Review note','note','','input');note.querySelector('input').maxLength=500;
        trainingForm(trainingPanel(card,caption),[note],caption,action,f=>({...payload(),note:f.get('note')}));
      }
    }
    const rows=assignments.filter(row=>row.course===course.id);
    if(actor==='analyst'&&course.status==='published'){
      const available=learners.filter(alias=>!rows.some(row=>row.learner===alias));
      if(available.length)trainingForm(trainingPanel(card,'Assign course to learner'),[
        trainingSelect('Synthetic learner','learner',available.map(value=>({value,label:value})))
      ],'Assign course','assign',f=>({...payload(),learner:f.get('learner')}));
    }
    if(rows.length){
      const table=trainingPanel(card,'Learner progress');
      const items=el('ul');
      for(const row of rows){
        const item=add(el('li'),el('p',row.learner+' · '+row.status.replaceAll('-',' ')+' · '+row.attempts+(row.attempts===1?' attempt':' attempts')));
        if(row.receipt)item.append(el('p','Receipt '+row.receipt.id+' · '+row.receipt.completedAt,'hint'));
        if(actor==='analyst'&&row.status==='retry-required'&&!row.resetCount)
          trainingForm(item,[],'Reset exhausted attempts','reset',()=>({assignment:row.id,revision:row.revision}));
        items.append(item);
      }
      table.append(items);
    }
    list.append(card);
  }
  trainingPane.replaceChildren(intro,list);
}
$('#show-training').onclick=()=>switchView('training');
$('#actor').addEventListener('change',()=>{if(!trainingPane.hidden)refreshTraining();});

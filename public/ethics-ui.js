'use strict';

const ethicsView=$('#ethics-view');
let ethicsTicket=0;
function ethicsSelect(label,name,values){
  const input=el('select');
  input.name=name;input.required=true;
  const placeholder=el('option','Select');placeholder.value='';input.append(placeholder);
  for(const [key,labelText] of Object.entries(values)){
    const option=el('option',labelText);option.value=key;input.append(option);
  }
  return add(el('label',label),input);
}
async function refreshEthics(){
  const marker=++ethicsTicket;
  try{
    const result=await read('/api/ethics/cases');
    if(marker===ethicsTicket&&!ethicsView.hidden)renderEthics(result);
  }catch(error){
    if(marker===ethicsTicket&&!ethicsView.hidden){
      ethicsView.replaceChildren(el('p','Synthetic ethics cases could not be loaded.'));
      notice(error.message,true);
    }
  }
}
function renderEthics({catalog,role,cases}){
  const investigator=role==='ethics-investigator';
  const intro=add(el('section'),heading('Synthetic ethics case management'),
    el('p','Fictional exercises only. This is not a reporting line. Do not enter a real allegation, identity or evidence.'));
  function form(parent,route,title,controls,fields,after){
    const node=add(el('form'),...controls,button(title,'submit'));
    node.onsubmit=async event=>{
      event.preventDefault();
      if(busy)return;
      busy=true;
      const submit=node.querySelector('button');submit.disabled=true;
      try{
        const payload=fields(Object.fromEntries(new FormData(node)));
        await read(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        if(!ethicsView.hidden){await refreshEthics();notice(after);}
      }catch(error){
        if(!ethicsView.hidden){
          notice(error.message,true);
          if(error.status===409){
            const reload=button('Reload ethics cases');
            reload.onclick=()=>{notice('');return refreshEthics();};
            $('#notice').append(document.createTextNode(' '),reload);
          }
        }
      }finally{busy=false;submit.disabled=false;}
    };
    return parent.appendChild(node);
  }
  if(investigator){
    form(intro,'/api/ethics/cases','Open synthetic case',[
      ethicsSelect('Fictional report category','category',catalog.categories),
      ethicsSelect('Fictional intake priority','urgency',catalog.urgency)
    ],values=>values,'Synthetic intake opened.');
  }
  const list=add(el('section'),heading(investigator?'Assigned synthetic cases':'Independent synthetic review queue'));
  if(!cases.length)list.append(el('p',investigator?'No synthetic cases yet.':'No case has been submitted for independent review.'));
  for(const c of cases){
    const panel=add(el('article',undefined,'module-record'),
      el('h3','ETH-'+c.number+' · '+catalog.categories[c.category]),
      el('p',catalog.statuses[c.status]+' · '+catalog.urgency[c.urgency]+' · Revision '+c.revision));
    if(c.route)panel.append(el('p','Review path: '+catalog.routes[c.route]));
    const path='/api/ethics/cases/'+c.id+'/';
    const withVersion=values=>({...values,expectedRevision:c.revision});
    if(investigator&&c.status==='intake')form(panel,path+'triage','Save triage',[
      ethicsSelect('Review path','route',c.urgency==='priority'?{expedited:catalog.routes.expedited}:catalog.routes)
    ],withVersion,'Synthetic case triaged.');
    if(investigator&&c.status==='triaged')form(panel,path+'begin','Begin investigation',[],withVersion,'Synthetic investigation started.');
    if(investigator&&c.status==='investigating'){
      form(panel,path+'finding','Record finding version',[
        ethicsSelect('Finding outcome','outcome',catalog.outcomes),
        ethicsSelect('Synthetic evidence basis','evidence',catalog.evidence)
      ],withVersion,'Finding version recorded.');
      const latest=c.findings.at(-1);
      if(latest&&c.returns.at(-1)?.findingVersion!==latest.version){
        const choices={
          supported:'remediation',not_supported:'no_action',inconclusive:'unresolved'
        };
        const valid=choices[latest.outcome];
        form(panel,path+'submit','Submit for closure review',[
          ethicsSelect('Proposed disposition','disposition',{[valid]:catalog.disposition[valid]})
        ],values=>({...withVersion(values),findingVersion:latest.version}),'Submitted to independent review.');
      }else panel.append(el('p','Record a current finding before requesting closure review.'));
    }
    if(c.proposal)panel.append(el('p','Proposed disposition: '+catalog.disposition[c.proposal.disposition]));
    if(!investigator&&c.status==='review'){
      form(panel,path+'return','Return for revision',[
        ethicsSelect('Return reason','reason',catalog.returnReasons)
      ],withVersion,'Returned to investigator.');
      form(panel,path+'close','Approve synthetic closure',[],withVersion,'Synthetic case closed.');
    }
    if(c.status==='closed'){
      panel.append(el('p','Approved disposition: '+catalog.disposition[c.review.disposition]));
      if(!investigator){
        const exportLink=el('a','Download redacted summary','button secondary');
        exportLink.href=scopeUrl(path+'export');exportLink.download='';panel.append(exportLink);
      }
    }
    if(c.findings.length){
      const history=add(el('details'),el('summary','Finding versions'));
      for(const f of c.findings)history.append(el('p','Version '+f.version+' · '+catalog.outcomes[f.outcome]+' · '+catalog.evidence[f.evidence]));
      panel.append(history);
    }
    if(c.returns.length){
      const history=add(el('details'),el('summary','Review returns'));
      for(const r of c.returns)history.append(el('p','Version '+r.findingVersion+' · '+catalog.returnReasons[r.reason]));
      panel.append(history);
    }
    const activity=add(el('details'),el('summary','Case activity'));
    const log=el('ol');
    for(const item of c.timeline)log.append(el('li',item.action+' · '+item.role+' · Revision '+item.revision+' · '+item.day));
    activity.append(log);panel.append(activity);list.append(panel);
  }
  ethicsView.replaceChildren(intro,list);
}
$('#show-ethics').onclick=()=>switchView('ethics');

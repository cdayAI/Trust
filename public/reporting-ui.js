'use strict';
const reportingPane=$('#report-view'),reportingPath='/api/reporting';
let reportFilters={},reportSequence=0;

function reportingQuery(filters){
  return new URLSearchParams(Object.entries(filters).filter(([,value])=>value!==null&&value!==undefined&&value!==''));
}
async function refreshReporting(announce=false,runId=null){
  const seq=++reportSequence;
  reportingPane.setAttribute('aria-busy','true');
  if(!reportingPane.children.length)reportingPane.append(el('p','Loading operational report…'));
  try{
    const [result,history]=await Promise.all([
      read(runId?reportingPath+'/runs/'+encodeURIComponent(runId):reportingPath+'?'+reportingQuery(reportFilters)),
      read(reportingPath+'/runs')
    ]);
    if(!reportingPane.hidden&&seq===reportSequence){
      reportFilters=result.filters;
      renderOperationalReport(result,history);
      if(announce)notice((runId?'Pinned report opened. ':'Report updated. ')+result.counts.total+' matched.');
      if(runId)$('#report-results-heading')?.focus();
      return true;
    }
  }catch(error){
    if(!reportingPane.hidden&&seq===reportSequence){
      if(error.status===403)reportingPane.replaceChildren(el('p','An analyst or reviewer is required for reporting.'));
      else notice(error.message,true);
    }
  }finally{if(seq===reportSequence)reportingPane.setAttribute('aria-busy','false')}
}
async function pinOperationalReport(filters,control){
  if(busy)return;
  busy=true;control.disabled=true;
  const seq=++reportSequence;
  reportingPane.setAttribute('aria-busy','true');
  try{
    const result=await read(reportingPath+'/runs',{method:'POST',
      headers:{'Content-Type':'application/json','X-Demo-Actor':actor},body:JSON.stringify({filters})});
    if(!reportingPane.hidden&&seq===reportSequence){
      if(await refreshReporting(false,result.run.id))notice('Pinned report saved. Its downloads will not recalculate.');
    }
  }catch(error){if(!reportingPane.hidden&&seq===reportSequence)notice(error.message,true)}
  finally{busy=false;control.disabled=false;if(seq===reportSequence)reportingPane.setAttribute('aria-busy','false')}
}
function renderReportRuns(history,options,current){
  const list=add(el('section',undefined,'report-run-history'),heading('Pinned reports'));
  list.append(el('p','Pinned reports expire after '+history.limits.retentionDays+' days. The oldest may be removed sooner to stay within workspace limits.','hint'));
  if(!history.runs.length){list.append(el('p','No pinned reports yet.'));return list}
  const rows=el('ul');
  for(const saved of history.runs){
    const when=saved.generatedAt.replace('T',' ').slice(0,19)+' UTC',
      mode=saved.filters.dataset==='activity'?'Audit activity':'Workflow records',
      area=options.workflows[saved.filters.workflow]??'All workflows';
    const open=button('Open pinned report','button','secondary');
    open.setAttribute('aria-label','Open pinned report: '+mode+', '+area+', '+when);
    if(current===saved.id)open.setAttribute('aria-current','true');
    open.onclick=()=>refreshReporting(true,saved.id);
    rows.append(add(el('li'),add(el('div'),el('strong',mode+' · '+area),
      el('p',when+' · '+saved.counts.total+' matched','hint')),open));
  }
  list.append(rows);return list;
}
function reportSelect(label,name,options,selected){
  const choices=Object.entries(options).map(([value,label])=>({value,label}));
  const field=el('select');field.name=name;
  for(const choice of choices){const option=el('option',choice.label);option.value=choice.value;field.append(option)}
  field.value=selected;
  return add(el('label',label),field);
}
function localReportSchedule(){
  const path=reportingPath+'/schedules';
  const detail=add(el('details',undefined,'report-run-history'),el('summary','Local report scheduling'));
  const content=el('div');
  detail.append(content);
  let sequence=0;
  const available=()=>!reportingPane.hidden&&detail.isConnected&&detail.open;
  const asUtc=value=>/^\d{4}-\d\d-\d\dT\d\d:\d\d$/u.test(value)?value+':00.000Z':value;
  const pretty=value=>value?value.replace('T',' ').slice(0,19)+' UTC':'—';
  function timeField(label,name,value){
    const field=labelled(label,name,'','input'),input=field.querySelector('input');
    input.type='datetime-local';
    input.value=value.slice(0,16);input.step='60';
    return field;
  }
  function form(target,operation,fields,label,payload,problem){
    const submit=button(label,'submit','secondary'),form=add(el('form'),...fields,submit);
    form.onsubmit=async event=>{
      event.preventDefault();
      if(busy||!available())return;
      busy=true;submit.disabled=true;
      problem.hidden=true;problem.textContent='';
      const request=++sequence;
      try{
        const body=payload(Object.fromEntries(new FormData(form)));
        const model=await read(path+'/'+operation,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        if(available()&&request===sequence)render(model,{focus:true});
      }catch(error){
        if(available()&&request===sequence){
          problem.hidden=false;
          problem.textContent=error.message;
          problem.focus();
        }
      }
      finally{busy=false;submit.disabled=false;}
    };
    target.append(form);
  }
  function render(model,{focus=false}={}){
    const title=heading(model.workerEnabled?'Local UTC report schedule':'Simulated UTC schedule');title.tabIndex=-1;
    const panel=add(el('section'),title,
      el('p',model.workerEnabled?
        'One local plan at a time. Only a separately approved worker plan can run automatically here. Outputs stay in this workspace; nothing is sent.':
        'One local plan at a time. The local worker is off here. Choose Run simulated slot for a manual plan; nothing goes to a recipient.'));
    const problem=el('p',undefined,'error');
    problem.hidden=true;problem.tabIndex=-1;problem.setAttribute('role','alert');panel.append(problem);
    const reload=button('Reload local schedule','button','secondary');reload.onclick=()=>load(true);panel.append(reload);
    const automatic=model.plans[0]?.execution==='local-worker';
    const outcomes={proposed:'Draft schedule saved. A separate reviewer must approve it.',
      approved:automatic?'Schedule approved for the local worker.':'Schedule approved for explicit simulated runs.',
      stopped:'Schedule stopped. Its history remains available.',ran:'One scheduled report was saved.',
      'already-run':'That UTC slot was already processed.', 'already-processed':'That UTC slot is no longer pending.',
      skipped:'That UTC slot was skipped by the bounded catch-up policy.',
      'not-due':automatic?'No report was saved. The slot is not due at the actual UTC time.':'No report was saved. The slot is not due at the simulated time.'};
    if(outcomes[model.outcome]){
      const result=el('p',outcomes[model.outcome]);result.setAttribute('role','status');panel.append(result);
    }
    if(model.canCreate){
      if(model.templates.length){
        const options=Object.fromEntries(model.templates.map(saved=>[saved.id,(saved.filters.dataset==='activity'?'Audit activity':'Workflow records')+
          ' · '+saved.filters.workflow+' · '+pretty(saved.generatedAt)+' · '+saved.id.slice(0,8)]));
        form(panel,'create',[
          reportSelect('Pinned report template','sourceRunId',options,model.templates[0].id),
          reportSelect('UTC cadence','cadence',{daily:'Daily',weekly:'Weekly'},'daily'),
          ...(model.workerEnabled?[reportSelect('Schedule execution','execution',{manual:'Manual simulation only','local-worker':'Approved local worker'},'manual')]:[]),
          timeField('First due time (UTC)','firstDueAt',new Date(Date.now()+3600000).toISOString())
        ],'Propose local schedule',raw=>({...raw,firstDueAt:asUtc(raw.firstDueAt),expectedRevision:model.revision}),problem);
      }else panel.append(el('p','Pin a report first. Its exact applied filters become the schedule template.'));
    }
    if(!model.plans.length)panel.append(el('p','No local schedule has been proposed.'));
    for(const plan of model.plans){
      const row=add(el('article',undefined,'module-record'),el('h3',(plan.cadence==='weekly'?'Weekly':'Daily')+' report plan · '+plan.status),
        el('p','First due: '+pretty(plan.firstDueAt)),
        el('p',(plan.status==='stopped'?'Last unprocessed slot: ':'Next due: ')+pretty(plan.nextDueAt)),
        el('p','Saved filters: '+Object.entries(plan.filters).filter(([,value])=>value!==null).map(([key,value])=>key+' '+value).join(' · '),'hint'));
      const workerPlan=plan.execution==='local-worker';
      if(workerPlan){
        row.append(el('p','Execution: approved local worker · '+plan.workerRuns+(plan.workerRuns===1?' automatic run':' automatic runs')+' · '+
          plan.skippedSlots+(plan.skippedSlots===1?' older slot skipped':' older slots skipped'),'hint'));
        if(!model.workerEnabled)row.append(el('p','The worker is disabled for this workspace. Due approved slots can still be run manually.','hint'));
        if(plan.workerFailure)row.append(el('p','Worker held after an export exceeded the saved-report size limit. Retry an actual due slot or stop and replace the plan.','hint'));
      }
      const action=()=>({planId:plan.id,expectedRevision:model.revision});
      if(plan.canApprove)form(row,'approve',[],'Approve local schedule',action,problem);
      if(plan.canStop)form(row,'stop',[],'Stop local schedule',action,problem);
      if(plan.status==='active'){
        if(plan.dueNow)row.append(el('p','The next slot is due at the current UTC time.','hint'));
        if(workerPlan)
          form(row,'tick',[],'Run one due slot',()=>({planId:plan.id,slotAt:plan.nextDueAt,simulatedAt:plan.nextDueAt}),problem);
        else form(row,'tick',[timeField('Simulated time (UTC)','simulatedAt',plan.nextDueAt)],'Run simulated slot',
          raw=>({planId:plan.id,slotAt:plan.nextDueAt,simulatedAt:asUtc(raw.simulatedAt)}),problem);
      }
      if(plan.receipts.length){
        const entries=el('ul');
        for(const receipt of plan.receipts){
          const entry=add(el('li'),el('p','Slot '+pretty(receipt.slotAt)+' · '+receipt.total+' matched'),
            el('p','Captured '+pretty(receipt.capturedAt)+(receipt.executor==='local-worker'?' · Local worker':
              receipt.executor==='staff'?' · Manual due run':' · Simulated '+pretty(receipt.simulatedAt)),'hint'));
          if(receipt.available){
            for(const format of ['json','csv']){
              const link=el('a','Download scheduled '+format.toUpperCase(),'button quiet');
              link.href=scopeUrl(reportingPath+'/runs/'+encodeURIComponent(receipt.reportId)+'/export?format='+format);
              link.download='';entry.append(link);
            }
          }else entry.append(el('p','Pinned bytes expired or were evicted. The slot receipt remains.','hint'));
          entries.append(entry);
        }
        row.append(el('h4','Simulated run history'),entries);
      }
      panel.append(row);
    }
    content.replaceChildren(panel);
    if(focus)title.focus({preventScroll:true});
  }
  async function load(focus=false){
    const request=++sequence;
    content.replaceChildren(el('p','Loading local report schedule…'));
    try{
      const model=await read(path);
      if(available()&&request===sequence)render(model,{focus});
    }catch{
      if(!available()||request!==sequence)return;
      const retry=button('Retry local schedule','button','secondary');retry.onclick=()=>load(true);
      content.replaceChildren(add(el('section'),el('p','The local schedule could not be loaded.'),retry));
      if(focus)retry.focus({preventScroll:true});
    }
  }
  detail.ontoggle=()=>{if(available())load();};
  return detail;
}
function renderOperationalReport({filters,counts,rows,options,generatedAt,run},history){
  const activity=filters.dataset==='activity';
  const intro=add(el('section',undefined,'report-intro'),el('p','WORKSPACE INSIGHTS','eyebrow'),heading('Operational reporting'),
    el('p','Filter and export aggregate results from this workspace. Record names, account details, forms and evidence content are not included.'));
  const form=el('form',undefined,'report-filter-grid');
  const data=reportSelect('Report dataset','dataset',{records:'Workflow records',activity:'Audit activity'},filters.dataset);
  const area=reportSelect('Report workflow','workflow',{all:'All workflows',...options.workflows},filters.workflow);
  const stage=reportSelect('Report stage','stage',{all:'All stages',...options.stages},filters.stage);
  const outcome=reportSelect('Report outcome','outcome',{all:'All outcomes',...options.outcomes},filters.outcome);
  const group=reportSelect('Group report by','group',{},'');
  const from=labelled('Start date (UTC)','from',filters.from??'','input',false);
  const to=labelled('End date (UTC)','to',filters.to??'','input',false);
  const fromInput=from.querySelector('input'),toInput=to.querySelector('input');
  fromInput.type='date';toInput.type='date';
  const rangeError=el('p',undefined,'error report-range-error');
  rangeError.id='report-date-range-error';
  rangeError.setAttribute('role','alert');
  function clearRangeError(){
    rangeError.hidden=true;rangeError.textContent='';
    toInput.removeAttribute('aria-invalid');toInput.removeAttribute('aria-describedby');
  }
  clearRangeError();
  for(const field of [fromInput,toInput])field.addEventListener('input',clearRangeError);
  const hint=el('p',undefined,'hint report-date-hint');
  function syncDataset(preferred){
    const dataset=data.querySelector('select').value,events=dataset==='activity';
    stage.hidden=events;stage.querySelector('select').disabled=events;
    outcome.hidden=!events;outcome.querySelector('select').disabled=!events;
    const field=group.querySelector('select');
    const choices=options.allowedGroups[dataset].map(value=>{const choice=el('option',options.groupings[value]);choice.value=value;return choice});
    field.replaceChildren(...choices);
    field.value=options.allowedGroups[dataset].includes(preferred)?preferred:'workflow';
    hint.textContent=events?'Date filters use the UTC audit event date.':'Date filters use the UTC record creation date. Stages show the current state, not historical state.';
  }
  data.onchange=()=>syncDataset(group.querySelector('select').value);
  syncDataset(filters.group);
  const apply=button('Apply report filters','submit');
  const reset=button('Reset report filters','button','secondary');
  apply.id='report-apply';reset.id='report-reset';
  reset.onclick=()=>{reportFilters={};notice('');refreshReporting(true)};
  const actions=add(el('div',undefined,'actions report-actions'),apply,reset);
  form.append(data,area,stage,outcome,group,from,to,rangeError,hint,actions);
  form.onsubmit=e=>{
    e.preventDefault();
    if(fromInput.value&&toInput.value&&fromInput.valueAsNumber>toInput.valueAsNumber){
      toInput.setAttribute('aria-invalid','true');
      toInput.setAttribute('aria-describedby',rangeError.id);
      rangeError.hidden=false;
      rangeError.textContent='The start date must be on or before the end date.';
      toInput.focus();
      return;
    }
    clearRangeError();
    reportFilters=Object.fromEntries(new FormData(form));notice('');refreshReporting(true);
  };
  intro.append(form);

  const totals=el('div',undefined,'metrics report-metrics');
  for(const [caption,count] of [[activity?'Matching audit events':'Matching workflow records',counts.total],['Workflows represented',counts.workflowCount],['Missing source date',counts.undated]]){
    totals.append(add(el('div',undefined,'metric'),el('strong',String(count)),el('span',caption)));
  }
  const resultHeading=heading('Report results');resultHeading.id='report-results-heading';resultHeading.tabIndex=-1;
  const results=add(el('section',undefined,'report-results'),resultHeading);
  if(run)results.append(el('p','Pinned report · Saved '+generatedAt.replace('T',' ').slice(0,19)+' UTC','hint'));
  else results.append(el('p','Live preview. Live downloads may change if the workspace changes. Pin a report to keep exactly the same results.','hint'));
  results.append(totals);
  const exports=el('div',undefined,'actions report-actions');
  for(const format of ['csv','json']){
    const link=el('a','Download '+format.toUpperCase(),'button quiet');
    const params=run?new URLSearchParams():reportingQuery(filters);params.set('format',format);
    link.href=scopeUrl(reportingPath+(run?'/runs/'+encodeURIComponent(run.id):'')+'/export?'+params);
    link.download='';
    exports.append(link);
  }
  if(run){
    const live=button('Return to live report','button','secondary');
    live.onclick=()=>refreshReporting(true);exports.append(live);
  }else{
    const pin=button('Pin current report','button','secondary');
    pin.onclick=()=>pinOperationalReport(filters,pin);exports.append(pin);
  }
  results.append(exports);
  if(!rows.length)results.append(el('p','No report results match these filters.'));
  else{
    const table=el('table',undefined,'report-table');
    table.append(el('caption',options.groupings[filters.group]+' breakdown'));
    const header=el('thead'),headRow=el('tr');
    for(const label of [options.groupings[filters.group],activity?'Events':'Records','Share of matched results']){
      const th=el('th',label);th.scope='col';headRow.append(th);
    }
    const body=el('tbody');
    for(const row of rows){
      const tr=el('tr'),name=el('th',row.label);name.scope='row';
      const share=el('td');
      const meter=el('meter');meter.min=0;meter.max=counts.total;meter.value=row.count;
      meter.setAttribute('aria-label',row.label+' share of matched results');
      const percentage=(100*row.count/counts.total).toLocaleString('en',{maximumFractionDigits:1})+'%';
      share.append(meter,el('span',percentage));
      tr.append(name,el('td',String(row.count)),share);body.append(tr);
    }
    header.append(headRow);table.append(header,body);
    const wrap=add(el('div',undefined,'report-table-wrap'),table);
    wrap.setAttribute('role','region');wrap.setAttribute('aria-label','Report breakdown table');wrap.tabIndex=0;
    results.append(wrap);
  }
  const focusId=document.activeElement?.id;
  const contents=[intro,results,renderReportRuns(history,options,run?.id)];
  if(localSession?.mode==='local-isolated'&&localSession.authenticated)contents.push(localReportSchedule());
  reportingPane.replaceChildren(...contents);
  if(focusId==='report-apply'||focusId==='report-reset')document.getElementById(focusId).focus({preventScroll:true});
}

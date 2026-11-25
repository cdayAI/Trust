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
  from.querySelector('input').type='date';to.querySelector('input').type='date';
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
  form.append(data,area,stage,outcome,group,from,to,hint,actions);
  form.onsubmit=e=>{e.preventDefault();reportFilters=Object.fromEntries(new FormData(form));notice('');refreshReporting(true)};
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
  reportingPane.replaceChildren(intro,results,renderReportRuns(history,options,run?.id));
  if(focusId==='report-apply'||focusId==='report-reset')document.getElementById(focusId).focus({preventScroll:true});
}

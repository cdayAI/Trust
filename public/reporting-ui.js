'use strict';
const reportingPane=$('#report-view'),reportingPath='/api/reporting';
let reportFilters={},reportSequence=0;

function reportingQuery(filters){
  return new URLSearchParams(Object.entries(filters).filter(([,value])=>value!==null&&value!==undefined&&value!==''));
}
async function refreshReporting(announce=false){
  const seq=++reportSequence;
  reportingPane.setAttribute('aria-busy','true');
  if(!reportingPane.children.length)reportingPane.append(el('p','Loading operational report…'));
  try{
    const result=await read(reportingPath+'?'+reportingQuery(reportFilters));
    if(!reportingPane.hidden&&seq===reportSequence){
      reportFilters=result.filters;
      renderOperationalReport(result);
      if(announce)notice('Report updated. '+result.counts.total+' matched.');
    }
  }catch(error){
    if(!reportingPane.hidden&&seq===reportSequence){
      if(error.status===403)reportingPane.replaceChildren(el('p','An analyst or reviewer is required for reporting.'));
      else notice(error.message,true);
    }
  }finally{if(seq===reportSequence)reportingPane.setAttribute('aria-busy','false')}
}
function reportSelect(label,name,options,selected){
  const choices=Object.entries(options).map(([value,label])=>({value,label}));
  const field=el('select');field.name=name;
  for(const choice of choices){const option=el('option',choice.label);option.value=choice.value;field.append(option)}
  field.value=selected;
  return add(el('label',label),field);
}
function renderOperationalReport({filters,counts,rows,options}){
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
  const results=add(el('section',undefined,'report-results'),heading('Report results'),totals);
  const exports=el('div',undefined,'actions report-actions');
  for(const format of ['csv','json']){
    const link=el('a','Download '+format.toUpperCase(),'button quiet');
    const params=reportingQuery(filters);params.set('format',format);
    link.href=scopeUrl(reportingPath+'/export?'+params);
    link.download='';
    exports.append(link);
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
  reportingPane.replaceChildren(intro,results);
  if(focusId==='report-apply'||focusId==='report-reset')document.getElementById(focusId).focus({preventScroll:true});
}

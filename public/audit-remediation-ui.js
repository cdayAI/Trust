'use strict';
function remediationDate(value=''){
  const label=labelled('Corrective due date (UTC)','dueDate',value,'input');
  label.querySelector('input').type='date';
  return label;
}
function remediationNote(value=''){
  return labelled('Corrective action','action',value);
}
function renderAuditRemediation(findings){
  if(!findings.length)return null;
  const section=add(el('section'),el('h4','Corrective actions'),el('p',
    'Track owned actions against finalized findings and close only with a newly accepted retest on the same control. The finalized audit stays unchanged.','hint'));
  const identity=localSession?.account??actor;
  for(const finding of findings){
    const row=finding.action;
    const name=el('h5',finding.control+' · '+finding.severity+' finding');
    name.id='remediation-title-'+finding.id;
    const item=add(el('article',undefined,'module-record'),name,el('p','Proposed in audit: '+finding.proposedAction,'hint'));
    item.id=row?'work-record-'+row.id:'remediation-'+finding.id;
    item.setAttribute('aria-labelledby',name.id);
    if(!row){
      item.append(el('p','No corrective action assigned.','hint'));
      if(actor==='analyst'){
        const plan=add(el('details'),el('summary','Assign corrective action to me'));
        auditMgmtForm(plan,'/remediations',[remediationNote(finding.proposedAction),remediationDate()],
          'Create corrective action',data=>({...Object.fromEntries(data),findingId:finding.id}));
        item.append(plan);
      }
      section.append(item);continue;
    }
    const path='/remediations/'+row.id;
    item.append(add(el('div',undefined,'row'),el('strong',row.action),badge(row.status)),
      el('p','Owner: '+row.owner+' · Due '+row.dueDate+' UTC · '+row.deadline.replaceAll('_',' ')+' · Revision '+row.revision,'hint'));
    if(row.attempts.length){
      const detail=add(el('details'),el('summary','Corrective evidence history'));
      for(const attempt of row.attempts.slice().reverse()){
        detail.append(el('p','Attempt '+attempt.number+' · '+attempt.proof.evidenceReference+' · '+(attempt.decision?.outcome??'Awaiting review')),
          el('p',attempt.result,'hint'));
        if(attempt.decision)detail.append(el('p',attempt.decision.reviewer+': '+attempt.decision.note,'hint'));
      }
      for(const review of row.reopened)detail.append(el('p','Reopened by '+review.reviewer+': '+review.note,'hint'));
      item.append(detail);
    }
    if(actor==='analyst'&&row.owner===identity&&['open','returned'].includes(row.status)){
      const change=add(el('details'),el('summary','Revise corrective action'));
      auditMgmtForm(change,path+'/plan',[remediationNote(row.action),remediationDate(row.dueDate)],'Save corrective plan',null,row.revision);
      item.append(change);
      if(row.retake&&!row.attempts.some(a=>a.proof.id===row.retake.id)){
        const submit=add(el('details'),el('summary','Submit corrective retest'));
        submit.append(el('p','Eligible accepted passing retest: '+row.retake.evidenceReference,'hint'));
        auditMgmtForm(submit,path+'/submit',[labelled('Corrective result','result','')],
          'Send retest for independent closure',data=>({...Object.fromEntries(data),testId:row.retake.id}),row.revision);
        item.append(submit);
      }else{
        const location=button('Open Risk and controls','button','secondary');location.onclick=()=>switchView('risk-controls');
        item.append(el('p','Record a new passing retest on this control in Risk and controls and have it independently accepted.','hint'),location);
      }
    }
    if(row.status==='in_review'){
      const attempt=row.attempts.at(-1);
      item.append(el('p','Submitted retest: '+attempt.proof.evidenceReference+' · '+attempt.result,'hint'));
      if(row.evidenceState!=='current')item.append(el('p','A new control test superseded the submitted retest. Return it for fresh evidence.','hint'));
      if(actor==='reviewer'&&row.owner!==identity){
        if(row.evidenceState==='current'){
          const close=add(el('details'),el('summary','Approve corrective closure'));
          auditMgmtForm(close,path+'/close',[labelled('Corrective closure rationale','note','')],
            'Close corrective action',null,row.revision);
          item.append(close);
        }
        const sendBack=add(el('details'),el('summary','Return corrective evidence'));
        auditMgmtForm(sendBack,path+'/return',[labelled('Corrective return rationale','note','')],
          'Return corrective action',null,row.revision);item.append(sendBack);
      }
    }
    if(row.attempts.some(a=>a.closure)){
      const link=el('a','Download approved closure JSON','button quiet');
      link.href=scopeUrl(auditMgmtPath+path+'/report');link.download='';
      item.append(link);
    }
    if(row.status==='closed'&&row.evidenceState!=='current')
      item.append(el('p','A newer retest exists. The previous closure remains unchanged.','hint'));
    if(actor==='reviewer'&&row.owner!==identity&&row.reopenAvailable){
      const reopen=add(el('details'),el('summary','Reopen after a failed retest'));
      auditMgmtForm(reopen,path+'/reopen',[labelled('Corrective reopening rationale','note','')],
        'Reopen corrective action',null,row.revision);
      item.append(reopen);
    }
    section.append(item);
  }
  return section;
}

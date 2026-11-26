'use strict';
const employeePane=$('#employee-attestations-view'),employeePath='/api/employee-attestations';
async function refreshEmployeeAdmin(){
  try{const data=await read<BrowserEmployeeAdminModel>(employeePath);if(!employeePane.hidden)renderEmployeeAdmin(data)}
  catch(error){if(!employeePane.hidden)employeePane.replaceChildren(el('p',error instanceof Error?error.message:String(error),'error'))}
}
function renderEmployeeAdmin(data:BrowserEmployeeAdminModel){
  const intro=add(el('section'),heading('Policy attestations'),
    el('p','Assign exact published fictional policy editions. Attestations are recorded locally only.'));
  if(!data.enabled){intro.append(el('p','Use a provisioned isolated operator workspace.'));employeePane.replaceChildren(intro);return}
  const portal=el('a','Open synthetic employee portal','button quiet');
  portal.href='/employee';portal.target='_blank';portal.rel='noopener';intro.append(portal);
  if(actor==='analyst'&&data.editions.length&&data.staff.length){
    const employee=rightsSelect('Synthetic employee','employee',data.staff.map(value=>({value,label:value})));
    const edition=rightsSelect('Exact published edition','edition',data.editions.map(v=>({value:v.edition,label:v.title+' · version '+v.number})));
    const form=add(el('form'),employee,edition,button('Assign published policy','submit'));
    form.onsubmit=async event=>{
      event.preventDefault();if(busy)return;
      const fields=new FormData(form),employeeId=fields.get('employee'),editionId=fields.get('edition');
      const v=data.editions.find(row=>row.edition===editionId);
      if(!v||typeof employeeId!=='string')return;
      busy=true;
      try{
        const next=await read<BrowserEmployeeAdminModel>(employeePath,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
          employee:employeeId,document:v.document,edition:v.edition,hash:v.hash
        })});
        if(!employeePane.hidden){renderEmployeeAdmin(next);notice('Assignment recorded.')}
      }catch(error){if(!employeePane.hidden)notice(error instanceof Error?error.message:String(error),true)}
      finally{busy=false}
    };
    intro.append(form);
  }
  const history=add(el('section'),heading('Assignment history'));
  if(!data.assignments.length)history.append(el('p','No policy assignments yet.'));
  for(const item of data.assignments){
    const card=add(el('article',undefined,'module-record'),el('h3',item.title+' · version '+item.number),
      el('p',item.employee+' · '+(item.receipt?'Acknowledged':'Pending')));
    if(item.receipt)card.append(el('p','Receipt '+item.receipt.receipt+' · '+item.receipt.acknowledgedAt,'hint'));
    history.append(card);
  }
  employeePane.replaceChildren(intro,history);
}
$('#show-employee-attestations').onclick=()=>switchView('employee-attestations');

'use strict';
const mapPane=$('#data-map-view'),mapPath='/api/data-map';
let mapData,selectedNode;
const mapNodeOption=(n,types)=>({value:n.id,label:n.name+' ('+types[n.type].label+' · '+n.id.slice(0,8)+')'});
async function refreshDataMap(){
  try{
    mapData=await read(mapPath);
    if(!mapPane.hidden)renderDataMap();
  }catch(error){
    if(!mapPane.hidden){mapPane.replaceChildren(el('p','The map could not be loaded.'));notice(error.message,true)}
  }
}
function mapForm(parent,route,fields,caption,revision){
  const form=add(el('form'),...fields,button(caption,'submit'));
  form.onsubmit=async e=>{
    e.preventDefault();
    if(busy)return;
    busy=true;const submit=form.querySelector('button');submit.disabled=true;
    try{
      const values=Object.fromEntries(new FormData(form));
      mapData=await read(mapPath+route,{method:'POST',
        headers:{'Content-Type':'application/json','X-Demo-Actor':actor},body:JSON.stringify({...values,expectedRevision:revision})});
      if(!mapPane.hidden){renderDataMap();notice('Data map updated.')}
    }catch(error){
      if(!mapPane.hidden){
        notice(error.message,true);
        if(error.status===409&&error.message.includes('Reload')){
          const reload=button('Reload map','button','secondary');
          reload.onclick=async()=>{notice('');await refreshDataMap()};
          $('#notice').append(document.createTextNode(' '),reload);
        }
      }
    }finally{busy=false;submit.disabled=false}
  };
  parent.append(form);
  return form;
}
function discoveryPanel(){
  const panel=add(el('section'),heading('Discover from a synthetic schema'),
    el('p','Preview a bundled fixture before adding it to inventory. No files, external systems or sample values are read.'));
  const load=button('Choose synthetic fixture','button','secondary'),result=el('div');
  panel.append(load,result);
  const request=(action,body)=>read(mapPath+'/discovery/'+action,{
    method:'POST',headers:{'Content-Type':'application/json','X-Demo-Actor':actor},body:JSON.stringify(body)
  });
  load.onclick=async()=>{
    load.disabled=true;
    try{
      const {fixtures}=await read(mapPath+'/discovery');
      if(!panel.isConnected)return;
      const pick=rightsSelect('Bundled fixture','fixture',fixtures.map(f=>({value:f.source+':'+f.version,label:f.label+' · version '+f.version})));
      const form=add(el('form'),pick,button('Preview synthetic import','submit'));
      const detail=el('div');detail.setAttribute('aria-live','polite');
      pick.addEventListener('change',()=>detail.replaceChildren());
      result.replaceChildren(form,detail);
      form.onsubmit=async event=>{
        event.preventDefault();
        const submit=form.querySelector('button');
        if(submit.disabled)return;
        const select=pick.querySelector('select');
        submit.disabled=true;select.disabled=true;detail.replaceChildren(el('p','Preparing schema preview…'));
        try{
          const [source,versionText]=select.value.split(':');
          const version=Number(versionText),plan=await request('preview',{source,version});
          if(!panel.isConnected)return;
          const labels={create:'Create',unchanged:'No change','refresh-schema':'Refresh schema only',conflict:'Conflict'};
          const summary=add(el('section'),el('h3','Review import'),el('p','Map revision '+plan.mapRevision+' · source version '+version));
          for(const candidate of plan.candidates){
            const row=add(el('article',undefined,'module-record'),el('h4',candidate.name),
              el('p',labels[candidate.action]+' · '+candidate.type+' · '+candidate.sourceId));
            const fields=el('ul');
            for(const f of candidate.provenance.fields)fields.append(el('li',f.id+' · '+f.type+' · '+f.classification));
            if(fields.children.length)row.append(fields);
            summary.append(row);
          }
          const links=el('ul');
          for(const link of plan.links)links.append(el('li',labels[link.action]+': '+link.from+' hosts '+link.to));
          summary.append(links);
          if(plan.conflicts.length){
            const errors=el('ul');
            for(const conflict of plan.conflicts)errors.append(el('li',(conflict.record?conflict.record+': ':'')+conflict.reason));
            summary.append(el('h4','Resolve before applying'),errors);
          }else{
            const apply=button('Apply reviewed import');
            apply.onclick=async()=>{
              if(busy||select.value!==source+':'+version)return;
              busy=true;apply.disabled=true;submit.disabled=true;select.disabled=true;
              try{
                const saved=await request('apply',{source,version,previewKey:plan.previewKey});
                if(!panel.isConnected)return;
                mapData=saved.map;renderDataMap();
                const {changed,createdNodes,refreshedNodes,createdLinks}=saved.result;
                notice(changed?'Imported: '+createdNodes+' new records, '+refreshedNodes+' schema updates, '+createdLinks+' links.':'Already imported. No changes.');
              }catch(error){
                if(panel.isConnected)detail.replaceChildren(el('p',error.message,'error'));
              }finally{busy=false;submit.disabled=false;select.disabled=false}
            };
            summary.append(apply);
          }
          detail.replaceChildren(summary);
        }catch(error){if(panel.isConnected)detail.replaceChildren(el('p',error.message,'error'))}
        finally{submit.disabled=false;select.disabled=false}
      };
    }catch(error){result.replaceChildren(el('p',error.message,'error'))}
    finally{load.disabled=false}
  };
  return panel;
}
const mapBlank={value:'',label:'Select an option'};
function addMapOptions(select,options){
  select.replaceChildren(...[mapBlank,...options].map(({value,label})=>{const o=el('option',label);o.value=value;return o}));
  select.value='';
}
function renderDataMap(){
  const {nodes,links,nodeTypes,linkTypes,legacyRecords,cyclePolicy,revision}=mapData;
  const active=nodes.filter(n=>!n.archivedAt);
  const mapIds=new Map(nodes.map(n=>[n.id,n]));
  const intro=add(el('section'),heading('Data mapping and lineage'),
    el('p','Connect fictional systems, datasets and processing activities. No external data is scanned.'),
    el('p',cyclePolicy,'hint'),add(el('a','Export map JSON','button quiet')));
  intro.querySelector('a').href=scopeUrl(mapPath+'/export');intro.querySelector('a').download='';
  if(actor==='analyst'){
    const builder=add(el('details'),el('summary','Add inventory record'));
    const type=rightsSelect('Record type','type',Object.entries(nodeTypes).map(([value,t])=>({value,label:t.label})));
    const detail=rightsNote('Fictional record detail');detail.querySelector('textarea').name='detail';
    const updateLabel=()=>{detail.firstChild.textContent=nodeTypes[type.querySelector('select').value].detail};
    type.querySelector('select').onchange=updateLabel;updateLabel();
    mapForm(builder,'/nodes',[type,labelled('Fictional name','name','','input'),labelled('Fictional owner','owner','','input'),detail],'Add inventory record',revision);
    intro.append(builder);
    if(active.length>=2){
      const editor=add(el('details'),el('summary','Add directed link'));
      const type=rightsSelect('Link type','type',Object.entries(linkTypes).map(([value,l])=>({value,label:l.label})));
      const from=rightsSelect('From','fromId',[mapBlank]),to=rightsSelect('To','toId',[mapBlank]);
      const updateEndpoints=()=>{
        const rule=linkTypes[type.querySelector('select').value];
        addMapOptions(from.querySelector('select'),active.filter(n=>rule.from.includes(n.type)).map(n=>mapNodeOption(n,nodeTypes)));
        addMapOptions(to.querySelector('select'),active.filter(n=>rule.to.includes(n.type)).map(n=>mapNodeOption(n,nodeTypes)));
      };
      type.querySelector('select').onchange=updateEndpoints;updateEndpoints();
      mapForm(editor,'/links',[type,from,to,rightsNote('Fictional flow purpose')],'Add directed link',revision);
      intro.append(editor);
    }
  }
  const inventory=add(el('section'),heading('Inventory'));
  if(!nodes.length)inventory.append(el('p','No fictional inventory records yet.'));
  for(const node of nodes.slice().reverse()){
    const card=add(el('article',undefined,'module-record'),add(el('div',undefined,'row'),el('h3',node.name),badge(nodeTypes[node.type].label+(node.archivedAt?' · archived':''))),
      el('p','Record ID: '+node.id,'hint'),el('p','Owner: '+node.owner),el('p',nodeTypes[node.type].detail+': '+node.detail),
      el('p',node.usage.incoming+' incoming · '+node.usage.outgoing+' outgoing links','hint'));
    const inspect=button('Inspect lineage for '+node.name,'button','secondary');
    inspect.onclick=()=>{
      selectedNode=node.id;
      const line=$('#lineage-output');line.hidden=false;line.replaceChildren(el('p','Loading lineage…'));
      loadLineage(node.id);
    };
    if(node.discovery){
      card.append(el('p','Synthetic source: '+node.discovery.source+' / '+node.discovery.sourceId+' · version '+node.discovery.version,'hint'));
      const fields=el('ul');
      for(const f of node.discovery.fields)fields.append(el('li',f.id+' · '+f.type+' · '+f.classification));
      if(fields.children.length)card.append(fields);
    }
    if(node.dictionaryTerms?.length){
      const list=el('ul');
      for(const term of node.dictionaryTerms)list.append(el('li',term.title+' · '+term.slug+' version '+term.version));
      card.append(el('p','Pinned dictionary terms'),list);
    }
    card.append(inspect);
    if(actor==='analyst'&&!node.archivedAt){
      const editor=add(el('details'),el('summary','Edit inventory record'));
      const detail=rightsNote(nodeTypes[node.type].detail);
      const input=detail.querySelector('textarea');input.name='detail';input.value=node.detail;
      mapForm(editor,'/nodes/'+node.id+'/update',[labelled('Fictional name','name',node.name,'input'),labelled('Fictional owner','owner',node.owner,'input'),detail],'Save inventory record',revision);
      card.append(editor);
      if(!node.usage.incoming&&!node.usage.outgoing&&!node.dictionaryTerms?.length){
        const archive=add(el('details'),el('summary','Archive inventory record'));
        mapForm(archive,'/nodes/'+node.id+'/archive',[rightsNote('Archive rationale')],'Archive inventory record',revision);
        card.append(archive);
      }
    }
    inventory.append(card);
  }
  const lineagePanel=el('section');lineagePanel.id='lineage-output';lineagePanel.hidden=!selectedNode;
  const flows=add(el('section'),heading('Directed links'));
  if(!links.length)flows.append(el('p','No directed links yet.'));
  for(const flow of links.slice().reverse()){
    const from=mapIds.get(flow.fromId),to=mapIds.get(flow.toId);
    const card=add(el('article',undefined,'module-record'),el('h3',from.name+' → '+to.name),
      el('p',linkTypes[flow.type].label+(flow.archivedAt?' · archived':'')),el('p',flow.note));
    if(actor==='analyst'&&!flow.archivedAt){
      const archive=add(el('details'),el('summary','Archive link'));
      mapForm(archive,'/links/'+flow.id+'/archive',[rightsNote('Archive rationale')],'Archive link',revision);
      card.append(archive);
    }
    flows.append(card);
  }
  const sections=[intro,...(actor==='analyst'?[discoveryPanel()]:[]),lineagePanel,inventory,flows];
  if(legacyRecords.length){
    const legacy=add(el('section'),heading('Legacy inventory entries'),el('p','These historical entries are separate from the verified graph.'));
    for(const row of legacyRecords)legacy.append(el('p',row.title+' · '+row.status));
    sections.push(legacy);
  }
  mapPane.replaceChildren(...sections);
  if(selectedNode)loadLineage(selectedNode);
}
async function loadLineage(id){
  try{
    const data=await read(mapPath+'/nodes/'+encodeURIComponent(id)+'/lineage');
    if(selectedNode!==id||mapPane.hidden)return;
    const line=$('#lineage-output');
    if(data.revision!==mapData.revision){
      line.replaceChildren(el('p','The map changed. Reload this view to see the current lineage.'));return;
    }
    line.replaceChildren(heading('Lineage for '+data.node.name));
    for(const [title,nodes] of [['Upstream',data.upstream],['Downstream',data.downstream]]){
      const list=el('ul');for(const n of nodes)list.append(el('li',n.name+' ('+mapData.nodeTypes[n.type].label+')'));
      line.append(el('h3',title),nodes.length?list:el('p','None'));
    }
  }catch(error){
    if(!mapPane.hidden&&selectedNode===id)$('#lineage-output').replaceChildren(el('p',error.message,'error'));
  }
}
$('#show-data-map').onclick=()=>switchView('data-map');
$('#actor').addEventListener('change',()=>{if(!mapPane.hidden&&mapData)renderDataMap()});

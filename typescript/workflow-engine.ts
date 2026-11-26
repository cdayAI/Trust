'use strict';
import type {RustCore,WorkflowActor,WorkflowRole,WorkflowDefinition,WorkflowTransition,PublishedWorkflow,WorkflowInstance,WorkflowSnapshot,WorkflowEvent,WorkflowRefusal,WorkflowResult} from './contracts';
import {randomUUID} from 'node:crypto';
const rust:RustCore=require('./rust-core');
type Details=Record<string,unknown>;
type Decision<T extends object>=({ok:true}&T&{details?:Details})|WorkflowRefusal;
type Refuse=(code:string,message:string,details?:Details)=>WorkflowRefusal;
type ActorInput={id:string;role:WorkflowRole;legacyId?:unknown};
interface EngineOptions {load:()=>unknown;save:(snapshot:WorkflowSnapshot)=>void;now?:()=>string;id?:()=>string}

const roles:ReadonlySet<string>=new Set(['publisher','initiator','reviewer']);
const keyPattern=/^[a-z][a-z0-9-]{0,63}$/;
const fieldPattern=/^[a-z][a-zA-Z0-9_]{0,63}$/;
const reserved=new Set(['constructor','prototype','__proto__']);
const key=(v:unknown):v is string=>typeof v==='string'&&keyPattern.test(v)&&!reserved.has(v);
const fieldKey=(v:unknown):v is string=>typeof v==='string'&&fieldPattern.test(v)&&!reserved.has(v);
const clean=(v:unknown,max:number):string|null=>typeof v==='string'&&v.trim().length>0&&v.trim().length<=max?v.trim():null;
const array=(v:unknown,max:number):v is unknown[]=>Array.isArray(v)&&v.length>0&&v.length<=max;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const role=(v:unknown):v is WorkflowRole=>typeof v==='string'&&roles.has(v);
const actorValid=(a:unknown):a is ActorInput=>object(a)&&key(a.id)&&role(a.role);
const distinct=(items:readonly unknown[])=>new Set(items).size===items.length;
const clone=<T>(x:T):T=>structuredClone(x);
const empty=():WorkflowSnapshot=>({schemaVersion:1,definitions:[],instances:[],events:[]});
const safeInteger=(value:unknown,min:number):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min;

function normalizeDefinition(d:unknown):WorkflowDefinition|null {
  if(!object(d)||!key(d.id)||!key(d.initial)||!array(d.states,50)||!array(d.transitions,100)||
     d.label!==undefined&&!clean(d.label,120))return null;
  const states:WorkflowDefinition['states']=[];
  for(const s of d.states){
    if(!object(s)||!key(s.id))return null;
    const label=clean(s.label,120);
    if(!label)return null;
    states.push({id:s.id,label});
  }
  const stateIds=states.map(s=>s.id);
  if(!distinct(stateIds)||!stateIds.includes(d.initial))return null;
  const transitions:WorkflowTransition[]=[];
  for(const t of d.transitions){
    if(!object(t)||!key(t.id)||typeof t.from!=='string'||typeof t.to!=='string'||
      !stateIds.includes(t.from)||!stateIds.includes(t.to)||t.from===t.to||
      !array(t.roles,roles.size)||!distinct(t.roles)||!t.roles.every(role)||
      (t.independent!==undefined&&typeof t.independent!=='boolean'))return null;
    const fields=t.requiredFields===undefined?[]:t.requiredFields;
    if(!Array.isArray(fields)||fields.length>20||!distinct(fields)||!fields.every(fieldKey))return null;
    transitions.push({id:t.id,from:t.from,to:t.to,roles:[...t.roles],independent:t.independent===true,requiredFields:[...fields]});
  }
  if(!distinct(transitions.map(x=>x.id)))return null;
  if(rust.enabled){
    const adjacency=new Map(stateIds.map(id=>[id,new Set<string>()]));
    for(const t of transitions)adjacency.get(t.from)!.add(t.to);
    if(rust.trace(d.initial,adjacency).length+1!==states.length)return null;
  }else{
    const reachable=new Set([d.initial]);
    for(let n=0;n<states.length;n++)for(const t of transitions)if(reachable.has(t.from))reachable.add(t.to);
    if(reachable.size!==states.length)return null;
  }
  return {id:d.id,...(d.label===undefined?{}:{label:clean(d.label,120)!}),initial:d.initial,states,transitions};
}
function selectDefinition(state:WorkflowSnapshot,id:unknown,version?:unknown):PublishedWorkflow|undefined {
  if(version!==undefined) return state.definitions.find(d=>d.id===id&&d.version===version);
  return state.definitions.filter(d=>d.id===id).at(-1);
}

// Inject only trustworthy actor identities from the calling application. This engine
// enforces workflow roles and independence; it does not authenticate a browser.
function refusal(t:WorkflowTransition,actor:WorkflowActor|null,instance:WorkflowInstance):[string,string]|null{
  if(rust.enabled){
    const decision=rust.workflowPermission(t,actor,instance);
    return decision===1?['ROLE_REQUIRED','This actor is not authorized for the transition.']:
      decision===2?['INDEPENDENCE_REQUIRED','A different actor must perform the independent review.']:null;
  }
  if(!actor||!t.roles.includes(actor.role))return ['ROLE_REQUIRED','This actor is not authorized for the transition.'];
  const identities=[actor.id,...(actor.legacyId?[actor.legacyId]:[])];
  if(t.independent&&identities.some(id=>id===instance.createdBy||instance.contributors.includes(id)))
    return ['INDEPENDENCE_REQUIRED','A different actor must perform the independent review.'];
  return null;
}
function createWorkflowEngine({load,save,now=()=>new Date().toISOString(),id=randomUUID}:Partial<EngineOptions>={}) {
  if(typeof load!=='function'||typeof save!=='function')throw TypeError('Workflow engine requires synchronous load and save functions.');
  const read=():WorkflowSnapshot=>{
    const s=load();
    if(s===undefined||s===null)return empty();
    if(!object(s)||s.schemaVersion!==1||!['definitions','instances','events'].every(k=>Array.isArray(s[k])))
      throw Error('Invalid workflow snapshot.');
    // Persistence retains its existing schema check. Do not cast request JSON
    // to this trusted internal model; commands normalize every supplied input.
    return clone(s) as unknown as WorkflowSnapshot;
  };
  function command<T extends object>(kind:string,raw:unknown,apply:(state:WorkflowSnapshot,input:Record<string,unknown>,actor:WorkflowActor,at:string,error:Refuse)=>Decision<T>):WorkflowResult<T>{
    const input=object(raw)?raw:{};
    const state=read();
    const suppliedActor=actorValid(input.actor)?input.actor:null;
    const a:WorkflowActor|null=suppliedActor?{id:suppliedActor.id,role:suppliedActor.role}:null;
    const stamp=now();
    const context={definitionId:key(input.definitionId)?input.definitionId:object(input.definition)&&key(input.definition.id)?input.definition.id:null,
      instanceId:key(input.instanceId)?input.instanceId:null,transitionId:key(input.transitionId)?input.transitionId:null};
    const error:Refuse=(code,message,details={})=>({ok:false,code,message,details});
    const result=a&&suppliedActor?apply(state,input,{...a,...(key(suppliedActor.legacyId)?{legacyId:suppliedActor.legacyId}:{})},stamp,error):
      error('INVALID_ACTOR','Supply a recognized workflow actor.');
    const {details={},...outcome}=result;
    const sequence=(state.events.at(-1)?.sequence??0)+1;
    const event:WorkflowEvent={id:id(),sequence,at:stamp,kind,actor:a,outcome:result.ok?'accepted':'refused',code:result.ok?null:result.code,
      ...context,...details};
    if(typeof event.id!=='string'||!event.id||state.events.some(e=>e.id===event.id))throw Error('Workflow event ID generator returned an invalid or duplicate ID.');
    state.events.push(event);
    save!(clone(state));
    return clone({...outcome,event}) as WorkflowResult<T>;
  }
  return Object.freeze({
    publish(raw:unknown) {
      return command<{definition:PublishedWorkflow}>('definition.publish',raw,(state,input,actor,at,error)=>{
        if(actor.role!=='publisher') return error('ROLE_REQUIRED','A publisher must publish workflow definitions.');
        const definition=normalizeDefinition(input.definition);
        if(!definition) return error('INVALID_DEFINITION','Definition is invalid: check states, reachability, transitions, roles and unique stable IDs.');
        const current=selectDefinition(state,definition.id)?.version??0;
        const revision=rust.enabled?rust.revision(input.expectedVersion,current,0):
          !safeInteger(input.expectedVersion,0)?1:input.expectedVersion!==current?2:0;
        if(revision===1)return error('INVALID_EXPECTED_VERSION','Provide the current definition version, or 0 for a new definition.');
        if(revision===2)return error('STALE_DEFINITION','The latest published definition version has changed.',{expectedVersion:input.expectedVersion,actualVersion:current});
        const published={...definition,version:current+1,publishedAt:at,publishedBy:actor.id};
        state.definitions.push(published);
        return {ok:true,definition:published,details:{definitionVersion:published.version}};
      });
    },
    start(raw:unknown) {
      return command<{instance:WorkflowInstance}>('instance.start',raw,(state,input,actor,at,error)=>{
        if(actor.role!=='initiator') return error('ROLE_REQUIRED','An initiator must start workflow instances.');
        if(input.version!==undefined&&!safeInteger(input.version,1)) return error('INVALID_DEFINITION_VERSION','Use a positive published version.');
        const definition=selectDefinition(state,input.definitionId,input.version);
        if(!definition) return error('DEFINITION_NOT_FOUND','Published workflow definition not found.');
        const title=clean(input.title,160);
        if(!title) return error('INVALID_TITLE','Enter a title of 1 to 160 characters.');
        // Prefix guarantees the public identifier starts with a letter even when UUID starts with a digit.
        const instance:WorkflowInstance={id:'wf-'+id(),definitionId:definition.id,definitionVersion:definition.version,state:definition.initial,
          title,revision:1,createdBy:actor.id,createdAt:at,updatedAt:at,lastActorId:actor.id,contributors:[actor.id],steps:[]};
        if (!key(instance.id) || state.instances.some(x=>x.id===instance.id)) throw Error('Workflow instance ID generator returned an invalid or duplicate ID.');
        state.instances.push(instance);
        return {ok:true,instance,details:{instanceId:instance.id,definitionVersion:instance.definitionVersion,to:instance.state,revision:instance.revision}};
      });
    },
    advance(raw:unknown) {
      return command<{instance:WorkflowInstance}>('instance.advance',raw,(state,input,actor,at,error)=>{
        const instance=state.instances.find(x=>x.id===input.instanceId);
        if(!instance) return error('INSTANCE_NOT_FOUND','Workflow instance not found.');
        const details={definitionId:instance.definitionId,definitionVersion:instance.definitionVersion,from:instance.state,revision:instance.revision};
        const revision=rust.enabled?rust.revision(input.expectedRevision,instance.revision,1):
          !safeInteger(input.expectedRevision,1)?1:input.expectedRevision!==instance.revision?2:0;
        if(revision===1)return error('INVALID_EXPECTED_REVISION','Provide the current instance revision.',details);
        if(revision===2)return error('STALE_REVISION','The workflow changed. Reload before retrying.',{...details,expectedRevision:input.expectedRevision});
        const definition=selectDefinition(state,instance.definitionId,instance.definitionVersion);
        if(!definition) throw Error('Pinned workflow revision is missing from storage.');
        const t=definition.transitions.find(t=>t.id===input.transitionId);
        const body=input.fields===undefined?{}:input.fields;
        let fields:Record<string,string>,contributors:string[];
        if(rust.enabled){
          const plan=rust.workflowPlan(t,actor,instance,body);
          if(plan.status===1)return error('TRANSITION_NOT_AVAILABLE','This transition is not available from the current state.',details);
          if(plan.status===2)return error('ROLE_REQUIRED','This actor is not authorized for the transition.',details);
          if(plan.status===3)return error('INDEPENDENCE_REQUIRED','A different actor must perform the independent review.',details);
          if(plan.status===4)return error('INVALID_FIELDS','Supply concise, nonempty text values under valid field keys.',details);
          if(plan.status===5)return error('MISSING_FIELDS','Complete the required transition fields: '+plan.missing.join(', ')+'.',{...details,missing:plan.missing});
          if(plan.status!==0||!t)throw Error('Invalid Rust workflow transition result.');
          ({fields,contributors}=plan);
        }else{
          if(!t||t.from!==instance.state)return error('TRANSITION_NOT_AVAILABLE','This transition is not available from the current state.',details);
          const denied=refusal(t,actor,instance);
          if(denied)return error(denied[0],denied[1],details);
          if(!object(body)||Object.keys(body).length>20||Object.keys(body).some(k=>!fieldKey(k)||!clean(body[k],2000)))return error('INVALID_FIELDS','Supply concise, nonempty text values under valid field keys.',details);
          const missing=t.requiredFields.filter(k=>!Object.hasOwn(body,k));
          if(missing.length)return error('MISSING_FIELDS','Complete the required transition fields: '+missing.join(', ')+'.',{...details,missing});
          fields=Object.fromEntries(Object.keys(body).map(k=>[k,clean(body[k],2000)!]));
          contributors=t.independent?[]:[...new Set([...instance.contributors,actor.id])];
        }
        if(!t)throw Error('Missing accepted workflow transition.');
        instance.revision++;
        instance.state=t.to;
        instance.updatedAt=at;
        instance.lastActorId=actor.id;
        instance.contributors=contributors;
        instance.steps.push({transitionId:t.id,actorId:actor.id,role:actor.role,at,from:t.from,to:t.to,revision:instance.revision,fields});
        return {ok:true,instance,details:{...details,to:t.to,revision:instance.revision,fieldKeys:Object.keys(fields)}};
      });
    },
    getDefinition:(id:unknown,version?:unknown)=>clone(selectDefinition(read(),id,version)),
    getInstance:(id:unknown)=>clone(read().instances.find(x=>x.id===id)),
    audit:()=>clone(read().events),
    catalog(actor:WorkflowActor|null,instanceId?:string){
      const snapshot=read();
      const definitions=new Map<string,{id:string;label:string;versions:number[]}>();
      for(const d of snapshot.definitions){
        if(!definitions.has(d.id))definitions.set(d.id,{id:d.id,label:d.label??d.id,versions:[]});
        const row=definitions.get(d.id)!;row.label=d.label??d.id;row.versions.push(d.version);
      }
      const summary=snapshot.instances.slice(-100).reverse().map(({id,title,state,definitionId,definitionVersion,revision})=>
        ({id,title,state,definitionId,definitionVersion,revision}));
      const instance=instanceId?snapshot.instances.find(x=>x.id===instanceId):null;
      let selected:{instance:WorkflowInstance;actions:(WorkflowTransition&{allowed:boolean;blockedReason:string|null})[];stateLabel:string}|null=null;
      if(instance){
        const definition=selectDefinition(snapshot,instance.definitionId,instance.definitionVersion);
        if(!definition)throw Error('Pinned workflow revision is missing from storage.');
        const actions=definition.transitions.filter(t=>t.from===instance.state).map(t=>{
          const denied=refusal(t,actor,instance);
          return {...t,allowed:!denied,blockedReason:denied?.[1]??null};
        });
        selected={instance,actions,stateLabel:definition.states.find(s=>s.id===instance.state)?.label??instance.state};
      }
      return {definitions:[...definitions.values()],instances:summary,selected,recentAudit:snapshot.events.slice(-30).reverse()};
    }
  });
}

const syntheticDefinition={
  id:'synthetic-review',
  initial:'draft',
  states:[{id:'draft',label:'Draft'},{id:'awaiting-review',label:'Awaiting independent review'},{id:'approved',label:'Approved'}],
  transitions:[
    {id:'submit-for-review',from:'draft',to:'awaiting-review',roles:['initiator'],requiredFields:['summary']},
    {id:'approve',from:'awaiting-review',to:'approved',roles:['reviewer'],independent:true,requiredFields:['reason']},
    {id:'return-for-changes',from:'awaiting-review',to:'draft',roles:['reviewer'],independent:true,requiredFields:['reason']}
  ]
};

export = {createWorkflowEngine,syntheticDefinition};

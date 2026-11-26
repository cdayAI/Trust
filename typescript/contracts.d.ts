/** Internal interfaces at the native, storage and domain boundaries. */
export type WorkspaceRole = 'analyst'|'reviewer'|'case-operator'|'publisher'|'identity-admin'|'ethics-investigator'|'ethics-reviewer';
export type StorageMode = 'demo'|'isolated';
export type SnapshotKind = 'workbench'|'workflow';
export type StorageSelection = 'node'|'rust';
export type SnapshotRow = {generation:number;payload?:string|null};
export type DocumentRow = {scope:string;kind:string;generation:number;payload:string};
export interface StorageDriver {
  configure():void;
  begin(write:boolean):void;
  commit():void;
  rollback():void;
  initialize():void;
  supportsSchema():boolean;
  readMode():string|undefined;
  setMode(mode:StorageMode):void;
  read(scope:string,kind:SnapshotKind):SnapshotRow|undefined;
  readSince(scope:string,kind:SnapshotKind,generation:number):SnapshotRow|undefined;
  save(scope:string,kind:SnapshotKind,payload:string):void;
  appendIntake(scope:string,generation:number,caseJson:string,eventJson:string):boolean;
  integrity():boolean;
  documents():DocumentRow[];
  hasSnapshots():boolean;
  insert(scope:string,kind:SnapshotKind,generation:number,payload:string):void;
  close():void;
}
export interface ArtifactRow {path:string;size:number;sha256:string}
export type JsonRecord = Record<string,unknown>;
export type HeaderValue = string|string[]|undefined;
export interface RequestEnvelope {
  headers:Record<string,HeaderValue>;
  socket:{remoteAddress?:string;encrypted?:boolean};
  url:string;
}
export interface CorporateOrigin {host:string;origin:string;secure:boolean}
export type ConnectionDecision = 0|1|2;
export type PostDecision = 0|1|2|3;
export type Question = {
  id:string;label:string;required:boolean;when?:{question:string;equals:string}
} & ({kind:'text'|'integer'}|{kind:'choice';options:readonly string[]});
export interface Questionnaire {id:string;version:number;label:string;questions:readonly Question[]}
export interface AssessmentRoute {id:string;workflowId:string;reason:string}
export type AnswerDecision = {status:0;value:string}|{status:1|2|3|4|5|6};
export interface Route {method:'GET'|'POST';value:string;path:RegExp;roles:readonly string[]}
export interface RustCore {
  readonly enabled:boolean;
  httpConnection(remote:unknown,host:unknown,target:unknown,corporateHost:unknown,encrypted:boolean,secure:boolean):ConnectionDecision;
  httpPost(host:unknown,origin:unknown,corporateOrigin:unknown,contentType:unknown,contentEncoding:unknown,binaryType:unknown,isolated:boolean,binary:boolean):PostDecision;
  batchHeader(bytes:Buffer):number;
  batchLayout(frameLength:number,manifestLength:number,sizes:number[]):number[]|-1|-2;
  questionnaireAnswer(question:Question,input:unknown,active:boolean,provided:boolean,submitting:boolean):AnswerDecision;
  aggregateReport(source:Iterable<ReportRow>,filters:ReportFilters,vocabulary:ReportVocabulary):ReportAggregation;
  installRoutes(routes:readonly Route[]):void;
  authorize(method:string,pathname:string,role:string,limited:boolean):0|1|2|3;
  trace(start:string,adjacency:Map<string,Set<string>>):unknown[];
  revision(expected:unknown,actual:number,min:number):0|1|2;
  workflowPermission(transition:WorkflowTransition,actor:WorkflowActor|null,instance:WorkflowInstance):0|1|2;
  workflowPlan(transition:WorkflowTransition|undefined,actor:WorkflowActor,instance:WorkflowInstance,body:unknown):WorkflowPlan;
  accountLive(account:AccountLifetime|null|undefined,at:number):boolean;
  sessionToken(name:string,header:string):string|null;
  addDays(from:string,days:number,basis:string,closedDates:string[]):string;
}
export interface QueueTask {timing:string;owner:string;workflow:string;destination:{view:string;recordId:string;projectId?:string}}
export interface QueueModel {tasks:QueueTask[];workflowLabels:Record<string,string>}
export interface SummaryCounts {total:number;overdue:number;dueToday:number;upcoming:number;undated:number}

export interface ReportFilters {
  dataset:'records'|'activity';workflow:string;stage:string;outcome:string;
  group:'workflow'|'stage'|'outcome'|'day'|'month';from:string|null;to:string|null
}
export interface ReportRow {workflow:string;stage?:string;outcome?:string;day:string|null}
export interface ReportAggregation {buckets:Map<string,number>;total:number;undated:number;workflowCount:number}
export interface ReportVocabulary {workflow:string[];stage:string[];outcome:string[]}

export type WorkflowRole='publisher'|'initiator'|'reviewer';
export interface WorkflowActor {id:string;role:WorkflowRole;legacyId?:string}
export interface WorkflowState {id:string;label:string}
export interface WorkflowTransition {id:string;from:string;to:string;roles:WorkflowRole[];independent:boolean;requiredFields:string[]}
export interface WorkflowDefinition {id:string;label?:string;initial:string;states:WorkflowState[];transitions:WorkflowTransition[]}
export interface PublishedWorkflow extends WorkflowDefinition {version:number;publishedAt:string;publishedBy:string}
export interface WorkflowStep {transitionId:string;actorId:string;role:WorkflowRole;at:string;from:string;to:string;revision:number;fields:Record<string,string>}
export interface WorkflowInstance {
  id:string;definitionId:string;definitionVersion:number;state:string;title:string;revision:number;
  createdBy:string;createdAt:string;updatedAt:string;lastActorId:string;contributors:string[];steps:WorkflowStep[];
  legacyBaseline?:{status:string;assessmentRevision:number;submittedBy?:string|null;decisionBy?:string|null};
}
export interface WorkflowEvent extends Record<string,unknown> {
  id:string;sequence:number;at:string;kind:string;actor:WorkflowActor|null;outcome:'accepted'|'refused';code:string|null;
}
export interface WorkflowSnapshot {schemaVersion:1;definitions:PublishedWorkflow[];instances:WorkflowInstance[];events:WorkflowEvent[]}
export interface WorkflowRefusal {ok:false;code:string;message:string;details?:Record<string,unknown>}
export type WorkflowOutcome<T extends object> = ({ok:true}&T)|Omit<WorkflowRefusal,'details'>;
export type WorkflowResult<T extends object> = WorkflowOutcome<T>&{event:WorkflowEvent};
export type WorkflowPlan={status:0;fields:Record<string,string>;contributors:string[]}|{status:1|2|3|4}|{status:5;missing:string[]};
export interface WorkDestination {view:string;recordId:string;projectId?:string}
export interface WorkTask extends QueueTask {
  id:string;label:string;title:string;dueDate:string|null;timing:'overdue'|'due-today'|'upcoming'|'no-date';
}
export interface WorkQueueTask extends WorkTask {sourceId:string;action:string}
export interface WorkQueueState {
  actors:readonly {id:string;name?:string}[];
  vendors:readonly {id:string;name?:string}[];
  assessments:readonly {id:string;vendorId:string;projectId:string;status:string;type?:string;monitoringCycleId?:unknown}[];
  rightsCases?:readonly {id:string;kind:string;owner:string;identity:{status:string};status:string;dueDate:string|null;closedAt?:unknown}[];
  incidentCases?:readonly {id:string;stage:string;owner:string;title:string}[];
  vendorMonitoring?:{cases?:readonly {id:string;vendorId:string;owner:string;status:string;renewalDueDate?:string|null;engagement?:{title:string}}[]};
  privacyNotices?:{notices?:readonly {id:string;status:string;authoredBy:string;title:string}[]};
  retentionBook?:{schedules?:readonly {id:string;status:string;authoredBy:string;title:string}[]};
  riskControls?:{
    controls?:readonly {id:string;title:string}[];
    risks?:readonly {id:string;title:string}[];
    tests?:readonly {id:string;controlId:string;reviewStatus:string}[];
    links?:readonly {id:string;riskId:string;reviewedBy?:unknown;archivedAt?:unknown}[];
  };
}

export interface WorkspaceDirectoryEntry {id:string;label:string;file:string;workflowFile:string}
export interface MembershipRecord {revision:number;disabled:boolean}
export interface IdentitySeat {id:string;role:string;configuredDisabled:boolean;validUntil:number|null;provisioning:string}
export interface AccountLifetime {disabled:boolean;validUntil:number|null}
export interface WorkspaceFeatureFlags {groupGovernance?:boolean;documentScope?:boolean;operatorJobs?:boolean;directoryLifecycle?:boolean}

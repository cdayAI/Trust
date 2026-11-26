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
  installRoutes(routes:readonly Route[]):void;
  authorize(method:string,pathname:string,role:string,limited:boolean):0|1|2|3;
}
export interface QueueTask {timing:string;owner:string;workflow:string;destination:{view:string;recordId:string;projectId?:string}}
export interface QueueModel {tasks:QueueTask[];workflowLabels:Record<string,string>}
export interface SummaryCounts {total:number;overdue:number;dueToday:number;upcoming:number;undated:number}

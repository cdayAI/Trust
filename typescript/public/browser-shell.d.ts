/** Classic-script contract with the remaining JavaScript browser shell.
 * The HTML shell supplies these required nodes. Server-side policy and
 * runtime response validation remain independent of compile-time types.
 */
declare function $(selector:string):HTMLElement;
declare function el<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,cls?:string):HTMLElementTagNameMap[K];
declare function add<P extends HTMLElement>(parent:P,...children:(Node|string)[]):P;
declare function button(caption:string,type?:'button'|'submit'|'reset',cls?:string):HTMLButtonElement;
declare function heading(text:string):HTMLHeadingElement;
declare function badge(text:unknown):HTMLSpanElement;
declare function labelled(label:string,name:string,value:string,kind?:'input'|'textarea',required?:boolean):HTMLLabelElement;
declare function rightsSelect(text:string,name:string,options:{value:string;label:string}[],selected?:string):HTMLLabelElement;
declare function notice(message:string,error?:boolean):void;
declare function scopeUrl(url:string):string;
declare function switchView(view:string,options?:{keepMyWorkLink?:boolean}):void;
// Typed response projections for the existing same-origin API. These are not
// a validator for arbitrary network JSON.
declare function read<T=unknown>(url:string,options?:RequestInit):Promise<T>;
declare let state:unknown;
declare let selected:string|undefined;
declare let actor:string;
declare let busy:boolean;
declare let localSession:{authenticated?:boolean;capabilities:{views:string[];workspaceAudit:boolean};workspace:string;account?:string}|null|undefined;

type BrowserWorkDestination=import('../contracts').WorkDestination;
type BrowserTiming=import('../contracts').WorkTask['timing'];
type BrowserQueueModel=ReturnType<typeof import('../work-queue').view>&{
  pagination?:{total:number;first:number;last:number;limit:number;previousCursor:string|null;nextCursor:string|null}
};
type BrowserHomeModel=ReturnType<typeof import('../workspace-home').dashboard>;
type BrowserHomeCounts=import('../contracts').SummaryCounts;
interface BrowserAssignedWork {
  asOf:string;
  tasks:{key:string;workflow:string;workflowName:string;actionLabel:string;recordLabel:string;dueDate:string|null;timing:BrowserTiming}[];
}
type BrowserQueueFilter={owner?:string;workflow?:string;timing?:string};
type BrowserEmployeeAdminModel={enabled:false}|{
  enabled:true;staff:string[];editions:{document:string;edition:string;title:string;number:number;hash:string}[];
  assignments:{title:string;number:number;employee:string;receipt?:{receipt:string;acknowledgedAt:string}|null}[];
};
type BrowserIdentityOperation='enable'|'disable'|'revoke';
interface BrowserIdentityMember {id:string;role:string;status:string;revision:number;allowed:BrowserIdentityOperation[]}
interface BrowserIdentityModel {
  members:BrowserIdentityMember[];
  operations:Record<BrowserIdentityOperation,{label:string;reason:string[]}>;
  reasons:Record<string,string>;
  audit:{action:string;target:string;actor:string;reason:string;at:string;revision:number}[];
}
type BrowserCenterAction='draft'|'submit'|'approve'|'return'|'publish'|'withdraw';
interface BrowserCenterVersion {version:number;status:string;card:{description:string};review?:{note?:string}|null}
type BrowserCenterModel={enabled:false}|{
  enabled:true;visitorPath:string;revision:number;
  catalog:Record<string,{label:string;options:Record<string,string>}>;
  topics:Record<string,{activeVersion:number|null;versions:BrowserCenterVersion[]}>;
};
interface BrowserDictionaryVersion {number:number;status:string;title:string;definition:string;review?:{reason?:string}|null}
interface BrowserDictionaryModel {
  revision:number;mapRevision:number;types:Record<string,{label:string;nodeTypes:string[]}>;
  inventory:{id:string;name:string;type:string}[];
  terms:{id:string;slug:string;type:string;retiredAt?:string|null;activeVersion?:number|null;versions:BrowserDictionaryVersion[];
    consumers:{nodeId:string;nodeName:string;version:number}[]}[];
}

'use strict';
const http = require('node:http');
const https = require('node:https');
const {createOperations,launchLocalServer,loopbackAddresses}=require('./operational-health');
const fs = require('node:fs/promises');
const path = require('node:path');
const {openStore} = require('./store');
const {openWorkflowHttp} = require('./workflow-http');
const {openSqlite} = require('./durable-storage');
const {view:workQueue}=require('./work-queue');
const {route:assessmentIncidentRoute}=require('./assessment-incident');
const {dashboard:workspaceHome}=require('./workspace-home');
const {model:myWork,taskToken:myWorkToken}=require('./my-work');
const myWorkRoute=new RegExp('^/api/my-work(?:/tasks/('+myWorkToken+'))?$');
const {createAccess}=require('./workspace-access');
const policy=require('./access-policy');
const groups=require('./group-governance');
const documentScope=require('./document-scope');
const directoryLifecycle=require('./directory-lifecycle');
const rightsCaseScope=require('./rights-case-scope');
const {fixtureOptions}=require('./discovery-import');
const discoveryRuns=require('./discovery-runs');
const {createPortal}=require('./requester-portal');
const trustCenter=require('./trust-center');
const employee=require('./employee-attestations');
const training=require('./training');
const binaryAttachments=require('./attachment-binary-batch');
const {provisionReview}=require('./governance-documents');
const {uploadRequestBytes,batchUploadRequestBytes}=require('./governance-document-attachments');
const attachmentUploadPath=/^\/api\/governance-documents\/records\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/revisions\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/attachments(?:\/batch)?$/u;
const reporting=require('./reporting');
const reportRuns=require('./reporting-runs');
const {route:reportScheduleRoute}=require('./report-schedules');
const publicDir = path.join(__dirname,'public');
const staticFiles = new Map([
  ['/',['index.html','text/html; charset=utf-8']],
  ['/index.html',['index.html','text/html; charset=utf-8']],
  ['/trust-center-ui.js',['trust-center-ui.js','text/javascript; charset=utf-8']],
  ['/identity-admin-ui.js',['identity-admin-ui.js','text/javascript; charset=utf-8']],
  ['/directory-lifecycle-ui.js',['directory-lifecycle-ui.js','text/javascript; charset=utf-8']],
  ['/document-access-ui.js',['document-access-ui.js','text/javascript; charset=utf-8']],
  ['/group-governance-ui.js',['group-governance-ui.js','text/javascript; charset=utf-8']],
  ['/training-admin-ui.js',['training-admin-ui.js','text/javascript; charset=utf-8']],
  ['/employee-admin-ui.js',['employee-admin-ui.js','text/javascript; charset=utf-8']],
  ['/workflow-studio-ui.js',['workflow-studio-ui.js','text/javascript; charset=utf-8']],
  ['/app.js',['app.js','text/javascript; charset=utf-8']],
  ['/governance-docs-ui.js',['governance-docs-ui.js','text/javascript; charset=utf-8']],
  ['/workspace-home-ui.js',['workspace-home-ui.js','text/javascript; charset=utf-8']],
  ['/workspace-home.css',['workspace-home.css','text/css; charset=utf-8']],
  ['/my-work-ui.js',['my-work-ui.js','text/javascript; charset=utf-8']],
  ['/operator-jobs-ui.js',['operator-jobs-ui.js','text/javascript; charset=utf-8']],
  ['/work-queue-ui.js',['work-queue-ui.js','text/javascript; charset=utf-8']],
  ['/vendor-monitoring-ui.js',['vendor-monitoring-ui.js','text/javascript; charset=utf-8']],
  ['/ethics-ui.js',['ethics-ui.js','text/javascript; charset=utf-8']],
  ['/audit-remediation-ui.js',['audit-remediation-ui.js','text/javascript; charset=utf-8']],
  ['/audit-management-ui.js',['audit-management-ui.js','text/javascript; charset=utf-8']],
  ['/risk-controls-ui.js',['risk-controls-ui.js','text/javascript; charset=utf-8']],
  ['/retention-ui.js',['retention-ui.js','text/javascript; charset=utf-8']],
  ['/privacy-notices-ui.js',['privacy-notices-ui.js','text/javascript; charset=utf-8']],
  ['/dictionary-ui.js',['dictionary-ui.js','text/javascript; charset=utf-8']],
  ['/data-map-ui.js',['data-map-ui.js','text/javascript; charset=utf-8']],
  ['/incident-ui.js',['incident-ui.js','text/javascript; charset=utf-8']],
  ['/rights-ui.js',['rights-ui.js','text/javascript; charset=utf-8']],
  ['/rights-deadline-ui.js',['rights-deadline-ui.js','text/javascript; charset=utf-8']],
  ['/assessment-config-ui.js',['assessment-config-ui.js','text/javascript; charset=utf-8']],
  ['/assessment-config.css',['assessment-config.css','text/css; charset=utf-8']],
  ['/processing-register-ui.js',['processing-register-ui.js','text/javascript; charset=utf-8']],
  ['/processing-register.css',['processing-register.css','text/css; charset=utf-8']],
  ['/maturity-planning-ui.js',['maturity-planning-ui.js','text/javascript; charset=utf-8']],
  ['/maturity-planning.css',['maturity-planning.css','text/css; charset=utf-8']],
  ['/reporting-ui.js',['reporting-ui.js','text/javascript; charset=utf-8']],
  ['/reporting.css',['reporting.css','text/css; charset=utf-8']],
  ['/modules-ui.js',['modules-ui.js','text/javascript; charset=utf-8']],
  ['/mvw-horizon.svg',['mvw-horizon.svg','image/svg+xml']],
  ['/styles.css',['styles.css','text/css; charset=utf-8']],
  ['/style.css',['style.css','text/css; charset=utf-8']]
]);
function send(res,status,value,type='application/json; charset=utf-8',extra={}) {
  res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",...extra});
  res.end(type.startsWith('application/json')&&!Buffer.isBuffer(value)?JSON.stringify(value,null,2)+'\n':value);
}
async function readBoundedBytes(req,limit) {
  const tooLarge=()=>Object.assign(new Error(limit===32768?'Request exceeds 32 KiB.':limit===binaryAttachments.requestLimit?
    'Attachment request exceeds the binary upload limit.':'Attachment request exceeds the encoded upload limit.'),
    {status:413,closeConnection:true});
  if(Number(req.headers['content-length'])>limit)throw tooLarge();
  let bytes=0;
  const chunks=[];
  for await (const chunk of req.iterator({destroyOnReturn:false})) {
    bytes+=chunk.length;
    if (bytes>limit)throw tooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks,bytes);
}
async function readBody(req,limit=32768) {
  const bytes=await readBoundedBytes(req,limit);
  try { return bytes.length?JSON.parse(bytes.toString('utf8')):{}; }
  catch { throw Object.assign(new Error('Invalid JSON.'),{status:400}); }
}
function createServer({dataFile=process.env.DATA_FILE || path.join(__dirname,'data','state.json'),sqliteFile,isolated,corporate,tls,operationalEvents=false}={}) {
  const directoryScopes=directoryLifecycle.provision(isolated,corporate===undefined);
  const oidcModule=corporate===undefined?null:require('./oidc/client');
  const oidc=oidcModule?.createOidc(corporate);
  if((oidc&&!isolated)||Boolean(tls)!==Boolean(oidc?.secure))
    throw new Error('Corporate sign-in requires an isolated workspace and the configured transport.');
  const scopedCatalogs=groups.provision(isolated);
  const scopedDocuments=documentScope.provision(isolated);
  const scopedRights=rightsCaseScope.provision(isolated);
  const stagedDiscovery=discoveryRuns.provision(isolated,sqliteFile,corporate);
  const manualReview=provisionReview(isolated);
  const largePdfScopes=binaryAttachments.provision(isolated,sqliteFile,manualReview);
  if(oidc&&largePdfScopes.size)throw Error('Larger PDF batches are limited to the local synthetic workbench.');
  const access=isolated===undefined?null:createAccess(isolated,(space,id)=>runtime(space).store.identityMembership(id),
    id=>({operatorJobs:sqliteFile!==undefined,groupGovernance:scopedCatalogs.has(id),documentScope:scopedDocuments.has(id),directoryLifecycle:directoryScopes.has(id)}),oidc);
  const portal=access&&isolated.requesterGrants!==undefined?createPortal({
    grants:isolated.requesterGrants,workspaces:isolated.workspaces,accounts:isolated.accounts,releaseWorkspaces:oidc?[]:isolated.requesterReleaseWorkspaces,now:isolated.now
  }):null;
  const centers=access&&isolated.trustCenters!==undefined?trustCenter.provision(isolated.trustCenters,isolated.workspaces):null;
  const staff=access&&isolated.employeeGrants!==undefined?employee.provision({
    grants:isolated.employeeGrants,key:isolated.employeeSigningKey,workspaces:isolated.workspaces,
    accounts:isolated.accounts,requesters:isolated.requesterGrants,now:isolated.now
  }):null;
  const learners=access&&isolated.trainingGrants!==undefined?training.provision({
    grants:isolated.trainingGrants,key:isolated.trainingSigningKey,workspaces:isolated.workspaces,accounts:isolated.accounts,
    requesters:isolated.requesterGrants,employees:isolated.employeeGrants,now:isolated.now
  }):null;
  const database=sqliteFile===undefined?null:openSqlite(sqliteFile);
  function openRuntime(stateFile,workflowFile,scope,empty,scopeDocuments=false,manualAttachmentReview=false,scopeRights=false,largePdf=false){
    const storage=database?.scope(scope);
    const workflow=openWorkflowHttp(workflowFile,{storage});
    return {store:openStore(stateFile,{empty,storage,scopeDocuments,manualAttachmentReview,scopeRights,largePdf}),workflow};
  }
  let demo;
  try {
    database?.requireMode(access?'isolated':'demo');
    demo=access?null:openRuntime(dataFile,dataFile+'.workflows','demo',false);
  } catch(error) {
    database?.close();
    throw error;
  }
  const runtimes=new Map();
  function runtime(space){
    if(!space)return demo;
    if(!runtimes.has(space.id))runtimes.set(space.id,
      openRuntime(space.file,space.workflowFile,'workspace:'+space.id,true,scopedDocuments.has(space.id),manualReview.has(space.id),scopedRights.has(space.id),largePdfScopes.has(space.id)));
    return runtimes.get(space.id);
  }
  try{
    for(const id of new Set([...scopedDocuments,...manualReview,...scopedRights]))runtime(access.spaceForProvisionedGrant(id));
  }catch(error){database?.close();throw error;}
  const files=database?[sqliteFile]:access?isolated.workspaces.flatMap(({id})=>{
    const {file,workflowFile}=access.spaceForProvisionedGrant(id);
    return [file,workflowFile];
  }):[dataFile,dataFile+'.workflows'];
  let operations;
  try{
    operations=createOperations({files,assets:['index.html','app.js','styles.css'].map(file=>path.join(publicDir,file)),
      logEvents:operationalEvents,checkBackend:database?()=>database.checkMode(access?'isolated':'demo'):undefined});
  }catch(error){database?.close();throw error;}
  let activeBatchUploads=0;
  const handler=async (req,res)=>{
    let countedBatch=false;
    try {
      if(!loopbackAddresses.has(req.socket.remoteAddress))return send(res,403,{error:'Only loopback access is allowed.'});
      if(oidc){
        if(req.headers.host!==oidc.host||Boolean(req.socket.encrypted)!==oidc.secure||
          !req.url.startsWith('/')||req.url.startsWith('//')||req.url.includes('\\'))
          return send(res,403,{error:'Invalid application origin.'});
      }else if(!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(req.headers.host||'')){
        return send(res,403,{error:'Only loopback access is allowed.'});
      }
      const {pathname,searchParams,search}=new URL(req.url,'http://localhost');
      const binaryUpload=binaryAttachments.pathPattern.test(pathname);
      if(oidc&&pathname===oidcModule.startPath){
        if(req.method!=='POST')return send(res,405,{error:'Method not allowed.'},undefined,{Allow:'POST'});
        if(req.headers.origin!==oidc.origin||searchParams.size)
          return send(res,403,{error:'Invalid sign-in request.'});
        try{
          const {location,cookie}=await oidc.start();
          return send(res,303,'','text/plain',{'Location':location,'Set-Cookie':cookie});
        }catch{
          operations.requestError();
          return send(res,503,{error:'Corporate sign-in is unavailable.'});
        }
      }
      if(oidc&&pathname===oidcModule.callbackPath){
        if(req.method!=='GET')return send(res,405,{error:'Method not allowed.'},undefined,{Allow:'GET'});
        const cookies=[oidc.clear()];
        let location=oidcModule.deniedPath;
        try{
          const identity=await oidc.complete(req,search);
          cookies.push(access.loginOidc(req,identity).cookie);
          location='/';
        }catch{
          // Keep provider responses, codes and claims out of error pages and logs.
        }
        return send(res,303,'','text/plain',{'Location':location,'Set-Cookie':cookies});
      }
      if(pathname==='/health/live'||pathname==='/health/ready'){
        if(searchParams.size)return send(res,404,{error:'Not found.'});
        if(req.method!=='GET')return send(res,405,{error:'Method not allowed.'},undefined,{Allow:'GET'});
        if(pathname==='/health/live')return send(res,200,{status:'live'});
        const result=await operations.ready(server.address());
        return send(res,result.status==='ready'?200:503,result);
      }
      const visit=pathname.match(/^\/api\/trust-center-visitor\/(sample-[a-z0-9-]{1,32})$/);
      const visitPage=pathname.match(/^\/trust-center\/(sample-[a-z0-9-]{1,32})$/);
      if(visit||visitPage||pathname==='/trust-center-visitor.js'){
        if(!centers||req.method!=='GET'||searchParams.size)return send(res,404,{error:'Not found.'});
        if(pathname==='/trust-center-visitor.js')return send(res,200,await fs.readFile(path.join(publicDir,'trust-center-visitor.js')),'text/javascript; charset=utf-8');
        const workspace=centers.workspace((visit??visitPage)[1]);
        if(!workspace)return send(res,404,{error:'Not found.'});
        if(visitPage)return send(res,200,await fs.readFile(path.join(publicDir,'trust-center-visitor.html')),'text/html; charset=utf-8');
        return send(res,200,runtime(access.spaceForProvisionedGrant(workspace)).store.trustCenterVisitor());
      }
      if(req.method==='GET'&&['/employee','/employee.js'].includes(pathname)){
        if(!staff)return send(res,404,{error:'Not found.'});
        const [file,type]=pathname==='/employee'?['employee.html','text/html']:['employee.js','text/javascript'];
        return send(res,200,await fs.readFile(path.join(publicDir,file)),type+'; charset=utf-8');
      }
      if(req.method==='GET'&&['/training','/training.js'].includes(pathname)){
        if(!learners)return send(res,404,{error:'Not found.'});
        const [file,type]=pathname==='/training'?['training.html','text/html']:['training-learner-ui.js','text/javascript'];
        return send(res,200,await fs.readFile(path.join(publicDir,file)),type+'; charset=utf-8');
      }
      if(req.method==='GET'&&['/requester','/requester.js'].includes(pathname)){
        if(!portal)return send(res,404,{error:'Not found.'});
        const [file,type]=pathname==='/requester'?['requester.html','text/html']:['requester.js','text/javascript'];
        return send(res,200,await fs.readFile(path.join(publicDir,file)),type+'; charset=utf-8');
      }
      if (req.method==='GET'&&staticFiles.has(pathname)) {
        const [file,type]=staticFiles.get(pathname);
        return send(res,200,await fs.readFile(path.join(publicDir,file)),type,
          oidc&&file==='index.html'?{'Referrer-Policy':'same-origin'}:undefined);
      }
      if(req.method==='POST'&&pathname.startsWith('/api/')){
        const origin=req.headers.origin;
        if ((access&&origin!==(oidc?.origin??'http://'+req.headers.host))||
          (origin&&origin!=='http://'+req.headers.host&&origin!=='https://'+req.headers.host))
          return send(res,403,{error:'Cross-origin writes are not allowed.'});
        if(binaryUpload){
          if(req.headers['content-type']!==binaryAttachments.contentType||req.headers['content-encoding'])
            return send(res,415,{error:'Use the uncompressed MVW Trust binary attachment-batch format.'},undefined,{'Connection':'close'});
        }else if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')) return send(res,415,{error:'Use application/json.'});
      }
      if(req.method==='GET'&&pathname==='/api/session')return send(res,200,access?access.describe(req):{mode:'synthetic-demo'});
      if(pathname.startsWith('/api/session/')){
        const operation=pathname.slice('/api/session/'.length);
        if(!access||req.method!=='POST'||!['login','switch','logout'].includes(operation)||(oidc&&operation==='login'))return send(res,404,{error:'Not found.'});
        const result=access[operation](req,await readBody(req));
        return send(res,200,result.value,undefined,{'Set-Cookie':result.cookie});
      }
      if(pathname.startsWith('/api/requester/')){
        const operation=pathname.slice('/api/requester/'.length);
        if(!portal||req.method!=='POST'||!['status','intake','result'].includes(operation)||
          (operation==='result'&&!portal.resultsProvisioned))return send(res,404,{error:'Not found.'});
        if(searchParams.size)return send(res,422,{error:'The requester portal does not accept URL parameters.'});
        const body=await readBody(req);
        const grant=portal.allow(operation,body);
        const {store}=runtime(access.spaceForProvisionedGrant(grant.workspace));
        const value=operation==='intake'?store.portalIntake(grant,body):operation==='result'?store.portalResult(grant):store.portalStatus(grant);
        return send(res,200,value);
      }
      if(pathname.startsWith('/api/employee/')){
        const operation=pathname.slice('/api/employee/'.length);
        if(!staff||req.method!=='POST'||!['assignments','attest'].includes(operation))return send(res,404,{error:'Not found.'});
        if(searchParams.size)return send(res,422,{error:'The employee portal does not accept URL parameters.'});
        const body=await readBody(req),seat=staff.authenticate(operation,body);
        const {store}=runtime(access.spaceForProvisionedGrant(seat.workspace));
        return send(res,200,operation==='attest'?store.employeeConfirm(seat,body,staff.signer):store.employeeView(seat));
      }
      if(pathname.startsWith('/api/training-learner/')){
        const operation=pathname.slice('/api/training-learner/'.length);
        if(!learners||req.method!=='POST'||!['list','lesson','start','complete'].includes(operation))return send(res,404,{error:'Not found.'});
        if(searchParams.size)return send(res,422,{error:'The training portal does not accept URL parameters.'});
        const body=await readBody(req),seat=learners.authenticate(body);
        const {store}=runtime(access.spaceForProvisionedGrant(seat.workspace));
        const value=['list','lesson'].includes(operation)?store.trainingQuery(seat,operation,body):store.trainingProgress(seat,operation,body,learners.sign);
        return send(res,200,value);
      }
      if(!pathname.startsWith('/api/'))return send(res,404,{error:'Not found.'});
      const operator = pathname === '/api/operator' || pathname.startsWith('/api/operator/');
      if (operator && (!access || !database)) return send(res, 404, {error:'Not found.'});
      const expected=searchParams.getAll('workspace');
      const selection=access?.context(req,expected);
      const actor=access?selection.actor:req.headers['x-demo-actor'];
      if(access){
        policy.requirePermission(req.method,pathname,actor);
        searchParams.delete('workspace');
      }
      const caseOperator=!!access&&actor==='case-operator';
      const {store,workflow}=runtime(selection?.space);
      if (operator) {
        if (searchParams.size) return send(res, 422, {error:'Operator jobs only accept the workspace URL parameter.'});
        const [jobId, command] = pathname.split('/').slice(5);
        if (req.method === 'GET') return send(res, 200, store.readOperatorJobs(selection, jobId));
        const body = await readBody(req);
        const caller = access.context(req, expected);
        const { changed, job } = store.changeOperatorJob(caller, command ?? 'submit', jobId, body);
        return send(res, changed && !jobId ? 201 : 200, { job });
      }
      if(pathname==='/api/identity-admin'){
        if(!access)return send(res,404,{error:'Not found.'});
        if(searchParams.size)return send(res,422,{error:'No identity administration query filters are supported.'});
        const roster=()=>access.identityRoster(selection.space.id);
        if(req.method==='GET')return send(res,200,store.identityAdminView(roster(),access.identityTime()));
        const body=await readBody(req);
        const checked=access.context(req,expected);
        policy.requirePermission(req.method,pathname,checked.actor);
        return send(res,200,store.identityAdminChange(roster(),access.identityTime(),checked.account,body));
      }
      if(pathname==='/api/directory-lifecycle'){
        if(!directoryScopes.has(selection?.space.id))return send(res,404,{error:'Not found.'});
        if(searchParams.size)return send(res,422,{error:'Directory reconciliation does not accept query filters.'});
        const directoryContext=checked=>({
          enabled:true,workspace:checked.space.id,role:checked.actor,account:checked.account,generation:checked.generation,
          roster:access.identityRoster(checked.space.id),at:access.identityTime()
        });
        if(req.method==='GET')return send(res,200,store.directoryView(directoryContext(selection)));
        if(req.method!=='POST')return send(res,404,{error:'Not found.'});
        const body=await readBody(req),checked=access.context(req,expected);
        policy.requirePermission(req.method,pathname,checked.actor);
        return send(res,200,store.directoryChange(directoryContext(checked),body));
      }
      if(pathname==='/api/group-governance'||pathname==='/api/scoped-applications'){
        const catalog=scopedCatalogs.get(selection?.space.id);
        if(!catalog)return send(res,404,{error:'Not found.'});
        if(searchParams.size)return send(res,422,{error:'Scope governance does not use query filters.'});
        const groupContext=checked=>({
          role:checked.actor,account:checked.account,roster:access.identityRoster(checked.space.id),
          at:access.identityTime(),catalog,generation:checked.generation
        });
        if(req.method==='GET'){
          const context=groupContext(selection);
          return send(res,200,pathname==='/api/scoped-applications'?store.scopedApplications(context):store.groupGovernanceView(context));
        }
        const body=await readBody(req);
        const checked=access.context(req,expected);
        policy.requirePermission(req.method,pathname,checked.actor);
        return send(res,200,store.groupGovernanceChange(groupContext(checked),body));
      }
      const scopeContext=checked=>({
        role:checked.actor,account:checked.account,generation:checked.generation,at:access.identityTime(),
        roster:access.identityRoster(checked.space.id),enabled:scopedDocuments.has(checked.space.id),
        rightsEnabled:scopedRights.has(checked.space.id),intakeEnabled:!!portal?.enabled(checked.space.id),
        ...(portal?.releaseEnabled(checked.space.id)&&!oidc?{activeReleaseBinding:id=>portal.activeBinding(id,checked.space.id)}:{})
      });
      if(pathname==='/api/document-access'){
        if(!scopedDocuments.has(selection?.space.id))return send(res,404,{error:'Not found.'});
        if(searchParams.size)return send(res,422,{error:'Document access does not accept query filters.'});
        if(req.method==='GET')return send(res,200,store.documentAccessView(scopeContext(selection)));
        if(req.method!=='POST')return send(res,404,{error:'Not found.'});
        const body=await readBody(req);
        const checked=access.context(req,expected);
        policy.requirePermission(req.method,pathname,checked.actor);
        return send(res,200,store.documentAccessTransition(scopeContext(checked),body));
      }
      const mode=access?'local-isolated':'synthetic-demo';
      const workflowParts=pathname.startsWith('/api/workflows/')?pathname.slice(15).split('/'):null;
      const employeeEnabled=staff?.enabled(selection?.space.id);
      const assignedStaff=staff?.staff(selection?.space.id)??[];
      if(pathname==='/api/ethics'||pathname.startsWith('/api/ethics/')){
        if(!access||searchParams.size)return send(res,404,{error:'Not found.'});
        if(req.method==='GET'&&pathname==='/api/ethics/cases')
          return send(res,200,store.getEthicsCases(actor,selection.account));
        const report=pathname.match(/^\/api\/ethics\/cases\/([a-f0-9-]{36})\/export$/);
        if(req.method==='GET'&&report)
          return send(res,200,store.getEthicsExport(report[1],actor,selection.account),undefined,
            {'Content-Disposition':'attachment; filename="synthetic-ethics-summary.json"'});
        const mutation=pathname.match(/^\/api\/ethics\/cases(?:\/([a-f0-9-]{36})\/(triage|begin|finding|submit|return|close))?$/);
        if(req.method==='POST'&&mutation){
          const body=await readBody(req);
          access.context(req,expected);
          return send(res,200,store.changeEthics(actor,selection.account,mutation[2]??'open',mutation[1],body));
        }
        return send(res,404,{error:'Not found.'});
      }
      if(req.method==='GET'&&pathname==='/api/employee-attestations')
        return send(res,200,employeeEnabled&&['analyst','reviewer'].includes(actor)?store.employeeOperatorView(assignedStaff):{enabled:false});
      const trainingEnabled=learners?.enabled(selection?.space.id);
      const enrolled=learners?.learners(selection?.space.id)??[];
      if(req.method==='GET'&&pathname==='/api/training')
        return send(res,200,trainingEnabled?store.trainingOperatorView(enrolled):{enabled:false});
      const centerPath=centers?.path(selection?.space.id);
      if(req.method==='GET'&&pathname==='/api/trust-center')
        return send(res,200,centerPath&&['analyst','reviewer'].includes(actor)?store.trustCenterView(centerPath):{enabled:false});
      if (req.method==='GET'&&workflowParts) {
        const r=workflow.get(workflowParts,mode,actor,selection?.account);
        const value=access&&actor==='publisher'&&workflowParts[0]==='studio'&&r.status===200?policy.publisherStudio(r.value):r.value;
        return send(res,r.status,value);
      }
      if(req.method==='GET'&&pathname==='/api/workspace-home'){
        // The only alternate actor is the selection made in the synthetic demo.
        // In isolated mode the session's authorization decides both counts and destinations.
        const homeActor=actor??'analyst';
        if(!['analyst','reviewer','case-operator'].includes(homeActor))
          return send(res,403,{error:'This role has no workspace dashboard.'});
        return send(res,200,workspaceHome(caseOperator?store.caseOperatorState(scopeContext(selection)):store.getState(),{mode,actor:homeActor,selection,views:policy.capabilities(homeActor).views},searchParams));
      }
      const scheduleRoute=pathname.match(reportScheduleRoute);
      if(scheduleRoute){
        if(!access||oidc)return send(res,404,{error:'Local report schedules require a local synthetic staff session.'});
        if(searchParams.size)return send(res,422,{error:'Report schedules accept only the workspace URL parameter.'});
        if(req.method==='GET'&&!scheduleRoute[1])return send(res,200,store.listReportSchedules(selection));
        if(req.method!=='POST'||!scheduleRoute[1])return send(res,404,{error:'Not found.'});
        const body=await readBody(req),current=access.context(req,expected);
        policy.requirePermission(req.method,pathname,current.actor);
        return send(res,200,store.changeReportSchedule(current,scheduleRoute[1],body));
      }
      const reportRoute=pathname.match(reportRuns.routePattern);
      if(reportRoute){
        const [,saved,id,download]=reportRoute;
        if(saved){
          if(!reporting.canReport(actor??'analyst'))return send(res,403,{error:'An analyst or reviewer is required for reporting.'});
          if(req.method==='POST'&&!id){
            reportRuns.query(searchParams,false);
            const body=await readBody(req);
            const current=access?.context(req,expected);
            if(!reporting.canReport(current?.actor??actor))return send(res,403,{error:'An analyst or reviewer is required to pin a report.'});
            const pinned=store.pinReportRun(body,mode);
            return send(res,201,pinned);
          }
          if(req.method!=='GET')return send(res,404,{error:'Not found.'});
          const format=reportRuns.query(searchParams,!!download);
          if(!id)return send(res,200,store.listReportRuns());
          const headers=download?{'Content-Disposition':'attachment; filename="mvw-trust-report-'+id+'.'+format+'"'}:{};
          return send(res,200,store.readReportRun(id,format),format==='csv'?'text/csv; charset=utf-8':undefined,headers);
        }
        if(req.method!=='GET')return send(res,404,{error:'Not found.'});
        if(access&&!reporting.canReport(actor))return send(res,403,{error:'An analyst or reviewer is required for reporting.'});
        const exporting=pathname.endsWith('/export');
        const {state,audit}=store.reportSnapshot();
        const {model,format}=reporting.report(state,audit,searchParams,{mode,exporting});
        if(!exporting)return send(res,200,model);
        const headers={'Content-Disposition':'attachment; filename="mvw-trust-report.'+format+'"'};
        return format==='csv'?send(res,200,reporting.csv(model),'text/csv; charset=utf-8',headers):send(res,200,model,undefined,headers);
      }
      const ownWork=req.method==='GET'&&pathname.match(myWorkRoute);
      if(ownWork){
        if(!selection)return send(res,404,{error:'My work requires an isolated staff session.'});
        return send(res,200,myWork(caseOperator?store.caseOperatorState(scopeContext(selection)):store.getState(),selection,policy.capabilities(actor).views,searchParams,ownWork[1]));
      }
      if (req.method==='GET'&&['/api/work-queue','/api/work-queue/export'].includes(pathname)){
        const queue=workQueue(store.getState(),searchParams);
        return pathname.endsWith('/export')?send(res,200,{schemaVersion:1,...queue},undefined,
          {'Content-Disposition':'attachment; filename="privacy-workbench-queue.json"'}):send(res,200,queue);
      }
      if (req.method==='GET'&&pathname==='/api/governance-documents'){
        const docs=caseOperator?store.getCaseDocuments(scopeContext(selection)):store.getDocuments(actor,selection?.account);
        return send(res,200,caseOperator?policy.caseDocumentView(docs):docs);
      }
      if (req.method==='GET'&&pathname==='/api/vendor-monitoring') return send(res,200,store.getVendorMonitoring());
      if(pathname==='/api/audit-management'||pathname.startsWith('/api/audit-management/')){
        if(req.method==='GET'&&pathname==='/api/audit-management') return send(res,200,store.getAuditManagement());
        const closure=pathname.match(/^\/api\/audit-management\/remediations\/([a-f0-9-]{36})\/report$/);
        if(req.method==='GET'&&closure)return send(res,200,store.getRemediationReport(closure[1]),undefined,
          {'Content-Disposition':'attachment; filename="synthetic-remediation-'+closure[1]+'.json"'});
        const report=pathname.match(/^\/api\/audit-management\/plans\/([a-f0-9-]{36})\/report$/);
        if(req.method==='GET'&&report)return send(res,200,store.getAuditReport(report[1]),undefined,
          {'Content-Disposition':'attachment; filename="synthetic-audit-'+report[1]+'.json"'});
      }
      const processingVersion=pathname.match(/^\/api\/processing-register\/entries\/([a-f0-9-]{36})\/versions\/([1-9][0-9]*)\/export$/);
      if(req.method==='GET'&&(pathname==='/api/processing-register/export'||processingVersion))
        return send(res,200,store.getProcessingExport(processingVersion?.[1],processingVersion?Number(processingVersion[2]):undefined),undefined,
          {'Content-Disposition':'attachment; filename="mvw-trust-processing-register.json"'});
      if(req.method==='GET'&&pathname==='/api/processing-register')return send(res,200,store.getProcessingRegister());
      if(req.method==='GET'&&pathname==='/api/assessment-config')return send(res,200,store.getAssessmentConfiguration());
      if(req.method==='GET'&&pathname==='/api/maturity-planning')return send(res,200,store.getMaturityPlanning());
      const maturityReport=pathname.match(/^\/api\/maturity-planning\/plans\/([a-f0-9-]{36})\/versions\/([1-9][0-9]*)\/report$/);
      if(req.method==='GET'&&maturityReport)return send(res,200,store.getMaturityReport(maturityReport[1],Number(maturityReport[2])),undefined,
        {'Content-Disposition':'attachment; filename="mvw-trust-plan-v'+maturityReport[2]+'.json"'});
      if (req.method==='GET'&&pathname==='/api/risk-controls') return send(res,200,store.getRiskControls());
      if (req.method==='GET'&&pathname==='/api/risk-controls/export') return send(res,200,{schemaVersion:1,mode,
        program:store.getRiskControls(),audit:store.getProgramAudit('risk-controls')},undefined,
        {'Content-Disposition':'attachment; filename="privacy-workbench-risk-controls.json"'});
      if (req.method==='GET'&&pathname==='/api/retention') return send(res,200,store.getRetention());
      if (req.method==='GET'&&pathname==='/api/privacy-notices') return send(res,200,store.getPreferences());
      if (req.method==='GET'&&pathname==='/api/dictionary')return send(res,200,store.getDictionary());
      if (req.method==='GET'&&pathname==='/api/dictionary/export')return send(res,200,{schemaVersion:1,mode,
        dictionary:store.getDictionary(),audit:store.getProgramAudit('dictionary')},undefined,
        {'Content-Disposition':'attachment; filename="privacy-workbench-dictionary.json"'});
      const runPath=pathname.match(discoveryRuns.pattern);
      if(runPath){
        if(!selection||!stagedDiscovery.has(selection.space.id))return send(res,404,{error:'Not found.'});
        if(searchParams.size)return send(res,422,{error:'Discovery rehearsal does not accept filters.'});
        if(req.method==='GET'&&!runPath[1])return send(res,200,store.discoveryRunModel());
        if(req.method!=='POST')return send(res,404,{error:'Not found.'});
        const body=await readBody(req),checked=access.context(req,expected);
        policy.requirePermission(req.method,pathname,checked.actor);
        return send(res,200,store.changeDiscoveryRun(checked,runPath[1],runPath[2],body));
      }
      if(selection&&['/api/data-map/discovery/preview','/api/data-map/discovery/apply'].includes(pathname)&&
        (stagedDiscovery.has(selection.space.id)||store.hasDiscoveryRehearsals()))
        return send(res,409,{error:'Use the staged discovery rehearsal for this workspace.'});
      if (req.method==='GET'&&pathname==='/api/data-map/discovery') return send(res,200,{fixtures:fixtureOptions()});
      if (req.method==='GET'&&pathname==='/api/data-map'){
        const map=store.getDataMap();
        if(selection&&stagedDiscovery.has(selection.space.id))map.discoveryRehearsal='available';
        else if(selection&&store.hasDiscoveryRehearsals())map.discoveryRehearsal='disabled';
        return send(res,200,map);
      }
      if (req.method==='GET'&&pathname==='/api/data-map/export') return send(res,200,{schemaVersion:1,mode,
        graph:store.getDataMap(),audit:store.getState().audit.filter(e=>e.action.startsWith('data-map.'))},undefined,
        {'Content-Disposition':'attachment; filename="privacy-workbench-data-map.json"'});
      const lineagePath=pathname.match(/^\/api\/data-map\/nodes\/([0-9a-f-]{36})\/lineage$/);
      if (req.method==='GET'&&lineagePath) return send(res,200,store.getLineage(lineagePath[1]));
      if (req.method==='GET'&&pathname==='/api/incidents/cases') return send(res,200,store.getIncidents(actor,selection?.account));
      if(pathname.startsWith('/api/rights/intake-form/')){
        const op=pathname.slice('/api/rights/intake-form/'.length);
        if(!portal?.enabled(selection?.space.id)||req.method!=='POST'||searchParams.size||
          !['save','submit','return','publish'].includes(op))return send(res,404,{error:'Not found.'});
        const body=await readBody(req),checked=access.context(req,expected);
        policy.requirePermission(req.method,pathname,checked.actor);
        return send(res,200,store.changeRequesterIntakeForm(scopeContext(checked),op,body));
      }
      if(pathname==='/api/rights/deadline-policy'||pathname.startsWith('/api/rights/deadline-policy/')){
        if(!access||searchParams.size)return send(res,404,{error:'Not found.'});
        if(req.method==='GET'&&pathname==='/api/rights/deadline-policy')return send(res,200,store.getRightsDeadlinePolicy(selection.account));
      }
      if(!access&&/^\/api\/rights\/cases\/[^/]+\/(?:request|approve|reject)-extension$/.test(pathname))
        return send(res,404,{error:'Not found.'});
      const releaseRoute=pathname.match(/^\/api\/rights\/cases\/([a-f0-9-]{36})\/result\/(draft|submit|return|approve|release)$/);
      if(req.method==='POST'&&releaseRoute){
        if(!selection||oidc||!portal?.releaseEnabled(selection.space.id)||searchParams.size)return send(res,404,{error:'Not found.'});
        const body=await readBody(req),checked=access.context(req,expected);
        policy.requirePermission(req.method,pathname,checked.actor);
        return send(res,200,store.changeRequesterRelease(scopeContext(checked),releaseRoute[1],releaseRoute[2],body));
      }
      if (req.method==='GET'&&pathname==='/api/rights/cases'){
        const rights=store.getRights(selection?scopeContext(selection):undefined);
        return send(res,200,caseOperator?policy.caseOperatorView(rights):rights);
      }
      if (req.method==='GET'&&pathname==='/api/modules') return send(res,200,store.getModules());
      if (req.method==='GET'&&pathname==='/api/state'){
        const state=store.publicState();
        return send(res,200,access?policy.operatorState(state,actor):state);
      }
      if (req.method==='GET'&&pathname==='/api/audit/export') {
        const audit=store.visibleAudit();
        return send(res,200,{schemaVersion:1,mode,exportedAt:new Date().toISOString(),audit},undefined,{'Content-Disposition':'attachment; filename="privacy-workbench-audit.json"'});
      }
      if (req.method==='POST'&&pathname.startsWith('/api/')) {
        const isAttachmentUpload=attachmentUploadPath.test(pathname);
        const batchUpload=binaryUpload||isAttachmentUpload&&pathname.endsWith('/batch');
        if(binaryUpload&&!largePdfScopes.has(selection?.space.id))
          return send(res,404,{error:'Not found.'},undefined,{'Connection':'close'});
        if(batchUpload){
          // Enforce authority and a small concurrency budget before buffering a large upload.
          if(actor!=='analyst')return send(res,403,{error:'Only the author can upload draft attachments.',code:'AUTHOR_REQUIRED'},undefined,{'Connection':'close'});
          if(activeBatchUploads>=2)return send(res,429,{error:'Two uploads are already in progress. Retry when one finishes.',code:'ATTACHMENT_UPLOAD_BUSY'},undefined,{'Connection':'close','Retry-After':'1'});
          activeBatchUploads++;countedBatch=true;
        }
        let body;
        if(binaryUpload){
          const deadline=setTimeout(()=>req.destroy(),20_000);
          try{body=binaryAttachments.decode(await readBoundedBytes(req,binaryAttachments.requestLimit));}
          finally{clearTimeout(deadline);}
        }else body=await readBody(req,batchUpload?batchUploadRequestBytes:isAttachmentUpload?uploadRequestBytes:undefined);
        // The session may have expired, been switched, or logged out while the body was arriving.
        const current=access?.context(req,expected);
        if((isAttachmentUpload||binaryUpload)&&current&&current.actor!==actor)return send(res,403,{error:'The upload role changed.'});
        if (workflowParts) {
          if(access&&workflowParts[0]==='definitions'&&Array.isArray(body?.definition?.transitions)&&
            body.definition.transitions.some(t=>Array.isArray(t?.roles)&&t.roles.includes('publisher')))
            return send(res,422,{error:'The isolated publisher does not participate in workflow execution.',code:'WORKFLOW_ROLE_UNAVAILABLE'});
          const r=workflow.post(workflowParts,actor,body,selection?.account);
          return send(res,r.status,r.value);
        }
        const assessmentLink=pathname.match(assessmentIncidentRoute);
        if(assessmentLink){
          if(!current)return send(res,404,{error:'Not found.'});
          if(searchParams.size)return send(res,422,{error:'The assessment follow-up does not accept filters.'});
          const result=store.openAssessmentIncident(assessmentLink[1],current,body);
          return send(res,result.created?201:200,result);
        }
        if(pathname==='/api/data-map/discovery/preview')return send(res,200,store.previewDiscovery(actor,body,selection?.account));
        const parts=pathname.slice(5).split('/');
        const rightsContext=current&&parts[0]==='rights'&&parts[1]==='cases'?scopeContext(current):undefined;
        if(parts[0]==='rights'&&parts[1]==='cases'&&parts[3]==='delegation'&&parts.length===4){
          if(!rightsContext?.rightsEnabled)return send(res,404,{error:'Rights case not found.'});
          if(searchParams.size)return send(res,422,{error:'Rights delegation does not accept query filters.'});
          return send(res,200,store.delegateRightsCase(parts[2],rightsContext,body));
        }
        if(parts[0]==='training'&&parts.length===2){
          if(!trainingEnabled)return send(res,404,{error:'Policy training is not provisioned for this workspace.'});
          return send(res,200,store.trainingAdmin(enrolled,actor,selection.account,parts[1],body));
        }
        if(pathname==='/api/employee-attestations'){
          if(!employeeEnabled)return send(res,404,{error:'Employee attestations are not provisioned for this workspace.'});
          return send(res,200,store.employeeAssign(assignedStaff,actor,selection.account,body));
        }
        if(parts[0]==='trust-center'){
          if(!centerPath)return send(res,404,{error:'Trust center is not configured for this workspace.'});
          store.change(parts,actor,body,selection?.account);
          return send(res,200,store.trustCenterView(centerPath));
        }
        const resourceChange=()=>caseOperator&&parts[0]==='governance-documents'?
          store.readCaseDocument(parts,scopeContext(current),body):store.change(parts,actor,body,selection?.account,current?.generation,rightsContext);
        if(parts.length===8&&parts[0]==='governance-documents'&&parts[1]==='records'&&parts[3]==='revisions'&&parts[5]==='attachments'&&parts[7]==='download'){
          const {bytes,filename}=resourceChange();
          return send(res,200,bytes,'application/octet-stream',{
            'Content-Disposition':'attachment; filename="'+filename+'"','Content-Security-Policy':"sandbox; default-src 'none'"
          });
        }
        const result=resourceChange();
        if(caseOperator&&parts[0]==='rights')return send(res,200,policy.caseOperatorView(result));
        if(caseOperator&&parts[0]==='governance-documents')return send(res,200,policy.caseDocumentView(result));
        return send(res,200,access&&['projects','vendors','assessments','handoff'].includes(parts[0])?policy.operatorState(result,actor):result);
      }
      return send(res,404,{error:'Not found.'});
    } catch (error) {
      if((!error.status&&error.code!=='ENOENT')||error.status>=500)operations.requestError();
      if (!res.headersSent) send(res,error.status||(error.code==='ENOENT'?404:500),{error:error.status?error.message:error.code==='ENOENT'?'Not found.':'Server error.',...(error.status&&error.code?{code:error.code}:{}),...(Array.isArray(error.fileErrors)?{fileErrors:error.fileErrors}:{})},undefined,error.closeConnection?{'Connection':'close'}:undefined);
    } finally {
      if(countedBatch)activeBatchUploads--;
    }
  };
  const server=tls?https.createServer(tls,handler):http.createServer(handler);
  if(database)server.once('close',()=>database.close());
  server.on('listening',operations.listening);
  server.on('close',operations.stopped);
  return server;
}
if (require.main===module) {
  launchLocalServer(()=>{
    const server=createServer({sqliteFile:process.env.TRUST_SQLITE_FILE,operationalEvents:true});
    return {server,onListening:()=>console.log('MVW Trust: http://127.0.0.1:'+server.address().port)};
  });
}
module.exports={createServer};

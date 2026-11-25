'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const {openStore} = require('./store');
const {openWorkflowHttp} = require('./workflow-http');
const {view:workQueue}=require('./work-queue');
const {createAccess}=require('./workspace-access');
const {fixtureOptions}=require('./discovery-import');
const {createPortal}=require('./requester-portal');
const trustCenter=require('./trust-center');
const employee=require('./employee-attestations');
const publicDir = path.join(__dirname,'public');
const staticFiles = new Map([
  ['/',['index.html','text/html; charset=utf-8']],
  ['/index.html',['index.html','text/html; charset=utf-8']],
  ['/trust-center-ui.js',['trust-center-ui.js','text/javascript; charset=utf-8']],
  ['/employee-admin-ui.js',['employee-admin-ui.js','text/javascript; charset=utf-8']],
  ['/workflow-studio-ui.js',['workflow-studio-ui.js','text/javascript; charset=utf-8']],
  ['/app.js',['app.js','text/javascript; charset=utf-8']],
  ['/governance-docs-ui.js',['governance-docs-ui.js','text/javascript; charset=utf-8']],
  ['/work-queue-ui.js',['work-queue-ui.js','text/javascript; charset=utf-8']],
  ['/vendor-monitoring-ui.js',['vendor-monitoring-ui.js','text/javascript; charset=utf-8']],
  ['/risk-controls-ui.js',['risk-controls-ui.js','text/javascript; charset=utf-8']],
  ['/retention-ui.js',['retention-ui.js','text/javascript; charset=utf-8']],
  ['/privacy-notices-ui.js',['privacy-notices-ui.js','text/javascript; charset=utf-8']],
  ['/dictionary-ui.js',['dictionary-ui.js','text/javascript; charset=utf-8']],
  ['/data-map-ui.js',['data-map-ui.js','text/javascript; charset=utf-8']],
  ['/incident-ui.js',['incident-ui.js','text/javascript; charset=utf-8']],
  ['/rights-ui.js',['rights-ui.js','text/javascript; charset=utf-8']],
  ['/modules-ui.js',['modules-ui.js','text/javascript; charset=utf-8']],
  ['/styles.css',['styles.css','text/css; charset=utf-8']],
  ['/style.css',['style.css','text/css; charset=utf-8']]
]);
function send(res,status,value,type='application/json; charset=utf-8',extra={}) {
  res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",...extra});
  res.end(type.startsWith('application/json')?JSON.stringify(value,null,2)+'\n':value);
}
async function readBody(req) {
  let bytes=0;
  const chunks=[];
  for await (const chunk of req) {
    bytes+=chunk.length;
    if (bytes>32768) throw Object.assign(new Error('Request exceeds 32 KiB.'),{status:413});
    chunks.push(chunk);
  }
  try { return bytes?JSON.parse(Buffer.concat(chunks).toString('utf8')):{}; }
  catch { throw Object.assign(new Error('Invalid JSON.'),{status:400}); }
}
function createServer({dataFile=process.env.DATA_FILE || path.join(__dirname,'data','state.json'),isolated}={}) {
  const access=isolated===undefined?null:createAccess(isolated);
  const portal=access&&isolated.requesterGrants!==undefined?createPortal({
    grants:isolated.requesterGrants,workspaces:isolated.workspaces,accounts:isolated.accounts,now:isolated.now
  }):null;
  const centers=access&&isolated.trustCenters!==undefined?trustCenter.provision(isolated.trustCenters,isolated.workspaces):null;
  const staff=access&&isolated.employeeGrants!==undefined?employee.provision({
    grants:isolated.employeeGrants,key:isolated.employeeSigningKey,workspaces:isolated.workspaces,
    accounts:isolated.accounts,requesters:isolated.requesterGrants,now:isolated.now
  }):null;
  const demo=access?null:{store:openStore(dataFile),workflow:openWorkflowHttp(dataFile+'.workflows')};
  const runtimes=new Map();
  function runtime(space){
    if(!space)return demo;
    if(!runtimes.has(space.id))runtimes.set(space.id,{
      store:openStore(space.file,{empty:true}),workflow:openWorkflowHttp(space.workflowFile)
    });
    return runtimes.get(space.id);
  }
  return http.createServer(async (req,res)=>{
    try {
      if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(req.headers.host||'')) return send(res,403,{error:'Only loopback access is allowed.'});
      const {pathname,searchParams}=new URL(req.url,'http://localhost');
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
      if(req.method==='GET'&&['/requester','/requester.js'].includes(pathname)){
        if(!portal)return send(res,404,{error:'Not found.'});
        const [file,type]=pathname==='/requester'?['requester.html','text/html']:['requester.js','text/javascript'];
        return send(res,200,await fs.readFile(path.join(publicDir,file)),type+'; charset=utf-8');
      }
      if (req.method==='GET'&&staticFiles.has(pathname)) {
        const [file,type]=staticFiles.get(pathname);
        return send(res,200,await fs.readFile(path.join(publicDir,file)),type);
      }
      if(req.method==='POST'&&pathname.startsWith('/api/')){
        const origin=req.headers.origin;
        if ((access&&origin!=='http://'+req.headers.host)||
          (origin&&origin!=='http://'+req.headers.host&&origin!=='https://'+req.headers.host))
          return send(res,403,{error:'Cross-origin writes are not allowed.'});
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')) return send(res,415,{error:'Use application/json.'});
      }
      if(req.method==='GET'&&pathname==='/api/session')return send(res,200,access?access.describe(req):{mode:'synthetic-demo'});
      if(pathname.startsWith('/api/session/')){
        const operation=pathname.slice('/api/session/'.length);
        if(!access||req.method!=='POST'||!['login','switch','logout'].includes(operation))return send(res,404,{error:'Not found.'});
        const result=access[operation](req,await readBody(req));
        return send(res,200,result.value,undefined,{'Set-Cookie':result.cookie});
      }
      if(pathname.startsWith('/api/requester/')){
        const operation=pathname.slice('/api/requester/'.length);
        if(!portal||req.method!=='POST'||!['status','intake'].includes(operation))return send(res,404,{error:'Not found.'});
        if(searchParams.size)return send(res,422,{error:'The requester portal does not accept URL parameters.'});
        const body=await readBody(req);
        const grant=portal.allow(operation,body);
        const {store}=runtime(access.spaceForProvisionedGrant(grant.workspace));
        const value=operation==='intake'?store.portalIntake(grant,body.kind):store.portalStatus(grant);
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
      if(!pathname.startsWith('/api/'))return send(res,404,{error:'Not found.'});
      const expected=searchParams.getAll('workspace');
      const selection=access?.context(req,expected);
      const {store,workflow}=runtime(selection?.space);
      const actor=access?selection.actor:req.headers['x-demo-actor'];
      if(access)searchParams.delete('workspace');
      const mode=access?'local-isolated':'synthetic-demo';
      const workflowParts=pathname.startsWith('/api/workflows/')?pathname.slice(15).split('/'):null;
      const employeeEnabled=staff?.enabled(selection?.space.id);
      const assignedStaff=staff?.staff(selection?.space.id)??[];
      if(req.method==='GET'&&pathname==='/api/employee-attestations')
        return send(res,200,employeeEnabled&&['analyst','reviewer'].includes(actor)?store.employeeOperatorView(assignedStaff):{enabled:false});
      const centerPath=centers?.path(selection?.space.id);
      if(req.method==='GET'&&pathname==='/api/trust-center')
        return send(res,200,centerPath&&['analyst','reviewer'].includes(actor)?store.trustCenterView(centerPath):{enabled:false});
      if (req.method==='GET'&&workflowParts) { const r=workflow.get(workflowParts,mode,actor,selection?.account); return send(res,r.status,r.value); }
      if (req.method==='GET'&&['/api/work-queue','/api/work-queue/export'].includes(pathname)){
        const queue=workQueue(store.getState(),searchParams);
        return pathname.endsWith('/export')?send(res,200,{schemaVersion:1,...queue},undefined,
          {'Content-Disposition':'attachment; filename="privacy-workbench-queue.json"'}):send(res,200,queue);
      }
      if (req.method==='GET'&&pathname==='/api/governance-documents') return send(res,200,store.getDocuments(actor));
      if (req.method==='GET'&&pathname==='/api/vendor-monitoring') return send(res,200,store.getVendorMonitoring());
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
      if (req.method==='GET'&&pathname==='/api/data-map/discovery') return send(res,200,{fixtures:fixtureOptions()});
      if (req.method==='GET'&&pathname==='/api/data-map') return send(res,200,store.getDataMap());
      if (req.method==='GET'&&pathname==='/api/data-map/export') return send(res,200,{schemaVersion:1,mode,
        graph:store.getDataMap(),audit:store.getState().audit.filter(e=>e.action.startsWith('data-map.'))},undefined,
        {'Content-Disposition':'attachment; filename="privacy-workbench-data-map.json"'});
      const lineagePath=pathname.match(/^\/api\/data-map\/nodes\/([0-9a-f-]{36})\/lineage$/);
      if (req.method==='GET'&&lineagePath) return send(res,200,store.getLineage(lineagePath[1]));
      if (req.method==='GET'&&pathname==='/api/incidents/cases') return send(res,200,store.getIncidents());
      if (req.method==='GET'&&pathname==='/api/rights/cases') return send(res,200,store.getRights());
      if (req.method==='GET'&&pathname==='/api/modules') return send(res,200,store.getModules());
      if (req.method==='GET'&&pathname==='/api/state') return send(res,200,store.publicState());
      if (req.method==='GET'&&pathname==='/api/audit/export') {
        const audit=store.visibleAudit();
        return send(res,200,{schemaVersion:1,mode,exportedAt:new Date().toISOString(),audit},undefined,{'Content-Disposition':'attachment; filename="privacy-workbench-audit.json"'});
      }
      if (req.method==='POST'&&pathname.startsWith('/api/')) {
        const body=await readBody(req);
        // The session may have expired, been switched, or logged out while the body was arriving.
        access?.context(req,expected);
        if (workflowParts) { const r=workflow.post(workflowParts,actor,body,selection?.account); return send(res,r.status,r.value); }
        if(pathname==='/api/data-map/discovery/preview')return send(res,200,store.previewDiscovery(actor,body,selection?.account));
        const parts=pathname.slice(5).split('/');
        if(pathname==='/api/employee-attestations'){
          if(!employeeEnabled)return send(res,404,{error:'Employee attestations are not provisioned for this workspace.'});
          return send(res,200,store.employeeAssign(assignedStaff,actor,selection.account,body));
        }
        if(parts[0]==='trust-center'){
          if(!centerPath)return send(res,404,{error:'Trust center is not configured for this workspace.'});
          store.change(parts,actor,body,selection?.account);
          return send(res,200,store.trustCenterView(centerPath));
        }
        return send(res,200,store.change(parts,actor,body,selection?.account));
      }
      return send(res,404,{error:'Not found.'});
    } catch (error) {
      if (!error.status && error.code!=='ENOENT') console.error(error);
      if (!res.headersSent) send(res,error.status||(error.code==='ENOENT'?404:500),{error:error.status?error.message:error.code==='ENOENT'?'Not found.':'Server error.',...(error.status&&error.code?{code:error.code}:{})});
    }
  });
}
if (require.main===module) {
  const port=Number(process.env.PORT??4173);
  const server=createServer();
  server.listen(port,'127.0.0.1',()=>console.log('Privacy Workbench: http://127.0.0.1:'+server.address().port));
}
module.exports={createServer};

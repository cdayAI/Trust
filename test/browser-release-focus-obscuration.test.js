'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {mkdtemp,readFile,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join,resolve,relative,isAbsolute}=require('node:path');

const b=(s,name)=>s.getByRole('button',{name,exact:true});
const h=(s,name)=>s.getByRole('heading',{name,exact:true});

async function setup(t){
  const room=await mkdtemp(join(tmpdir(),'mvw-release-focus32-'));
  const child=spawn(process.execPath,[resolve(__dirname,'../start-release.js'),'--port','0'],{
    cwd:room,env:{...process.env,TMPDIR:room,TMP:room,TEMP:room},stdio:['ignore','pipe','pipe']
  });
  const exit=once(child,'exit');
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exit;}
    await rm(room,{recursive:true,force:true,maxRetries:2});
  });
  const announcement=await new Promise((ok,fail)=>{
    let buffer='';
    const timer=setTimeout(()=>fail(Error('Release start deadline.')),20_000);
    exit.then(()=>{clearTimeout(timer);fail(Error('Release exited before starting.'));},fail);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      buffer+=chunk;
      if(buffer.includes('\n')){clearTimeout(timer);ok(buffer.split('\n')[0]);}
    });
    child.stderr.resume();
  });
  const live=JSON.parse(announcement);
  assert.equal(live.status,'ready');
  assert.match(live.url,/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/);
  const rel=relative(room,live.accessFile);
  assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));
  const access=JSON.parse(await readFile(live.accessFile,'utf8'));
  assert.equal(access.mode,'local-synthetic-only');
  const seat=(workspace,role)=>access.staff.find(s=>s.memberships[workspace]===role);

  async function request(path,{workspace='harbor',cookie,body,status=200}={}){
    const endpoint=new URL(path,live.url);
    if(workspace)endpoint.searchParams.set('workspace',workspace);
    const res=await fetch(endpoint,{
      ...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),
      headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{Origin:live.url,'Content-Type':'application/json'})},
      signal:AbortSignal.timeout(7000)
    });
    assert.equal(res.status,status,path);
    const raw=Buffer.from(await res.arrayBuffer());
    return {raw,data:res.headers.get('content-type')?.startsWith('application/json')?JSON.parse(raw):null,
      cookie:res.headers.get('set-cookie')?.split(';')[0]};
  }
  async function login(role,workspace='harbor'){
    const {id:account,code}=seat(workspace,role);
    return (await request('/api/session/login',{body:{account,workspace,code},workspace:null})).cookie;
  }
  return {url:live.url,seat,request,login};
}

test('composed Chromium: reverse Tab does not hide report focus behind the desktop header',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Requires Playwright and Chromium',timeout:35_000
},async t=>{
  const f=await setup(t),{chromium}=require('playwright');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  t.after(()=>browser.close());
  const seat=f.seat('harbor','analyst'),cookie=await f.login('analyst');
  for(let i=0;i<8;i++){
    await f.request('/api/reporting/runs',{cookie,body:{filters:{dataset:'records',group:'workflow'}},status:201});
  }
  const p=await browser.newPage({viewport:{width:1280,height:650},reducedMotion:'reduce'});
  p.setDefaultTimeout(5500);
  const external=[];
  await p.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin===f.url)return route.continue();
    external.push(url.origin);return route.abort();
  });
  await p.goto(f.url);
  await p.getByLabel('Test account',{exact:true}).fill(seat.id);
  await p.getByLabel('Workspace ID',{exact:true}).fill('harbor');
  await p.getByLabel('Local access code',{exact:true}).fill(seat.code);
  await b(p,'Sign in').press('Enter');
  await b(p,'Reporting').press('Enter');
  await h(p,'Operational reporting').waitFor();

  const csv=p.getByRole('link',{name:'Download CSV',exact:true});
  const reset=b(p,'Reset report filters');
  async function geometry(){
    return p.evaluate(()=>{
      const header=document.querySelector('body > .top'),target=document.activeElement;
      const r=target.getBoundingClientRect(),bar=header.getBoundingClientRect();
      const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
      return {target:target.id||target.textContent,scroll:scrollY,top:Math.round(r.top),bottom:Math.round(r.bottom),
        headerBottom:Math.round(bar.bottom),headerSticky:getComputedStyle(header).position==='sticky',
        hit:target.contains(hit),focusVisible:target.matches(':focus-visible')};
    });
  }
  for(const mode of ['glass','solid']){
    if(mode==='solid'){
      const toggle=b(p,'Solid surfaces');
      await toggle.press('Enter');
      assert.equal(await toggle.getAttribute('aria-pressed'),'true');
    }
    // Put native keyboard focus on CSV, reset's next tabbable item. Scroll
    // with the mouse as during reading; CSV must still be fully in view.
    await reset.focus();
    await p.keyboard.press('Tab');
    assert.equal(await csv.evaluate(el=>el===document.activeElement),true);
    const needed=await reset.evaluate(el=>el.getBoundingClientRect().top-14);
    const current=await p.evaluate(()=>window.scrollY);
    await p.mouse.move(1160,490);
    await p.mouse.wheel(0,Math.round(needed));
    await p.waitForFunction(goal=>Math.abs(scrollY-goal)<3,current+Math.round(needed));
    const start=await geometry();
    assert.equal(start.headerSticky,true);
    assert.equal(start.hit,true);
    assert.ok(start.top>start.headerBottom&&start.bottom<650);
    const hidden=await reset.evaluate(el=>{
      const rect=el.getBoundingClientRect(),bar=document.querySelector('body > .top').getBoundingClientRect();
      return rect.top>=0&&rect.bottom<bar.bottom;
    });
    assert.equal(hidden,true,'The sticky header must actually cover reset in the initial scroll position.');
    await p.keyboard.press('Shift+Tab');
    const after=await geometry();
    t.diagnostic(JSON.stringify({mode,start,after}));
    assert.equal(after.target,'report-reset');
    assert.equal(after.focusVisible,true);
    assert.ok(after.top>=after.headerBottom&&after.hit,'Focused Reset report filters is obstructed by the desktop header.');
    await p.keyboard.press('Tab');
    const resumed=await geometry();
    assert.equal(resumed.target,'Download CSV');
    assert.equal(resumed.hit,true);
  }
  assert.deepEqual(external,[]);
});

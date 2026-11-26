'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const fs=require('node:fs/promises');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const http=require('node:http');
const {connect}=require('node:net');
const required=process.env.TRUST_HTTP_TRANSPORT==='rust';
test('native listener serves real application over loopback and refuses public transport markers and direct private access',
  {skip:!required,timeout:30000},async t=>{
    const room=await fs.mkdtemp(join(tmpdir(),'trust-http-'));
    const child=spawn(process.execPath,[join(__dirname,'..','start-release.js')],{
      env:{...process.env,TMPDIR:room,TMP:room,TEMP:room},stdio:['ignore','pipe','pipe']});
    let output='',stderr='';
    child.stdout.setEncoding('utf8').on('data',chunk=>output+=chunk);
    child.stderr.setEncoding('utf8').on('data',chunk=>stderr+=chunk);
    const done=once(child,'close');
    t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await done;await fs.rm(room,{recursive:true,force:true});});
    const launch=await new Promise((resolve,reject)=>{
      const check=()=>{if(output.includes('\n')){try{resolve(JSON.parse(output.split('\n')[0]));}catch(e){reject(e);}}};
      child.stdout.on('data',check);check();
      done.then(()=>reject(Error('Native release did not start: '+stderr)));
    });
    assert.match(launch.url,/^http:\/\/127\.0\.0\.1:\d+$/);
    const live=await fetch(launch.url+'/health/live');assert.equal(live.status,200);
    assert.equal((await fetch(launch.url+'/health/ready')).status,200);
    const anon=await fetch(launch.url+'/api/session');assert.equal((await anon.json()).authenticated,false);
    const spoof=await fetch(launch.url+'/api/session',{headers:{'x-mvw-trust-internal':'a'.repeat(64)}});
    assert.equal(spoof.status,400);
    const socket=join(launch.runDirectory,'http.sock');
    assert.equal((await fs.lstat(socket)).mode&0o777,0o600);
    const refused=await new Promise((resolve,reject)=>{
      const req=http.request({socketPath:socket,path:'/health/live',method:'GET',headers:{Host:'127.0.0.1'}},
        res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
      req.on('error',reject);req.end();
    });
    assert.equal(refused,403);
    const port=Number(new URL(launch.url).port);
    const absolute=await new Promise((resolve,reject)=>{
      const stream=connect(port,'127.0.0.1');let result='';
      stream.setEncoding('utf8').on('data',chunk=>result+=chunk);
      stream.on('error',reject);stream.on('end',()=>resolve(result));
      stream.on('connect',()=>stream.write('GET http://example.invalid/health/live HTTP/1.1\r\nHost: 127.0.0.1:'+port+'\r\nConnection: close\r\n\r\n'));
    });
    assert.match(absolute,/^HTTP\/1\.1 400 /);
    child.kill();
    assert.deepEqual(await done,[0,null]);
    await assert.rejects(fetch(launch.url+'/health/live'));
});

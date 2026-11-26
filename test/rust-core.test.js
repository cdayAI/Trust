'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {join}=require('node:path');
const rust=require('../rust-core');
const samples=require('../fixtures/governance-upload-formats.json');
const {formats}=require('../document-attachment-formats');
const root=join(__dirname,'..');

test('Rust core mode is explicit and required mode never silently falls back',()=>{
  const disabled=spawnSync(process.execPath,['-e',"process.stdout.write(String(require('./rust-core').enabled))"],
    {cwd:root,encoding:'utf8',env:{...process.env,TRUST_RUST_CORE:'off'}});
  assert.equal(disabled.status,0,disabled.stderr);
  assert.equal(disabled.stdout,'false');
  if(process.env.TRUST_RUST_CORE==='required')assert.equal(rust.enabled,true);
});

test('Rust raster checks agree with the JS reference across samples and bounded corruptions',{skip:!rust.enabled},()=>{
  const kinds={png:1,jpeg:2,gif:3,webp:4,bmp:5,tiff:6};
  const vectors=[];
  for(const [name,encoded] of Object.entries(samples)){
    const ext=name.split('.').at(-1);
    if(!Object.hasOwn(kinds,ext))continue;
    const bytes=Buffer.from(encoded,'base64');
    const push=b=>vectors.push({extension:'.'+ext,bytes:b.toString('base64')});
    push(bytes);
    for(const len of new Set([0,1,8,13,32,Math.floor(bytes.length/2),bytes.length-1]))
      if(len>=0&&len<bytes.length)push(bytes.subarray(0,len));
    for(let i=0;i<Math.min(bytes.length,48);i++){
      const copy=Buffer.from(bytes);copy[i]^=0xff;push(copy);
    }
  }
  assert.ok(vectors.length>100);
  const run=String.raw`const fs=require('node:fs'); const {formats}=require('./document-attachment-formats');
const vectors=JSON.parse(fs.readFileSync(0,'utf8'));
process.stdout.write(JSON.stringify(vectors.map(v=>{try{formats.get(v.extension).check(Buffer.from(v.bytes,'base64'));return true;}
catch(error){return {status:error.status??null,code:error.code??null,message:error.message};}})));`;
  const reference=spawnSync(process.execPath,['-e',run],{cwd:root,input:JSON.stringify(vectors),encoding:'utf8',
    env:{...process.env,TRUST_RUST_CORE:'off'},maxBuffer:4*1024*1024});
  assert.equal(reference.status,0,reference.stderr);
  const expected=JSON.parse(reference.stdout);
  const observed=vectors.map(v=>{
    try{formats.get(v.extension).check(Buffer.from(v.bytes,'base64'));return true;}
    catch(error){return {status:error.status??null,code:error.code??null,message:error.message};}
  });
  for(let i=0;i<vectors.length;i++)assert.deepEqual(observed[i],expected[i],vectors[i].extension+' vector '+i);
});

test('Rust graph traversal preserves breadth-first order and detects cycles, including parallel edges',{skip:!rust.enabled},()=>{
  let seed=123456789;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  for(let round=0;round<100;round++){
    const nodes=Array.from({length:1+random()%30},(_,i)=>'n'+i);
    const edges=[],adj=new Map(nodes.map(n=>[n,new Set()]));
    for(let i=0;i<80;i++){
      const from=nodes[random()%nodes.length],to=nodes[random()%nodes.length];
      if(round%2===0&&Number(from.slice(1))>=Number(to.slice(1)))continue;
      edges.push([from,to]);adj.get(from).add(to);
    }
    const seen=new Set([nodes[0]]),work=[nodes[0]];
    for(let i=0;i<work.length;i++)for(const next of adj.get(work[i]))
      if(!seen.has(next)){seen.add(next);work.push(next);}
    assert.deepEqual(rust.trace(nodes[0],adj),work.slice(1));
    const visiting=new Set(),done=new Set();
    const acyclic=node=>{
      if(visiting.has(node))return false;
      if(done.has(node))return true;
      visiting.add(node);
      if(![...adj.get(node)].every(acyclic))return false;
      visiting.delete(node);done.add(node);return true;
    };
    assert.equal(rust.acyclic(nodes,edges),nodes.every(acyclic));
  }
  assert.equal(rust.acyclic([],[]),true);
  assert.throws(()=>rust.acyclic(['a'],[['a','b']]),/Unresolved graph endpoint/);
});

test('Rust business calendars agree with the UTC reference across year and leap boundaries',{skip:!rust.enabled},()=>{
  const starts=['1900-02-27','1969-12-26','1999-12-31','2000-02-28','2024-02-29','2026-12-24','2100-02-28'];
  const closed=['2000-02-29','2026-12-25','2026-12-28','2027-01-01'];
  for(const start of starts)for(const count of [0,1,2,5,30,90,365])for(const basis of ['calendar','business']){
    const d=new Date(start+'T00:00:00Z');
    for(let n=0;n<count;){
      d.setUTCDate(d.getUTCDate()+1);
      if(basis==='calendar'||(![0,6].includes(d.getUTCDay())&&!closed.includes(d.toISOString().slice(0,10))))n++;
    }
    assert.equal(rust.addDays(start,count,basis,closed),d.toISOString().slice(0,10));
  }
});


test('Rust archive layout accepts the same Office/OpenDocument fixtures and refuses corrupt layouts',{skip:!rust.enabled},()=>{
  const vectors=[];
  for(const [name,encoded] of Object.entries(samples)){
    const ext=name.split('.').at(-1);
    if(!['docx','xlsx','pptx','odt','ods','odp'].includes(ext))continue;
    const data=Buffer.from(encoded,'base64');
    const push=(bytes,valid=false)=>vectors.push({extension:'.'+ext,bytes:bytes.toString('base64'),valid});
    push(data,true);
    for(const len of [1,29,data.length-1])push(data.subarray(0,len));
    const central=data.readUInt32LE(data.length-6);
    for(const index of [...Array.from({length:24},(_,i)=>i),...Array.from({length:46},(_,i)=>central+i),
      ...Array.from({length:22},(_,i)=>data.length-22+i)]){
      if(index>=0&&index<data.length){
        const copy=Buffer.from(data);copy[index]^=0xff;push(copy);
      }
    }
  }
  assert.ok(vectors.length>300);
  const run="const fs=require('node:fs');const {formats}=require('./document-attachment-formats');const rows=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(rows.map(v=>{try{formats.get(v.extension).check(Buffer.from(v.bytes,'base64'));return true;}catch{return false;}})));";
  const reference=spawnSync(process.execPath,['-e',run],{cwd:root,input:JSON.stringify(vectors),encoding:'utf8',
    env:{...process.env,TRUST_RUST_CORE:'off'},maxBuffer:4*1024*1024});
  assert.equal(reference.status,0,reference.stderr);
  const expected=JSON.parse(reference.stdout);
  for(const [i,v] of vectors.entries()){
    let accepted=true;
    try{formats.get(v.extension).check(Buffer.from(v.bytes,'base64'));}
    catch(error){accepted=false;assert.equal(error.status,415,v.extension+' vector '+i);}
    if(v.valid)assert.equal(accepted,true,v.extension+' fixture');
    assert.equal(accepted,expected[i],v.extension+' vector '+i);
  }
});

test('Rust binary batch framing preserves offsets and rejection ordering',{skip:!rust.enabled},()=>{
  const {decode,maxBytes,requestLimit}=require('../attachment-binary-batch');
  const frame=(files,payload)=>{
    const manifest=Buffer.from(JSON.stringify({version:1,expectedRevision:7,files}));
    const header=Buffer.alloc(4);header.writeUInt32BE(manifest.length);
    return Buffer.concat([header,manifest,payload]);
  };
  const row=(filename,size)=>({filename,mediaType:'text/plain',size});
  const good=frame([row('a.txt',1),row('b.txt',3)],Buffer.from('abcd'));
  const parsed=decode(good);
  assert.equal(parsed.expectedRevision,7);
  assert.deepEqual(parsed.files.map(x=>[x.filename,x.data.toString()]),[['a.txt','a'],['b.txt','bcd']]);
  for(const bad of [good.subarray(0,good.length-1),Buffer.concat([good,Buffer.from('x')]),
    frame([row('a.txt',-1)],Buffer.alloc(0)),frame([row('a.txt',maxBytes+1)],Buffer.alloc(0)),Buffer.alloc(4)]){
    assert.throws(()=>decode(bad),{status:422,code:'ATTACHMENT_BATCH_FRAME'});
  }
  assert.throws(()=>decode(Buffer.alloc(requestLimit+1)),{status:413,code:'ATTACHMENT_BATCH_TOO_LARGE'});
});


test('Rust domain decisions preserve scores, review independence and session parsing',{skip:!rust.enabled},()=>{
  for(let l=1;l<=5;l++)for(let i=1;i<=5;i++){
    const value=l*i;
    assert.deepEqual(rust.riskScore(0,l,i),{value,tier:value>=20?'critical':value>=12?'high':value>=6?'moderate':'low'});
    for(const extras of [0,2,4]){
      const score=value+extras;
      assert.deepEqual(rust.riskScore(1,l,i,extras),{value:score,tier:score>=22?'critical':score>=14?'high':score>=7?'moderate':'low'});
    }
  }
  for(const archivedAt of [null,'at'])for(const reviewedBy of [null,'reviewer'])
    for(const t of [null,...['pass','fail'].flatMap(outcome=>['pending','accepted','rejected'].map(reviewStatus=>({outcome,reviewStatus})))]){
      const link={archivedAt,reviewedBy};
      const expected=archivedAt?'unlinked':!reviewedBy?'link-awaiting-review':!t?'untested':t.outcome==='fail'?'latest-test-failed':
        t.reviewStatus==='accepted'?'verified-pass':t.reviewStatus==='rejected'?'review-rejected':'awaiting-independent-review';
      assert.equal(rust.linkReason(link,t),expected);
    }
  const instance={createdBy:'alice',contributors:['bob']};
  for(const actor of [null,{id:'alice',role:'reviewer'},{id:'carol',legacyId:'bob',role:'reviewer'},{id:'carol',role:'reviewer'},{id:'dan',role:'initiator'}])
    for(const independent of [false,true]){
      const transition={roles:['reviewer'],independent};
      const expected=!actor||actor.role!=='reviewer'?1:independent&&[actor.id,actor.legacyId].some(id=>id===instance.createdBy||instance.contributors.includes(id))?2:0;
      assert.equal(rust.workflowPermission(transition,actor,instance),expected);
    }
  const token='a'.repeat(43),name='trust_local_session';
  for(const header of ['',name+'='+token,' x=2; \uFEFF'+name+'='+token+' ; z=3',name+'='+token+'; '+name+'='+token,name+'=bad',name+'='+token+'x',name+' ='+token]){
    const values=header.split(';').map(x=>x.trim()).filter(x=>x.startsWith(name+'='));
    const expected=values.length===1&&/^[A-Za-z0-9_-]{43}$/.test(values[0].slice(name.length+1))?values[0].slice(name.length+1):null;
    assert.equal(rust.sessionToken(name,header),expected);
  }
  for(const disabled of [false,true])for(const validUntil of [null,0,10,100])
    assert.equal(rust.accountLive({disabled,validUntil},10),!disabled&&(validUntil===null||10<validUntil));
});

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

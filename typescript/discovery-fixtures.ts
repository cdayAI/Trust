'use strict';

// Original schema-only examples. None contain sample rows, connectors, paths, or URLs.
type Field={id:string;type:'text'|'integer'|'timestamp'|'boolean'};
interface Fixture {source:string;version:number;system:{id:string;name:string;owner:string};datasets:{id:string;name:string;fields:Field[]}[]}
const alpha=(version:number,fields:Field[]):Fixture=>({
  source:'sample-library',version,system:{id:'reader-stack',name:'Fictional Reading Desk',owner:'Library operations'},
  datasets:[
    {id:'reading-queue',name:'Fictional Reading Queue',fields},
    {id:'genre-rollup',name:'Fictional Genre Rollup',fields:[{id:'genre',type:'text'},{id:'volume',type:'integer'}]},
  ]
});
const v1Fields:Field[]=[{id:'reader_alias',type:'text'},{id:'queued_at',type:'timestamp'}];
const fixtures:Record<string,Fixture>={
  'sample-library:1':alpha(1,v1Fields),
  'sample-library:2':alpha(2,[...v1Fields,{id:'loan_reference',type:'text'}]),
  'sample-garden:1':{
    source:'sample-garden',version:1,system:{id:'garden-stack',name:'Fictional Seed Library',owner:'Garden operations'},
    datasets:[{id:'seed-index',name:'Fictional Seed Index',fields:[{id:'species',type:'text'},{id:'available',type:'boolean'}]}]
  }
};
function fixtureOptions(){return Object.values(fixtures).map(x=>({source:x.source,version:x.version,label:x.system.name}));}
function getFixture(source:string,version:number):Fixture|null{
  const key=source+':'+version;
  return Object.hasOwn(fixtures,key)?structuredClone(fixtures[key]):null;
}
export = {fixtureOptions,getFixture};

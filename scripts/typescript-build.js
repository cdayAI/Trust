'use strict';
const fs=require('node:fs');
const path=require('node:path');
const ts=require('./type-tools/node_modules/typescript');
const root=path.resolve(__dirname,'..');
const configFile=path.join(root,'typescript','tsconfig.json');
const config=ts.readConfigFile(configFile,ts.sys.readFile);
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,path.dirname(configFile));
const diagnostics=[...(config.error?[config.error]:[]),...parsed.errors];
const program=ts.createProgram(parsed.fileNames,parsed.options);
diagnostics.push(...ts.getPreEmitDiagnostics(program));
const outputs=new Map();
const emit=program.emit(undefined,(file,content)=>{
  const relative=path.relative(parsed.options.outDir,file).split(path.sep).join('/');
  if(relative.endsWith('.js'))outputs.set(relative,content.replace(/\r\n/g,'\n'));
});
diagnostics.push(...emit.diagnostics);
const host={getCanonicalFileName:f=>f,getCurrentDirectory:()=>root,getNewLine:()=>'\n'};
if(diagnostics.length||emit.emitSkipped){
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics,host));
  process.exitCode=1;
}else{
  const expected=JSON.parse(fs.readFileSync(path.join(root,'typescript','manifest.json'),'utf8'));
  if(JSON.stringify([...outputs.keys()].sort())!==JSON.stringify(expected))throw Error('TypeScript output inventory mismatch.');
  const mode=process.argv[2]??'verify';
  if(!['verify','generate','report','check'].includes(mode))throw Error('Unknown TypeScript build mode.');
  for(const relative of expected){
    if(!/^(?:public\/|scripts\/)?[a-z0-9-]+\.js$/.test(relative))throw Error('Unsafe generated JavaScript destination.');
    const output=outputs.get(relative);
    const destination=path.join(root,relative);
    if(mode==='generate'||mode==='report')fs.writeFileSync(destination,output);
    if(mode==='verify'&&fs.readFileSync(destination,'utf8').replace(/\r\n/g,'\n')!==output)throw Error('Stale generated JavaScript: '+relative);
    if(mode==='report'){
      for(const line of output.split('\n'))console.log('TRUST_TS|'+relative+'|'+JSON.stringify(line));
    }
  }
  console.log('Strict TypeScript: '+expected.length+' runtime modules verified ('+mode+').');
}

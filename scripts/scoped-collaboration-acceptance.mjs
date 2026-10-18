import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const args=process.argv.slice(2);if(args.some(arg=>arg!=='--core-only'))throw new Error('用法：scoped:acceptance [--core-only]');
const coreOnly=args.includes('--core-only');
const output=path.resolve('apps/server/data/scoped-acceptance',new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(output,{recursive:true,mode:0o700});
const nativeChecks=['verify:scoped-native','verify:scoped-native-files','verify:scoped-native-codex-protocol'];
const scripts=['typecheck','verify:autonomous-ac1','verify:autonomous-ac2','verify:autonomous-ac3','verify:autonomous-ac4','verify:autonomous-ac5','verify:scoped-collaboration-baseline','verify:scoped-collaboration','verify:scoped-delivery','verify:information-release','verify:scoped-recovery',...(!coreOnly?nativeChecks:[]),'verify:message-visibility','verify:private-interaction','verify:runtime-action-commands','verify:stage-scheduling','verify:scoped-g6','verify:scoped-g6-operations',...(!coreOnly?['verify:scoped-delivery-ui','verify:information-release-ui','verify:autonomous-ac3-ui','verify:autonomous-ac4-ui','verify:autonomous-ac5-ui']:[]),'verify:docs'];
const results=[];
for(const name of scripts){
  const started=performance.now();let log='';
  const result=await new Promise(resolve=>{
    const child=spawn('pnpm',['run',name],{env:{...process.env,SCOPED_COLLABORATION_MODE:'execute'},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',data=>{log+=data;});child.stderr.on('data',data=>{log+=data;});
    child.once('error',()=>resolve({exitCode:1}));child.once('exit',(code,signal)=>resolve({exitCode:code??1,signal}));
  });
  const logFile=name.replaceAll(':','-')+'.log';await writeFile(path.join(output,logFile),log,{mode:0o600});
  results.push({name,...result,durationMs:Math.round(performance.now()-started),logFile});
  console.log(`${result.exitCode===0?'PASS':'FAIL'} ${name}`);
}
const report={completeUiMatrix:!coreOnly,completeNativeMatrix:!coreOnly,skipped:coreOnly?[...nativeChecks,'verify:scoped-delivery-ui','verify:information-release-ui','verify:autonomous-ac3-ui','verify:autonomous-ac4-ui','verify:autonomous-ac5-ui']:[],passed:results.every(r=>r.exitCode===0),results};
await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({passed:report.passed,completeUiMatrix:report.completeUiMatrix,evidence:output}));
if(!report.passed)process.exitCode=1;

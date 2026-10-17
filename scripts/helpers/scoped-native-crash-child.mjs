import {readFile} from 'node:fs/promises';
import path from 'node:path';
const data=JSON.parse(await readFile(process.argv[2],'utf8'));
if(process.env.AGENT_GAND_ISOLATED_WORKER!=='1'||process.env.DB_PATH!==path.join(data.root,'test.sqlite'))throw new Error('ISOLATED_NATIVE_CRASH_REQUIRED');
const {config}=await import('../../apps/server/src/config.ts');config.dataDir=data.root;config.sandboxDir=path.join(data.root,'sandbox');config.externalAgents.codexCommand=data.codexCommand;
const {runScopedNativeTurn}=await import('../../apps/server/src/collaboration/scopedNativeTurn.ts');
const {parseScopedControlCall,scopedControlTool}=await import('../../apps/server/src/collaboration/scopedRunner.ts');
const {assembleScopedContext}=await import('../../apps/server/src/runtime/scopedCollaboration.ts');
const {startSpan}=await import('../../apps/server/src/runs/trace.ts');
try{
  const result=await runScopedNativeTurn({binding:data.binding,agent:data.agent,context:assembleScopedContext(data.binding),parentSpanId:startSpan(data.binding.runId,{spanKind:'agent',name:'g5-native-crash'}).id,tool:scopedControlTool(data.expected),parse:call=>parseScopedControlCall(call,data.expected),signal:AbortSignal.timeout(30000)});
  process.send?.({type:'candidate',result});
  // Parent kills the owning worker after a real native terminal, before a domain commit.
  await new Promise(()=>{});
}catch(error){process.send?.({type:'error',message:error.message});process.exit(1);}

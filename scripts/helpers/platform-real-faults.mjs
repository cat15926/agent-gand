import {createRequire}from'node:module';
import {existsSync,readFileSync,unlinkSync,writeFileSync}from'node:fs';
import {execFileSync}from'node:child_process';
import path from'node:path';

/** Test-host-only failures. Inference, tools, authentication and evidence use product implementations. */
export function installRealFaults({root,db,getTool,allowLoopback=false}){
  const require=createRequire(new URL('../../apps/server/package.json',import.meta.url)),{Dispatcher,getGlobalDispatcher,setGlobalDispatcher}=require('undici');
  const original=getGlobalDispatcher(),arm=path.join(root,'upstream-fault.json'),resultPath=path.join(root,'upstream-fault-result.json'),write=getTool('fs.write'),ordinary=write.run;
  write.run=async(input,context)=>{const result=await ordinary(input,context);
    if(existsSync(arm)){const fault=JSON.parse(readFileSync(arm,'utf8'));if(fault.type==='native_after_write'&&context.agentId===fault.agentId&&input.path===fault.afterFile){
      const owned=db.prepare("SELECT p.pid,p.token FROM external_native_processes p JOIN external_agent_executions e ON e.id=p.execution_id WHERE e.run_id=? AND e.agent_id=? AND p.status='active' ORDER BY p.created_at DESC LIMIT 1").get(context.runId,context.agentId);
      if(!owned||owned.pid<=1)throw new Error('R8_NATIVE_FAULT_OWNERSHIP_UNVERIFIED');
      const command=execFileSync('ps',['-p',String(owned.pid),'-o','command='],{encoding:'utf8',timeout:1000});
      if(!command.includes('/execution/guardian.mjs')||!command.includes(owned.token))throw new Error('R8_NATIVE_FAULT_OWNERSHIP_UNVERIFIED');
      unlinkSync(arm);writeFileSync(resultPath,JSON.stringify({runId:context.runId,kind:'native_process_group_terminated_after_write',afterFile:fault.afterFile,at:new Date().toISOString()}),{mode:0o600});process.kill(-owned.pid,'SIGKILL');
    }}return result;
  };
  const injected=new class extends Dispatcher{
    dispatch(options,handler){
      const target=new URL(String(options.origin)),active=db.prepare("SELECT id,run_id,agent_id FROM orchestration_model_calls WHERE status='started' ORDER BY started_at DESC LIMIT 1").get();
      if(existsSync(arm)&&active&&(allowLoopback||!['127.0.0.1','localhost','::1'].includes(target.hostname))&&/\/(messages|responses)$/.test(String(options.path).split('?')[0])){
        const fault=JSON.parse(readFileSync(arm,'utf8'));
        if(!fault.type&&active.agent_id===fault.agentId){
          unlinkSync(arm);let abort,stopped=false;
          const wrapped=new Proxy(handler,{get(target,key){const value=target[key];if(typeof value!=='function')return value;return(...args)=>{
            if(stopped)return false;
            if(key==='onConnect')abort=args[0];if(key==='onRequestStart')abort=error=>args[0].abort(error);
            if(key==='onHeaders'||key==='onResponseStart'){
              stopped=true;const error=new Error('R8_CONTROLLED_UPSTREAM_RESPONSE_LOSS');
              writeFileSync(resultPath,JSON.stringify({runId:active.run_id,receivedUpstreamHeaders:true,httpStatus:key==='onHeaders'?args[0]:args[1],at:new Date().toISOString()}),{mode:0o600});
              if(key==='onResponseStart')target.onResponseError(args[0],error);else target.onError(error);
              abort?.(error);return false;
            }return value.apply(target,args);
          };}});
          return original.dispatch(options,wrapped);
        }
      }return original.dispatch(options,handler);
    }
    close(...args){return original.close(...args);}destroy(...args){return original.destroy(...args);}
  };
  setGlobalDispatcher(injected);
  return ()=>{setGlobalDispatcher(original);write.run=ordinary;};
}

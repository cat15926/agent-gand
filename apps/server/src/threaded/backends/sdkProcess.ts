import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { withRpcProcess } from '../../execution/rpc.ts';
import type { BackendSdkProcess } from './types.ts';
import { sdkPermission } from '../../execution/policy.ts';

/** Raw worker protocol preserves SDK UUID/checkpoint facts; it never touches legacy Run state. */
export const invokeThreadedSdkProcess:BackendSdkProcess=async input=>{
  await withRpcProcess({command:process.execPath,args:['--import',import.meta.resolve('tsx'),
    fileURLToPath(new URL('./sdkWorker.ts',import.meta.url))],cwd:input.cwd,signal:input.signal,
    timeoutMs:input.timeoutMs,env:input.environment,onProcess:input.onProcess,onProcessStopped:input.onProcessStopped},async peer=>{
    let resolve!:()=>void,reject!:(error:Error)=>void;
    const done=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});void done.catch(()=>{});
    peer.onInterrupt(()=>peer.send({method:'sdk/interrupt',params:{}}));
    peer.onMessage(async message=>{
      if(message.method==='sdk/message'||message.method==='sdk/checkpoint') {
        const record=message.method==='sdk/checkpoint'?{type:'threaded_checkpoint',...message.params}:message.params?.message;
        if(!record||typeof record!=='object'||Array.isArray(record))throw new Error('THREADED_SDK_RECORD_INVALID');
        input.onRecord(record);
      } else if(message.method==='sdk/done')resolve();
      else if(message.method==='sdk/error'||message.method==='sdk/resumeUnavailable')reject(new Error('THREADED_SDK_WORKER_FAILED'));
      else if(message.method==='sdk/permission'&&message.id!==undefined) {
        const p=message.params??{};
        input.onRecord({type:'threaded_tool_gate',tool:p.tool,input:p.input});
        const application=input.tools?.some(t=>p.tool===`mcp__threaded__${t.name}`)??false;
        const allowed=application||['Read','Grep','Glob'].includes(p.tool)&&sdkPermission({permissionMode:'readonly',
          execution:{kind:'external',driver:'claude-sdk'}},input.cwd,p.tool,p.input)==='allow';
        peer.send({id:message.id,result:{allow:allowed}});
      } else if(message.method==='sdk/applicationTool'&&message.id!==undefined) {
        const p=message.params??{};
        input.onRecord({type:'threaded_tool_gate',tool:`mcp__threaded__${p.name}`,input:p.input});
        if(typeof p.name!=='string'||!input.tools?.some(t=>t.name===p.name)||!input.executeTool)throw new Error('THREADED_SDK_TOOL_NOT_ALLOWED');
        const result=await input.executeTool(p.name,p.input,String(message.id));
        peer.send({id:message.id,result:{text:result}});
      } else if(message.method==='sdk/nativeToolCompleted') {
        const p=message.params??{};
        if(!['Read','Grep','Glob'].includes(p.tool)||typeof p.toolUseId!=='string')throw new Error('THREADED_SDK_TOOL_FACT_INVALID');
        input.onRecord({type:'threaded_native_tool_completed',tool:p.tool,toolUseId:p.toolUseId});
      } else throw new Error('THREADED_SDK_PROTOCOL_UNSUPPORTED');
    });
    peer.send({method:'sdk/start',params:{cwd:input.cwd,model:input.model,instructions:input.instructions,
      prompt:input.prompt,permissionMode:'readonly',nativeTools:[],session:{id:input.nativeId,resume:input.resume,
        configDir:input.configDir,projectDir:input.projectDir??''},autonomousTurn:{maxOutputTokens:input.maxOutputTokens},applicationTools:input.tools??[]}});
    await done;
  });
};
/** A failed process inspection is unknown, never an exit proof. */
export function threadedProcessGroupStopped(pid:number):boolean {
  if(!Number.isSafeInteger(pid)||pid<=1)return false;
  try {
    return !execFileSync('ps',['-axo','pgid=,stat='],{encoding:'utf8',timeout:1000}).split('\n').some(line=>{
      const [group,status]=line.trim().split(/\s+/);
      return Number(group)===pid&&!!status&&!status.startsWith('Z');
    });
  } catch{return false;}
}

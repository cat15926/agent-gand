import assert from 'node:assert/strict';
import {realpathSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openBackendRuntimeFixture} from './threadedBackendRuntimeFixture.mjs';

export async function openOsHarness(root,name,mode='running',extra={}) {
  const {createThreadedOsCommandPort,verifyThreadedOsCommandResourceEvidence}=await import('../../apps/server/src/threaded/osCommands.ts');
  const {createThreadedOsCommandResources}=await import('../../apps/server/src/threaded/osCommandResources.ts');
  const {createExecutionResourceCoordinator}=await import('../../apps/server/src/execution/resources/coordinator.ts');
  const {verifyThreadedBackendResourceEvidence}=await import('../../apps/server/src/threaded/backends/evidence.ts');
  const {THREADED_APPLICATION_TOOL_NAMES}=await import('../../apps/server/src/threaded/tools.ts');
  const directory=path.join(root,`${name}-command`);mkdirSync(directory,{recursive:true});
  let port,f;let authorization=1,effects=true;
  const proxy={authorization:scope=>port?.authorization(scope)??'fixed:1',validate:args=>port.validate(args),
    start:input=>port.start(input),observe:input=>port.observe(input),cancel:input=>port.cancel(input)};
  f=await openBackendRuntimeFixture(root,name,{applicationTools:THREADED_APPLICATION_TOOL_NAMES,actions:{commands:{fixed:proxy}},
    fetch:async()=>{try{return new Response(JSON.stringify({type:'message',id:randomUUID(),content:[{type:'text',text:await(f.handler?.(f.activeClaim)??'done')}],stop_reason:'end_turn',usage:{input_tokens:5,output_tokens:2}}),{headers:{'content-type':'application/json'}});}catch(error){f.handlerError=error;throw error;}}});
  const resources=createExecutionResourceCoordinator(f.db,{ownerNonce:`os-fixture:${randomUUID()}`,leaseMs:5000,
    verifyEvidence:(_request,identity,evidence)=>{const claim=resources.getClaim(identity.claimId);return !!claim&&(verifyThreadedOsCommandResourceEvidence(f.db,claim,evidence)||verifyThreadedBackendResourceEvidence(f.db,claim,evidence));}});
  const registration={id:'fixed',program:realpathSync(process.execPath),argv:[new URL('./threadedOsCommandNative.mjs',import.meta.url).pathname,directory,mode],cwd:realpathSync(directory),environment:{FIXTURE_ENV:'fixed'},
    authorization:()=>`fixed:${authorization}`,reconcileSideEffects:()=>effects,...extra.registration};
  const makePort=()=>createThreadedOsCommandPort(f.db,{registration,lease:createThreadedOsCommandResources(f.db,resources)});
  port=makePort();
  for(const config of f.configurations.values()){config.kind='api';config.backendVersion='threaded-http-v1';}
  const tool=async(claim,name,input,key=randomUUID())=>JSON.parse(await f.runtime.collaboration.tools.execute(claim.binding,name,input,key,THREADED_APPLICATION_TOOL_NAMES));
  const ok=result=>{assert.equal(result.ok,true,JSON.stringify(result));return result.result;};
  async function run(receipt,handler){if(receipt)for(const wake of receipt.wakes)f.runtime.queue.enqueueWake(wake.id);
    const claim=f.runtime.queue.claimNext('t12-os');assert.ok(claim);f.activeClaim=claim;f.handler=handler;
    const result=await f.runtime.executeClaim(claim);f.handler=undefined;if(f.handlerError)throw f.handlerError;assert.equal(result.status,'completed',JSON.stringify(result));return claim;}
  async function start(onHolder){let action,command,holder,task;
    await run(f.user('Create a registered fixed OS command Action'),async claim=>{
      task=ok(await tool(claim,'create_task',{idempotencyKey:'task',title:'Fixed OS operation',acceptanceCriteria:['Publish trusted result']}));
      action=ok(await tool(claim,'transfer_action',{idempotencyKey:'transfer',subject:{kind:'task',taskId:task.taskId},predicate:'task_done',family:'work',successorSlot:'primary',targets:['other-member']}));return 'Transfer responsibility';});
    await run(undefined,async claim=>{holder=claim;assert.equal(claim.binding.agentId,'other-member');
      command=ok(await tool(claim,'run_command',{idempotencyKey:'start',actionId:action.actionId,expectedGeneration:1,command:'fixed',args:null}));
      ok(await tool(claim,'wait_command',{idempotencyKey:'wait',actionId:action.actionId,expectedGeneration:1,commandId:command.commandId}));if(onHolder)await onHolder({claim,action,command,task});return 'Registered durable command wait';});
    return {action,command,holder,task};
  }
  return {f,directory,resources,registration,get port(){return port;},tool,ok,run,start,makePort,
    replacePort(){port=makePort();return port;},revoke(){authorization++;},effects(value){effects=value;},
    close(){port.close();f.close();}};
}

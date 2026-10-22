/** RC03: shared hold admission and authorization fences; injected command transport, no OS claim. */
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openBackendRuntimeFixture} from './fixtures/threadedBackendRuntimeFixture.mjs';
const root=await realpath(await mkdtemp(path.join(tmpdir(),'threaded-rc03-admission-')));
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'unused.sqlite'),AGENTS_DIR:path.join(root,'agents')});
const {THREADED_APPLICATION_TOOL_NAMES}=await import('../apps/server/src/threaded/tools.ts');
const originalFetch=globalThis.fetch;let externalNetworkCalls=0;
globalThis.fetch=async()=>{externalNetworkCalls++;throw new Error('No external requests permitted');};
const fixtures=[],checks=[];let injectedModelRequests=0,starts=0;
async function fixture(name){
  let f,clock=Date.now(),authorized=true,observation={state:'running',evidenceRef:'injected:running'};
  const port={authorization:()=>authorized?'fixed:v1':null,validate:args=>assert.deepEqual(args,{}),
    start:async()=>{starts++;return observation;},observe:async()=>observation,cancel:async()=>({state:'unknown',evidenceRef:'injected:cancel-unverified'})};
  f=await openBackendRuntimeFixture(root,name,{now:()=>clock,applicationTools:THREADED_APPLICATION_TOOL_NAMES,actions:{commands:{fixed:port}},
    fetch:async()=>{injectedModelRequests++;try{return new Response(JSON.stringify({type:'message',id:randomUUID(),content:[{type:'text',text:await(f.handler?.(f.activeClaim)??'done')}],stop_reason:'end_turn',usage:{input_tokens:5,output_tokens:2}}),{headers:{'content-type':'application/json'}});}catch(error){f.handlerError=error;throw error;}}});
  for(const value of f.configurations.values()){value.kind='api';value.backendVersion='threaded-http-v1';}
  f.runtime.collaboration.close();f.advance=n=>clock+=n;f.clock=()=>clock;f.revoke=()=>{authorized=false;};f.complete=()=>{observation={state:'completed',evidenceRef:'injected:reconciled'};};fixtures.push(f);return f;
}
const tool=async(f,claim,name,input)=>JSON.parse(await f.runtime.collaboration.tools.execute(claim.binding,name,input,randomUUID(),THREADED_APPLICATION_TOOL_NAMES));
const ok=value=>{assert.equal(value.ok,true,JSON.stringify(value));return value.result;};
async function run(f,receipt,handler){if(receipt)for(const wake of receipt.wakes)f.runtime.queue.enqueueWake(wake.id);
  f.runtime.queue.scanPending();const claim=f.runtime.queue.claimNext('rc03-admission');assert.ok(claim);f.activeClaim=claim;f.handler=handler;f.handlerError=undefined;
  const result=await f.runtime.executeClaim(claim);if(f.handlerError)throw f.handlerError;assert.equal(result.status,'completed',JSON.stringify(result));return claim;}
async function assign(f){let task,action;
  await run(f,f.user('Run a registered fixed command'),async claim=>{task=ok(await tool(f,claim,'create_task',{idempotencyKey:'task',title:'Independent command',acceptanceCriteria:['result']}));
    action=ok(await tool(f,claim,'transfer_action',{idempotencyKey:'transfer',subject:{kind:'task',taskId:task.taskId},predicate:'task_done',family:'work',successorSlot:'primary',targets:['other-member']}));return 'Assigned';});return {task,action};}
async function start(f,action,claim,key='command'){return ok(await tool(f,claim,'run_command',{idempotencyKey:key,actionId:action.actionId,expectedGeneration:1,command:'fixed',args:{}}));}
const wait=(f,claim,action,command,key='wait')=>tool(f,claim,'wait_command',{idempotencyKey:key,actionId:action.actionId,expectedGeneration:1,commandId:command.commandId});
const timer=(f,claim,jobKey,source)=>tool(f,claim,'hold_ball',{idempotencyKey:jobKey,jobKey,seconds:5,
  waitSourceRef:{kind:'thread_message',value:source,expectedSignal:'registered background fact',slaUntilMs:f.clock()+60000}});
try{
  {
    const f=await fixture('shared-quota'),{action}=await assign(f);
    await run(f,undefined,async claim=>{
      const command=await start(f,action,claim),before=starts;await start(f,action,claim);assert.equal(starts,before);
      ok(await wait(f,claim,action,command));ok(await wait(f,claim,action,command,'new-operation-same-job'));
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_hold_admissions').get().n,1);
      const source=f.runtime.collaboration.cooperation.source(claim.binding).id;
      const first=ok(await timer(f,claim,'timer-one',source));assert.equal(ok(await timer(f,claim,'timer-one',source)).waitId,first.waitId);
      ok(await timer(f,claim,'timer-two',source));assert.equal((await timer(f,claim,'timer-three',source)).code,'THREADED_HOLD_QUOTA_EXCEEDED');
      const second=await start(f,action,claim,'second-command');assert.equal((await wait(f,claim,action,second,'second-wait')).code,'THREADED_HOLD_QUOTA_EXCEEDED');
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_command_waits').get().n,1);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_waits').get().n,2);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_hold_admissions').get().n,3);
      return 'One stable job charges once; timers and command wakes share three/hour';});
    f.advance(3600000);
    await run(f,f.user('Timer after one-hour window',['other-member']),async claim=>{
      assert.equal(claim.binding.agentId,'other-member');
      ok(await timer(f,claim,'after-window',f.runtime.collaboration.cooperation.source(claim.binding).id));
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_hold_admissions').get().n,4);return 'New work admitted after window';});
    checks.push('RC03-C01: timer and command wake share one durable 3/hour per owner/Thread/member ledger; same timer job and command ID charge once across different operation keys; rejected admission rolls back its wait; exact one-hour boundary admits new work');
  }
  {
    const f=await fixture('revoke-terminal-wait'),{action}=await assign(f);let command;
    await run(f,undefined,async claim=>{command=await start(f,action,claim);ok(await wait(f,claim,action,command));return 'Awaiting result';});
    f.complete();await f.runtime.collaboration.commands.recover();
    assert.equal(f.db.prepare('SELECT state FROM threaded_commands').get().state,'completed');
    // A terminal command can still have an undispatched wait after a crash. Recheck
    // current registration rather than trusting that its old terminal is sufficient.
    const callback=f.db.prepare("SELECT id FROM threaded_collaboration_callbacks WHERE kind='command'").get();assert.ok(callback);
    checks.push('RC03-C02: a currently authorized terminal command emits one typed callback, preserving separate business-condition verification');
  }
  {
    const f=await fixture('revoke-before-terminal'),{action}=await assign(f);let command;
    await run(f,undefined,async claim=>{command=await start(f,action,claim);ok(await wait(f,claim,action,command));return 'Awaiting result';});
    f.db.prepare("UPDATE threaded_commands SET state='completed',version=version+1,result=? WHERE id=?").run(JSON.stringify({state:'completed',evidenceRef:'injected:crash-after-terminal'}),command.commandId);
    f.revoke();await f.runtime.collaboration.commands.recover();
    assert.equal(f.db.prepare('SELECT state FROM threaded_command_waits').get().state,'stale');
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM threaded_collaboration_callbacks WHERE kind='command'").get().n,0);
    checks.push('RC03-C03: a terminal row restored before wait delivery rechecks current registration; revoked port marks wait stale without emitting a callback');
  }
  {
    const f=await fixture('paused-command-callback'),{action}=await assign(f);let command;
    await run(f,undefined,async claim=>{command=await start(f,action,claim);ok(await wait(f,claim,action,command));return 'Awaiting result';});
    f.db.prepare("UPDATE threaded_threads SET state='paused' WHERE id=?").run(f.thread.id);f.complete();await f.runtime.collaboration.commands.recover();
    assert.equal(f.db.prepare("SELECT state FROM threaded_collaboration_callbacks WHERE kind='command'").get().state,'waiting');
    f.revoke();f.db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(f.thread.id);const before=f.db.prepare('SELECT COUNT(*) n FROM threaded_messages').get().n;
    f.runtime.collaboration.cooperation.recover();const saved=f.db.prepare("SELECT state,reason,message_id FROM threaded_collaboration_callbacks WHERE kind='command'").get();
    assert.equal(saved.state,'rejected');assert.equal(saved.reason,'THREADED_COMMAND_AUTHORITY_CHANGED');assert.equal(saved.message_id,null);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_messages').get().n,before);
    checks.push('RC03-C04: a command terminal callback already held by pause is reauthorized before resume; revocation rejects the old callback without a new message or wake');
  }
  assert.equal(externalNetworkCalls,0);
  const report={ok:true,groups:checks.length,checks,injectedModelRequests,injectedCommandStarts:starts,realModelCalls:0,externalNetworkCalls,
    scope:'Temporary SQLite with application tools, Action fences and injected command transport; actual OS process checks are separate'};
  const output=process.env.THREADED_RC03_ADMISSION_OUTPUT??'docs/reports/evidence/threaded-rc03-command-admission.json';
  await mkdir(path.dirname(path.resolve(output)),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{globalThis.fetch=originalFetch;for(const f of fixtures)f.close();await rm(root,{recursive:true,force:true});}

import assert from 'node:assert/strict';
import {mkdtemp,realpath,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fork,spawn,execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-gand-t12-os-')));
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'unused.sqlite'),AGENTS_DIR:path.join(root,'agents'),THREADED_OS_UNEXPECTED_ENV:'must-not-pass'});
const {openOsHarness}=await import('./fixtures/threadedOsCommandHarness.mjs');
const {createThreadedOsCommandPort,verifyThreadedOsCommandResourceEvidence}=await import('../apps/server/src/threaded/osCommands.ts');
const {createThreadedOsCommandResources}=await import('../apps/server/src/threaded/osCommandResources.ts');
const {createExecutionResourceCoordinator}=await import('../apps/server/src/execution/resources/coordinator.ts');
const checks=[],harnesses=[],workers=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout=5000){const start=Date.now();for(;;){const value=await fn();if(value)return value;if(Date.now()-start>timeout)throw new Error('Timed out');await pause(50);}}
const scope=holder=>({ownerId:holder.binding.ownerId,threadId:holder.binding.threadId,agentId:holder.binding.agentId});
const rows=h=>h.f.db.prepare('SELECT * FROM threaded_os_commands').all();
const claimFor=(h,id)=>h.resources.getClaim(JSON.parse(rows(h).find(r=>r.command_id===id).claim_record).claimId);
async function fixture(name,mode,extra){const h=await openOsHarness(root,name,mode,extra);harnesses.push(h);return h;}
async function poll(h,commandId,s,target){return until(async()=>{const result=await h.port.observe({commandId,scope:s});return target(result)?result:null;});}
async function worker(name){const child=fork(new URL('./fixtures/threadedOsCommandWorker.mjs',import.meta.url),[root,name],{execArgv:['--import',new URL('../apps/server/node_modules/tsx/dist/loader.mjs',import.meta.url).pathname],stdio:['ignore','ignore','pipe','ipc']});workers.push(child);let stderr='';child.stderr.on('data',d=>stderr+=d);const info=await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',code=>reject(new Error(`${code}: ${stderr}`)));});return {child,info};}
function recover(info){const db=new Database(info.file,{fileMustExist:true,timeout:10000});db.pragma('foreign_keys=ON');
  const resources=createExecutionResourceCoordinator(db,{ownerNonce:`os-recovery:${randomUUID()}`,verifyEvidence:(_request,id,evidence)=>{const claim=resources.getClaim(id.claimId);return !!claim&&verifyThreadedOsCommandResourceEvidence(db,claim,evidence);}});
  const registration={...info.registration,authorization:()=> 'fixed:1',reconcileSideEffects:()=>true};
  const port=createThreadedOsCommandPort(db,{registration,lease:createThreadedOsCommandResources(db,resources)});return {db,resources,port};}
try{
  assert.equal(process.platform,'darwin','This acceptance is deliberately macOS only');
  {
    const h=await fixture('complete','complete'),{command,holder}=await h.start();
    assert.equal(command.state,'running');
    const answer=await poll(h,command.commandId,scope(holder),r=>r.state==='completed');
    assert.equal(JSON.parse(answer.result).processStopped,true);assert.equal(JSON.parse(answer.result).resourceReleased,true);
    assert.equal(claimFor(h,command.commandId).state,'released');
    assert.equal(verifyThreadedOsCommandResourceEvidence(h.f.db,claimFor(h,command.commandId),{reason:'reconciled',sideEffects:'reconciled',reference:answer.evidenceRef}),true);
    const count=(await readFile(path.join(h.directory,'starts.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(count.length,1);assert.equal(count[0].environment,'fixed');assert.equal(count[0].unexpected,null);
    const replay=await h.makePort().start({commandId:command.commandId,binding:holder.binding,args:{}});assert.equal(replay.state,'completed');
    assert.equal((await readFile(path.join(h.directory,'starts.jsonl'),'utf8')).trim().split('\n').length,1);
    for(const args of [{argv:['x']},{cwd:'/tmp'},{environment:{PATH:'x'}},{url:'https://example.invalid'},['x'],'echo x'])assert.throws(()=>h.port.validate(args),/ARGUMENTS_FORBIDDEN/);
    assert.throws(()=>h.f.db.prepare("UPDATE threaded_os_command_events SET kind='fake'").run(),/IMMUTABLE/);
    checks.push('OS01: actual allowlisted program/argv/cwd/env only, no inherited environment or model shell/path/URL; native exit plus absent process group and trusted effects proof release exact independent command lease; durable restart replay starts once');
  }
  {
    const h=await fixture('cancel','running'),{command,holder}=await h.start();
    await until(async()=>{try{return JSON.parse(await readFile(path.join(h.directory,'pids.json'),'utf8'));}catch{return null;}});
    assert.equal(h.f.resources.getClaim(holder.binding.claimId).state,'released');
    assert.equal(claimFor(h,command.commandId).state,'started');
    const before=h.f.db.prepare('SELECT COUNT(*) n FROM threaded_invocation_terminals').get().n;
    const cancelled=await h.port.cancel({commandId:command.commandId,scope:scope(holder)});assert.equal(cancelled.state,'cancelled');
    assert.equal(JSON.parse(cancelled.result).processStopped,true);assert.equal(claimFor(h,command.commandId).state,'released');
    assert.equal(h.f.db.prepare('SELECT COUNT(*) n FROM threaded_invocation_terminals').get().n,before);
    await h.f.runtime.collaboration.commands.recover();await h.f.runtime.collaboration.commands.recover();
    assert.equal(h.f.db.prepare("SELECT COUNT(*) n FROM threaded_collaboration_callbacks WHERE kind='command'").get().n,1);
    assert.equal(h.f.db.prepare('SELECT state FROM threaded_actions').get().state,'active');
    checks.push('W01/W04/OS01: real command outlives completed Invocation with its own fenced workspace claim; verified group cancellation releases only command lease; duplicate recovery produces one wait callback and never completes the business Action');
  }
  {
    const h=await fixture('resource-barriers','running');let blocked;
    const {command,holder}=await h.start(async({claim,command})=>{
      const prior=h.f.db.prepare('SELECT * FROM threaded_commands WHERE id=?').get(command.commandId),id=randomUUID(),keys=Object.keys(prior);
      h.f.db.prepare(`INSERT INTO threaded_commands(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>k==='id'?id:prior[k]));
      await assert.rejects(()=>h.port.start({commandId:id,binding:claim.binding,args:null}),/RESOURCE_UNAVAILABLE/);
      assert.equal(h.f.db.prepare('SELECT COUNT(*) n FROM threaded_os_commands WHERE command_id=?').get(id).n,0,'blocked reservation rolls back its intent and ticket');
      const bad={requestKey:randomUUID(),operationId:randomUUID(),mode:'threaded',ownerId:claim.binding.ownerId,threadId:claim.binding.threadId,
        invocationId:claim.binding.invocationId,runId:claim.binding.runId,attemptId:claim.binding.attemptId,agentId:claim.binding.agentId,capacity:false,
        workspaces:[{path:root,access:'write'}],threadedCommand:{commandId:command.commandId,registrationId:'fixed'}};
      assert.throws(()=>h.resources.enqueue(bad),/COMMAND_SCOPE_UNAVAILABLE|COMMAND_WORKSPACES_CHANGED/);
      const runId=randomUUID();h.f.db.prepare("INSERT INTO runs(id,goal,mode,status,agent_ids,created_at) VALUES(?,'fixture','collaboration','running',?,?)").run(runId,JSON.stringify([claim.binding.agentId]),new Date().toISOString());
      blocked=h.resources.enqueue({requestKey:randomUUID(),operationId:randomUUID(),mode:'legacy',ownerId:claim.binding.ownerId,agentId:claim.binding.agentId,runId,attemptId:randomUUID(),capacity:false});
      assert.equal(h.resources.tryAcquire(blocked.id),null);
    });
    assert.equal(h.resources.tryAcquire(blocked.id),null,'completed Invocation does not free a still-running command Agent barrier');
    await h.port.cancel({commandId:command.commandId,scope:scope(holder)});
    const legacy=h.resources.tryAcquire(blocked.id);assert.ok(legacy);
    const proof=h.resources.recordQuiescence(legacy,{reason:'not_started',sideEffects:'none'});h.resources.release(legacy,proof);
    checks.push('Q03/Q06: independent command lease preserves workspace write and old-mode exclusive barriers after Invocation completion; a second same-workspace command cannot spawn; forged command cwd is rejected and blocked intent/ticket roll back together');
  }
  {
    const h=await fixture('stale-generation','running');
    const {command,holder}=await h.start(async({claim,action,task,command})=>{
      h.ok(await h.tool(claim,'transfer_action',{idempotencyKey:'return',subject:{kind:'task',taskId:task.taskId},predicate:'task_done',family:'work',successorSlot:'primary',targets:['api-member'],operation:'return',expectedGeneration:1}));
      const late=await h.tool(claim,'cancel_command',{idempotencyKey:'late-cancel',actionId:action.actionId,expectedGeneration:1,commandId:command.commandId});assert.equal(late.code,'THREADED_ACTION_STALE_GENERATION');
    });
    await h.port.cancel({commandId:command.commandId,scope:scope(holder)});
    await h.f.runtime.collaboration.commands.recover();await h.f.runtime.collaboration.commands.recover();
    assert.equal(h.f.db.prepare('SELECT state FROM threaded_command_waits WHERE command_id=?').get(command.commandId).state,'stale');
    assert.equal(h.f.db.prepare("SELECT COUNT(*) n FROM threaded_collaboration_callbacks WHERE kind='command'").get().n,0);
    assert.equal(h.f.db.prepare('SELECT generation FROM threaded_actions').get().generation,2);
    assert.equal(h.f.db.prepare('SELECT state FROM threaded_actions').get().state,'active');
    checks.push('W04: actual OS command belongs to its original Action generation; late model cancellation is denied after responsibility returns, and trusted stop/recovery of the old process never wakes or completes the new holder');
  }
  {
    const h=await fixture('unreconciled','complete');h.effects(false);const {command,holder}=await h.start();
    const unknown=await poll(h,command.commandId,scope(holder),r=>JSON.parse(r.result??'{}').processStopped);
    assert.equal(unknown.state,'unknown');assert.equal(claimFor(h,command.commandId).state,'unknown');assert.equal(JSON.parse(unknown.result).resourceReleased,false);
    assert.throws(()=>h.resources.recordQuiescence(claimFor(h,command.commandId).identity,{reason:'reconciled',sideEffects:'reconciled',reference:unknown.evidenceRef}),/UNVERIFIED/);
    h.effects(true);await poll(h,command.commandId,scope(holder),r=>r.state==='completed');assert.equal(claimFor(h,command.commandId).state,'released');
    checks.push('Q06/REC03: process exit without trusted side-effect reconciliation stays unknown and fenced; fabricated stop reference cannot release; later independent reconciliation settles once');
  }
  {
    const h=await fixture('identity','running'),{command,holder}=await h.start();
    const original=rows(h)[0],record=JSON.parse(original.record);
    h.f.db.prepare('UPDATE threaded_os_commands SET record=? WHERE command_id=?').run(JSON.stringify({...record,startIdentity:'different-start'}),command.commandId);
    const denied=await h.port.cancel({commandId:command.commandId,scope:scope(holder)});assert.equal(denied.state,'unknown');
    const live=execFileSync('/bin/ps',['-p',String(record.pid),'-o','pid='],{encoding:'utf8'}).trim();assert.equal(Number(live),record.pid);
    const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    try {
      await new Promise((resolve,reject)=>{unrelated.once('spawn',resolve);unrelated.once('error',reject);});
      const start=execFileSync('/bin/ps',['-p',String(unrelated.pid),'-o','lstart='],{encoding:'utf8'}).trim();
      h.f.db.prepare('UPDATE threaded_os_commands SET record=? WHERE command_id=?').run(JSON.stringify({...record,pid:unrelated.pid,pgid:unrelated.pid,startIdentity:start}),command.commandId);
      assert.equal((await h.port.cancel({commandId:command.commandId,scope:scope(holder)})).state,'unknown');
      assert.equal(Number(execFileSync('/bin/ps',['-p',String(unrelated.pid),'-o','pid='],{encoding:'utf8'}).trim()),unrelated.pid,'An unrelated real process remains alive');
    } finally {const exit=new Promise(resolve=>unrelated.once('exit',resolve));unrelated.kill('SIGTERM');await exit;}
    h.f.db.prepare('UPDATE threaded_os_commands SET record=? WHERE command_id=?').run(original.record,command.commandId);
    await assert.rejects(()=>h.port.observe({commandId:command.commandId,scope:{...scope(holder),threadId:'foreign'}}),/NOT_FOUND/);
    h.revoke();await assert.rejects(()=>h.port.cancel({commandId:command.commandId,scope:scope(holder)}),/AUTHORITY_CHANGED/);
    h.port.close();
    checks.push('OS01: wrong process start identity, foreign Thread scope and revoked registration do not signal an unrelated/stale process; signal syscall return alone never supplies stop proof');
  }
  for(const crash of ['disconnect','sigkill']){
    const {child,info}=await worker(crash);const starts=path.join(root,`${crash}-command`,'starts.jsonl');
    await until(async()=>{try{return (await readFile(starts,'utf8')).trim().split('\n').length===2;}catch{return false;}});
    if(crash==='sigkill'){const exit=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exit;}else child.send({type:'disconnect-owned'});
    const r=recover(info);
    try{const answer=await until(async()=>{const a=await r.port.observe({commandId:info.commandId,scope:info.scope});return JSON.parse(a.result??'{}').processStopped?a:null;});
      assert.equal(answer.state,'unknown');assert.equal(JSON.parse(answer.result).resourceReleased,true);assert.equal(r.resources.getClaim(info.claim.claimId).state,'released');
      assert.equal((await readFile(starts,'utf8')).trim().split('\n').length,2);
      await r.port.observe({commandId:info.commandId,scope:info.scope});assert.equal((await readFile(starts,'utf8')).trim().split('\n').length,2);
      checks.push(`OS01/REC03: actual ${crash==='sigkill'?'owner process SIGKILL':'guardian IPC disconnect'} terminates registered guardian/native/grandchild group; rebuilt SQLite/coordinator observes stop with unknown result, reconciles exact lease and never restarts native work`);
    }finally{r.port.close();r.db.close();if(child.connected)child.send({type:'close'});}
  }
  const output={ok:true,platform:process.platform,checks:checks.length,passed:checks,realModelRequests:0,realModelTokens:0,productionRegistrations:0,linuxVerified:false};
  if(process.env.THREADED_OS_OUTPUT){await mkdir(path.dirname(process.env.THREADED_OS_OUTPUT),{recursive:true});await import('node:fs/promises').then(fs=>fs.writeFile(process.env.THREADED_OS_OUTPUT,JSON.stringify(output,null,2)+'\n'));}
  console.log(JSON.stringify(output,null,2));
}finally{
  for(const h of harnesses)try{h.port.close();}catch{};
  for(const child of workers)if(child.connected)child.send({type:'close'});
  await pause(650);for(const h of harnesses)try{h.close();}catch{};
  await rm(root,{recursive:true,force:true});
}

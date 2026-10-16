import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root=await mkdtemp(path.join(tmpdir(),'gand-g4-'));process.env.G4_TEST_ROOT=root;
const f=await import('./helpers/scoped-recovery-fixture.mjs');
const {db,registry,rooms,trace,store,delivery,runner,scheduler,releases,recovery,holds}=f;
const cases=[];const costs=[];let killed=0,racers=0;
const childArgs=(mode,x,arg='')=>['--import','./apps/server/node_modules/tsx/dist/loader.mjs','scripts/helpers/scoped-recovery-child.mjs',mode,x.room.id,x.id,arg];
const crash=(mode,x,arg='')=>{const r=spawnSync(process.execPath,childArgs(mode,x,arg),{env:process.env,encoding:'utf8',timeout:20000});assert.equal(r.signal,'SIGKILL',mode+': '+r.stdout+r.stderr);killed++;};
const waitFor=async predicate=>{for(let n=0;n<800;n++){if(await predicate())return;await new Promise(r=>setTimeout(r,10));}throw new Error('G4 wait timeout');};
async function race(specs,outputGate=false){
  const gate=path.join(root,'gate-'+randomUUID());
  const workers=specs.map(([mode,x,arg])=>{const child=spawn(process.execPath,childArgs(mode,x,arg),{env:{...process.env,G4_BARRIER:gate,...(outputGate?{G4_OUTPUT_GATE:gate+'-output'}:{})},stdio:['ignore','pipe','pipe']});let text='',errors='';child.stdout.on('data',v=>text+=v);child.stderr.on('data',v=>errors+=v);const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>code===0?resolve(JSON.parse(text.trim())):reject(new Error(text+errors+signal)));});return {child,done};});
  // Cleanup even when a worker fails before reaching the barrier.
  for(const w of workers)void w.done.catch(()=>{});
  try {
  await waitFor(async()=>{const files=await readdir(root);return workers.every(w=>files.includes(path.basename(gate)+'.'+w.child.pid));});
  await writeFile(gate,'go');
  if(outputGate){await waitFor(async()=>{const files=await readdir(root);return workers.every(w=>files.includes(path.basename(gate)+'-output.'+w.child.pid));});await writeFile(gate+'-output','go');}
  const results=await Promise.all(workers.map(w=>w.done));for(const r of results)assert.equal(r.networkAttempts,0);racers+=workers.length;return results;
  } finally {for(const w of workers)if(w.child.exitCode===null&&w.child.signalCode===null)w.child.kill('SIGKILL');await Promise.allSettled(workers.map(w=>w.done));}
}
for(const id of ['coordinator','aa','bb','cc'])registry.createAgent({id,name:id,description:'G4 fixture',systemPrompt:'Only examine the supplied material.',model:'mock:'+id,capabilities:['execute'],permissionMode:'readonly',tools:[],disallowedTools:[],color:'#4477aa',avatar:''});
const costPolicy={version:1,currency:'USD',mode:'estimate',maxCost:1,unknownAction:'stop',prices:['coordinator','aa','bb','cc'].map(id=>({agentId:id,model:'mock:'+id,source:'G4 fixture',version:'1',inputPerMillion:1,outputPerMillion:2,otherCharges:'none'}))};
function admit(join='all'){
  const room=rooms.createConversation({title:'G4 '+randomUUID(),mode:'collaboration',agentIds:['coordinator','aa','bb','cc'],supervisorId:null,workspace:null,preferences:{strategy:'auto',workflow:'routine',supervisorId:null,defaultReviewerId:null,aggregatorId:null,constraints:{costPolicy}}});
  const draft={conversationId:room.id,coordinatorId:'coordinator',goal:'独立审阅',join,returnProfile:'status-only-v1',maxTokens:16000,items:['aa','bb'].map((target,n)=>({key:'item-'+(n+1),target,batch:1,expectation:'result',material:'PRIVATE_MATERIAL_'+target}))};
  const p=delivery.previewScopedDelivery(draft,'owner');return {room,id:delivery.confirmScopedDelivery({previewId:p.id,fingerprint:p.fingerprint,clientKey:randomUUID()},'owner')};
}
const finish=async(x,status='completed')=>{scheduler.reconcileCollaborationBatches(x.id);scheduler.recoverCollaborationRuns();await waitFor(()=>['completed','failed','cancelled'].includes(trace.getRun(x.id).status));assert.equal(trace.getRun(x.id).status,status,JSON.stringify(store.listAttempts(x.id)));};
const audit=id=>{
  const calls=db.all('SELECT * FROM orchestration_model_calls WHERE run_id=? ORDER BY queued_at,id',id),tokens=db.all('SELECT * FROM orchestration_token_reservations WHERE run_id=? ORDER BY id',id),money=db.all('SELECT * FROM execution_cost_reservations WHERE run_id=? ORDER BY id',id);
  assert.equal(tokens.length,money.length);assert.equal(tokens.length,new Set(tokens.map(t=>t.id)).size);
  for(const t of tokens){const c=calls.find(c=>c.id===t.id),m=money.find(m=>m.id===t.id);assert.ok(c);assert.ok(m);assert.notEqual(t.status,'pending');assert.notEqual(m.status,'pending');if(!c.started_at){assert.equal(t.used,0);assert.equal(m.known,0);}else if(t.status==='settled'){assert.equal(t.used,8);assert.equal(m.known,19);}if(t.status==='unknown'){assert.ok(c.started_at);assert.equal(m.status,'unknown');}}
  costs.push({runId:id,calls:calls.length,issued:calls.filter(c=>c.started_at).length,settled:tokens.filter(t=>t.status==='settled').length,unknown:tokens.filter(t=>t.status==='unknown').length,chargedCostUsd:delivery.scopedDeliveryStatus(id).costBudget.run.charged,chargedTokens:tokens.reduce((n,t)=>n+(t.status==='settled'?t.used:t.reserved),0)});
  return {calls,tokens,money};
};
async function releaseFixture(source){const p=releases.previewPrivateAggregate({sourceRunId:source.id,itemKeys:['item-1','item-2'],aggregatorId:'cc',instruction:'提交私密总评。',maxTokens:16000},'owner');const {runId:id}=releases.confirmPrivateAggregate({previewId:p.id,fingerprint:p.fingerprint,clientKey:randomUUID()},'owner');const x={id,room:source.room};scheduler.kickCollaboration(x.room.id);await waitFor(()=>trace.getRun(id).status==='waiting_for_user');const preview=releases.previewInformationRelease(id,{expectedRevision:1,mode:'exact_content',access:{visibility:'private',audience:['aa']}},'owner');const grant=releases.confirmInformationRelease({previewId:preview.id,fingerprint:preview.fingerprint,clientKey:randomUUID()},'owner');return {...x,grantId:grant.grantId,policyId:preview.policyId};}
try{
  for(const mode of ['batch_before','batch_after']){
    const x=admit();crash(mode,x);assert.equal(store.listBatches(x.id).length,mode==='batch_before'?0:1);assert.equal(db.get('SELECT COUNT(*) n FROM scoped_delivery_envelopes WHERE run_id=?',x.id).n,mode==='batch_before'?0:2);
    f.expire(x.id);await finish(x);assert.equal(store.listBatches(x.id).length,1);assert.equal(store.listDispatches(x.id).filter(d=>d.kind==='aggregate').length,1);audit(x.id);cases.push(mode+': atomic batch rollback/commit and unique parent');
  }
  for(const mode of ['claim','reserved','issued','output','complete_before','complete_after']){
    const x=admit();await f.step(x.room.id);const good=await f.step(x.room.id);const output=store.getDispatch(good.dispatch.id).outputMessageId;
    crash(mode,x);const before=store.listAttempts(x.id).length;f.expire(x.id);f.expire(x.id);f.expire(x.id);assert.equal(store.listAttempts(x.id).length,before);
    await finish(x,mode==='issued'?'failed':'completed');assert.equal(store.getDispatch(good.dispatch.id).outputMessageId,output);assert.equal(store.listAttempts(x.id).filter(a=>a.agentId==='aa').length,1);
    const ledger=audit(x.id);if(mode==='issued'){assert.equal(ledger.tokens.filter(t=>t.status==='unknown').length,1);assert.equal(store.listAttempts(x.id).filter(a=>a.agentId==='bb').length,1);}
    if(mode==='reserved'){assert.equal(ledger.calls.filter(c=>!c.started_at).length,1);assert.equal(ledger.tokens.filter(t=>t.used===0).length,1);}
    if(mode==='output'||mode==='complete_before')assert.equal(ledger.calls.filter(c=>c.agent_id==='bb'&&c.started_at).length,2);
    if(mode==='complete_after')assert.equal(store.listAttempts(x.id).filter(a=>a.agentId==='bb').length,1);
    cases.push(mode+': partial recovery preserves successful sibling and accounts every invocation');
  }
  for(const mode of ['reconcile_before','reconcile_after']){
    const x=admit();await f.step(x.room.id);await f.step(x.room.id);await f.step(x.room.id);const batch=store.listBatches(x.id)[0];crash(mode,x,batch.id);assert.equal(store.listDispatches(x.id).filter(d=>d.kind==='aggregate').length,mode==='reconcile_before'?0:1);
    const receipts=await race([['reconcile',x,batch.id],['reconcile',x,batch.id]]);assert.ok(receipts.every(r=>r.ok));
    await finish(x);assert.equal(store.listDispatches(x.id).filter(d=>d.kind==='aggregate').length,1);audit(x.id);cases.push(mode+': status projection and parent resume are atomic');
  }
  const independent=admit();await f.step(independent.room.id);crash('claim',independent);
  const lost=store.listAttempts(independent.id).find(a=>a.status==='running');let unblock,entered=false;
  const beforeProvider=f.mockProvider.chat;f.mockProvider.chat=async req=>{if(req.model==='mock:bb'){entered=true;await new Promise(r=>{unblock=r;});}return f.response(req);};
  const sibling=f.step(independent.room.id);await waitFor(()=>entered);
  const live=db.get("SELECT c.id FROM orchestration_model_calls c WHERE c.run_id=? AND c.agent_id='bb' AND c.status='started'",independent.id);
  db.run("UPDATE collaboration_attempts SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?",lost.id);store.interruptExpiredAttempts({onlyExpired:true});
  assert.equal(db.get('SELECT status FROM orchestration_token_reservations WHERE id=?',live.id).status,'pending');assert.equal(db.get('SELECT status FROM execution_cost_reservations WHERE id=?',live.id).status,'pending');
  unblock();await sibling;f.mockProvider.chat=beforeProvider;await finish(independent);audit(independent.id);cases.push('recover one expired worker without changing a live sibling reservation');
  const any=admit('any');await f.step(any.room.id);const competing=await race([['complete_race',any],['complete_race',any]],true);assert.ok(competing.every(r=>r.ok));await finish(any);
  const batch=store.listBatches(any.id)[0],children=store.listDispatches(any.id).filter(d=>d.kind==='fanout');assert.ok(batch.winnerDispatchId);assert.equal(children.filter(d=>d.status==='completed').length,1);assert.equal(children.filter(d=>d.status==='cancelled').length,1);
  assert.equal(db.get("SELECT COUNT(*) n FROM messages WHERE run_id=? AND message_type='collaboration_contribution' AND from_agent IN ('aa','bb')",any.id).n,1);
  const loser=children.find(d=>d.id!==batch.winnerDispatchId),loserKey=db.get('SELECT item_key FROM scoped_delivery_envelopes WHERE dispatch_id=?',loser.id).item_key;
  assert.throws(()=>releases.previewPrivateAggregate({sourceRunId:any.id,itemKeys:[loserKey],aggregatorId:'cc',instruction:'汇总',maxTokens:16000},'owner'));
  audit(any.id);cases.push('cross-process readonly any: one accepted winner; late loser has no publishable output');
  const abortedAny=admit('any');const baseProvider=f.mockProvider.chat;let bothEntered=0,releaseModels;
  const modelGate=new Promise(r=>{releaseModels=r;});f.mockProvider.chat=async req=>{if(req.model!=='mock:coordinator'){if(++bothEntered===2)releaseModels();await modelGate;if(req.model==='mock:bb')await new Promise(resolve=>setTimeout(resolve,50));}return f.response(req);};
  await finish(abortedAny);await new Promise(resolve=>setTimeout(resolve,70));f.mockProvider.chat=baseProvider;
  assert.ok(store.listBatches(abortedAny.id)[0].winnerDispatchId);assert.equal(audit(abortedAny.id).tokens.filter(t=>t.status==='unknown').length,1);cases.push('same-process any cancellation retains unknown loser cost; deterministic control needs no new model call');
  const none=admit('any');const original=f.mockProvider.chat;f.mockProvider.chat=async req=>req.model==='mock:coordinator'?f.response(req):({...f.response(req),toolCalls:[{name:'agent.complete',input:'{"summary":"收到"}'}]});await finish(none,'failed');f.mockProvider.chat=original;cases.push('any exhausted: failed join cannot become a successful parent');
  // Cross-process completion racing Stop. Late output must never create post-terminal commands.
  const stopped=admit();await f.step(stopped.room.id);const stopRace=await race([['step',stopped],['stop',stopped]]);assert.ok(stopRace.some(r=>r.ok));assert.equal(trace.getRun(stopped.id).status,'cancelled');const frozen=db.get('SELECT COUNT(*) n FROM runtime_action_commands WHERE run_id=?',stopped.id).n;f.expire(stopped.id);scheduler.reconcileCollaborationBatches(stopped.id);assert.equal(db.get('SELECT COUNT(*) n FROM runtime_action_commands WHERE run_id=?',stopped.id).n,frozen);audit(stopped.id);cases.push('cross-process Stop/complete fence');
  // Unknown write ledger is deliberately injected; scoped tools never expose this operation.
  const write=admit();const claim=store.claimNextDispatch(write.room.id,'write-crash');db.run("INSERT INTO tool_executions(id,run_id,agent_id,attempt_id,tool_name,idempotency_key,input,replay_policy,status,created_at,started_at) VALUES (?,?,?,?,?,?,?,'manual','running',?,?)",randomUUID(),write.id,'coordinator',claim.attempt.id,'fixture.write',randomUUID(),'{}',new Date().toISOString(),new Date().toISOString());f.expire(write.id);f.expire(write.id);assert.equal(store.getDispatch(claim.dispatch.id).status,'failed');assert.equal(db.get('SELECT status FROM tool_executions WHERE attempt_id=?',claim.attempt.id).status,'needs_attention');await finish(write,'failed');cases.push('unknown external write is retained for attention and never replayed');
  const source=admit();await finish(source);
  for(const mode of ['publish_before','publish_after']){
    const x=await releaseFixture(source);crash(mode,x,x.grantId);assert.equal(releases.releaseState(x.id).records.length,mode==='publish_before'?0:1);const pub=releases.publishInformationRelease(x.grantId);assert.deepEqual(releases.publishInformationRelease(x.grantId),pub);assert.equal(releases.releaseState(x.id).records.length,1);
    recovery.recoverDurableHolds(x.id);await finish(x);assert.equal(store.listDispatches(x.id).filter(d=>d.kind==='resume').length,1);audit(x.id);cases.push(mode+': grant, message, publication record and wake event commit together');
  }
  for(const mode of ['hold_claim','wake_before','wake_after']){
    const x=await releaseFixture(source);releases.publishInformationRelease(x.grantId);crash(mode,x);db.run("UPDATE runtime_holds SET claim_expires_at='2000-01-01T00:00:00.000Z' WHERE run_id=? AND status='claimed'",x.id);
    const rr=await race([['wake',x],['wake',x]]);assert.ok(rr.every(r=>r.ok));recovery.recoverDurableHolds(x.id);await finish(x);assert.equal(store.listDispatches(x.id).filter(d=>d.kind==='resume').length,1);assert.equal(holds.listDurableHolds(x.id)[0].status,'resumed');audit(x.id);cases.push(mode+': expired hold claim and competing wakes yield one resume');
  }
  for(const opponent of ['publish','stop','revoke']){
    const x=await releaseFixture(source);const rr=await race([['publish',x,x.grantId],[opponent,x,opponent==='revoke'?x.policyId:x.grantId]]);const records=releases.releaseState(x.id).records;assert.ok(records.length<=1);
    if(opponent==='publish'){assert.ok(rr.every(r=>r.ok));assert.deepEqual(rr[0].result,rr[1].result);assert.equal(records.length,1);}
    if(opponent==='stop'){assert.equal(trace.getRun(x.id).status,'cancelled');assert.equal(store.listDispatches(x.id).filter(d=>d.kind==='resume').length,0);}
    if(records.length){assert.deepEqual(releases.publishInformationRelease(x.grantId).messageId,records[0].messageId);if(opponent!=='stop'){recovery.recoverDurableHolds(x.id);await finish(x);}}
    else {assert.throws(()=>releases.publishInformationRelease(x.grantId));f.stop(x.id);}
    audit(x.id);cases.push('cross-process publish/'+opponent+': serialized authorization consumption');
  }
  const wakeStopped=await releaseFixture(source);releases.publishInformationRelease(wakeStopped.grantId);
  const wakeRace=await race([['wake',wakeStopped],['stop',wakeStopped]]);assert.ok(wakeRace.every(r=>r.ok));assert.equal(trace.getRun(wakeStopped.id).status,'cancelled');
  assert.ok(store.listDispatches(wakeStopped.id).filter(d=>d.kind==='resume').length<=1);const stoppedCount=store.listDispatches(wakeStopped.id).length;
  recovery.recoverDurableHolds(wakeStopped.id);scheduler.reconcileCollaborationBatches(wakeStopped.id);assert.equal(store.listDispatches(wakeStopped.id).length,stoppedCount);assert.equal(store.listDispatches(wakeStopped.id).filter(d=>['queued','running'].includes(d.status)).length,0);assert.equal(releases.releaseState(wakeStopped.id).records.length,1);audit(wakeStopped.id);cases.push('cross-process Stop/wake: no post-terminal dispatch; committed publication remains');
  assert.equal(f.networkAttempts,0);assert.equal(db.get('PRAGMA integrity_check').integrity_check,'ok');
  const report={passed:cases.length,cases,killedWorkers:killed,concurrentWorkers:racers,networkAttempts:f.networkAttempts,costs};
  if(process.env.G4_REPORT_PATH)await writeFile(process.env.G4_REPORT_PATH,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await f.network.close();db.db.close();await rm(root,{recursive:true,force:true});}

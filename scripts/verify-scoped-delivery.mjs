// Real admission, scheduler, scopes, commands and completion; only the model is stubbed.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root=await mkdtemp(path.join(tmpdir(),'gand-scoped-g2-'));
for(const key of Object.keys(process.env))if(/^(LLM_|ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_|ACCOUNT_|COLLAB_|COORDINATION_|ORCHESTRATION_|EXTERNAL_|MCP_)/.test(key))delete process.env[key];
Object.assign(process.env,{NODE_ENV:'test',AGENT_GAND_ISOLATED_WORKER:'1',LOG_LEVEL:'silent',DB_PATH:path.join(root,'test.sqlite'),AGENTS_DIR:path.join(root,'roles'),AGENT_GAND_PRIVATE_DIR:path.join(root,'private'),EXTERNAL_CODEX_HOME:path.join(root,'codex'),EXTERNAL_CLAUDE_HOME:path.join(root,'claude'),EXTERNAL_WORKSPACE_DIR:path.join(root,'workspaces'),EXTERNAL_CODEX_COMMAND:path.join(root,'no-codex'),EXTERNAL_CLAUDE_COMMAND:path.join(root,'no-claude'),MCP_SERVER_CMD:''});
const requireServer=createRequire(new URL('../apps/server/package.json',import.meta.url));
const {MockAgent,setGlobalDispatcher}=requireServer('undici');const network=new MockAgent();network.disableNetConnect();setGlobalDispatcher(network);
let networkAttempts=0;globalThis.fetch=async()=>{networkAttempts++;throw new Error('G2 forbids network');};
const dispatchNetwork=network.dispatch.bind(network);network.dispatch=(...args)=>{networkAttempts++;return dispatchNetwork(...args);};
const {config}=await import('../apps/server/src/config.ts');config.dataDir=root;config.sandboxDir=path.join(root,'sandbox');
const db=await import('../apps/server/src/db/database.ts');
const registry=await import('../apps/server/src/agents/registry.ts');
const rooms=await import('../apps/server/src/conversations/service.ts');
const trace=await import('../apps/server/src/runs/trace.ts');
const store=await import('../apps/server/src/collaboration/store.ts');
const delivery=await import('../apps/server/src/collaboration/scopedDelivery.ts');
const runner=await import('../apps/server/src/collaboration/scopedRunner.ts');
const scheduler=await import('../apps/server/src/collaboration/scheduler.ts');
const commands=await import('../apps/server/src/runtime/actionCommands.ts');
const {mockProvider}=await import('../apps/server/src/llm/provider.ts');
const {post}=await import('../apps/server/src/messaging/inbox.ts');
const {commitRunTerminal}=await import('../apps/server/src/runtime/terminal.ts');
const cases=[];const calls=[];const scenarios=new Map();const modelErrors=[];
for(const id of ['coordinator','aa','bb','cc'])registry.createAgent({id,name:id,description:'G2 synthetic fixture',systemPrompt:`ROLE_${id}: independently examine your material`,model:'mock:'+id,capabilities:['execute'],permissionMode:'readonly',tools:[],disallowedTools:[],color:'#4477aa',avatar:''});
const room=rooms.createConversation({title:'G2 isolated fixture',mode:'collaboration',agentIds:['coordinator','aa','bb','cc'],supervisorId:null,workspace:null});
const oldRun=trace.createRun('UNRELATED_ROOM_HISTORY','collaboration',['coordinator','aa'],null,null,room.id,1);
post({runId:oldRun.id,from:'user',to:'aa',kind:'user',body:'UNRELATED_ROOM_HISTORY',visibility:'private',audience:['user','aa']});trace.setRunStatus(oldRun.id,'completed');
const draft=(layout=[['aa',1,'result'],['bb',2,'result'],['cc',2,'result']])=>({conversationId:room.id,coordinatorId:'coordinator',goal:'按确认计划独立审阅',join:'all',returnProfile:'status-only-v1',maxTokens:16000,items:layout.map(([target,batch,expectation],n)=>({key:'item-'+(n+1),target,batch,expectation,material:`PRIVATE_MATERIAL_${n+1}: examine independent document ${randomUUID()}`}))});
const tool=(name,input)=>({name,input:JSON.stringify(input)});
const response=call=>({content:'',toolCalls:[call],usage:{tokensIn:3,tokensOut:8,costUsd:0},stopReason:'end_turn',truncated:false});
mockProvider.chat=async req=>{
  try{
    const id=req.model.slice(5);assert.ok(req.model.startsWith('mock:'));
    const attempt=db.get("SELECT * FROM collaboration_attempts WHERE agent_id=? AND status='running' ORDER BY rowid DESC LIMIT 1",id);assert.ok(attempt);
    const plan=delivery.getDeliveryPlan(attempt.run_id),scenario=scenarios.get(attempt.run_id)??{};
    const dispatch=store.getDispatch(attempt.dispatch_id),item=plan.items.find(i=>i.source.id===dispatch.sourceMessageId);
    const text=req.messages.map(m=>m.content).join('\n');calls.push({runId:attempt.run_id,attemptId:attempt.id,agentId:id,kind:dispatch.kind,text});
    assert.equal(req.tools.length,1);assert.ok(!text.includes('UNRELATED_ROOM_HISTORY'));
    for(const i of plan.items){const marker=`PRIVATE_MATERIAL_${i.key.split('-')[1]}`;assert.equal(text.includes(marker),i===item,`scope leak: ${id}/${i.key}`);}
    if(item){
      assert.ok(!text.includes('PRIVATE_RESULT_'));
      if(scenario.wait){scenario.entered=true;await scenario.wait;}
      if(scenario.ackAsResult)return response(tool('agent.complete',{summary:'收到'}));
      if(scenario.unknown)return {...response(tool('agent.complete',{summary:'PRIVATE_RESULT_'+item.key+'：已完成独立审阅，结论充分且证据完整。'})),usage:{tokensIn:3,tokensOut:0,costUsd:0,outputKnown:false,costKnown:false}};
      return response(item.expectation==='acknowledged'?tool('agent.acknowledge',{envelopeId:item.payloadRef}):tool('agent.complete',{summary:'PRIVATE_RESULT_'+item.key+'：已完成独立审阅，结论充分且证据完整。'}));
    }
    assert.ok(!text.includes('PRIVATE_RESULT_'));
    if(req.tools[0].name==='agent.complete')return response(tool('agent.complete',{summary:'固定状态核对完成，已按计划交付所有事项。'}));
    const n=store.listBatches(attempt.run_id).length+1;
    const action=runner.plannedBatchAction(plan.items.filter(i=>i.batch===n));
    if(scenario.corruptSecond){const second=plan.items[1];db.run("UPDATE messages SET audience='[\"user\"]' WHERE id=?",second.source.id);}
    return response(tool('agent.consult_batch',{items:action.items,join:action.join,returnProfile:action.returnProfile}));
  }catch(error){modelErrors.push(error);throw error;}
};
const waitFor=async predicate=>{for(let n=0;n<500;n++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw new Error('timeout: '+JSON.stringify(db.all('SELECT id,status FROM runs'))+' attempts: '+JSON.stringify(db.all('SELECT agent_id,error,status FROM collaboration_attempts')));};
const admit=(value,scenario={})=>{const preview=delivery.previewScopedDelivery(value,'owner');const input={previewId:preview.id,fingerprint:preview.fingerprint,clientKey:randomUUID()};const id=delivery.confirmScopedDelivery(input,'owner');scenarios.set(id,scenario);return {id,preview,input};};
const execute=async(value,scenario={})=>{const item=admit(value,scenario);scheduler.kickCollaboration(room.id);await waitFor(()=>['completed','failed','cancelled'].includes(trace.getRun(item.id).status));return item;};
const successful=id=>assert.equal(trace.getRun(id).status,'completed',JSON.stringify(store.listAttempts(id)));
let app;
try{
  const first=await execute(draft());successful(first.id);cases.push('A → B/C; clean control resumes');
  assert.equal(store.listBatches(first.id).length,2);
  const parentContexts=calls.filter(c=>c.runId===first.id&&c.agentId==='coordinator').map(c=>c.text);assert.equal(parentContexts.length,3);
  assert.ok(parentContexts[1].includes('"state":"completed"'));
  const variant=await execute(draft());successful(variant.id);
  const projections=id=>db.all("SELECT body FROM messages WHERE run_id=? AND client_message_id LIKE 'scoped:return:%' ORDER BY seq",id).map(r=>JSON.parse(r.body));
  assert.deepEqual(projections(first.id),projections(variant.id));cases.push('private material changes do not change fixed parent status projection');
  const second=await execute(draft([['aa',1,'result'],['bb',1,'result'],['cc',1,'result'],['aa',2,'result'],['bb',2,'result']]));successful(second.id);
  assert.equal(calls.filter(c=>c.runId===second.id).length,8);
  const budget=db.get("SELECT count(*) n,SUM(used) used FROM orchestration_token_reservations WHERE run_id=?",second.id);
  assert.deepEqual(budget,{n:8,used:64});cases.push('five items in two batches; same-agent fresh scopes; shared output budget');
  const before=store.listDispatches(second.id).length;assert.equal(delivery.confirmScopedDelivery(second.input,'owner'),second.id);assert.equal(store.listDispatches(second.id).length,before);
  assert.throws(()=>delivery.confirmScopedDelivery({...second.input,clientKey:randomUUID()},'owner'),/提交编号/);
  for(let n=0;n<3;n++)scheduler.reconcileCollaborationBatches(second.id);
  assert.equal(store.listDispatches(second.id).length,before);assert.equal(commands.listRuntimeActionCommands(second.id).filter(c=>c.kind==='wake').length,2);cases.push('idempotent confirm and unique parent wake');
  const batchCommand=commands.listRuntimeActionCommands(second.id).find(c=>c.kind==='consult_all');
  const bindingRow=db.get('SELECT scope_id FROM runtime_scope_attempts WHERE attempt_id=?',batchCommand.attemptId);
  const ledger=db.get('SELECT MAX(sequence) n FROM runtime_input_provenance WHERE attempt_id=?',batchCommand.attemptId).n;
  const replayInput={plan:delivery.getDeliveryPlan(second.id),dispatch:store.getDispatch(batchCommand.dispatchId),attemptId:batchCommand.attemptId,
    scope:{runId:second.id,scopeId:bindingRow.scope_id,attemptId:batchCommand.attemptId,agentId:'coordinator',ledgerRevision:ledger,outputAccess:{visibility:'private',audience:['coordinator','user']}},action:batchCommand.result.action};
  assert.equal(runner.commitScopedBatch(replayInput).committed,false);
  assert.throws(()=>runner.commitScopedBatch({...replayInput,action:{...replayInput.action,items:[{...replayInput.action.items[0],target:'coordinator'},...replayInput.action.items.slice(1)]}}),/幂等键冲突/);
  assert.deepEqual(db.get('SELECT count(*) n,SUM(used) used FROM orchestration_token_reservations WHERE run_id=?',second.id),budget);cases.push('command replay preserves original result; changed intent conflicts without budget duplication');
  const receipts=await execute(draft([['aa',1,'material'],['bb',1,'acknowledged'],['cc',1,'result']]));successful(receipts.id);
  assert.deepEqual(delivery.scopedDeliveryStatus(receipts.id).items.map(i=>i.status),['delivered','acknowledged','completed']);
  assert.equal(calls.filter(c=>c.runId===receipts.id&&c.agentId==='aa').length,0);cases.push('material / ACK / result are distinct obligations');
  const invalid=await execute(draft([['aa',1,'result']]),{ackAsResult:true});assert.equal(trace.getRun(invalid.id).status,'failed');assert.equal(delivery.scopedDeliveryStatus(invalid.id).items[0].status,'blocked');cases.push('ACK cannot satisfy result');
  const denied=await execute(draft([['aa',1,'result'],['bb',1,'result']]),{corruptSecond:true});assert.equal(trace.getRun(denied.id).status,'failed');assert.equal(store.listBatches(denied.id).length,0);assert.equal(store.listDispatches(denied.id).length,1);assert.equal(db.get('SELECT count(*) n FROM scoped_delivery_envelopes WHERE run_id=?',denied.id).n,0);cases.push('second item permission drift rolls back whole batch');
  // Confirm commits before any process dispatch; production recovery discovers the pending task.
  const recovered=admit(draft([['aa',1,'result']]));assert.equal(store.listAttempts(recovered.id).length,0);scheduler.recoverCollaborationRuns();await waitFor(()=>trace.getRun(recovered.id).status==='completed');cases.push('commit-before-dispatch recovery');
  const pending=admit(draft([['aa',1,'result'],['bb',1,'result']]));
  const claim=store.claimNextDispatch(room.id,'g2-window');assert.equal(claim.dispatch.runId,pending.id);
  const batchId=await runner.executeScopedDispatch(claim.dispatch,claim.attempt.id,trace.listRunAgentSnapshots(pending.id).find(a=>a.id==='coordinator'));
  assert.ok(batchId);assert.equal(store.listAttempts(pending.id).length,1);
  for(let n=0;n<2;n++){const child=store.claimNextDispatch(room.id,'g2-window');assert.equal(child.dispatch.kind,'fanout');await runner.executeScopedDispatch(child.dispatch,child.attempt.id,trace.listRunAgentSnapshots(pending.id).find(a=>a.id===child.dispatch.targetAgentId));}
  assert.equal(store.getBatch(batchId).resultDispatchId,null);
  scheduler.reconcileCollaborationBatches(pending.id);scheduler.reconcileCollaborationBatches(pending.id);
  assert.equal(store.listDispatches(pending.id).filter(d=>d.kind==='aggregate').length,1);
  scheduler.recoverCollaborationRuns();await waitFor(()=>trace.getRun(pending.id).status==='completed');cases.push('batch commit before child dispatch and child completion before wake are recoverable');
  let release;const blocked={wait:new Promise(r=>{release=r;})};const stopped=admit(draft([['aa',1,'result']]),blocked);scheduler.kickCollaboration(room.id);await waitFor(()=>blocked.entered);
  commitRunTerminal({runId:stopped.id,status:'cancelled',disposition:'cancelled',source:'g2-test',userMessageStatus:'cancelled',prepare:()=>({reasonCodes:['USER_STOP']})});store.cancelCollaborationRun(stopped.id);const stopCount=store.listDispatches(stopped.id).length;release();await new Promise(r=>setTimeout(r,100));
  assert.equal(trace.getRun(stopped.id).status,'cancelled');assert.equal(store.listDispatches(stopped.id).length,stopCount);assert.equal(db.get("SELECT count(*) n FROM messages WHERE run_id=? AND body LIKE 'PRIVATE_RESULT_%'",stopped.id).n,0);cases.push('Stop fences late result and parent wake');
  const unknown=await execute(draft([['aa',1,'result']]),{unknown:true});assert.equal(trace.getRun(unknown.id).status,'failed');assert.equal(db.get("SELECT count(*) n FROM orchestration_token_reservations WHERE run_id=? AND status='unknown'",unknown.id).n,1);assert.equal(calls.filter(c=>c.runId===unknown.id&&c.agentId==='aa').length,1);cases.push('unknown output usage retains reservation and blocks automatic replay');
  assert.throws(()=>delivery.previewScopedDelivery({...draft(),join:'any'},'owner'),/单批次/);
  assert.throws(()=>delivery.previewScopedDelivery({...draft(),returnProfile:'publish-body'},'owner'),/all/);
  assert.throws(()=>delivery.previewScopedDelivery(draft([['aa',1,'result'],['aa',1,'result']]),'owner'),/同批/);
  assert.throws(()=>runner.parseScopedControlCall(tool('agent.complete',{summary:'收到'}),{version:3,type:'complete',summary:''}),/RESULT_REQUIRED/);
  assert.throws(()=>runner.parseScopedControlCall(tool('agent.acknowledge',{envelopeId:'wrong'}),{version:3,type:'acknowledge',envelopeId:'approved'}),/ACK_MISMATCH/);
  assert.throws(()=>runner.parseScopedControlCall(tool('agent.consult',{targets:['aa']}),runner.plannedBatchAction(delivery.getDeliveryPlan(first.id).items)),/ACTION_INVALID|PLAN_MISMATCH/);cases.push('reject multibatch any, release, duplicate member and v2 fallback');
  const original=db.get('SELECT definition FROM agents WHERE id=?','bb').definition;
  db.run('UPDATE agents SET definition=? WHERE id=?',JSON.stringify({...JSON.parse(original),execution:{kind:'external',driver:'claude-sdk',platformTools:[]}}),'bb');
  assert.throws(()=>delivery.previewScopedDelivery(draft(),'owner'),/SDK/);db.run('UPDATE agents SET definition=? WHERE id=?',original,'bb');
  const gate=config.orchestrationRollout.entryMode;config.orchestrationRollout.entryMode='preview';const gated=delivery.previewScopedDelivery(draft(),'owner');assert.throws(()=>delivery.confirmScopedDelivery({previewId:gated.id,fingerprint:gated.fingerprint,clientKey:randomUUID()},'owner'),/仅允许预览/);config.orchestrationRollout.entryMode=gate;cases.push('external backend and closed execution rollout are rejected');
  const stale=delivery.previewScopedDelivery(draft(),'owner');rooms.updateConversationMembers(room.id,{agentIds:room.agentIds,supervisorId:null,defaultReviewerId:null,expectedMembersVersion:room.membersVersion});
  assert.throws(()=>delivery.confirmScopedDelivery({previewId:stale.id,fingerprint:stale.fingerprint,clientKey:randomUUID()},'owner'),/重新预览/);cases.push('preview invalidated by membership revision');
  const Fastify=requireServer('fastify');app=Fastify({logger:false});const {registerAccountRoutes}=await import('../apps/server/src/api/accountRoutes.ts');await registerAccountRoutes(app);await app.ready();
  let res=await app.inject({method:'GET',url:`/api/accounts/scoped-delivery/runs/${first.id}`,headers:{host:'localhost:3010'}});assert.equal(res.statusCode,401);
  res=await app.inject({method:'POST',url:'/api/accounts/session',headers:{host:'localhost:3010','x-gand-bootstrap':'1'}});assert.equal(res.statusCode,200,res.body);
  const headers={host:'localhost:3010',cookie:res.headers['set-cookie'].split(';')[0],'x-gand-csrf':res.json().csrfToken};
  res=await app.inject({method:'POST',url:'/api/accounts/scoped-delivery/preview',headers:{...headers,'x-gand-csrf':''},payload:draft()});assert.equal(res.statusCode,403);
  res=await app.inject({method:'POST',url:'/api/accounts/scoped-delivery/preview',headers:{...headers,origin:'https://evil.invalid'},payload:draft()});assert.equal(res.statusCode,403);
  res=await app.inject({method:'POST',url:'/api/accounts/scoped-delivery/preview',headers,payload:draft([['aa',1,'result']])});assert.equal(res.statusCode,200,res.body);const apiPreview=res.json();
  res=await app.inject({method:'POST',url:'/api/accounts/scoped-delivery/confirm',headers,payload:{previewId:apiPreview.id,fingerprint:apiPreview.fingerprint,clientKey:randomUUID()}});assert.equal(res.statusCode,200,res.body);const apiRun=res.json().runId;await waitFor(()=>trace.getRun(apiRun).status==='completed');
  res=await app.inject({method:'GET',url:`/api/accounts/scoped-delivery/runs/${apiRun}`,headers});assert.equal(res.statusCode,200);assert.match(res.json().items[0].output,/PRIVATE_RESULT_/);cases.push('management preview/confirm/result routes with session, CSRF and Origin checks');
  const costPolicy={version:1,currency:'USD',mode:'estimate',maxCost:1,unknownAction:'stop',prices:['coordinator','aa','bb','cc'].map(id=>({agentId:id,model:'mock:'+id,source:'G2 fixture',version:'1',inputPerMillion:1,outputPerMillion:2,otherCharges:'none'}))};
  const setCost=policy=>{const latest=rooms.getConversation(room.id);rooms.updateRoomPreferences(room.id,{...latest.preferences,constraints:{...latest.preferences.constraints,costPolicy:policy}},latest.membersVersion);};
  setCost(costPolicy);const priced=await execute(draft([['aa',1,'result']]));successful(priced.id);
  assert.equal(db.get('SELECT COUNT(*) n FROM execution_cost_reservations WHERE run_id=?',priced.id).n,3);
  assert.ok(delivery.scopedDeliveryStatus(priced.id).costBudget.run.charged>0);
  assert.equal(delivery.getDeliveryPlan(priced.id).costPolicy.currency,'USD');
  setCost({...costPolicy,mode:'strict'});assert.throws(()=>delivery.previewScopedDelivery(draft(),'owner'),/硬上限/);
  setCost({...costPolicy,prices:[]});assert.throws(()=>delivery.previewScopedDelivery(draft(),'owner'),/价格/);
  cases.push('inherit frozen room money policy; shared cost reservations; strict and unknown-price admission blocked');
  assert.equal(modelErrors.length,0,modelErrors[0]?.stack);assert.equal(networkAttempts,0);
  console.log(JSON.stringify({passed:cases.length,cases,modelCalls:calls.length,networkAttempts,migration:db.get('SELECT MAX(version) v FROM orchestration_schema_migrations').v},null,2));
}finally{await app?.close();await network.close();db.db.close();await rm(root,{recursive:true,force:true});}

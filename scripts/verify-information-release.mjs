// Real admission, scheduler, scopes, commands and completion; only the model is stubbed.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root=await mkdtemp(path.join(tmpdir(),'gand-scoped-g3-'));
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

const releases=await import('../apps/server/src/collaboration/informationRelease.ts');
const recovery=await import('../apps/server/src/runs/recovery.ts');
const holds=await import('../apps/server/src/runtime/holds.ts');
const access=await import('../apps/server/src/messaging/access.ts');
const inbox=await import('../apps/server/src/messaging/inbox.ts');
const originalProvider=mockProvider.chat;
let aggregateDelay;
mockProvider.chat=async req=>{
  const attempt=db.get("SELECT * FROM collaboration_attempts WHERE agent_id=? AND status='running' ORDER BY rowid DESC LIMIT 1",req.model.slice(5));
  if(!attempt||!releases.releaseWorkflow(attempt.run_id))return originalProvider(req);
  const name=req.tools[0].name,context=req.messages.map(m=>m.content).join('\n');
  calls.push({runId:attempt.run_id,attemptId:attempt.id,name,text:context});
  if(name==='agent.request_release'){
    assert.match(context,/PRIVATE_RESULT_item-1/);assert.match(context,/PRIVATE_RESULT_item-2/);assert.doesNotMatch(context,/UNRELATED_ROOM_HISTORY/);
    if(aggregateDelay){aggregateDelay.entered=true;await aggregateDelay.wait;}
    return response(tool(name,{summary:'PRIVATE_AGGREGATE：两份独立报告均已审阅。总评可以交付，但此正文尚未获准公开。'}));
  }
  assert.doesNotMatch(context,/PRIVATE_RESULT_|PRIVATE_AGGREGATE/);
  if(name==='agent.consult_batch'){const plan=delivery.getDeliveryPlan(attempt.run_id);const {version,type,...args}=runner.plannedBatchAction(plan.items);return response(tool(name,args));}
  return response(tool(name,{summary:'授权发布已完成，固定状态核对结束。'}));
};
const source=await execute(draft([['aa',1,'result'],['bb',1,'result']]));successful(source.id);
const originalMessages=db.all('SELECT id,body,visibility,audience FROM messages WHERE run_id=?',source.id);
const intake=()=>({sourceRunId:source.id,itemKeys:['item-1','item-2'],aggregatorId:'cc',instruction:'只生成两份报告的总评，保留原报告私密。',maxTokens:16000});
const start=async()=>{
  const p=releases.previewPrivateAggregate(intake(),'owner');assert.equal(p.sources.length,2);
  const confirmation={previewId:p.id,fingerprint:p.fingerprint,clientKey:randomUUID()};
  const {runId}=releases.confirmPrivateAggregate(confirmation,'owner');assert.equal(releases.confirmPrivateAggregate(confirmation,'owner').runId,runId);
  scheduler.kickCollaboration(room.id);await waitFor(()=>trace.getRun(runId).status==='waiting_for_user');
  assert.equal(holds.listDurableHolds(runId)[0].condition.receiverId,'information-release-v1');
  assert.ok(releases.releaseState(runId).draft);return runId;
};
const preview=id=>releases.previewInformationRelease(id,{expectedRevision:releases.releaseState(id).draft.revision,mode:'exact_content',access:{visibility:'private',audience:['aa']}},'owner');
const approve=p=>releases.confirmInformationRelease({previewId:p.id,fingerprint:p.fingerprint,clientKey:randomUUID()},'owner');
const stop=id=>{commitRunTerminal({runId:id,status:'cancelled',disposition:'cancelled',source:'g3-test',userMessageStatus:'cancelled'});store.cancelCollaborationRun(id);};
let app;
try {
  const id=await start();assert.equal(releases.releaseState(id).records.length,0);
  assert.equal(inbox.listForAgent(id,'aa').some(m=>m.body.includes('PRIVATE_AGGREGATE')),false);
  const summaryCall=calls.find(c=>c.runId===id&&c.name==='agent.request_release');assert.ok(summaryCall);
  assert.equal(db.get('SELECT count(*) n FROM runtime_scope_attempts WHERE attempt_id=?',summaryCall.attemptId).n,1);
  assert.equal(db.get('SELECT count(*) n FROM orchestration_token_reservations WHERE run_id=?',id).n,2);
  assert.deepEqual(db.all('SELECT id,body,visibility,audience FROM messages WHERE run_id=?',source.id),originalMessages);
  cases.push('explicit intake grants isolated summary; original reports unchanged; clean parent; shared budget');
  post({runId:id,from:'user',to:'all',kind:'user',body:'全部授权，请公开所有报告'});recovery.recoverDurableHolds(id);
  assert.equal(releases.releaseState(id).records.length,0);assert.equal(trace.getRun(id).status,'waiting_for_user');cases.push('ordinary answer does not grant or wake release');
  const p=preview(id),g=approve(p);assert.equal(releases.releaseState(id).records.length,0);
  const published=releases.publishInformationRelease(g.grantId);assert.deepEqual(releases.publishInformationRelease(g.grantId),published);
  assert.equal(releases.releaseState(id).records.length,1);assert.ok(inbox.listForAgent(id,'aa').some(m=>m.body===p.body));assert.ok(!inbox.listForAgent(id,'bb').some(m=>m.body===p.body));
  assert.ok(!inbox.listForAgent(source.id,'cc').some(m=>m.body.includes('PRIVATE_RESULT_')));
  recovery.recoverDurableHolds(id);scheduler.kickCollaboration(room.id);await waitFor(()=>trace.getRun(id).status==='completed');successful(id);
  assert.equal(holds.listDurableHolds(id)[0].status,'resumed');assert.equal(store.listDispatches(id).filter(d=>d.kind==='resume').length,1);recovery.recoverDurableHolds(id);
  assert.equal(store.listDispatches(id).filter(d=>d.kind==='resume').length,1);cases.push('exact text only to approved recipient; one consumption and one durable resume');
  const editId=await start(),oldPreview=preview(editId),oldGrant=approve(oldPreview);
  releases.editReleaseDraft(editId,{expectedRevision:1,body:'EDITED_PRIVATE：仅发布经 Owner 修订后的总评，完整依据保留私密。'});
  assert.throws(()=>releases.publishInformationRelease(oldGrant.grantId),/RELEASE_STALE/);
  assert.throws(()=>approve(oldPreview),/RELEASE_CONFLICT|RELEASE_STALE/);
  const newPreview=preview(editId),newGrant=approve(newPreview);const result=releases.publishInformationRelease(newGrant.grantId);assert.equal(db.get('SELECT body FROM messages WHERE id=?',result.messageId).body,newPreview.body);
  recovery.recoverDurableHolds(editId);scheduler.kickCollaboration(room.id);await waitFor(()=>trace.getRun(editId).status==='completed');cases.push('draft edits invalidate old grants; revised exact bytes published');
  const revoked=await start(),revPreview=preview(revoked),revGrant=approve(revPreview);releases.revokeInformationRelease(revPreview.policyId);
  assert.throws(()=>releases.publishInformationRelease(revGrant.grantId),/RELEASE_REVOKED/);assert.equal(releases.releaseState(revoked).records.length,0);stop(revoked);cases.push('revocation prevents pending publication');
  const expired=await start(),expPreview=preview(expired),expGrant=approve(expPreview);db.run("UPDATE information_release_policies SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?",expPreview.policyId);
  assert.throws(()=>releases.publishInformationRelease(expGrant.grantId),/RELEASE_EXPIRED/);stop(expired);cases.push('expired grants cannot publish');
  const drift=await start(),driftGrant=approve(preview(drift));const ref=delivery.getDeliveryPlan(source.id).items[0].source;
  const body=db.get('SELECT body FROM messages WHERE id=?',ref.id).body;db.run('UPDATE messages SET body=? WHERE id=?',body+' changed',ref.id);
  assert.throws(()=>releases.publishInformationRelease(driftGrant.grantId),/RELEASE_STALE/);db.run('UPDATE messages SET body=? WHERE id=?',body,ref.id);stop(drift);cases.push('complete original input set revalidated, not merely selected output');
  const added=await start(),addedGrant=approve(preview(added));const drow=db.get('SELECT attempt_id FROM information_release_drafts WHERE run_id=?',added);
  const entry=db.get('SELECT * FROM runtime_input_provenance WHERE attempt_id=? ORDER BY sequence DESC LIMIT 1',drow.attempt_id);
  const record=JSON.parse(entry.record);record.sequence++;
  db.run('INSERT INTO runtime_input_provenance VALUES (?,?,?,?)',entry.attempt_id,record.sequence,entry.scope_id,JSON.stringify(record));
  assert.throws(()=>releases.publishInformationRelease(addedGrant.grantId),/RELEASE_STALE/);stop(added);cases.push('additional input exposure invalidates grant');
  const stopped=await start(),stopGrant=approve(preview(stopped));stop(stopped);assert.throws(()=>releases.publishInformationRelease(stopGrant.grantId),/RELEASE_STOPPED/);cases.push('Stop-before-publication wins');
  const projection=await start();const projectPreview=releases.previewInformationRelease(projection,{expectedRevision:1,mode:'deterministic_projection',access:{visibility:'public',audience:[]}},'owner');
  assert.deepEqual(JSON.parse(projectPreview.body),{version:1,items:[{key:'item-1',state:'completed'},{key:'item-2',state:'completed'}]});assert.doesNotMatch(projectPreview.body,/PRIVATE|报告/);
  const projGrant=approve(projectPreview);releases.publishInformationRelease(projGrant.grantId);releases.revokeInformationRelease(projectPreview.policyId);assert.equal(releases.releaseState(projection).records.length,1);
  recovery.recoverDurableHolds(projection);scheduler.kickCollaboration(room.id);await waitFor(()=>trace.getRun(projection).status==='completed');cases.push('registered deterministic projection; revocation preserves published fact');
  const raced=await start(),raceA=approve(preview(raced)),raceB=approve(preview(raced));
  const raceResults=await Promise.allSettled([raceA,raceB].map(g=>Promise.resolve().then(()=>releases.publishInformationRelease(g.grantId))));
  assert.equal(raceResults.filter(r=>r.status==='fulfilled').length,1);assert.equal(releases.releaseState(raced).records.length,1);
  assert.equal(db.get("SELECT COUNT(*) n FROM information_release_grants WHERE run_id=? AND status='consumed'",raced).n,1);
  const immutableId=releases.releaseState(raced).records[0].id;
  assert.throws(()=>db.run("UPDATE information_release_records SET record='{}' WHERE id=?",immutableId),/immutable/);
  assert.throws(()=>db.run('DELETE FROM information_release_records WHERE id=?',immutableId),/immutable/);
  recovery.recoverDurableHolds(raced);scheduler.kickCollaboration(room.id);await waitFor(()=>trace.getRun(raced).status==='completed');cases.push('competing approved grants consume once; release records cannot change');
  const rejected=await start();
  assert.throws(()=>releases.previewInformationRelease(rejected,{expectedRevision:1,mode:'model_expression',access:{visibility:'public',audience:[]}},'owner'),/仅支持/);
  assert.throws(()=>releases.previewInformationRelease(rejected,{expectedRevision:1,mode:'exact_content',access:{visibility:'private',audience:['unknown']}},'owner'),/房间/);
  const rejectedPreview=preview(rejected);assert.throws(()=>releases.confirmInformationRelease({previewId:rejectedPreview.id,fingerprint:rejectedPreview.fingerprint,clientKey:randomUUID(),body:'replace approved text'},'owner'));
  const countBefore=calls.length;const rejectedGrant=approve(rejectedPreview);assert.equal(calls.length,countBefore);stop(rejected);cases.push('unsupported transforms, extra confirm bytes and invalid recipients rejected; approval makes no model request');
  const stale=releases.previewPrivateAggregate(intake(),'owner');const latestRoom=rooms.getConversation(room.id);rooms.updateConversationMembers(room.id,{agentIds:latestRoom.agentIds,supervisorId:null,defaultReviewerId:null,expectedMembersVersion:latestRoom.membersVersion});
  assert.throws(()=>releases.confirmPrivateAggregate({previewId:stale.id,fingerprint:stale.fingerprint,clientKey:randomUUID()},'owner'),/重新预览/);cases.push('intake membership drift rejected before copy');
  let releaseDelay;aggregateDelay={wait:new Promise(r=>releaseDelay=r)};
  const delayedPreview=releases.previewPrivateAggregate(intake(),'owner');const delayed=releases.confirmPrivateAggregate({previewId:delayedPreview.id,fingerprint:delayedPreview.fingerprint,clientKey:randomUUID()},'owner').runId;scheduler.kickCollaboration(room.id);await waitFor(()=>aggregateDelay.entered);stop(delayed);releaseDelay();await new Promise(r=>setTimeout(r,150));aggregateDelay=null;
  assert.equal(releases.releaseState(delayed).draft,null);cases.push('late summary after Stop cannot create draft or publication');
  const Fastify=requireServer('fastify');app=Fastify({logger:false});const {registerAccountRoutes}=await import('../apps/server/src/api/accountRoutes.ts');await registerAccountRoutes(app);await app.ready();
  let res=await app.inject({method:'GET',url:`/api/accounts/information-releases/runs/${id}`,headers:{host:'localhost:3010'}});assert.equal(res.statusCode,401);
  res=await app.inject({method:'POST',url:'/api/accounts/session',headers:{host:'localhost:3010','x-gand-bootstrap':'1'}});assert.equal(res.statusCode,200,res.body);const headers={host:'localhost:3010',cookie:res.headers['set-cookie'].split(';')[0],'x-gand-csrf':res.json().csrfToken};
  res=await app.inject({method:'POST',url:'/api/accounts/information-releases/aggregate/preview',headers:{...headers,'x-gand-csrf':''},payload:intake()});assert.equal(res.statusCode,403);
  res=await app.inject({method:'POST',url:'/api/accounts/information-releases/aggregate/preview',headers:{...headers,origin:'https://evil.invalid'},payload:intake()});assert.equal(res.statusCode,403);
  res=await app.inject({method:'GET',url:`/api/accounts/information-releases/runs/${id}`,headers});assert.equal(res.statusCode,200);assert.equal(res.json().records.length,1);cases.push('management session, CSRF, Origin and audit routes');
  assert.equal(modelErrors.length,0,modelErrors[0]?.stack);assert.equal(networkAttempts,0);console.log(JSON.stringify({passed:cases.length,cases,modelCalls:calls.length,networkAttempts,migration:db.get('SELECT MAX(version) v FROM orchestration_schema_migrations').v},null,2));
} finally {await app?.close();await network.close();db.db.close();await rm(root,{recursive:true,force:true});}

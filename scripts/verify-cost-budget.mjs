import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createDemoEnvironment } from './helpers/orchestration-demo-environment.mjs';

Object.assign(process.env,{HOST:'127.0.0.1',PORT:'43220',ACCOUNT_TRUSTED_ORIGINS:'http://127.0.0.1:43220'});
const environment = await createDemoEnvironment();
const db = environment.database;
const entry = await import('../apps/server/src/orchestration/entry.ts');
const trace = await import('../apps/server/src/runs/trace.ts');
const rooms = await import('../apps/server/src/conversations/service.ts');
const coordination = await import('../apps/server/src/coordination/runtime.ts');
const business = await import('../apps/server/src/orchestration/business.ts');
const costs = await import('../apps/server/src/orchestration/costBudget.ts');
const { budgetedChat } = await import('../apps/server/src/orchestration/executionBudget.ts');
const { withBusinessStageExecution } = await import('../apps/server/src/orchestration/businessStageExecution.ts');
const continuation = await import('../apps/server/src/orchestration/continuation.ts');
const rework = await import('../apps/server/src/orchestration/businessRework.ts');
const { readBusinessCheckpoint } = await import('../apps/server/src/orchestration/businessCheckpointStore.ts');
const { mockProvider, OpenAICompatibleProvider, AnthropicProvider } = await import('../apps/server/src/llm/provider.ts');
const { config } = await import('../apps/server/src/config.ts');
if (process.argv.includes('--kernel-off')) config.coordinationRuntime.kernelMode='off';
config.llm.proxy=null;
const { registerAccountRoutes } = await import('../apps/server/src/api/accountRoutes.ts'); await registerAccountRoutes(environment.app);
const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = await import('../apps/server/node_modules/undici/index.js');
const originalDispatcher = getGlobalDispatcher(), dispatcher = new MockAgent(); dispatcher.disableNetConnect(); setGlobalDispatcher(dispatcher);
const price = (agentId='aa') => ({ agentId, model:'mock:'+agentId,source:'fixture tariff, not supplier prices',version:'r5-fixture-v1',inputPerMillion:1,outputPerMillion:2,cacheReadPerMillion:0.5,cacheWritePerMillion:1.5,otherCharges:'none' });
const policy = (patch={}) => ({version:1,currency:'USD',maxCost:10,mode:'estimate',unknownAction:'reserve',unknownReserve:0.1,prices:[price(),price('bb')],...patch});
const response = (usage={tokensIn:1,tokensOut:2,costUsd:0},content='已完成实际分析，结论与验证依据齐全，提供下一步建议。') => ({content,usage,toolCalls:[],truncated:false,stopReason:'end_turn'});
const contract = groups => ({version:1,executionMode:'stage_gated',stages:groups.map((ids,i)=>({id:'phase-'+i,title:'费用阶段 '+i,criteria:['交付完整'],deliverables:[{id:'result',title:'实质结果',kind:'text'}],execution:{assignments:ids.map(agentId=>({agentId,objective:'完成 R5 阶段分析并提供依据'})),maxCost:1}}))});
async function fixture(p=policy(),groups=null,team=groups?[...new Set(groups.flat())]:['aa'],extra={}) {
  const room=rooms.createConversation({title:'R5 isolated',mode:'collaboration',agentIds:team,workspace:null});
  const input={conversationId:room.id,goal:'费用治理的只读测试',agentIds:team,recipientIds:team,strategy:'serial',workflow:'routine',workspace:null,constraints:{readonly:true,costPolicy:p},...(groups?{businessContract:contract(groups)}:{}),...extra};
  input.constraints.costPolicy={...input.constraints.costPolicy,prices:input.constraints.costPolicy.prices.filter(p=>team.includes(p.agentId))};
  const preview=await entry.previewExecutionOrchestration(input);
  assert.deepEqual(preview.decision.issues.filter(i=>i.severity==='error'),[],JSON.stringify(preview.decision.issues));
  return {...entry.submitExecutionOrchestration({...input,entryVersion:1,clientRequestId:randomUUID(),previewId:preview.previewId,orchestrationFingerprint:preview.fingerprint},room.id),input};
}
const request={model:'mock:aa',messages:[{role:'user',content:'fee request'}],maxTokens:10};
const chat=(id,provider,req=request)=>budgetedChat(id,provider,req,undefined,'aa');
const code=(fn,c)=>assert.throws(fn,e=>e.code===c);
const rejection=(fn,c)=>assert.rejects(fn,e=>e.code===c);
function action(id,value){return business.applyBusinessCommand(id,{...value,expectedVersion:business.getBusinessState(id).version,clientRequestId:randomUUID()});}
function deliver(id,stage){const ref=business.listBusinessEvidence(id).find(e=>e.stageId===stage).ref;return action(id,{action:'report',stageId:stage,kind:'delivery',note:'检查实际交付',evidence:[{deliverableId:'result',ref}]});}
function decide(id,stage,verdict='accept'){return action(id,{action:'decide',stageId:stage,reportId:business.getBusinessState(id).stages.find(s=>s.stage.id===stage).report.id,verdict,checkedCriteria:verdict==='accept'?[0]:[],reason:verdict==='accept'?'核对通过':'需要更完整的行动依据'});}
const confirmation=p=>({previewId:p.preview.previewId,orchestrationFingerprint:p.preview.fingerprint,...(p.costCarryDigest?{costCarryDigest:p.costCarryDigest}:{})});
try {
  const { readRoomDraft, writeRoomDraft, emptyPreferences } = await import('../apps/web/src/services/roomDraft.ts');
  const memory=new Map();globalThis.sessionStorage={getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)};
  const draft={...emptyPreferences(),version:2,goal:'保留费用',selected:['aa'],initialTargets:['aa'],workspace:'',title:'draft',constraints:{costPolicy:policy()}};
  writeRoomDraft(draft);assert.deepEqual(readRoomDraft().constraints.costPolicy,policy());
  writeRoomDraft({...draft,constraints:{costPolicy:{...policy(),prices:null}}});assert.equal(readRoomDraft().constraints.costPolicy.mode,'strict');assert.match(readRoomDraft().recoveryNotice,/费用政策损坏/);assert.ok(memory.get('gand:room-draft:recovery'));
  delete globalThis.sessionStorage;
  // Admission never silently downgrades strict cost controls, including the API backend.
  const room=rooms.createConversation({title:'fee admission',mode:'collaboration',agentIds:['aa','sdk','codex'],workspace:null});
  for(const id of room.agentIds){
    const before=environment.calls.length;
    const input={conversationId:room.id,goal:'strict cost',recipientIds:[id],strategy:'serial',workflow:'routine',constraints:{readonly:true,costPolicy:policy({mode:'strict',prices:[]})}};
    const p=await entry.previewExecutionOrchestration(input);
    assert.ok(p.decision.issues.some(i=>i.code==='HARD_COST_LIMIT_UNSUPPORTED'));assert.equal(environment.calls.length,before);
    code(()=>entry.submitExecutionOrchestration({...input,clientRequestId:randomUUID(),entryVersion:1,previewId:p.previewId,orchestrationFingerprint:p.fingerprint},room.id),'PREVIEW_INVALID');
    code(()=>entry.submitExecutionOrchestration({...input,clientRequestId:randomUUID(),entryVersion:1},room.id),'PLAN_CONFIRMATION_REQUIRED');
  }
  const stop=await entry.previewExecutionOrchestration({conversationId:room.id,goal:'unknown cost',recipientIds:['sdk'],strategy:'serial',workflow:'routine',constraints:{readonly:true,costPolicy:policy({unknownAction:'stop',unknownReserve:undefined,prices:[]})}});
  assert.ok(stop.decision.issues.some(i=>i.code==='COST_ESTIMATE_UNKNOWN'&&i.severity==='error'));
  const plannerRoom=rooms.createConversation({title:'fee planner',mode:'collaboration',agentIds:['planner','aa'],workspace:null});
  const plannerInput={conversationId:plannerRoom.id,goal:'生成主管计划',strategy:'serial',workflow:'supervisor_decomposition',supervisorId:'planner',constraints:{readonly:true,costPolicy:policy({prices:[]})}};
  const plannerPreview=await entry.previewExecutionOrchestration(plannerInput);assert.ok(plannerPreview.decision.issues.some(i=>i.code==='COST_PLANNING_UNSUPPORTED'));
  const beforePlanning=environment.calls.length;await assert.rejects(()=>entry.previewExecutionOrchestration({...plannerInput,planning:'detailed'}));assert.equal(environment.calls.length,beforePlanning);
  for(const invalid of [{currency:'EUR'},{maxCost:0},{unknownReserve:-1},{prices:[price(),price()]},{prices:[{...price(),version:''}]},{maxCost:0.0000001}])await rejection(()=>entry.previewExecutionOrchestration({conversationId:room.id,goal:'invalid',constraints:{costPolicy:policy(invalid)}}),'INVALID_COST_POLICY');

  // Simultaneous requests reserve atomically. A losing request has no provider or token side effect.
  const f=await fixture(policy({maxCost:0.004,unknownAction:'stop',unknownReserve:undefined}));let release;
  const pending=new Promise(resolve=>release=resolve);let io=0;
  const provider={chat:async()=>{io++;await pending;return response();}};
  const first=chat(f.run.id,provider),second=chat(f.run.id,provider);
  await Promise.resolve();await Promise.resolve();assert.equal(io,2);assert.equal(costs.costBudgetState(f.run.id).run.pendingCalls,2);
  await rejection(()=>chat(f.run.id,provider),'COST_BUDGET_RESERVED');assert.equal(io,2);
  release();await Promise.all([first,second]);assert.equal(costs.costBudgetState(f.run.id).run.calculated,0.00001);assert.equal(costs.costBudgetState(f.run.id).run.pending,0);
  const strictSaved=db.get('SELECT snapshot FROM orchestration_requests WHERE run_id=?',f.run.id).snapshot;
  const strictFrozen=JSON.parse(strictSaved);strictFrozen.request.constraints.costPolicy.mode='strict';db.run('UPDATE orchestration_requests SET snapshot=? WHERE run_id=?',JSON.stringify(strictFrozen),f.run.id);
  await rejection(()=>chat(f.run.id,provider),'HARD_COST_LIMIT_UNSUPPORTED');assert.equal(io,2);db.run('UPDATE orchestration_requests SET snapshot=? WHERE run_id=?',strictSaved,f.run.id);
  const atomic=await fixture(policy({maxCost:0.000001}),null,['aa'],{constraints:{readonly:true,maxTokens:20,costPolicy:policy({maxCost:0.000001})}});
  await rejection(()=>chat(atomic.run.id,provider),'COST_BUDGET_EXHAUSTED');assert.equal(db.all('SELECT * FROM orchestration_token_reservations WHERE run_id=?',atomic.run.id).length,0);assert.equal(costs.costRows(atomic.run.id).length,0);

  // Unknown price, partial/missing usage, cancellation, failed I/O and genuine reported zero.
  const unknown=await fixture(policy({prices:[]}));const noUsage={chat:async()=>response({tokensIn:0,tokensOut:0,costUsd:0,inputKnown:false,outputKnown:false,costKnown:false})};
  await chat(unknown.run.id,noUsage);assert.equal(costs.costBudgetState(unknown.run.id).run.unknown,0.1);assert.equal(costs.costRows(unknown.run.id)[0].known,null);
  const partial=await fixture();await chat(partial.run.id,{chat:async()=>response({tokensIn:3,tokensOut:0,costUsd:0,inputKnown:true,outputKnown:false,costKnown:false})});
  assert.equal(costs.costBudgetState(partial.run.id).run.calculated,0.000003);assert.equal(costs.costBudgetState(partial.run.id).run.unknownCalls,1);assert.equal(costs.costBudgetState(partial.run.id).run.charged,costs.costRows(partial.run.id)[0].reserved/1e6);
  const zero=await fixture();await chat(zero.run.id,{chat:async()=>response({tokensIn:0,tokensOut:0,costUsd:0,inputKnown:true,outputKnown:true})});assert.equal(costs.costRows(zero.run.id)[0].status,'settled');assert.equal(costs.costRows(zero.run.id)[0].known,0);
  const stopped=await fixture(policy({unknownAction:'stop',unknownReserve:undefined}));await chat(stopped.run.id,noUsage);await rejection(()=>chat(stopped.run.id,provider),'COST_RESULT_UNKNOWN');
  const cancelled=await fixture();await assert.rejects(()=>chat(cancelled.run.id,{chat:async()=>{throw new Error('cancelled after supplier request');}}));assert.equal(costs.costRows(cancelled.run.id)[0].status,'unknown');
  const aborted=await fixture();await assert.rejects(()=>chat(aborted.run.id,provider,{...request,signal:AbortSignal.abort()}));assert.equal(costs.costRows(aborted.run.id).length,0);
  const overrun=await fixture(policy({maxCost:0.01}));await chat(overrun.run.id,{chat:async()=>response({tokensIn:20_000,tokensOut:0,costUsd:0})});assert.equal(costs.costBudgetState(overrun.run.id).run.exceeded,true);await rejection(()=>chat(overrun.run.id,provider),'COST_BUDGET_EXHAUSTED');

  // Real provider parsers through undici MockAgent, including streaming usage and cache charges.
  config.llm.pricing={};const pool=dispatcher.get('http://fee-parser.invalid');
  const api=new OpenAICompatibleProvider('fixture-not-real','http://fee-parser.invalid');
  pool.intercept({path:'/chat/completions',method:'POST'}).reply(200,{choices:[{message:{content:'full'},finish_reason:'stop'}]},{headers:{'content-type':'application/json'}});
  const missing=await api.chat({...request,model:'openai:fixture'});assert.equal(missing.usage.inputKnown,false);assert.equal(missing.usage.costKnown,false);
  const sse=[{choices:[{delta:{content:'stream'},finish_reason:'stop'}]},{usage:{prompt_tokens:100,completion_tokens:10,prompt_tokens_details:{cached_tokens:80}},choices:[]}].map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')+'data: [DONE]\n\n';
  pool.intercept({path:'/chat/completions',method:'POST'}).reply(200,sse,{headers:{'content-type':'text/event-stream'}});
  const cached=await api.chat({...request,model:'openai:fixture'});assert.equal(cached.usage.tokensIn,100);assert.equal(cached.usage.inputBaseTokens,20);assert.equal(cached.usage.cacheReadTokens,80);
  const cache=await fixture();const cacheRow=costs.reserveCost(cache.run.id,'aa','mock:aa','builtin-llm',request);costs.settleCost(cacheRow,cached.usage);assert.equal(costs.costRows(cache.run.id)[0].known,80);assert.equal(costs.costRows(cache.run.id)[0].status,'settled');
  const cacheMissing=await fixture(policy({prices:[{...price(),cacheReadPerMillion:undefined}]}));const cm=costs.reserveCost(cacheMissing.run.id,'aa','mock:aa','builtin-llm',request);costs.settleCost(cm,cached.usage);assert.equal(costs.costRows(cacheMissing.run.id)[0].status,'unknown');
  const anthropic=new AnthropicProvider('fixture-not-real','http://fee-parser.invalid');
  pool.intercept({path:'/v1/messages',method:'POST'}).reply(200,[{type:'message_start',message:{usage:{input_tokens:0,cache_read_input_tokens:4}}},{type:'content_block_start',index:0,content_block:{type:'text',text:'text'}},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{input_tokens:3,output_tokens:2}}].map(x=>'data: '+JSON.stringify(x)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
  const anth=await anthropic.chat({...request,model:'anthropic:fixture'});assert.equal(anth.usage.tokensIn,7);assert.equal(anth.usage.inputBaseTokens,3);assert.equal(anth.usage.outputKnown,true);
  pool.intercept({path:'/v1/messages',method:'POST'}).reply(200,{content:[{type:'text',text:'text'}],usage:{input_tokens:3,output_tokens:2,server_tool_use:{web_search_requests:1}}},{headers:{'content-type':'application/json'}});
  const extra=await anthropic.chat({...request,model:'anthropic:fixture'});assert.equal(extra.usage.billingComplete,false);
  const extraRow=costs.reserveCost(cache.run.id,'aa','mock:aa','builtin-llm',request);costs.settleCost(extraRow,extra.usage);assert.equal(costs.costRows(cache.run.id).at(-1).status,'unknown');dispatcher.assertNoPendingInterceptors();
  for(const usage of [{prompt_tokens:3,completion_tokens:2,prompt_tokens_details:{cached_tokens:-1}},{prompt_tokens:3,completion_tokens:2,prompt_tokens_details:{cached_tokens:9}},{prompt_tokens:3,completion_tokens:2,future_tool_requests:1},{prompt_tokens:3,completion_tokens:2.5}]) {
    pool.intercept({path:'/chat/completions',method:'POST'}).reply(200,{choices:[{message:{content:'text'},finish_reason:'stop'}],usage},{headers:{'content-type':'application/json'}});
    const parsed=await api.chat({...request,model:'openai:fixture'});const row=costs.reserveCost(cache.run.id,'aa','mock:aa','builtin-llm',request);costs.settleCost(row,parsed.usage);assert.equal(db.get('SELECT status FROM execution_cost_reservations WHERE id=?',row.id).status,'unknown');
  }
  dispatcher.assertNoPendingInterceptors();

  // Stage limits inherit currency and policy. Actual SDK/Codex turns reserve before invocation.
  const stage=await fixture(policy(),[['aa']]);const narrow={...stage.input.businessContract.stages[0],execution:{...stage.input.businessContract.stages[0].execution,maxCost:0.000001}};
  const saved=db.get('SELECT snapshot FROM orchestration_requests WHERE run_id=?',stage.run.id).snapshot;const frozen=JSON.parse(saved);frozen.request.businessContract.stages[0]=narrow;db.run('UPDATE orchestration_requests SET snapshot=? WHERE run_id=?',JSON.stringify(frozen),stage.run.id);
  await rejection(()=>withBusinessStageExecution(stage.run.id,narrow,()=>chat(stage.run.id,provider)),'COST_BUDGET_EXHAUSTED');assert.equal(costs.costRows(stage.run.id).length,0);db.run('UPDATE orchestration_requests SET snapshot=? WHERE run_id=?',saved,stage.run.id);
  for(const [id,currency] of [['sdk','USD'],['codex','USD'],['sdk','CNY']]){
    const native=await fixture(policy({currency,prices:[]}),[[id]], [id]);await coordination.runCoordinationPlan(native.run,native.run.goal);
    const rows=costs.costRows(native.run.id);assert.equal(rows.length,1);assert.equal(rows[0].stage_id,'phase-0');assert.equal(rows[0].reserved,100000);
    if(id==='sdk'&&currency==='USD'){assert.equal(rows[0].status,'settled');assert.equal(rows[0].known,10000);assert.equal(rows[0].cost_source,'reported');}else{assert.equal(rows[0].status,'unknown');assert.equal(rows[0].known,null);}
  }

  // Checkpoint lineage never resets known or unknown charges; repeated/restarted confirmation is unique.
  let fail=true;mockProvider.chat=async req=>{environment.calls.push({model:req.model});if(req.model==='mock:bb'&&fail)throw new Error('R5 read-only peer timeout');return response();};
  const original=await fixture(policy(),[['aa'],['aa','bb']]);await coordination.runCoordinationPlan(original.run,original.run.goal);deliver(original.run.id,'phase-0');decide(original.run.id,'phase-0');await assert.rejects(()=>coordination.resumeCoordinationRun(original.run.id));
  const sourceRows=costs.costRows(original.run.id),sourceRun=trace.getRun(original.run.id),sourceFee=costs.costBudgetState(original.run.id).run.charged;
  const p=await continuation.previewRunContinuation(original.run.id,true);assert.equal(p.checkpoint.business.costBudget.run.charged,sourceFee);const countRuns=db.get('SELECT COUNT(*) n FROM runs').n;
  db.run("CREATE TRIGGER r5_carry_failure BEFORE INSERT ON execution_cost_reservations WHEN NEW.source_reservation_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'r5-carry-rollback'); END");
  assert.throws(()=>continuation.submitRunContinuation(original.run.id,confirmation(p),true),/r5-carry-rollback/);assert.equal(db.get('SELECT COUNT(*) n FROM runs').n,countRuns);assert.equal(db.get('SELECT 1 FROM orchestration_run_continuations WHERE source_run_id=?',original.run.id),undefined);db.run('DROP TRIGGER r5_carry_failure');
  const successor=continuation.submitRunContinuation(original.run.id,confirmation(p),true);assert.equal(continuation.submitRunContinuation(original.run.id,confirmation(p),true).run.id,successor.run.id);assert.equal(costs.costBudgetState(successor.run.id).run.charged,sourceFee);
  await assert.rejects(()=>coordination.runCoordinationPlan(successor.run,successor.run.goal));assert.equal(costs.costRows(successor.run.id).filter(r=>r.source_reservation_id).length,sourceRows.length);
  const p2=await continuation.previewRunContinuation(successor.run.id,true),secondRun=continuation.submitRunContinuation(successor.run.id,confirmation(p2),true);fail=false;
  assert.equal(new Set(costs.costRows(secondRun.run.id).map(r=>r.source_reservation_id)).size,costs.costRows(secondRun.run.id).length);const callCount=environment.calls.length;await coordination.runCoordinationPlan(secondRun.run,secondRun.run.goal);assert.equal(environment.calls.length,callCount+1);assert.deepEqual(costs.costRows(original.run.id),sourceRows);assert.deepEqual(trace.getRun(original.run.id),sourceRun);
  const cold=execFileSync(process.execPath,['--import','./apps/server/node_modules/tsx/dist/loader.mjs','--input-type=module','-e',"const {costBudgetState}=await import('./apps/server/src/orchestration/costBudget.ts');const {readBusinessCheckpoint}=await import('./apps/server/src/orchestration/businessCheckpointStore.ts');console.log(JSON.stringify({fees:costBudgetState(process.env.R5_RUN),cp:readBusinessCheckpoint(process.env.R5_RUN).costs.length}));const {closeDatabase}=await import('./apps/server/src/db/database.ts');closeDatabase();"],{env:{...process.env,R5_RUN:secondRun.run.id},encoding:'utf8'});assert.equal(JSON.parse(cold).fees.run.charged,costs.costBudgetState(secondRun.run.id).run.charged);assert.equal(JSON.parse(cold).cp,readBusinessCheckpoint(secondRun.run.id).costs.length);
  deliver(secondRun.run.id,'phase-1');decide(secondRun.run.id,'phase-1','reject');const reworkInput={stageId:'phase-1',reportId:business.getBusinessState(secondRun.run.id).stages[1].report.id,expectedVersion:business.getBusinessState(secondRun.run.id).version,instruction:'补充更完整的结论与行动验证依据'};
  const rp=await rework.previewBusinessRework(secondRun.run.id,reworkInput,true),reworked=rework.submitBusinessRework(secondRun.run.id,{...reworkInput,...confirmation(rp)},true);assert.equal(costs.costBudgetState(reworked.run.id).run.charged,costs.costBudgetState(secondRun.run.id).run.charged);assert.equal(trace.getRun(secondRun.run.id).status,'cancelled');await coordination.runCoordinationPlan(reworked.run,reworked.run.goal);

  const pendingRun=await fixture();const reservation=costs.reserveCost(pendingRun.run.id,'aa','mock:aa','builtin-llm',request);costs.recoverCostReservations();assert.equal(costs.costRows(pendingRun.run.id)[0].status,'unknown');assert.equal(costs.costBudgetState(pendingRun.run.id).run.charged,reservation.reserved/1e6);assert.throws(()=>costs.carryCosts(pendingRun.run.id,[{...sourceRows[0],currency:'CNY'}]),/政策|币种/);
  const blockedStop=await fixture(policy({unknownAction:'stop',unknownReserve:undefined}));await chat(blockedStop.run.id,noUsage);code(()=>costs.costCarry(blockedStop.run.id),'COST_RESULT_UNKNOWN');
  const host={host:'127.0.0.1:43220'};const url=`/api/accounts/business/${original.run.id}/cost-budget`;
  assert.equal((await environment.app.inject({method:'GET',url,headers:host})).statusCode,401);
  const session=await environment.app.inject({method:'POST',url:'/api/accounts/session',headers:{...host,'x-gand-bootstrap':'1'}});const auth={...host,cookie:session.headers['set-cookie'].split(';')[0]};
  const audit=await environment.app.inject({method:'GET',url,headers:auth});assert.equal(audit.statusCode,200,audit.body);assert.equal(audit.headers['cache-control'],'no-store');assert.equal(audit.json().budget.run.charged,sourceFee);assert.equal(audit.json().records[0].pricing.version,'r5-fixture-v1');
  assert.equal((await environment.app.inject({method:'GET',url,headers:{...auth,origin:'https://bad.invalid'}})).statusCode,403);
  assert.equal(db.get('SELECT MAX(version) n FROM orchestration_schema_migrations').n,10);assert.equal(environment.externalRequests,0);
  console.log(`R5 verified (${config.coordinationRuntime.kernelMode}): strict/unknown admission and runtime, atomic concurrent Run/stage fee reservations, complete/partial/missing/malformed usage and caching, failed/cancelled calls, SDK/Codex reported/unknown fees and no FX, immutable multi-generation continuation/rework carry, rollback/idempotency/cold read, owner budget audit. Mock inference and local stdio only; real supplier requests 0.`);
} finally { setGlobalDispatcher(originalDispatcher);await dispatcher.close();await environment.close(); }

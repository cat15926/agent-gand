import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import { createFakeThreadedResources } from './fixtures/threadedFakeExecutor.mjs';

const root=await realpath(await mkdtemp(path.join(tmpdir(),'threaded-backends-')));
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',
  DB_PATH:path.join(root,'unused.sqlite'),AGENTS_DIR:path.join(root,'agents')});
const nativeFetch=globalThis.fetch;let externalCalls=0;
globalThis.fetch=async(url,...args)=>{
  if(new URL(String(url)).hostname!=='127.0.0.1'){externalCalls++;throw new Error('External network forbidden');}
  return nativeFetch(url,...args);
};
const {config}=await import('../apps/server/src/config.ts');config.sandboxDir=path.join(root,'sandbox');
const {applyOrchestrationSchemaMigrations}=await import('../apps/server/src/db/orchestrationMigrations.ts');
const {createThreadedStore}=await import('../apps/server/src/threaded/store.ts');
const {createThreadedMessages}=await import('../apps/server/src/threaded/messages.ts');
const {createThreadedAuthority}=await import('../apps/server/src/threaded/authority.ts');
const {createThreadedLifecycle}=await import('../apps/server/src/threaded/lifecycle.ts');
const {createThreadedBudget}=await import('../apps/server/src/threaded/budget.ts');
const {createApiBackend}=await import('../apps/server/src/threaded/backends/api.ts');
const {createClaudeSdkBackend}=await import('../apps/server/src/threaded/backends/claudeSdk.ts');
const {createThreadedBackendRegistry}=await import('../apps/server/src/threaded/backends/registry.ts');
const {parseBackendResponse,backendUrl}=await import('../apps/server/src/threaded/backends/http.ts');
const {createThreadedBackendEvidence,verifyThreadedBackendUsage,verifyThreadedBackendResourceEvidence,
  verifyThreadedBackendDelivery}=await import('../apps/server/src/threaded/backends/evidence.ts');
const schema=await readFile(new URL('../apps/server/src/db/schema.sql',import.meta.url),'utf8');
const databases=[],checks=[];
const answer=(text='fixture answer',tokens=7,tools=[])=>({id:randomUUID(),type:'message',role:'assistant',
  content:[{type:'text',text},...tools.map(tool=>({type:'tool_use',...tool}))],
  stop_reason:tools.length?'tool_use':'end_turn',usage:{input_tokens:11,output_tokens:tokens}});
const response=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
async function fixture(kind='api') {
  const db=new Database(':memory:');databases.push(db);db.pragma('foreign_keys=ON');db.exec(schema);
  db.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER');applyOrchestrationSchemaMigrations(db);
  db.prepare("INSERT INTO agents(id,name,definition,source,created_at,updated_at) VALUES('aa','aa',?,'fixture','now','now')")
    .run(JSON.stringify({id:'aa',version:1,model:'anthropic:fixture',enabled:true,tools:[],permissionMode:'readonly'}));
  const store=createThreadedStore(db),thread=store.createThread({title:'backends',members:[{agentId:'aa',handle:'aa',roleVersion:1,permissionVersion:1}]});
  db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(thread.id);
  const resources=createFakeThreadedResources(),authority=createThreadedAuthority(db,resources);
  const evidence=createThreadedBackendEvidence(db);
  const budget=createThreadedBudget(db,{authority,resources,verifyUsage:(binding,auth,usage)=>verifyThreadedBackendUsage(db,binding,auth,usage)});
  const lifecycle=createThreadedLifecycle(db,authority,{resources,onOutcomeWithinTransaction:(binding,outcome)=>
    budget.settleOutcomeWithinTransaction(binding,authorization.id,outcome)});
  const messages=createThreadedMessages(db,{authority});
  const source=messages.acceptUserMessage({ownerId:thread.ownerId,threadId:thread.id,clientRequestId:randomUUID(),body:'fixture',targets:['aa']});
  const rootBudget=budget.ensureRootForMessage(source.message.id);
  const inv=lifecycle.createInvocation({ownerId:thread.ownerId,threadId:thread.id,agentId:'aa',causalRootId:rootBudget.id,goal:'fixture'});
  const claim=resources.acquire({ownerId:thread.ownerId,threadId:thread.id,agentId:'aa',invocationId:inv.id,runId:inv.runId});
  const quote={maxOutputTokens:128,estimatedCostMicrousd:1000,pricingReference:'fixture-price'};
  let authorization,binding;
  db.transaction(()=>{
    authorization=budget.reserveAdmission({invocationId:inv.id,attemptId:claim.attemptId,sourceMessageId:source.message.id,quote,claim});
    binding=lifecycle.prepareAttempt({ownerId:thread.ownerId,invocationId:inv.id,claim});
    lifecycle.startAttempt(binding);budget.beginAttemptActivity(binding,authorization.id);
  }).immediate();
  const home=path.join(root,randomUUID());await mkdir(home);
  let current=null;const controller=new AbortController(),deliveries=[],events=[],requests=[];
  const prepared={kind,model:'anthropic:fixture',instructions:'fixture instructions',serializedContext:JSON.stringify({messages:[{id:source.message.id,body:'authorized exact payload'}]}),
    contextManifestId:randomUUID(),maxOutputTokens:128,maxRequests:6,apiProtocol:'anthropic-messages',
    connection:{baseUrl:'https://fixture.invalid/api/anthropic',headers:{'x-api-key':'fixture-not-a-secret'},timeoutMs:1000},
    price:{inputPerMillion:1,outputPerMillion:2},
    session:{bindingId:randomUUID(),nativeId:kind==='api'?null:randomUUID(),version:1,backendVersion:kind==='api'?'api-v1':'0.3.288',cwd:home,configDir:home,resume:false},
    assertCurrent(){authority.assertAuthorized(binding);},
    delivery(status,reference){deliveries.push({status,reference});},
    nativeEvent(event){events.push(event);if(event.type==='bound'&&event.nativeId!==prepared.session.nativeId)throw new Error('unexpected native id');},
    requests:{
      begin(key,description) {
        return db.transaction(()=>{
          budget.assertAttemptAuthorized(binding);
          const first=budget.getAuthorization(authorization.id);
          const auth=first.executionState==='reserved'?first:budget.reserveRequest(binding,key,{...quote,maxOutputTokens:description.maxOutputTokens});
          budget.markStartedWithinTransaction(binding,auth.id);current=auth.id;requests.push({key,description,id:auth.id});
          return {id:auth.id,maxOutputTokens:auth.maxOutputTokens};
        }).immediate();
      },
      settle(id,usage){budget.settleRequest(binding,id,usage);current=null;},
      unknown(id){budget.markRequestUnknown(binding,id);},
    }};
  const input={binding,contextManifestId:prepared.contextManifestId,sessionBindingId:prepared.session.bindingId,
    budgetAuthorizationId:authorization.id,signal:controller.signal,
    assertAuthorized(){if(controller.signal.aborted)throw new Error('aborted');authority.assertAuthorized(binding);budget.assertAttemptAuthorized(binding);
      if(current)budget.assertAuthorized(current,binding);},
    onEvent(){},setBudgetAuthorization(id){current=id;}};
  const options={loadInput:()=>prepared,evidence,recordQuiescence(_binding,value){
    assert.equal(verifyThreadedBackendResourceEvidence(db,{request:{mode:'threaded'},identity:claim},value),true);
    return resources.quiescent(binding,{reason:value.reason,sideEffects:value.sideEffects});
  }};
  return {db,resources,authority,budget,lifecycle,rootBudget,authorization,binding,claim,evidence,prepared,input,options,
    deliveries,events,requests,controller,usage:()=>budget.getUsage(rootBudget.id)};
}
const rows=f=>f.db.prepare('SELECT * FROM threaded_backend_requests ORDER BY rowid').all();
async function fakeSdk(input,calls=1,parallel=false) {
  const token=randomUUID();input.onProcess({pid:process.pid,token});
  try {
    input.onRecord({type:'system',subtype:'init',session_id:input.nativeId,tools:['Read','Grep','Glob']});
    const send=async()=>{
      const result=await globalThis.fetch(input.environment.ANTHROPIC_BASE_URL+'/v1/messages',{method:'POST',
        headers:{'x-api-key':input.environment.ANTHROPIC_API_KEY,'content-type':'application/json'},
        body:JSON.stringify({model:input.model,max_tokens:input.maxOutputTokens,messages:[{role:'user',content:input.prompt}]})});
      if(!result.ok)throw new Error('metered SDK request failed');await result.text();
    };
    if(parallel)await Promise.all(Array.from({length:calls},send));
    else for(let index=0;index<calls;index++)await send();
    input.onRecord({type:'result',subtype:'success',session_id:input.nativeId,uuid:randomUUID(),
      result:'SDK protocol fixture',total_cost_usd:999999,usage:{output_tokens:999999}});
    input.onRecord({type:'threaded_checkpoint',sessionId:input.nativeId,anchorUuid:randomUUID(),inputUserUuid:randomUUID()});
  }finally{input.onProcessStopped(token);}
}
try {
  {
    const f=await fixture();let calls=0;
    const backend=createApiBackend({...f.options,fetch:async(url,init)=>{
      calls++;assert.equal(url,'https://fixture.invalid/api/anthropic/v1/messages');
      assert.equal(JSON.parse(init.body).messages[0].content,f.prepared.serializedContext);
      assert.equal(f.usage().actualRequests,1);return response(answer());
    }});
    assert.equal(f.usage().actualRequests,0,'Attempt startup is not an actual HTTP call');
    const outcome=await backend.execute(f.input);assert.equal(outcome.kind,'completed');f.lifecycle.recordOutcome(f.binding,outcome);
    assert.equal(calls,1);assert.equal(f.usage().outputTokens,7);assert.equal(f.usage().costMicrousd,25);
    assert.equal(f.resources.isHeld(f.binding),false);assert.equal(f.deliveries[0].status,'delivered');
    const manifest={id:f.prepared.contextManifestId,payloadHash:rows(f)[0].payload_hash,session:{nativeId:null}};
    assert.equal(verifyThreadedBackendDelivery(f.db,f.binding,manifest,{status:'delivered',evidence:{reference:f.deliveries[0].reference}}),true);
    checks.push('API exact serialized context, pre-I/O reservation, real per-request usage receipt and final proof settle through the lifecycle without legacy Run handling');
  }
  {
    const f=await fixture();let calls=0;f.prepared.tools=[{name:'read_fixture',description:'fixture',parameters:{type:'object'}}];
    f.prepared.executeTool=async()=>{f.budget.checkpointAttempt(f.binding);return 'safe tool output';};
    const backend=createApiBackend({...f.options,fetch:async(_url,init)=>{
      calls++;const body=JSON.parse(init.body);
      if(calls===1)return response(answer('tool',3,[{id:'tool-1',name:'read_fixture',input:{}}]));
      assert.equal(body.messages.at(-1).content[0].type,'tool_result');return response(answer('final',4));
    }});
    const outcome=await backend.execute(f.input);assert.equal(outcome.kind,'completed');f.lifecycle.recordOutcome(f.binding,outcome);
    assert.deepEqual([f.usage().invocations,f.usage().attempts,f.usage().actualRequests],[1,1,2]);
    assert.equal(f.usage().outputTokens,7);assert.equal(rows(f).length,2);
    checks.push('API tool loop reserves each HTTP separately and continues Attempt heartbeats after the initial request is settled');
  }
  {
    const f=await fixture();f.prepared.apiProtocol='openai-chat-completions';f.prepared.model='openai:fixture';
    let calls=0;const backend=createApiBackend({...f.options,fetch:async()=>{calls++;return new Response('bad request',{status:400});}});
    const outcome=await backend.execute(f.input);assert.equal(outcome.kind,'failed');assert.equal(calls,1);
    assert.equal(rows(f)[0].state,'complete');assert.equal(rows(f)[0].delivered,0);assert.equal(f.deliveries[0].status,'unknown');
    assert.equal(f.usage().costMicrousd,1000);
    assert.equal(verifyThreadedBackendDelivery(f.db,f.binding,{id:f.prepared.contextManifestId,payloadHash:rows(f)[0].payload_hash,
      session:{nativeId:null}},{status:'unknown',evidence:{reference:f.deliveries[0].reference}}),true);
    checks.push('HTTP 400 does not hide a compatibility retry; complete rejection retains unknown billing and unknown delivery rather than leaving a sending-only receipt');
  }
  {
    const f=await fixture();const backend=createApiBackend({...f.options,fetch:async()=>new Response(
      'data: '+JSON.stringify({type:'message_start',message:{id:'partial',usage:{input_tokens:9}}})+'\n\n',
      {headers:{'content-type':'text/event-stream'}})});
    const outcome=await backend.execute(f.input);assert.equal(outcome.kind,'unknown');assert.equal(rows(f)[0].state,'unknown');
    assert.throws(()=>f.evidence.quiescence(f.binding),/UNCONFIRMED/);
    assert.equal(f.resources.isHeld(f.binding),true);
    checks.push('Truncated stream and missing terminal confirmation retain unknown execution and cannot produce a release proof');
  }
  {
    const f=await fixture();let calls=0;
    f.prepared.tools=[{name:'read_fixture',description:'fixture',parameters:{}}];f.prepared.executeTool=async()=> 'safe';
    const backend=createApiBackend({...f.options,fetch:async()=>{
      if(++calls===1)return response(answer('tool',3,[{id:'t1',name:'read_fixture',input:{}}]));
      throw new Error('unknown remote request');
    }});
    const outcome=await backend.execute(f.input);assert.equal(outcome.kind,'unknown');f.lifecycle.recordOutcome(f.binding,outcome);
    const ledger=f.db.prepare('SELECT execution_state,usage_state,known_output FROM threaded_budget_requests ORDER BY rowid').all();
    assert.equal(ledger[0].execution_state,'quiescent');assert.equal(ledger[0].usage_state,'settled');assert.equal(ledger[0].known_output,3);
    assert.equal(ledger[1].execution_state,'unknown');assert.equal(f.usage().actualRequests,2);
    checks.push('A later actual request becoming unknown preserves the first request’s confirmed usage and keeps the Attempt fence');
  }
  {
    const f=await fixture();const backend=createApiBackend({...f.options,fetch:async()=>response(answer())});
    await backend.execute(f.input);const row=rows(f)[0];
    const usage={outputTokens:7,costMicrousd:25,evidenceReference:`threaded-backend-request:${row.id}`};
    assert.equal(verifyThreadedBackendUsage(f.db,f.binding,f.budget.getAuthorization(f.authorization.id),usage),true);
    assert.equal(verifyThreadedBackendUsage(f.db,{...f.binding,generation:99},f.budget.getAuthorization(f.authorization.id),usage),false);
    assert.equal(verifyThreadedBackendUsage(f.db,f.binding,f.budget.getAuthorization(f.authorization.id),{...usage,costMicrousd:0}),false);
    assert.throws(()=>f.db.prepare('UPDATE threaded_backend_requests SET output_tokens=0 WHERE id=?').run(row.id),/IMMUTABLE/);
    checks.push('Usage receipts bind the exact persisted request and fencing identity; changed usage, another generation and SQL mutation are rejected');
  }
  {
    const f=await fixture('claude-sdk');let upstream=0;
    const backend=createClaudeSdkBackend({...f.options,fetch:async()=>{upstream++;return response(answer('SDK',5));},
      sdkProcess:input=>fakeSdk(input,2),processGroupStopped:()=>true});
    const outcome=await backend.execute(f.input);assert.equal(outcome.kind,'completed');assert.equal(upstream,2);
    assert.equal(f.usage().actualRequests,2);assert.equal(f.usage().outputTokens,10);
    assert.ok(f.events.some(event=>event.type==='anchor'));
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM threaded_backend_processes WHERE state='verified_stopped'").get().n,1);
    checks.push('SDK local protocol relay meters every hidden HTTP request, ignores cumulative SDK result usage and records a checkpoint only with exact native identity and input receipt');
  }
  {
    const first=await fixture('claude-sdk'),boundary=randomUUID();
    first.prepared.session.compactionBoundary='stale-cold-boundary';
    const initial=createClaudeSdkBackend({...first.options,fetch:async()=>response(answer()),
      sdkProcess:input=>fakeSdk({...input,onRecord(record) {
        if(record.type==='result')input.onRecord({type:'system',subtype:'compact_boundary',session_id:input.nativeId,uuid:boundary});
        input.onRecord(record);
      }}),processGroupStopped:()=>true});
    const firstOutcome=await initial.execute(first.input);assert.equal(firstOutcome.kind,'completed');
    const firstAnchor=first.events.find(event=>event.type==='anchor').evidence;
    assert.equal(firstAnchor.compactionBoundary,boundary);first.lifecycle.recordOutcome(first.binding,firstOutcome);

    const resumed=await fixture('claude-sdk');
    Object.assign(resumed.prepared.session,{nativeId:first.prepared.session.nativeId,configDir:first.prepared.session.configDir,
      cwd:first.prepared.session.cwd,resume:true,compactionBoundary:firstAnchor.compactionBoundary});
    const continued=createClaudeSdkBackend({...resumed.options,fetch:async()=>response(answer()),sdkProcess:input=>{
      assert.equal(input.resume,true);return fakeSdk(input);
    },processGroupStopped:()=>true});
    const resumedOutcome=await continued.execute(resumed.input);assert.equal(resumedOutcome.kind,'completed');
    assert.equal(resumed.events.some(event=>event.type==='compact'),false);
    assert.equal(resumed.events.find(event=>event.type==='anchor').evidence.compactionBoundary,boundary);
    resumed.lifecycle.recordOutcome(resumed.binding,resumedOutcome);

    const cold=await fixture('claude-sdk');
    cold.prepared.session.compactionBoundary=boundary;
    const coldBackend=createClaudeSdkBackend({...cold.options,fetch:async()=>response(answer()),sdkProcess:fakeSdk,processGroupStopped:()=>true});
    const coldOutcome=await coldBackend.execute(cold.input);assert.equal(coldOutcome.kind,'completed');
    assert.equal(cold.events.find(event=>event.type==='anchor').evidence.compactionBoundary,undefined);
    cold.lifecycle.recordOutcome(cold.binding,coldOutcome);
    checks.push('SDK resume preserves the trusted prior compaction boundary when no new compact event occurs; a new compact event replaces it and cold sessions never inherit it');
  }
  {
    const f=await fixture('claude-sdk');
    const backend=createClaudeSdkBackend({...f.options,fetch:async()=>response(answer()),sdkProcess:fakeSdk,processGroupStopped:()=>false});
    const outcome=await backend.execute(f.input);assert.equal(outcome.kind,'unknown');
    assert.throws(()=>f.evidence.quiescence(f.binding),/UNCONFIRMED/);assert.equal(f.resources.isHeld(f.binding),true);
    checks.push('SDK close notification without verified owned process-group exit cannot release resources or mint an anchor');
  }
  {
    const f=await fixture('claude-sdk');let upstream=0;
    const backend=createClaudeSdkBackend({...f.options,fetch:async()=>{upstream++;throw new Error('must not send');},
      sdkProcess:async input=>{const token=randomUUID();input.onProcess({pid:process.pid,token});
        try{input.onRecord({type:'system',subtype:'init',session_id:'unexpected-id',tools:[]});}finally{input.onProcessStopped(token);}},
      processGroupStopped:()=>true});
    const outcome=await backend.execute(f.input);assert.equal(outcome.kind,'failed');assert.equal(upstream,0);
    assert.equal(f.events[0].nativeId,'unexpected-id');assert.equal(f.usage().actualRequests,0);
    checks.push('Unexpected SDK session identity reaches the server reconciliation gate before any HTTP request or continuation');
  }
  {
    const f=await fixture();const first=f.evidence.quiescence(f.binding);
    assert.equal(verifyThreadedBackendResourceEvidence(f.db,{request:{mode:'threaded'},identity:f.claim},first),true);
    const auth=f.prepared.requests.begin('later',{model:f.prepared.model,maxOutputTokens:128,inputBytes:10});
    const receipt=f.evidence.begin(f.binding,f.prepared,auth.id,'later','{}',false);
    f.evidence.complete(receipt.id,{delivered:false});
    assert.equal(verifyThreadedBackendResourceEvidence(f.db,{request:{mode:'threaded'},identity:f.claim},first),false);
    checks.push('A proof snapshots request/process cardinality and cannot release the same claim after another request has appeared');
  }
  {
    const f=await fixture();let calls=0;
    f.db.exec(`CREATE TRIGGER fixture_backend_fault BEFORE INSERT ON threaded_backend_requests
      BEGIN SELECT RAISE(ABORT,'fixture_backend_receipt_fault'); END;`);
    const backend=createApiBackend({...f.options,fetch:async()=>{calls++;return response(answer());}});
    const outcome=await backend.execute(f.input);assert.equal(outcome.kind,'failed');
    assert.equal(calls,0);assert.equal(rows(f).length,0);assert.equal(f.usage().actualRequests,0);
    assert.equal(f.budget.getAuthorization(f.authorization.id).executionState,'reserved');
    f.lifecycle.recordOutcome(f.binding,outcome);assert.equal(f.usage().outputTokens,0);
    checks.push('Failure while persisting the pre-I/O backend receipt rolls back request start and quota changes before any transport call');
  }
  {
    const f=await fixture('claude-sdk');let active=0,peak=0;
    const backend=createClaudeSdkBackend({...f.options,fetch:async()=>{
      active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,20));active--;return response(answer());
    },sdkProcess:input=>fakeSdk(input,3,true),processGroupStopped:()=>true});
    const outcome=await backend.execute(f.input);assert.equal(outcome.kind,'completed');assert.equal(peak,1);
    assert.equal(f.usage().actualRequests,3);
    checks.push('Concurrent hidden SDK helper requests are serialized before request admission so a single resource claim never authorizes parallel actual HTTP calls');
  }
  {
    assert.equal(backendUrl('https://example.invalid/api/anthropic','/v1/messages'),'https://example.invalid/api/anthropic/v1/messages');
    assert.equal(backendUrl('https://example.invalid/v1','/v1/messages'),'https://example.invalid/v1/messages');
    const parsed=parseBackendResponse('anthropic-messages',JSON.stringify({...answer(),usage:{input_tokens:10,output_tokens:2,
      cache_read_input_tokens:30,cache_creation_input_tokens:5}}),'application/json');
    assert.equal(parsed.inputTokens,45);assert.equal(parsed.costMicrousd,undefined);
    const registry=createThreadedBackendRegistry({api:{execute:async()=>{}},claudeSdk:{execute:async()=>{}},resolveKind:()=> 'codex-exec'});
    assert.throws(()=>registry.execute({binding:{},sessionBindingId:'x'}),/NOT_ADMITTED/);
    checks.push('Endpoint prefixes are preserved, cached input contributes to total-token acceptance accounting, unknown cache tariffs remain unknown and other drivers stay closed');
  }
  assert.equal(externalCalls,0);
  console.log(JSON.stringify({ok:true,groups:checks.length,checks,externalCalls,realModelCalls:0,
    scope:'isolated DB, injected HTTP responses, real loopback SDK relay; process-exit positives are explicitly injected protocol facts'},null,2));
}finally{for(const db of databases)if(db.open)db.close();globalThis.fetch=nativeFetch;await rm(root,{recursive:true,force:true});}

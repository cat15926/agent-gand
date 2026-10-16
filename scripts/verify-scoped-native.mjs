// G5 boundary tests: real installed Claude SDK against loopback only; Codex stdio fixture.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root=await realpath(await mkdtemp(path.join(tmpdir(),'gand-scoped-native-')));
for(const key of Object.keys(process.env))if(/^(LLM_|ACCOUNT_|ANTHROPIC_|OPENAI_|EXTERNAL_|CLAUDE_|CODEX_|MCP_)/.test(key))delete process.env[key];
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'test.sqlite'),AGENTS_DIR:path.join(root,'roles'),AGENT_GAND_PRIVATE_DIR:path.join(root,'private'),EXTERNAL_CODEX_HOME:path.join(root,'codex'),EXTERNAL_CLAUDE_HOME:path.join(root,'claude'),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1'});
const {config}=await import('../apps/server/src/config.ts'); config.dataDir=root;config.sandboxDir=path.join(root,'sandbox');
const db=await import('../apps/server/src/db/database.ts');
const scopes=await import('../apps/server/src/runtime/scopedCollaboration.ts');
const policy=await import('../apps/server/src/runtime/runPolicy.ts');
const {freezeRuntimeContract}=await import('../apps/server/src/runtime/controlAction.ts');
const {post}=await import('../apps/server/src/messaging/inbox.ts');
const {createScopedNativeEnvironment}=await import('../apps/server/src/execution/scopedNative.ts');
const {createAccount}=await import('../apps/server/src/accounts/store.ts');
const {resolveAccount,freezeRunAccounts}=await import('../apps/server/src/accounts/resolver.ts');
const {getDriver}=await import('../apps/server/src/execution/drivers.ts');
const {sdkOptions}=await import('../apps/server/src/execution/sdkOptions.ts');
const {reserveScopedNativeTokens,settleScopedNativeTokens}=await import('../apps/server/src/execution/scopedNativeBudget.ts');
const {queueModelCall}=await import('../apps/server/src/orchestration/modelCalls.ts');
const now=new Date().toISOString(),privateAccess={visibility:'private',audience:['a','user']};
function fixture(privateRoot = false) {
  const runId = randomUUID(), roomId = randomUUID(), subjectId = randomUUID(), dispatchId = randomUUID();
  db.run('INSERT INTO conversations(id,title,mode,agent_ids,created_at,updated_at) VALUES(?,?,?,?,?,?)', roomId, 'G1 fixture', 'collaboration', '["a","b"]', now, now);
  db.run('INSERT INTO runs(id,goal,mode,conversation_id,status,agent_ids,created_at) VALUES(?,?,?,?,?,?,?)', runId, 'ROOT_MUST_NOT_BE_INJECTED', 'collaboration', roomId, 'running', '["a","b"]', now);
  const rootMessage = post({ runId, from: 'user', to: 'a', kind: 'user', body: 'ROOT_MUST_NOT_BE_INJECTED', ...(privateRoot ? privateAccess : {}) });
  const contract = { version: 1, runId, objective: 'ROOT_MUST_NOT_BE_INJECTED', participantIds: ['a', 'b'], requiredSubjectKeys: ['root:a'],
    completionPolicy: 'all_required', partialFailurePolicy: 'needs_attention',
    executionPolicy: policy.executionPolicyForProfile('execute', { toolApiVersion: 3, implicitAnswerPolicy: 'explicit_only' }),
    features: { completionEngine: true, controlActionVersion: 3, messageVisibilityVersion: 1,
      completionCandidateVersion: 1, successorObligationVersion: 1, evidenceBundleVersion: 1, contextContributorVersion: 1,
      durableHoldVersion: 2, exitGuard: { version: 1, maxCorrections: 1, correctionMaxTokens: 512 },
      scopedCollaboration: { boundaryVersion: 2, manifestVersion: 1, provenanceVersion: 1, policyRevision: 1, capabilityPackage: 'scoped-control-v1' } } };
  freezeRuntimeContract(contract);
  db.run('INSERT INTO runtime_subjects VALUES(?,?,?,?,?,?,?,?,?)', subjectId, runId, 'root:a', 'root', null, 'active', 'review', now, now);
  db.run('INSERT INTO runtime_custody VALUES(?,?,?,?,?,?,?)', subjectId, 'owned', 'a', null, 1, 1, now);
  db.run('INSERT INTO collaboration_dispatches(id,run_id,conversation_id,source_message_id,kind,from_actor,target_agent_id,status,depth,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', dispatchId, runId, roomId, rootMessage.id, 'initial', 'user', 'a', 'running', 0, dispatchId, now);
  db.run('INSERT INTO runtime_dispatch_subjects VALUES(?,?,?)', dispatchId, subjectId, 1);
  let attemptNo = 0;
  const attempt = () => {
    const id = randomUUID();
    db.run('INSERT INTO collaboration_attempts(id,dispatch_id,run_id,conversation_id,agent_id,attempt_no,status,lease_owner,lease_expires_at,created_at,started_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, dispatchId, runId, roomId, 'a', ++attemptNo, 'running', 'g1-fixture', new Date(Date.now() + 60000).toISOString(), now, now);
    db.run('INSERT INTO runtime_custody_events(id,run_id,subject_id,source_event_id,kind,holder_agent_id,generation,payload,created_at) VALUES(?,?,?,?,?,?,?,?,?)',randomUUID(),runId,subjectId,'claim:'+id,'custody.acquired','a',1,'{}',now);
    return id;
  };
  const message = (body, acl = privateAccess) => scopes.compileScopedSource(runId, 'message', post({ runId, from: 'user', to: acl.visibility === 'private' && !acl.audience.includes('a') ? 'b' : 'a', kind: 'agent', body, ...acl }).id);
  const create = (objective, more = {}) => scopes.createExecutionScope({ runId, subjectId, agentId: 'a', kind: 'content', recoveryGeneration: 1, defaultOutputAccess: privateAccess, objective, inputs: [], ...more });
  const binding = scope => ({ runId, scopeId: scope.id, attemptId: attempt(), agentId: 'a' });
  return { runId, roomId, subjectId, dispatchId, contract, message, create, binding };
}
const requests=[];let providerError;let controlMode=false;let providerWait;
let control={name:'agent_complete',arguments:{summary:'当前事项已完成，已核对事实、依据与限制。'}};
const upstream=createServer(async(req,res)=>{try{
  assert.ok(req.url.startsWith('/v1/messages'));
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
  if(req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'}).end('{"input_tokens":10}');return;}
  assert.equal(req.headers['x-api-key'],'fixture-scoped-key');requests.push(body);
  if(providerWait)await providerWait;
  if(res.destroyed)return;
  res.writeHead(200,{'content-type':'text/event-stream'});
  const send=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
  send('message_start',{message:{id:'msg_'+requests.length,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}});
  if(controlMode){
    const t=body.tools?.find(t=>t.name?.endsWith(control.name));assert.ok(t,'SDK must receive the scoped MCP control tool');
    send('content_block_start',{index:0,content_block:{type:'tool_use',id:'tool_scope_'+requests.length,name:t.name,input:{}}});
    send('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(control.arguments)}});
    send('content_block_stop',{index:0});send('message_delta',{delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:8}});send('message_stop',{});res.end();return;
  }
  send('content_block_start',{index:0,content_block:{type:'text',text:''}});
  send('content_block_delta',{index:0,delta:{type:'text_delta',text:'已完成当前独立事项的分析。'}});
  send('content_block_stop',{index:0});send('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:8}});send('message_stop',{});res.end();
}catch(error){providerError=error;res.writeHead(500).end('{}');}});
await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
const environments=[];
try{
  const f=fixture(),first=f.create(f.message('PRIVATE_FIRST_SCOPE')),second=f.create(f.message('PRIVATE_SECOND_SCOPE'));
  const publicScope=f.create(f.message('PUBLIC_THIRD_SCOPE',{visibility:'public',audience:[]}),{defaultOutputAccess:{visibility:'public',audience:[]}});
  const account=createAccount({displayName:'G5 local SDK',provider:'custom',apiKey:'fixture-scoped-key',baseUrl:`http://127.0.0.1:${upstream.address().port}`,protocols:['anthropic-messages'],models:['claude-sonnet-4-6'],defaultModel:'claude-sonnet-4-6',timeoutMs:30000});
  const agent={id:'a',model:'claude-sonnet-4-6',accountRef:account.id,execution:{kind:'external',driver:'claude-sdk',sessionPolicy:'conversation'}};
  const resolved=resolveAccount(agent);
  await mkdir(resolved.runtimeHome,{recursive:true});await writeFile(path.join(resolved.runtimeHome,'CLAUDE.md'),'ACCOUNT_HOME_SECRET_MUST_NOT_BE_LOADED');
  for(const scope of [first,second,publicScope]){
    const binding=f.binding(scope),context=scopes.assembleScopedContext(binding),env=await createScopedNativeEnvironment(binding);environments.push(env);
    assert.equal((await readdir(env.cwd)).length,0);assert.equal((await readdir(env.home)).length,0);
    const input={cwd:env.cwd,nativeHome:env.home,scopedNative:env,account:resolved,model:agent.model,prompt:context,instructions:'Only answer the current task. No tools.',permissionMode:'readonly',privateContext:true,controlOnly:true,session:{id:randomUUID(),resume:false,ephemeral:true,configDir:env.home,projectDir:'scope-'+scope.id},signal:new AbortController().signal,timeoutMs:30000,onEvent:()=>{}};
    const options=sdkOptions({...input,nativeTools:[]},async()=>false);
    assert.equal(options.persistSession,false);assert.deepEqual(options.tools,[]);assert.deepEqual(options.settingSources,[]);assert.equal(options.strictMcpConfig,true);
    const before=requests.length;assert.match(await getDriver('claude-sdk').invoke(input),/独立事项/);
    const payloads=JSON.stringify(requests.slice(before));assert.ok(payloads.includes(context));
    assert.doesNotMatch(payloads,/ACCOUNT_HOME_SECRET_MUST_NOT_BE_LOADED/);
    if(scope!==first)assert.doesNotMatch(payloads,/PRIVATE_FIRST_SCOPE/);
    if(scope===publicScope)assert.doesNotMatch(payloads,/PRIVATE_SECOND_SCOPE/);
    assert.ok(requests.slice(before).every(r=>!r.tools?.length));
    await assert.rejects(()=>getDriver('claude-sdk').invoke({...input,session:{...input.session,resume:true}}),/冷边界/);
    await writeFile(path.join(env.cwd,'old-memory.txt'),'OLD_NATIVE_MEMORY');
  }
  assert.equal(new Set(environments.map(e=>e.home)).size,3);assert.equal(new Set(environments.map(e=>e.cwd)).size,3);
  const log=path.join(root,'codex-turns.jsonl'),command=path.join(root,'codex-command.mjs'),controlFile=path.join(root,'control.json');
  await writeFile(controlFile,JSON.stringify(control));
  await writeFile(command,`#!${process.execPath}\nimport {readFileSync} from 'node:fs';process.env.G5_FIXTURE_LOG=${JSON.stringify(log)};process.env.G5_FIXTURE_CONTROL=readFileSync(${JSON.stringify(controlFile)},'utf8');await import(${JSON.stringify(new URL('./fixtures/scoped-native-codex.mjs',import.meta.url).href)});`,{mode:0o700});
  config.externalAgents.codexCommand=command;
  const codexAccount=createAccount({displayName:'G5 local Codex',provider:'custom',apiKey:'fixture-codex-key',baseUrl:`http://127.0.0.1:${upstream.address().port}`,protocols:['openai-responses'],models:['fixture-model'],defaultModel:'fixture-model',timeoutMs:30000});
  const codexResolved=resolveAccount({id:'a',model:'fixture-model',accountRef:codexAccount.id,execution:{kind:'external',driver:'codex-app-server'}});
  for(const scope of [first,second,publicScope]){
    const binding=f.binding(scope),context=scopes.assembleScopedContext(binding),env=await createScopedNativeEnvironment(binding);environments.push(env);
    const result=await getDriver('codex-app-server').invoke({cwd:env.cwd,scopedNative:env,account:codexResolved,model:'default',prompt:context,instructions:'Only current task',permissionMode:'readonly',privateContext:true,session:{id:null,resume:false,ephemeral:true,configDir:env.home},signal:new AbortController().signal,timeoutMs:10000,onEvent:()=>{}});
    assert.match(result,/scoped fixture/);
  }
  const codexTurns=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(codexTurns.length,3);assert.equal(new Set(codexTurns.map(t=>t.home)).size,3);assert.equal(new Set(codexTurns.map(t=>t.cwd)).size,3);
  assert.doesNotMatch(codexTurns[1].prompt,/PRIVATE_FIRST_SCOPE/);assert.doesNotMatch(codexTurns[2].prompt,/PRIVATE_FIRST_SCOPE|PRIVATE_SECOND_SCOPE/);
  // Actual owning runner + bridge + v3 adapter. The stdio fixture submits one controlled candidate.
  const nativeFixture=fixture(),nativeScope=nativeFixture.create(nativeFixture.message('NATIVE_CONTROL_SCOPE'));
  const nativeBinding=nativeFixture.binding(nativeScope),nativeContext=scopes.assembleScopedContext(nativeBinding);
  db.run('INSERT INTO scoped_delivery_plans VALUES (?,?,?,?)',nativeFixture.runId,'native-fixture',JSON.stringify({deadlineAt:new Date(Date.now()+60000).toISOString()}),2048);
  const {runScopedNativeTurn}=await import('../apps/server/src/collaboration/scopedNativeTurn.ts');
  const {parseScopedControlCall,scopedControlTool}=await import('../apps/server/src/collaboration/scopedRunner.ts');
  const {startSpan}=await import('../apps/server/src/runs/trace.ts');
  const nativeAgent={id:'a',name:'G5 native worker',description:'fixture',systemPrompt:'Only current task',version:1,model:'fixture-model',accountRef:codexAccount.id,permissionMode:'readonly',tools:[],disallowedTools:[],capabilities:[],execution:{kind:'external',driver:'codex-app-server',sessionPolicy:'conversation'}};
  freezeRunAccounts(nativeFixture.runId,[nativeAgent]);
  const candidate=await runScopedNativeTurn({binding:nativeBinding,agent:nativeAgent,context:nativeContext,parentSpanId:startSpan(nativeFixture.runId,{spanKind:'agent',name:'g5-test'}).id,
    tool:{name:'agent.complete',description:'Submit result',parameters:{type:'object',additionalProperties:false,required:['summary'],properties:{summary:{type:'string'}}}},parse:call=>parseScopedControlCall(call,{version:3,type:'complete',summary:''}),signal:new AbortController().signal});
  assert.equal(candidate.version,3);assert.equal(candidate.type,'complete');assert.match(candidate.summary,/事实/);
  assert.equal(db.get('SELECT COUNT(*) n FROM runtime_action_commands WHERE run_id=?',nativeFixture.runId).n,0,'transport must never commit the v2 marker');
  const execution=JSON.parse(db.get('SELECT record FROM external_agent_executions WHERE run_id=?',nativeFixture.runId).record);
  assert.equal(execution.status,'completed');await assert.rejects(()=>readdir(execution.cwd));
  assert.equal(db.get('SELECT COUNT(*) n FROM external_agent_sessions WHERE execution_id=?',execution.id).n,0,'no reusable native session');
  controlMode=true;
  const sdkFixture=fixture(),sdkScope=sdkFixture.create(sdkFixture.message('NATIVE_CONTROL_SCOPE'));
  const sdkBinding=sdkFixture.binding(sdkScope),sdkContext=scopes.assembleScopedContext(sdkBinding);
  db.run('INSERT INTO scoped_delivery_plans VALUES (?,?,?,?)',sdkFixture.runId,'native-fixture',JSON.stringify({deadlineAt:new Date(Date.now()+60000).toISOString()}),2048);
  const sdkAgent={id:'a',name:'G5 native worker',description:'fixture',systemPrompt:'Only current task',version:1,model:'claude-sonnet-4-6',accountRef:account.id,permissionMode:'readonly',tools:[],disallowedTools:[],capabilities:[],execution:{kind:'external',driver:'claude-sdk',sessionPolicy:'conversation'}};
  freezeRunAccounts(sdkFixture.runId,[sdkAgent]);
  const sdkCandidate=await runScopedNativeTurn({binding:sdkBinding,agent:sdkAgent,context:sdkContext,parentSpanId:startSpan(sdkFixture.runId,{spanKind:'agent',name:'g5-test'}).id,
    tool:{name:'agent.complete',description:'Submit result',parameters:{type:'object',additionalProperties:false,required:['summary'],properties:{summary:{type:'string'}}}},parse:call=>parseScopedControlCall(call,{version:3,type:'complete',summary:''}),signal:new AbortController().signal});
  assert.equal(sdkCandidate.version,3);assert.equal(sdkCandidate.type,'complete');assert.match(sdkCandidate.summary,/事实/);
  assert.equal(db.get('SELECT COUNT(*) n FROM runtime_action_commands WHERE run_id=?',sdkFixture.runId).n,0,'transport must never commit the v2 marker');
  const sdkExecution=JSON.parse(db.get('SELECT record FROM external_agent_executions WHERE run_id=?',sdkFixture.runId).record);
  assert.equal(sdkExecution.status,'completed');await assert.rejects(()=>readdir(sdkExecution.cwd));
  assert.equal(db.get('SELECT COUNT(*) n FROM external_agent_sessions WHERE execution_id=?',sdkExecution.id).n,0,'no reusable native session');
  // All v3 transports use the real tool schema/parser, but cannot themselves commit
  // a Batch, acknowledgment, business completion, release draft or publication.
  const controlCases=[];
  for(const template of [nativeAgent,sdkAgent])for(const type of ['consult_batch','acknowledge','request_release']){
    const current=fixture(),scope=current.create(current.message('ONLY_THIS_ACTION_SCOPE'));
    const binding=current.binding(scope),context=scopes.assembleScopedContext(binding);
    const expected=type==='consult_batch'?{version:3,type,items:[{key:'one',target:'b',payloadRef:'owner-approved-envelope',expectation:'result'}],join:'all',returnProfile:'status-only-v1'}
      :type==='acknowledge'?{version:3,type,envelopeId:'owner-approved-envelope'}:{version:3,type,summary:'已核对当前独立材料，包含事实依据、限制与结论的私密草稿。'};
    const {version, type:actionType,...args}=expected;
    control={name:'agent_'+type,arguments:args};await writeFile(controlFile,JSON.stringify(control));
    db.run('INSERT INTO scoped_delivery_plans VALUES (?,?,?,?)',current.runId,'native-fixture',JSON.stringify({deadlineAt:new Date(Date.now()+60000).toISOString()}),2048);
    freezeRunAccounts(current.runId,[template]);
    const candidate=await runScopedNativeTurn({binding,agent:template,context,parentSpanId:startSpan(current.runId,{spanKind:'agent',name:'g5-control-'+type}).id,
      tool:scopedControlTool(expected),parse:call=>parseScopedControlCall(call,expected),signal:new AbortController().signal});
    assert.deepEqual(candidate,expected);
    assert.equal(db.get('SELECT COUNT(*) n FROM runtime_action_commands WHERE run_id=?',current.runId).n,0);
    assert.equal(db.get('SELECT COUNT(*) n FROM collaboration_batches WHERE run_id=?',current.runId).n,0);
    assert.equal(db.get("SELECT COUNT(*) n FROM messages WHERE run_id=? AND from_agent='a'",current.runId).n,0);
    const execution=JSON.parse(db.get('SELECT record FROM external_agent_executions WHERE run_id=?',current.runId).record);
    assert.equal(execution.status,'completed');await assert.rejects(()=>readdir(execution.cwd));
    assert.equal(db.get('SELECT COUNT(*) n FROM external_agent_sessions WHERE execution_id=?',execution.id).n,0);
    controlCases.push({driver:template.execution.driver,type,tokenReservation:db.get('SELECT status FROM orchestration_token_reservations WHERE run_id=?',current.runId).status});
  }
  controlMode=false;
  const interruptedCases=[];
  for(const template of [nativeAgent,sdkAgent])for(const cause of ['cancel','source-drift']){
    const current=fixture(),source=current.message('LIVE_SCOPE_INPUT'),scope=current.create(source);
    const binding=current.binding(scope),context=scopes.assembleScopedContext(binding);
    db.run('INSERT INTO scoped_delivery_plans VALUES (?,?,?,?)',current.runId,'native-fixture',JSON.stringify({deadlineAt:new Date(Date.now()+60000).toISOString()}),2048);
    freezeRunAccounts(current.runId,[template]);
    await writeFile(controlFile,JSON.stringify({wait:true}));
    let unblock;providerWait=new Promise(resolve=>{unblock=resolve;});
    const beforeRequests=requests.length,beforeTurns=(await readFile(log,'utf8')).trim().split('\n').length;
    const controller=new AbortController(),expected={version:3,type:'complete',summary:''};
    const operation=runScopedNativeTurn({binding,agent:template,context,parentSpanId:startSpan(current.runId,{spanKind:'agent',name:'g5-'+cause}).id,
      tool:scopedControlTool(expected),parse:call=>parseScopedControlCall(call,expected),signal:controller.signal});
    // Attach the rejection observer before aborting; both backends must have entered a model turn.
    const rejected=assert.rejects(operation);
    try{
      let started=false;
      for(let i=0;i<600;i++){
        started=template.execution.driver==='claude-sdk'?requests.length>beforeRequests:(await readFile(log,'utf8')).trim().split('\n').length>beforeTurns;
        if(started)break;await new Promise(resolve=>setTimeout(resolve,50));
      }
      assert.ok(started,'native turn must start before cancellation');
      if(cause==='cancel')controller.abort(new Error('G5 test cancellation'));
      else db.run('UPDATE messages SET body=? WHERE id=?','REVOKED_SOURCE',source.id);
      await rejected;
    }finally{controller.abort();unblock();providerWait=undefined;await operation.catch(()=>{});}
    const execution=JSON.parse(db.get('SELECT record FROM external_agent_executions WHERE run_id=?',current.runId).record);
    assert.equal(execution.status,'cancelled');await assert.rejects(()=>readdir(execution.cwd));
    assert.equal(db.get('SELECT status FROM orchestration_token_reservations WHERE run_id=?',current.runId).status,'unknown');
    assert.equal(db.get('SELECT COUNT(*) n FROM runtime_action_commands WHERE run_id=?',current.runId).n,0);
    assert.equal(db.get('SELECT COUNT(*) n FROM external_agent_sessions WHERE execution_id=?',execution.id).n,0);
    interruptedCases.push(template.execution.driver+':'+cause);
  }
  // A fixture-only frozen snapshot constructs combinations that product admission
  // deliberately still rejects. There is no production flag to bypass that gate.
  const registry=await import('../apps/server/src/agents/registry.ts');
  const rooms=await import('../apps/server/src/conversations/service.ts');
  const trace=await import('../apps/server/src/runs/trace.ts');
  const delivery=await import('../apps/server/src/collaboration/scopedDelivery.ts');
  const scheduler=await import('../apps/server/src/collaboration/scheduler.ts');
  const store=await import('../apps/server/src/collaboration/store.ts');
  const {plannedBatchAction}=await import('../apps/server/src/collaboration/scopedRunner.ts');
  const {mockProvider}=await import('../apps/server/src/llm/provider.ts');
  // Boundary fixtures above intentionally retain live Attempt bindings for later
  // invalidation checks; leave normal scheduler capacity available beside them.
  const concurrency=config.collaboration.maxConcurrency;
  config.collaboration.maxConcurrency+=db.get("SELECT COUNT(*) n FROM collaboration_attempts WHERE status='running'").n;
  for(const id of ['mixed-owner','mixed-api','mixed-codex','mixed-sdk'])registry.createAgent({id,name:id,description:'isolated G5 combination fixture',systemPrompt:'Use only the current scope.',model:'mock:'+id,capabilities:['execute'],permissionMode:'readonly',tools:[],disallowedTools:[],color:'#4477aa',avatar:''});
  const mixedCalls=[],mixedCases=[];
  mockProvider.chat=async req=>{
    const id=req.model.slice(5),attempt=db.get("SELECT * FROM collaboration_attempts WHERE agent_id=? AND status='running' ORDER BY rowid DESC LIMIT 1",id);
    assert.ok(attempt);const text=req.messages.map(m=>m.content).join('\n');mixedCalls.push({runId:attempt.run_id,id,text});
    assert.doesNotMatch(text,/MIXED_CODEX_PRIVATE|MIXED_SDK_PRIVATE/);
    const name=req.tools[0].name;
    const expected=name==='agent.consult_batch'?plannedBatchAction(delivery.getDeliveryPlan(attempt.run_id).items):{version:3,type:'complete',summary:'已按当前事项核对事实、依据与限制，提交完整结论。'};
    const {version,type,...args}=expected;
    return {content:'',toolCalls:[{name,input:JSON.stringify(args)}],usage:{tokensIn:3,tokensOut:8,costUsd:0,costKnown:true,outputKnown:true},stopReason:'end_turn',truncated:false};
  };
  controlMode=true;control={name:'agent_complete',arguments:{summary:'已核对本事项的事实、依据与限制，提交完整结论。'}};await writeFile(controlFile,JSON.stringify(control));
  for(const mode of ['codex-api','all-backends','missing-final-usage']){
    const includeSdk=mode==='all-backends',unknownExpected=mode==='missing-final-usage';
    await writeFile(controlFile,JSON.stringify({...control,omitFinalUsage:unknownExpected}));
    const members=['mixed-owner','mixed-api','mixed-codex',...(includeSdk?['mixed-sdk']:[])];
    const room=rooms.createConversation({title:'G5 local mixed fixture',mode:'collaboration',agentIds:members,workspace:null});
    const draft={conversationId:room.id,coordinatorId:'mixed-owner',goal:'按已确认事项独立分析',join:'all',returnProfile:'status-only-v1',maxTokens:16000,
      items:members.slice(1).map((target,i)=>({key:'mixed-'+i,target,batch:1,expectation:'result',material:target==='mixed-sdk'?'MIXED_SDK_PRIVATE':target==='mixed-codex'?'MIXED_CODEX_PRIVATE':'MIXED_API_PRIVATE'}))};
    const preview=delivery.previewScopedDelivery(draft,'g5-owner');
    const runId=delivery.confirmScopedDelivery({previewId:preview.id,fingerprint:preview.fingerprint,clientKey:randomUUID()},'g5-owner');
    const nativeDefinitions=[];
    for(const id of members.filter(id=>['mixed-codex','mixed-sdk'].includes(id))){
      const template=id==='mixed-codex'?nativeAgent:sdkAgent;
      const definition={...registry.getAnyAgent(id),model:template.model,accountRef:template.accountRef,execution:template.execution};
      db.run('UPDATE run_agent_snapshots SET definition=? WHERE run_id=? AND agent_id=?',JSON.stringify(definition),runId,id);
      nativeDefinitions.push(definition);
    }
    db.run('DELETE FROM run_planner_snapshots WHERE run_id=?',runId);
    freezeRunAccounts(runId,nativeDefinitions);
    const beforeNative=(await readFile(log,'utf8')).trim().split('\n').length,beforeLocal=requests.length;
    scheduler.kickCollaboration(room.id);
    for(let i=0;i<1200&&!['completed','failed','cancelled'].includes(trace.getRun(runId).status);i++)await new Promise(resolve=>setTimeout(resolve,50));
    const states=store.listAttempts(runId);
    assert.equal(trace.getRun(runId).status,unknownExpected?'failed':'completed',JSON.stringify(states));
    const unknown=db.get("SELECT COUNT(*) n FROM orchestration_token_reservations WHERE run_id=? AND status='unknown'",runId).n;
    assert.equal(unknown,unknownExpected?1:0);
    assert.equal(db.get("SELECT COUNT(*) n FROM external_agent_executions WHERE run_id=? AND record LIKE '%LATE_SEALED_PRIVATE_MUST_NOT_ESCAPE%'",runId).n,0);
    assert.equal(db.get("SELECT COUNT(*) n FROM run_events WHERE run_id=? AND output LIKE '%LATE_SEALED_PRIVATE_MUST_NOT_ESCAPE%'",runId).n,0);
    assert.ok(states.filter(a=>a.agentId==='mixed-sdk').length<=1,'unknown usage cannot replay the SDK');
    for(const turn of (await readFile(log,'utf8')).trim().split('\n').slice(beforeNative).map(JSON.parse)){
      assert.match(turn.prompt,/MIXED_CODEX_PRIVATE/);assert.doesNotMatch(turn.prompt,/MIXED_API_PRIVATE|MIXED_SDK_PRIVATE/);
    }
    for(const request of requests.slice(beforeLocal)){
      assert.match(JSON.stringify(request),/MIXED_SDK_PRIVATE/);assert.doesNotMatch(JSON.stringify(request),/MIXED_API_PRIVATE|MIXED_CODEX_PRIVATE/);
    }
    assert.ok(mixedCalls.filter(c=>c.runId===runId&&c.id==='mixed-owner').every(c=>!c.text.includes('MIXED_API_PRIVATE')));
    mixedCases.push({mode,backends:includeSdk?'API + Codex fixture + installed SDK':'API + Codex fixture',status:trace.getRun(runId).status,unknownReservations:unknown});
  }
  controlMode=false;
  config.collaboration.maxConcurrency=concurrency;
  const old=environments[0];db.run('UPDATE messages SET body=? WHERE id=?','SOURCE_REVOKED',JSON.parse(db.get('SELECT record FROM runtime_context_manifests WHERE scope_id=?',first.id).record).objective.id);
  assert.throws(()=>old.assertAuthorized(),/SOURCE_VERSION_CHANGED/);
  assert.throws(()=>scopes.assertScopedTool(environments[1].binding,'fs.read'),/SCOPE_NOT_READABLE/);
  // Native admission reserves remaining allowance, serializes competitors and retains unknown usage.
  db.run('INSERT INTO scoped_delivery_plans VALUES (?,?,?,?)',f.runId,'fixture',JSON.stringify({deadlineAt:new Date(Date.now()+60000).toISOString()}),100);
  const call=queueModelCall(f.runId,'a','fixture','claude-sdk',environments[1].binding.attemptId);
  await reserveScopedNativeTokens(f.runId,call,new AbortController().signal);assert.equal(db.get('SELECT reserved FROM orchestration_token_reservations WHERE id=?',call).reserved,100);
  settleScopedNativeTokens(call,8);
  const next=queueModelCall(f.runId,'a','fixture','claude-sdk',environments[1].binding.attemptId);
  await reserveScopedNativeTokens(f.runId,next,new AbortController().signal);assert.equal(db.get('SELECT reserved FROM orchestration_token_reservations WHERE id=?',next).reserved,92);settleScopedNativeTokens(next,null);
  const blocked=queueModelCall(f.runId,'a','fixture','claude-sdk',environments[1].binding.attemptId);
  await assert.rejects(()=>reserveScopedNativeTokens(f.runId,blocked,new AbortController().signal),/USAGE_UNKNOWN/);
  if(providerError)throw providerError;
  console.log(JSON.stringify({passed:true,realSdkProcesses:3+db.get("SELECT COUNT(*) n FROM external_agent_executions WHERE json_extract(record,'$.driver')='claude-sdk'").n,codexFixtureProcesses:3+db.get("SELECT COUNT(*) n FROM external_agent_executions WHERE json_extract(record,'$.driver')='codex-app-server'").n,localMessages:requests.length,supplierRequests:0,controlCases,interruptedCases,mixedCases,requestKinds:requests.map(r=>({tools:r.tools?.length??0,lastRole:r.messages?.at(-1)?.role,stopFeedback:r.messages?.at(-1)?.content?.filter?.(c=>c.type==='tool_result').map(c=>c.is_error??false)})),cases:['same-audience-cold-home','private-to-public','no-native-tools','no-session-persistence','resume-rejected','source-drift-revocation','manifest-tool-denial','native-token-unknown-block']}));
}finally{
  await Promise.all(environments.map(e=>e.close()));
  for(const e of environments){await assert.rejects(()=>readFile(path.join(e.cwd,'old-memory.txt')));assert.throws(()=>e.assertAuthorized());}
  upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));db.closeDatabase();await rm(root,{recursive:true,force:true});
}

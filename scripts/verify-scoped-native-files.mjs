import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile,readFile,readdir,access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {createDemoEnvironment} from './helpers/orchestration-demo-environment.mjs';
import {nativeScopeFixture} from './helpers/scoped-native-fixture.mjs';

const env=await createDemoEnvironment(),root=env.root,requests=[],checks=[];
const db=env.database,{config}=await import('../apps/server/src/config.ts');config.dataDir=root;config.externalAgents.sdkWorkerCommand=undefined;
const tools=['fs.read','fs.write','search.files'],content='SCOPE_FILE_CONTENT: 7 * 6 = 42. The arithmetic is exact; this synthetic example does not establish other facts.\n';
const encoded=name=>'platform_'+Buffer.from(name).toString('hex');
let providerError;
const upstream=createServer(async(req,res)=>{try{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
  if(req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'}).end('{"input_tokens":10}');return;}
  requests.push(body);const text=body.messages.flatMap(m=>typeof m.content==='string'?[m.content]:(m.content??[]).filter(c=>c.type==='text').map(c=>c.text)).join('\n'),previous=(name)=>body.messages.some(m=>Array.isArray(m.content)&&m.content.some(c=>c.type==='tool_use'&&c.name?.endsWith(name)));
  let action={name:'agent_complete',arguments:{summary:'42。已读取获准材料并生成完整受控文件，计算依据明确；本结论仅针对本次合成材料。'}};
  if(text.includes('SCOPE_FILE_DENIED'))action={name:encoded('fs.read'),arguments:{path:'not-selected.txt'}};
  else if(text.includes('SCOPE_FILE_WORK')){
    if(!previous(encoded('fs.read')))action={name:encoded('fs.read'),arguments:{path:'input.txt'}};
    else if(!previous(encoded('fs.write')))action={name:encoded('fs.write'),arguments:{path:'result.txt',content}};
  }
  else if(body.tools?.some(t=>t.name.endsWith('agent_consult_batch')))action={name:'agent_consult_batch',arguments:JSON.parse(text.slice(text.lastIndexOf('{"items":')).split('\n')[0])};
  else if(body.tools?.some(t=>t.name.endsWith('agent_request_release')))action={name:'agent_request_release',arguments:{summary:'42。已核对所选算术报告的输入和计算依据；该结果只适用于本次合成材料，不推广到其他任务。'}};
  const tool=body.tools?.find(t=>t.name.endsWith(action.name));assert.ok(tool,'required scoped MCP tool: '+action.name);
  res.writeHead(200,{'content-type':'text/event-stream'});
  const send=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
  send('message_start',{message:{id:'msg_files_'+requests.length,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}});
  send('content_block_start',{index:0,content_block:{type:'tool_use',id:'call_files_'+requests.length,name:tool.name,input:{}}});
  send('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(action.arguments)}});
  send('content_block_stop',{index:0});send('message_delta',{delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:8}});send('message_stop',{});res.end();
}catch(error){providerError=error;res.writeHead(500).end('{}');}});
await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
const {createAccount}=await import('../apps/server/src/accounts/store.ts'),registry=await import('../apps/server/src/agents/registry.ts');
const account=createAccount({displayName:'G5 files loopback',provider:'custom',apiKey:'scoped-files-fixture',baseUrl:`http://127.0.0.1:${upstream.address().port}`,protocols:['anthropic-messages'],models:['scope-files'],defaultModel:'scope-files',timeoutMs:30000});
const {freezeRunAccounts}=await import('../apps/server/src/accounts/resolver.ts'),scopes=await import('../apps/server/src/runtime/scopedCollaboration.ts');
const policy=await import('../apps/server/src/runtime/runPolicy.ts'),{freezeRuntimeContract}=await import('../apps/server/src/runtime/controlAction.ts'),{post}=await import('../apps/server/src/messaging/inbox.ts');
const artifacts=await import('../apps/server/src/artifacts/store.ts'),fileTools=await import('../apps/server/src/runtime/scopedFileTools.ts');
const {runScopedNativeTurn}=await import('../apps/server/src/collaboration/scopedNativeTurn.ts'),{scopedControlTool,parseScopedControlCall}=await import('../apps/server/src/collaboration/scopedRunner.ts'),trace=await import('../apps/server/src/runs/trace.ts');
const fixture=()=>nativeScopeFixture({db,scopes,policy,freezeRuntimeContract,post});
const role=(id,driver='claude-sdk',accountRef=account.id)=>({id,name:id,description:'isolated scoped files fixture',systemPrompt:'Read selected input.txt, write result.txt via platform tools, then call agent.complete with evidence and a limitation.',model:'scope-files',accountRef,requiresAccount:true,permissionMode:'auto',tools,disallowedTools:[],capabilities:['execute'],color:'#4477aa',avatar:'',execution:{kind:'external',driver,nativeTools:[],platformTools:tools,sessionPolicy:'conversation'}});
function prepared(label,agent=role('a')){
  const f=fixture(),source=artifacts.createManagedArtifact({runId:f.runId,path:'input.txt',content:Buffer.from('SELECTED_INPUT_SECRET: 7*6'),access:{visibility:'private',audience:['a','user']},createdBy:'user'});
  artifacts.createManagedArtifact({runId:f.runId,path:'not-selected.txt',content:Buffer.from('UNSELECTED_SAME_AUDIENCE_SECRET'),access:{visibility:'private',audience:['a','user']},createdBy:'user'});
  const scope=f.create(f.message(label),{dynamicInputs:[scopes.compileScopedSource(f.runId,'artifact',source.id)],allowedTools:tools}),binding=f.binding(scope),context=scopes.assembleScopedContext(binding);freezeRunAccounts(f.runId,[agent]);
  db.run('INSERT INTO scoped_delivery_plans VALUES(?,?,?,?)',f.runId,'scoped-files-fixture',JSON.stringify({deadlineAt:new Date(Date.now()+60000).toISOString()}),2048);
  return {...f,binding,context,source,agent};
}
async function native(f){const expected={version:3,type:'complete',summary:''};return runScopedNativeTurn({binding:f.binding,agent:f.agent,context:f.context,parentSpanId:trace.startSpan(f.runId,{spanKind:'agent',name:'files'}).id,tool:scopedControlTool(expected),parse:call=>parseScopedControlCall(call,expected),signal:AbortSignal.timeout(45000)});}
try {
  const f=prepared('SCOPE_FILE_WHITELIST');
  assert.match(await fileTools.runScopedFileTool(f.binding,'fs.read',{path:'input.txt'}),/SELECTED_INPUT_SECRET/);
  await assert.rejects(()=>fileTools.runScopedFileTool(f.binding,'fs.read',{path:'not-selected.txt'}),/SCOPED_TOOL_REJECTED/);
  assert.doesNotMatch(await fileTools.runScopedFileTool(f.binding,'search.files',{pattern:'SECRET'}),/UNSELECTED/);
  for(const p of ['/etc/passwd','../escape','shared/test','.codex/auth.json'])await assert.rejects(()=>fileTools.runScopedFileTool(f.binding,'fs.write',{path:p,content}),/ARTIFACT_PATH_INVALID|受控文件/);
  await assert.rejects(()=>fileTools.runScopedFileTool(f.binding,'fs.read',{path:'input.txt',runId:'forged'}),/SCOPED_TOOL_REJECTED/);
  await fileTools.runScopedFileTool(f.binding,'fs.write',{path:'own.txt',content});assert.match(await fileTools.runScopedFileTool(f.binding,'fs.read',{path:'own.txt'}),/SCOPE_FILE_CONTENT/);
  assert.ok(db.get("SELECT 1 FROM runtime_input_provenance WHERE attempt_id=? AND json_extract(record,'$.source.kind')='artifact' AND json_extract(record,'$.channel')='file_read'",f.binding.attemptId));
  const before=JSON.parse(db.get('SELECT record FROM managed_artifact_versions WHERE id=?',f.source.id).record);db.run('UPDATE managed_artifact_versions SET record=? WHERE id=?',JSON.stringify({...before,audience:['user']}),f.source.id);
  assert.throws(()=>scopes.assertScopedOutput({...f.binding,ledgerRevision:scopes.inputLedgerRevision(f.binding.attemptId),outputAccess:{visibility:'private',audience:['user','a']}}));
  checks.push('manifest-only reads/search, own writes, denied traversal/authority fields and artifact ACL drift');

  const sdk=prepared('SCOPE_FILE_WORK'),start=requests.length;const result=await native(sdk);assert.match(result.summary,/42/);assert.equal(requests.length-start,3);
  const execution=JSON.parse(db.get('SELECT record FROM external_agent_executions WHERE run_id=?',sdk.runId).record);assert.equal(execution.status,'completed');assert.ok(execution.tokensOut>0);await assert.rejects(()=>access(execution.cwd));
  assert.equal(db.get("SELECT COUNT(*) n FROM tool_executions WHERE run_id=? AND status='completed'",sdk.runId).n,2);
  assert.equal(db.get("SELECT COUNT(*) n FROM runtime_input_provenance WHERE attempt_id=? AND json_extract(record,'$.channel')='mcp_result'",sdk.binding.attemptId).n,2);
  assert.equal(db.get("SELECT COUNT(*) n FROM external_agent_sessions WHERE execution_id=?",execution.id).n,0);
  checks.push('installed SDK performs read/write/control across three loopback requests; final usage and cold cleanup');

  const denied=prepared('SCOPE_FILE_DENIED'),denyStart=requests.length;await assert.rejects(()=>native(denied),/SCOPED_TOOL_REJECTED/);assert.equal(requests.length-denyStart,1);
  assert.equal(db.get('SELECT COUNT(*) n FROM managed_artifact_versions WHERE run_id=? AND json_extract(record,\'$.createdBy\')=\'a\'',denied.runId).n,0);
  checks.push('denied native file access seals query without another model request');

  const codexAccount=createAccount({displayName:'Codex stdio fixture only',provider:'custom',apiKey:'fixture-not-real',baseUrl:'http://127.0.0.1:1',protocols:['openai-responses'],models:['scope-files'],defaultModel:'scope-files',timeoutMs:30000});
  const command=path.join(root,'codex-files'),controlFile=path.join(root,'codex-control.json'),log=path.join(root,'codex-files.jsonl');await writeFile(log,'');
  await writeFile(command,`#!${process.execPath}\nimport {readFileSync} from 'node:fs';process.env.G5_FIXTURE_LOG=${JSON.stringify(log)};process.env.G5_FIXTURE_CONTROL=readFileSync(${JSON.stringify(controlFile)},'utf8');await import(${JSON.stringify(new URL('./fixtures/scoped-native-codex.mjs',import.meta.url).href)});`,{mode:0o700});
  config.externalAgents.codexCommand=command;config.scopedNativeDrivers=['claude-sdk','codex-app-server'];
  const codexActions={actions:[{name:encoded('fs.read'),arguments:{path:'input.txt'},expect:'SELECTED_INPUT_SECRET'},{name:encoded('fs.write'),arguments:{path:'result.txt',content}},{name:'agent_complete',arguments:{summary:'42。已核对获准材料并形成实际受控文件，依据明确；结论只适用于当前样本。'}}]};
  await writeFile(controlFile,JSON.stringify(codexActions));
  const codex=prepared('SCOPE_FILE_WORK', {...role('a','codex-app-server',codexAccount.id),permissionMode:'confirm'});assert.match((await native(codex)).summary,/42/);
  checks.push('Codex stdio fixture exercises identical controlled file bridge; real Codex calls = 0');

  const rooms=await import('../apps/server/src/conversations/service.ts'),entry=await import('../apps/server/src/orchestration/entry.ts'),coordination=await import('../apps/server/src/coordination/runtime.ts'),business=await import('../apps/server/src/orchestration/business.ts');
  const {mockProvider}=await import('../apps/server/src/llm/provider.ts');
  mockProvider.chat=async req=>{const body=req.messages.map(m=>m.content).join('\n');assert.match(body,/result\.txt/);if(body.includes('【工具结果】'))assert.match(body,/SCOPE_FILE_CONTENT/);
    const toolCalls=body.includes('【工具结果】')?[]:[{name:'fs.read',input:JSON.stringify({path:'result.txt'})}];
    return {content:toolCalls.length?'':'已核对 SCOPE_FILE_CONTENT：42，算术和来源明确；此审阅仅针对获准的合成材料。',toolCalls,usage:{tokensIn:3,tokensOut:5,costUsd:0},stopReason:toolCalls.length?'tool_use':'stop',truncated:false};};
  const completed=[];
  for(const driver of ['claude-sdk','codex-app-server']){
    const id=driver==='claude-sdk'?'sdk-files':'codex-files';registry.createAgent({...role(id,driver,driver==='claude-sdk'?account.id:codexAccount.id),permissionMode:driver==='claude-sdk'?'auto':'confirm'});
    if(!registry.getAnyAgent('file-reader'))registry.createAgent({id:'file-reader',name:'file-reader',description:'fixture',systemPrompt:'Only read approved result.txt.',model:'mock:file-reader',permissionMode:'readonly',tools:['fs.read'],disallowedTools:[],capabilities:['execute'],color:'#4477aa',avatar:''});
    const room=rooms.createConversation({title:'Scoped files '+driver,mode:'collaboration',agentIds:[id,'file-reader','summary'],workspace:null});
    const input={conversationId:room.id,agentIds:room.agentIds,goal:'仅核对所选算术材料并保留私密交付',workflow:'routine',strategy:'serial',constraints:{readonly:false,maxTokens:4096},attachments:[{path:'input.txt',contentBase64:Buffer.from('SELECTED_INPUT_SECRET: 7*6').toString('base64')}],clientRequestId:randomUUID(),businessContract:{version:3,revision:1,executionMode:'stage_gated',stages:[{id:'analysis',title:'受控文件交付',criteria:['核对证据与限制'],deliverables:[{id:'file',title:'完整报告',kind:'file'}],execution:{maxTokens:2048,assignments:[{agentId:id,objective:'SCOPE_FILE_WORK 读取 input.txt，写 result.txt，再调用 agent.complete。',dependsOn:[],visibility:'private',audience:[id,'file-reader']},{agentId:'file-reader',objective:'只读取获准的 result.txt 并核对事实、依据与限制。',dependsOn:[id],visibility:'private',audience:['file-reader']}]}}]}};
    const hardBudget=await entry.previewExecutionOrchestration(input);assert.ok(hardBudget.decision.issues.some(i=>i.code==='HARD_TOKEN_LIMIT_UNSUPPORTED'),'native clients cannot promise a supplier-enforced stage token ceiling');
    delete input.businessContract.stages[0].execution.maxTokens;
    delete input.constraints.maxTokens;
    const preview=await entry.previewExecutionOrchestration(input);assert.deepEqual(preview.decision.issues.filter(i=>i.severity==='error'),[]);
    const admitted=entry.submitExecutionOrchestration({...input,entryVersion:1,previewId:preview.previewId,orchestrationFingerprint:preview.fingerprint},room.id);
    assert.equal(policy.loadRuntimeContract(admitted.run.id).features.coordinationScopes,2);
    await coordination.runCoordinationPlan(admitted.run,admitted.run.goal);
    assert.equal(trace.getRun(admitted.run.id).status,'waiting_for_user',JSON.stringify(db.all('SELECT step_id,status,error FROM coordination_step_states WHERE run_id=?',admitted.run.id)));
    const state=business.getBusinessState(admitted.run.id);assert.equal(state.stages[0].execution.canAccept,true);
    const file=business.listBusinessEvidence(admitted.run.id).find(e=>e.ref.kind==='workspace_file'&&e.ref.artifactId&&e.ref.path==='result.txt');assert.ok(file);
    const producer=artifacts.getManagedArtifact(file.ref.artifactId).attemptId;
    db.run("UPDATE coordination_step_attempts SET status='failed' WHERE id=?",producer);
    assert.throws(()=>business.applyBusinessCommand(admitted.run.id,{action:'report',stageId:'analysis',kind:'delivery',note:'失败步骤不能提供交付',evidence:[{deliverableId:'file',ref:file.ref}],expectedVersion:state.version,clientRequestId:randomUUID()}),/交付证据必须/);
    db.run("UPDATE coordination_step_attempts SET status='completed' WHERE id=?",producer);
    const report=business.applyBusinessCommand(admitted.run.id,{action:'report',stageId:'analysis',kind:'delivery',note:'核对当前受控文件',evidence:[{deliverableId:'file',ref:file.ref}],expectedVersion:state.version,clientRequestId:randomUUID()});
    business.applyBusinessCommand(admitted.run.id,{action:'decide',stageId:'analysis',reportId:report.stages[0].report.id,verdict:'accept',checkedCriteria:[0],reason:'证据完整',expectedVersion:report.version,clientRequestId:randomUUID()});
    await coordination.resumeCoordinationRun(admitted.run.id);assert.equal(trace.getRun(admitted.run.id).status,'completed');
    assert.equal(db.get("SELECT COUNT(*) n FROM business_stage_token_reservations WHERE run_id=? AND status!='settled'",admitted.run.id).n,0);
    const releases=await import('../apps/server/src/collaboration/informationRelease.ts');assert.ok(releases.roomAggregateSources(room.id).some(r=>r.runId===admitted.run.id));
    assert.ok(releases.previewPrivateAggregate({sourceRunId:admitted.run.id,itemKeys:['stage-1-work-2'],aggregatorId:'summary',instruction:'汇总这份报告',maxTokens:2048},'owner').sources.length);
    completed.push(admitted.run.id);
  }
  checks.push('normal Coordination entry, selected attachments, native/API file DAG, v2 scope ledger, Owner file acceptance and G3 intake');
  // Low-level transport fixtures have no scheduler to close their synthetic custody.
  // Release those four fixture slots before testing the normal scheduler.
  for(const fixture of [f,sdk,denied,codex]){
    db.run("UPDATE collaboration_attempts SET status='cancelled' WHERE run_id=? AND status='running'",fixture.runId);
    db.run("UPDATE collaboration_dispatches SET status='cancelled' WHERE run_id=?",fixture.runId);
    trace.setRunStatus(fixture.runId,'cancelled');
  }
  mockProvider.chat=async()=>({content:'',toolCalls:[{name:'agent.complete',input:JSON.stringify({summary:'42。7*6 的算术与材料一致，依据清楚；该结论仅针对本次合成样本。'})}],usage:{tokensIn:3,tokensOut:8,costUsd:0},stopReason:'tool_use',truncated:false});
  const {verifyNativeDeliveryIntegration}=await import('./helpers/scoped-native-integration.mjs');
  await verifyNativeDeliveryIntegration({sdkId:'sdk-files',apiId:'file-reader'});
  checks.push('normal SDK preview/confirm, API mixture, SDK aggregate and single-use Owner-approved release without replacing frozen snapshots');
  const {withBusinessStageExecution}=await import('../apps/server/src/orchestration/businessStageExecution.ts'),{reserveScopedNativeTokens,settleScopedNativeTokens}=await import('../apps/server/src/execution/scopedNativeBudget.ts'),{queueModelCall}=await import('../apps/server/src/orchestration/modelCalls.ts');
  const budget=fixture();db.run('INSERT INTO scoped_delivery_plans VALUES(?,?,?,?)',budget.runId,'budget-fixture','{}',500);
  await withBusinessStageExecution(budget.runId,{id:'ledger',title:'ledger',execution:{maxTokens:100}},async signal=>{
    const first=queueModelCall(budget.runId,'a','fixture','claude-sdk');await reserveScopedNativeTokens(budget.runId,first,signal);
    assert.equal(db.get('SELECT reserved FROM orchestration_token_reservations WHERE id=?',first).reserved,100);assert.equal(db.get('SELECT reserved FROM business_stage_token_reservations WHERE id=?',first).reserved,100);settleScopedNativeTokens(first,8);
    const second=queueModelCall(budget.runId,'a','fixture','claude-sdk');await reserveScopedNativeTokens(budget.runId,second,signal);settleScopedNativeTokens(second,null);
    assert.equal(db.get('SELECT status FROM business_stage_token_reservations WHERE id=?',second).status,'unknown');
    const third=queueModelCall(budget.runId,'a','fixture','claude-sdk');await assert.rejects(()=>reserveScopedNativeTokens(budget.runId,third,signal),/USAGE_UNKNOWN/);
  });
  checks.push('strict native stage token limits remain rejected; shared run/stage accounting retains unknown and blocks following calls');
  if(providerError)throw providerError;assert.equal(env.externalRequests,0);
  const executions=db.all('SELECT record FROM external_agent_executions').map(r=>JSON.parse(r.record));for(const execution of executions){assert.notEqual(execution.status,'running');await assert.rejects(()=>access(execution.cwd));}
  assert.equal(db.get('SELECT COUNT(*) n FROM external_agent_sessions').n,0);
  console.log(JSON.stringify({passed:true,checks,loopbackMessages:requests.length,codexFixtureProcesses:(await readFile(log,'utf8')).trim().split('\n').length,realSupplierRequests:0,realCodexCalls:0,completedCoordinationRuns:completed.length}));
} finally {upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));await env.close();}

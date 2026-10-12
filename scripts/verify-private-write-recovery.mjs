import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'gand-r4-recovery-'));
const native = path.join(root, 'native'); await copyFile(new URL('./fixtures/external-agent-o4.mjs', import.meta.url), native); await chmod(native, 0o755);
const repo = path.join(root, 'repo'); await mkdir(repo); await writeFile(path.join(repo, 'README.md'), 'R4 baseline\n');
execFileSync('git', ['init', '-q', repo]); execFileSync('git', ['-C', repo, 'add', '.']);
execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']);
const codexHome = path.join(root, 'codex'); await mkdir(codexHome); await writeFile(path.join(codexHome, 'auth.json'), JSON.stringify({ auth_mode:'chatgpt',tokens:{account_id:'fixture'} }));
Object.assign(process.env, { NODE_ENV:'test',DB_PATH:path.join(root,'test.sqlite'),AGENTS_DIR:path.join(root,'roles'),LOG_LEVEL:'silent',MCP_SERVER_CMD:'',
  AGENT_GAND_ISOLATED_WORKER:'1',AGENT_GAND_PRIVATE_DIR:path.join(root,'private'),ACCOUNT_MASTER_KEY:'',ACCOUNT_ADMIN_TOKEN:'',
  COORDINATION_RUNTIME_KERNEL:process.argv.includes('--kernel-off')?'off':'execute',EXTERNAL_WORKSPACE_MODE:'isolated',EXTERNAL_WORKSPACE_DIR:path.join(root,'workspaces'),
  EXTERNAL_AGENT_TIMEOUT_MS:'10000',EXTERNAL_CODEX_COMMAND:native,EXTERNAL_CLAUDE_SDK_WORKER_COMMAND:native,EXTERNAL_CODEX_HOME:codexHome,
  EXTERNAL_CLAUDE_HOME:path.join(root,'claude'),ANTHROPIC_API_KEY:'fixture-not-real',FAKE_D_LOG:path.join(root,'native.jsonl'),FAKE_O2_SERVER_ROOT:path.resolve('apps/server'),
  HOST:'127.0.0.1',PORT:'43220',ACCOUNT_TRUSTED_ORIGINS:'http://127.0.0.1:43220' });
await writeFile(process.env.FAKE_D_LOG,''); globalThis.fetch=()=>{throw new Error('R4 fixture prohibits real suppliers/network');};
const db = await import('../apps/server/src/db/database.ts');
const {config} = await import('../apps/server/src/config.ts'); config.sandboxDir=path.join(root,'sandbox');
const registry = await import('../apps/server/src/agents/registry.ts');
const rooms = await import('../apps/server/src/conversations/service.ts');
const entry = await import('../apps/server/src/orchestration/entry.ts');
const trace = await import('../apps/server/src/runs/trace.ts');
const coordination = await import('../apps/server/src/coordination/runtime.ts');
const plans = await import('../apps/server/src/coordination/store.ts');
const business = await import('../apps/server/src/orchestration/business.ts');
const cp = await import('../apps/server/src/orchestration/businessCheckpointStore.ts');
const recovery = await import('../apps/server/src/orchestration/businessRecovery.ts');
const continuation = await import('../apps/server/src/orchestration/continuation.ts');
const rework = await import('../apps/server/src/orchestration/businessRework.ts');
const access = await import('../apps/server/src/messaging/access.ts');
const inbox = await import('../apps/server/src/messaging/inbox.ts');
const artifacts = await import('../apps/server/src/artifacts/store.ts');
const evidence = await import('../apps/server/src/runtime/evidence.ts');
const tools = await import('../apps/server/src/tools/builtin/index.ts');
const approvals = await import('../apps/server/src/hitl/approvals.ts');
const executions = await import('../apps/server/src/execution/store.ts');
const costs = await import('../apps/server/src/orchestration/costBudget.ts');
const {assessRunRecovery} = await import('../apps/server/src/runtime/recovery.ts');
const {mockProvider} = await import('../apps/server/src/llm/provider.ts');
const {recoverDurableHolds}=await import('../apps/server/src/runs/recovery.ts');
const {registerExternal} = await import('../apps/server/src/workspaces/external.ts');
const workspace = 'ext:'+registerExternal({path:repo,trusted:true}).id;
const role=(id,extra={})=>({id,name:id,description:'R4 fixture',systemPrompt:'Deliver actual substantive results.',model:'mock:'+id,
  capabilities:['execute'],permissionMode:'readonly',tools:[],disallowedTools:[],color:'#4477aa',avatar:'',...extra});
for(const id of ['worker','peer','observer'])registry.createAgent(role(id));
for(const [id,driver] of [['sdk','claude-sdk'],['codex','codex-app-server']])registry.createAgent(role(id,{model:'fixture-session',permissionMode:'confirm',tools:['fs.read','fs.write','search.files'],execution:{kind:'external',driver,platformTools:['fs.read','fs.write','search.files']}}));
const updateAgent=(id,value)=>registry.updateAgent(id,{...registry.getAgent(id),...value},registry.getAgent(id).version);
const calls=[];let failPeer=true,probeBlockedTool=false;
mockProvider.chat=async req=>{const text=req.messages.map(m=>m.content).join('\n');calls.push({model:req.model,text,tools:req.tools?.map(t=>t.name)??[]});
  if(probeBlockedTool&&req.model==='mock:peer'){probeBlockedTool=false;assert.ok(!req.tools.some(t=>t.name==='shell.run'),'recovery must not expose shell, even in confirm mode');return {content:'',usage:{tokensIn:1,tokensOut:1,costUsd:0},toolCalls:[{id:'malicious-shell',name:'shell.run',input:JSON.stringify({cmd:'touch R4_MUST_NOT_EXIST'})}],truncated:false,stopReason:'tool_use'};}
  if(failPeer&&req.model==='mock:peer')throw new Error('R4 known readonly failure before any effect');
  return {content:'PRIVATE_R4_RESULT 实质交付：已经核对原始文件、工具结果和授权，给出可以验收的完整分析结论与剩余行动。',usage:{tokensIn:1,tokensOut:2,costUsd:0},toolCalls:[],truncated:false,stopReason:'end_turn'};};
const code=(fn,c)=>assert.throws(fn,e=>e.code===c,`expected ${c}`);
const confirmation=p=>({previewId:p.preview.previewId,orchestrationFingerprint:p.preview.fingerprint});
const apply=(id,c)=>business.applyBusinessCommand(id,{...c,expectedVersion:business.getBusinessState(id).version,clientRequestId:randomUUID()});
function report(id,stage,ref=business.listBusinessEvidence(id).find(e=>e.stageId===stage)?.ref){assert.ok(ref,'stage evidence');return apply(id,{action:'report',stageId:stage,kind:'delivery',note:'核对本次交付',evidence:[{deliverableId:'result',ref}]});}
function decide(id,stage,verdict='accept'){return apply(id,{action:'decide',stageId:stage,reportId:business.getBusinessState(id).stages.find(s=>s.stage.id===stage).report.id,verdict,checkedCriteria:verdict==='accept'?[0]:[],reason:verdict==='accept'?'逐项核对通过':'交付缺少行动细节，请重新修订'});}
function contract(groups){return {version:1,executionMode:'stage_gated',stages:groups.map((ids,i)=>({id:'phase-'+i,title:'阶段 '+i,criteria:['交付完整'],deliverables:[{id:'result',title:'完整结果',kind:'text'}],execution:{assignments:ids.map(agentId=>({agentId,objective:`R4_STAGE_${i} 实际完成本阶段任务`}))}}))};}
async function fixture(groups=[['worker'],['peer']],priv=true,write=false,costPolicy=undefined){
  const team=[...new Set(groups.flat())],room=rooms.createConversation({title:'R4 recovery',mode:'collaboration',agentIds:[...team,'observer'],workspace:write&&!priv?workspace:null});
  const input={conversationId:room.id,goal:priv?'PRIVATE_R4_INPUT 按授权阶段完成任务':'按阶段完成文件写入',agentIds:room.agentIds,recipientIds:team,strategy:'serial',workflow:'routine',workspace:room.workspace,
    constraints:{readonly:!write,...(costPolicy?{costPolicy}:{})},businessContract:contract(groups),...(priv?{visibility:'private',audience:team,attachments:[{path:'attachments/private.txt',contentBase64:Buffer.from('PRIVATE_R4_BYTES').toString('base64'),mimeType:'text/plain'}]}:{})};
  const preview=await entry.previewExecutionOrchestration(input); assert.deepEqual(preview.decision.issues.filter(i=>i.severity==='error'),[],JSON.stringify(preview.decision));
  return entry.submitExecutionOrchestration({...input,clientRequestId:randomUUID(),entryVersion:1,previewId:preview.previewId,orchestrationFingerprint:preview.fingerprint},room.id);
}
function source(id){return {run:trace.getRun(id),attempts:db.all('SELECT * FROM coordination_step_attempts WHERE run_id=? ORDER BY id',id),ledger:business.businessHistory(id),plan:plans.getRunCoordinationPlan(id),tokens:db.all('SELECT * FROM orchestration_token_reservations WHERE run_id=? ORDER BY id',id),tools:db.all('SELECT * FROM tool_executions WHERE run_id=? ORDER BY id',id)};}
function review(id,verdict='completed') {const inspection=recovery.inspectBusinessRecovery(id);return {fingerprint:inspection.fingerprint,clientRequestId:randomUUID(),reason:'逐项核对工作区、工具记录及外部服务，没有需要重放的外部动作。',externalEffectsChecked:true,
  steps:inspection.steps.filter(s=>s.state==='unknown').map(s=>({stepId:s.stepId,verdict,reason:'已经核对文件实际内容和工具执行记录，确认此步骤的实际结果。',...(verdict==='completed'?{output:'所有者核对交付：文件已经完整写入且内容与任务一致，已检查工具日志和外部状态；保留当前文件，只让后续成员完成分析及验收。'}:{})}))};}
async function failedPrivate(writer='worker',costPolicy=undefined) {const f=await fixture([[writer],['peer']],true,writer!=='worker',costPolicy);await approvedExecution(f);report(f.run.id,'phase-0');decide(f.run.id,'phase-0');await assert.rejects(()=>coordination.resumeCoordinationRun(f.run.id));return f;}
async function approvedExecution(f){const timer=setInterval(()=>{for(const a of approvals.listApprovals('pending').filter(a=>a.runId===f.run.id))approvals.decide(a.id,{decision:'approve',by:'owner'});recoverDurableHolds();},30);try{await coordination.runCoordinationPlan(f.run,f.run.goal);}catch(e){throw new Error(e.message+' '+JSON.stringify({steps:db.all("SELECT step_id,error FROM coordination_step_states WHERE plan_id=? AND status='failed'",f.plan?.id??plans.getRunCoordinationPlan(f.run.id).id),native:executions.listExecutions(f.run.id).map(x=>({error:x.error,errorCode:x.errorCode}))}),{cause:e});}finally{clearInterval(timer);}}
const {default:Fastify}=await import('../apps/server/node_modules/fastify/fastify.js');
const {registerRoutes}=await import('../apps/server/src/api/routes.ts');const {registerAccountRoutes}=await import('../apps/server/src/api/accountRoutes.ts');
const app=Fastify();await registerRoutes(app);await registerAccountRoutes(app);
try{
  // Private readonly progress remains encrypted and scoped; only the failed member executes.
  const f=await failedPrivate(),original=source(f.run.id),count=calls.length;
  const inspection=recovery.inspectBusinessRecovery(f.run.id);assert.equal(inspection.requiresReview,false);assert.equal(inspection.scope.visibility,'private');
  const p=await continuation.previewRunContinuation(f.run.id,true);assert.equal(calls.length,count);assert.equal(p.preview.request.visibility,'private');assert.equal(p.preview.request.workspace,null);
  const admitted=continuation.submitRunContinuation(f.run.id,confirmation(p),true);assert.equal(continuation.submitRunContinuation(f.run.id,confirmation(p),true).run.id,admitted.run.id);
  const raw=db.get('SELECT manifest FROM business_run_checkpoints WHERE run_id=?',admitted.run.id).manifest;assert.doesNotMatch(raw,/PRIVATE_R4_|实质交付/);assert.equal(JSON.parse(raw).encryptedCheckpointVersion,3);
  assert.deepEqual(access.runSourceAccess(admitted.run.id),access.runSourceAccess(f.run.id));
  const imported=artifacts.listManagedArtifacts(admitted.run.conversationId).find(a=>a.runId===admitted.run.id);assert.ok(imported);assert.equal(imported.visibility,'private');assert.deepEqual(imported.audience,inspection.scope.audience);
  cp.materializeBusinessCheckpoint(admitted.run.id);assert.equal(existsSync(path.join(config.sandboxDir,'runs',admitted.run.id,imported.path)),false);
  assert.equal(await tools.getTool('fs.read').run({path:imported.path},{runId:admitted.run.id,agentId:'peer'}),'PRIVATE_R4_BYTES');
  await assert.rejects(()=>tools.getTool('fs.read').run({path:imported.path},{runId:admitted.run.id,agentId:'observer'}),/授权范围/);
  failPeer=false;await coordination.runCoordinationPlan(trace.getRun(admitted.run.id),admitted.run.goal);assert.equal(calls.length,count+1);assert.match(calls.at(-1).text,/PRIVATE_R4_RESULT/);
  assert.doesNotMatch(JSON.stringify(inbox.listByConversation(admitted.run.conversationId,'observer')),/PRIVATE_R4_/);
  report(admitted.run.id,'phase-1');decide(admitted.run.id,'phase-1');await coordination.resumeCoordinationRun(admitted.run.id);assert.equal(business.getBusinessState(admitted.run.id).outcome,'achieved');assert.deepEqual(source(f.run.id),original);
  const cold=execFileSync(process.execPath,['--import','./apps/server/node_modules/tsx/dist/loader.mjs','--input-type=module','-e',"const {readBusinessCheckpoint}=await import('./apps/server/src/orchestration/businessCheckpointStore.ts');const {db}=await import('./apps/server/src/db/database.ts');console.log(readBusinessCheckpoint(process.env.R4_RUN).version);db.close();"],{env:{...process.env,R4_RUN:admitted.run.id},encoding:'utf8'});assert.equal(cold.trim(),'3');

  // Unknown usage is conservative, immutable, and needs explicit review before new scheduling.
  failPeer=true;const budget=await failedPrivate();
  db.run("INSERT INTO orchestration_token_reservations(id,run_id,reserved,status,created_at) VALUES(?,?,7,'unknown',?)",randomUUID(),budget.run.id,new Date().toISOString());
  db.run("INSERT INTO business_stage_token_reservations(id,run_id,stage_id,reserved,status,created_at) VALUES(?,?,'phase-1',7,'unknown',?)",randomUUID(),budget.run.id,new Date().toISOString());
  assert.equal(assessRunRecovery(budget.run.id).reconciliationAvailable,true);const budgetOriginal=source(budget.run.id);
  code(()=>recovery.confirmBusinessRecovery(budget.run.id,review(budget.run.id),false),'OWNER_REQUIRED');
  const rb=review(budget.run.id);recovery.confirmBusinessRecovery(budget.run.id,rb,true);recovery.confirmBusinessRecovery(budget.run.id,rb,true);
  code(()=>recovery.confirmBusinessRecovery(budget.run.id,{...rb,reason:rb.reason+' changed'},true),'IDEMPOTENCY_CONFLICT');
  assert.doesNotMatch(db.get('SELECT record FROM business_recovery_reviews WHERE run_id=?',budget.run.id).record,/逐项核对/);
  const bp=await continuation.previewRunContinuation(budget.run.id,true),bn=continuation.submitRunContinuation(budget.run.id,confirmation(bp),true);
  assert.equal(db.get("SELECT reserved FROM orchestration_token_reservations WHERE run_id=? AND status='carried_unknown'",bn.run.id).reserved,7);
  failPeer=false;await coordination.runCoordinationPlan(trace.getRun(bn.run.id),bn.run.goal);assert.equal(business.getBusinessState(bn.run.id).stages[1].execution.canAccept,true);assert.deepEqual(source(budget.run.id),budgetOriginal);

  // Private controlled writes via actual SDK and Codex stdio/MCP, never physical private files.
  for(const id of ['sdk','codex']){
    updateAgent(id,{model:'r4-bridge'});failPeer=true;const w=await failedPrivate(id),before=source(w.run.id);
    const wi=recovery.inspectBusinessRecovery(w.run.id);assert.equal(wi.readonly,false);assert.equal(wi.requiresReview,true);
    await assert.rejects(()=>continuation.previewRunContinuation(w.run.id,true),e=>e.code==='WRITE_RECONCILIATION_REQUIRED');
    const managed=artifacts.listManagedArtifacts(w.run.conversationId).filter(a=>a.runId===w.run.id&&a.createdBy!=='user');assert.ok(managed.length);assert.equal(managed[0].visibility,'private');
    recovery.confirmBusinessRecovery(w.run.id,review(w.run.id),true);const wp=await continuation.previewRunContinuation(w.run.id,true);assert.equal(wp.preview.request.constraints.readonly,false);
    const wn=continuation.submitRunContinuation(w.run.id,confirmation(wp),true);failPeer=false;await coordination.runCoordinationPlan(trace.getRun(wn.run.id),wn.run.goal);
    assert.deepEqual(source(w.run.id),before);assert.equal(cp.readBusinessCheckpoint(wn.run.id).version,3);assert.equal(existsSync(path.join(config.sandboxDir,'runs',wn.run.id,managed[0].path)),false);
  }

  updateAgent('peer',{permissionMode:'confirm',tools:['fs.read','fs.write','search.files','shell.run']});
  // Actual native write, then missing completion/timeout: never repeat the written member.
  for(const id of ['sdk','codex']){
    updateAgent(id,{model:'fixture-write-crash',tools:[],execution:{kind:'external',driver:id==='sdk'?'claude-sdk':'codex-app-server',platformTools:[]}});
    const w=await fixture([[id,'peer'],['worker']],false,true);config.externalAgents.timeoutMs=3000;await assert.rejects(()=>approvedExecution(w));config.externalAgents.timeoutMs=10000;
    const x=executions.listExecutions(w.run.id)[0];assert.equal(x.errorCode,'timeout',JSON.stringify(x));assert.equal(db.get("SELECT COUNT(*) n FROM external_native_processes WHERE execution_id=? AND status='active'",x.id).n,0,'timeout process must be stopped');
    const wi=recovery.inspectBusinessRecovery(w.run.id),step=wi.steps.find(s=>s.agentId===id);assert.equal(step.state,'unknown');assert.equal(step.canConfirmNotExecuted,false,JSON.stringify({x,step,approvals:approvals.listApprovals().filter(a=>a.runId===w.run.id),log:(await readFile(process.env.FAKE_D_LOG,'utf8')).split('\n').filter(Boolean).map(JSON.parse).filter(l=>l.cwd===x.cwd).map(({prompt,...l})=>l)}));
    const wr=review(w.run.id);code(()=>recovery.confirmBusinessRecovery(w.run.id,review(w.run.id,'not_executed'),true),'RECOVERY_EFFECT_OBSERVED');
    code(()=>recovery.confirmBusinessRecovery(w.run.id,{...wr,steps:[{...wr.steps[0],verdict:'unknown'}]},true),'RECOVERY_REVIEW_INVALID');
    const nativeRoot=x.cwd;assert.equal(await readFile(path.join(nativeRoot,'work.txt'),'utf8'),'fixture write');
    await writeFile(path.join(nativeRoot,'work.txt'),'OWNER FINISHED WRITE');code(()=>recovery.confirmBusinessRecovery(w.run.id,wr,true),'RECOVERY_REVIEW_STALE');
    recovery.confirmBusinessRecovery(w.run.id,review(w.run.id),true);const frozen=source(w.run.id),before=calls.length;
    const wp=await continuation.previewRunContinuation(w.run.id,true),wn=continuation.submitRunContinuation(w.run.id,confirmation(wp),true);assert.equal(continuation.submitRunContinuation(w.run.id,confirmation(wp),true).run.id,wn.run.id);
    const check=cp.readBusinessCheckpoint(wn.run.id);assert.equal(check.outputs[0].origin,'owner_reconciled');assert.equal(check.archive.manifest.git.commit,execFileSync('git',['-C',nativeRoot,'rev-parse','HEAD'],{encoding:'utf8'}).trim());
    probeBlockedTool=id==='sdk';await coordination.runCoordinationPlan(trace.getRun(wn.run.id),wn.run.goal);assert.equal(calls.length,before+(id==='sdk'?2:1));assert.equal(db.get("SELECT COUNT(*) n FROM tool_executions WHERE run_id=? AND tool_name='shell.run'",wn.run.id).n,0);assert.equal(approvals.listApprovals().filter(a=>a.runId===wn.run.id&&a.toolName==='shell.run').length,0);assert.equal(existsSync(path.join(config.sandboxDir,'runs',wn.run.id,'R4_MUST_NOT_EXIST')),false);assert.equal(await readFile(path.join(config.sandboxDir,'runs',wn.run.id,'work.txt'),'utf8'),'OWNER FINISHED WRITE');
    assert.match(evidence.resolveEvidence(wn.run.id,{kind:'attempt_output',id:step.attemptId}).source,/owner_reconciled/);
    report(wn.run.id,'phase-0',{kind:'attempt_output',id:step.attemptId});decide(wn.run.id,'phase-0');await coordination.resumeCoordinationRun(wn.run.id);
    cp.materializeBusinessCheckpoint(wn.run.id);await writeFile(path.join(config.sandboxDir,'runs',wn.run.id,'work.txt'),'out of band');code(()=>cp.materializeBusinessCheckpoint(wn.run.id),'CHECKPOINT_FILE_CHANGED');
    assert.deepEqual(source(w.run.id),frozen);assert.equal(executions.listExecutions(wn.run.id).length,0,'written native step never replayed');
  }

  // Failed before write: explicit not-executed reconciliation permits one fresh attempt.
  for(const id of ['sdk','codex']){
    updateAgent(id,{model:'r4-before-write-wait',tools:[],execution:{kind:'external',driver:id==='sdk'?'claude-sdk':'codex-app-server',platformTools:[]}});
    const pre=await fixture([[id],['worker']],false,true);config.externalAgents.timeoutMs=3000;await assert.rejects(()=>coordination.runCoordinationPlan(pre.run,pre.run.goal));config.externalAgents.timeoutMs=10000;
    const pi=recovery.inspectBusinessRecovery(pre.run.id);assert.equal(pi.steps[0].state,'unknown');assert.equal(pi.steps[0].canConfirmNotExecuted,true);
    recovery.confirmBusinessRecovery(pre.run.id,review(pre.run.id,'not_executed'),true);updateAgent(id,{model:'fixture-write'});
    const pp=await continuation.previewRunContinuation(pre.run.id,true),pn=continuation.submitRunContinuation(pre.run.id,confirmation(pp),true);await approvedExecution(pn);
    assert.equal(executions.listExecutions(pn.run.id).length,1);assert.equal(await readFile(path.join(config.sandboxDir,'runs',pn.run.id,'work.txt'),'utf8'),'fixture write');
    const nativeLog=(await readFile(process.env.FAKE_D_LOG,'utf8')).split('\n').filter(Boolean).map(JSON.parse).filter(l=>l.cwd===executions.listExecutions(pn.run.id)[0].cwd&&l.kind==='turn');assert.equal(nativeLog.length,1);assert.equal(nativeLog[0].resume,false);
    report(pn.run.id,'phase-0');decide(pn.run.id,'phase-0');await coordination.resumeCoordinationRun(pn.run.id);cp.materializeBusinessCheckpoint(pn.run.id);
  }

  // Private rework retains the accepted prefix, requires fresh delivery and never widens scope.
  failPeer=false;const rw=await fixture();await coordination.runCoordinationPlan(rw.run,rw.run.goal);report(rw.run.id,'phase-0');decide(rw.run.id,'phase-0');await coordination.resumeCoordinationRun(rw.run.id);report(rw.run.id,'phase-1');decide(rw.run.id,'phase-1','reject');
  const ri={stageId:'phase-1',reportId:business.getBusinessState(rw.run.id).stages[1].report.id,expectedVersion:business.getBusinessState(rw.run.id).version,instruction:'补充完整行动和依据后重新交付'};
  const rp=await rework.previewBusinessRework(rw.run.id,ri,true),rn=rework.submitBusinessRework(rw.run.id,{...ri,...confirmation(rp)},true);assert.equal(trace.getRun(rw.run.id).status,'cancelled');
  assert.deepEqual(access.runSourceAccess(rn.run.id),access.runSourceAccess(rw.run.id));const rejected=cp.readBusinessCheckpoint(rn.run.id).rework.rejectedOutputs[0];assert.equal(evidence.resolveEvidence(rn.run.id,{kind:'attempt_output',id:rejected.attemptId}).trusted,false);
  const prior=calls.length;await coordination.runCoordinationPlan(trace.getRun(rn.run.id),rn.run.goal);assert.equal(calls.length,prior+1);report(rn.run.id,'phase-1');decide(rn.run.id,'phase-1');await coordination.resumeCoordinationRun(rn.run.id);assert.equal(business.getBusinessState(rn.run.id).outcome,'achieved');

  // Whole-stage write rework runs deliberately in a new isolated scope, with fresh evidence.
  for(const priv of [true,false]){
    updateAgent('sdk',{model:priv?'r4-bridge':'fixture-write',tools:priv?['fs.read','fs.write','search.files']:[],execution:{kind:'external',driver:'claude-sdk',platformTools:priv?['fs.read','fs.write','search.files']:[]}});
    const w=await fixture([['sdk'],['worker']],priv,true);await approvedExecution(w);report(w.run.id,'phase-0');decide(w.run.id,'phase-0','reject');
    recovery.confirmBusinessRecovery(w.run.id,review(w.run.id),true);
    const input={stageId:'phase-0',reportId:business.getBusinessState(w.run.id).stages[0].report.id,expectedVersion:business.getBusinessState(w.run.id).version,instruction:'核对文件并修订交付内容，重新提交本阶段实际结果'};
    const preview=await rework.previewBusinessRework(w.run.id,input,true),next=rework.submitBusinessRework(w.run.id,{...input,...confirmation(preview)},true);
    const checkpoint=cp.readBusinessCheckpoint(next.run.id);assert.equal(checkpoint.outputs.length,0);assert.equal(checkpoint.rework.rejectedOutputs.length,1);
    assert.equal(evidence.resolveEvidence(next.run.id,{kind:'attempt_output',id:checkpoint.rework.rejectedOutputs[0].attemptId}).trusted,false);
    await approvedExecution(next);assert.equal(executions.listExecutions(w.run.id).length,1);assert.equal(executions.listExecutions(next.run.id).length,1);assert.equal(trace.getRun(w.run.id).status,'cancelled');
    if(priv){const files=artifacts.listManagedArtifacts(w.run.conversationId).filter(a=>a.runId===next.run.id);assert.equal(files.filter(a=>a.path==='bridge-result.txt').length,1,'rejected version is not imported as a current completed artifact');assert.ok(files.every(a=>a.visibility==='private'));}
    report(next.run.id,'phase-0');decide(next.run.id,'phase-0');await coordination.resumeCoordinationRun(next.run.id);report(next.run.id,'phase-1');decide(next.run.id,'phase-1');await coordination.resumeCoordinationRun(next.run.id);assert.equal(business.getBusinessState(next.run.id).outcome,'achieved');
  }

  // Stale current configuration, exact authorization and atomic rollback, then lost response retry.
  failPeer=true;const stale=await failedPrivate();const sp=await continuation.previewRunContinuation(stale.run.id,true);updateAgent('peer',{systemPrompt:'Changed current configuration'});code(()=>continuation.submitRunContinuation(stale.run.id,confirmation(sp),true),'PREVIEW_STALE');
  const fresh=await continuation.previewRunContinuation(stale.run.id,true);const beforeRuns=db.get('SELECT COUNT(*) n FROM runs').n;
  db.run("CREATE TRIGGER r4_fail_import BEFORE INSERT ON managed_artifact_versions WHEN json_extract(NEW.record,'$.restoredFrom') IS NOT NULL BEGIN SELECT RAISE(ABORT,'r4-import-rollback'); END");
  assert.throws(()=>continuation.submitRunContinuation(stale.run.id,confirmation(fresh),true),/r4-import-rollback/);assert.equal(db.get('SELECT COUNT(*) n FROM runs').n,beforeRuns);assert.equal(db.get('SELECT 1 FROM orchestration_run_continuations WHERE source_run_id=?',stale.run.id),undefined);db.run('DROP TRIGGER r4_fail_import');
  const sn=continuation.submitRunContinuation(stale.run.id,confirmation(fresh),true);assert.equal(continuation.submitRunContinuation(stale.run.id,confirmation(fresh),true).run.id,sn.run.id);
  const frozenRequest=db.get('SELECT snapshot FROM orchestration_requests WHERE run_id=?',sn.run.id).snapshot;const widened=JSON.parse(frozenRequest);widened.request.visibility='public';widened.request.audience=[];db.run('UPDATE orchestration_requests SET snapshot=? WHERE run_id=?',JSON.stringify(widened),sn.run.id);code(()=>cp.readBusinessCheckpoint(sn.run.id),'PRIVATE_CHECKPOINT_UNSUPPORTED');db.run('UPDATE orchestration_requests SET snapshot=? WHERE run_id=?',frozenRequest,sn.run.id);
  const narrow=await failedPrivate();inbox.post({runId:narrow.run.id,from:'worker',to:'user',kind:'agent',body:'NARROW_PRIVATE',visibility:'private',audience:['worker']});code(()=>recovery.inspectBusinessRecovery(narrow.run.id),'PRIVATE_CHECKPOINT_UNSUPPORTED');
  const active=await failedPrivate();db.run("UPDATE coordination_step_attempts SET status='running' WHERE run_id=? AND step_id='stage-2-work-1'",active.run.id);code(()=>recovery.inspectBusinessRecovery(active.run.id),'RESULT_UNKNOWN');

  // R5 fees remain unknown through private write review and encrypted successor import.
  failPeer=true;updateAgent('sdk',{model:'r4-bridge',permissionMode:'confirm',tools:['fs.read','fs.write','search.files'],execution:{kind:'external',driver:'claude-sdk',platformTools:['fs.read','fs.write','search.files']}});
  const feePolicy={version:1,currency:'USD',mode:'estimate',maxCost:1,unknownAction:'reserve',unknownReserve:0.1,prices:[]};
  const paid=await failedPrivate('sdk',feePolicy),oldReview=review(paid.run.id);
  const late=costs.reserveCost(paid.run.id,'peer','mock:peer','builtin-llm');costs.settleCost(late);
  code(()=>recovery.confirmBusinessRecovery(paid.run.id,oldReview,true),'RECOVERY_REVIEW_STALE');
  const paidRows=costs.costRows(paid.run.id),paidFees=costs.costBudgetState(paid.run.id);
  assert.ok(paidFees.run.unknownCalls>0);recovery.confirmBusinessRecovery(paid.run.id,review(paid.run.id),true);
  assert.deepEqual(costs.costRows(paid.run.id),paidRows,'Owner review cannot release unknown fee credit');
  const paidPreview=await continuation.previewRunContinuation(paid.run.id,true),paidNext=continuation.submitRunContinuation(paid.run.id,confirmation(paidPreview),true);
  assert.equal(cp.readBusinessCheckpoint(paidNext.run.id).version,3);
  assert.equal(costs.costBudgetState(paidNext.run.id).run.charged,paidFees.run.charged);
  assert.equal(costs.costBudgetState(paidNext.run.id).run.unknownCalls,paidFees.run.unknownCalls);
  failPeer=false;const paidCalls=calls.length;await coordination.runCoordinationPlan(paidNext.run,paidNext.run.goal);assert.equal(calls.length,paidCalls+1);
  assert.deepEqual(costs.costRows(paid.run.id),paidRows);

  // Owner/CSRF/Host/Origin and strict immutable-scope input, no dispatch from inspection/review.
  const url=`/api/accounts/business/${budget.run.id}/recovery-inspection`,host={host:'127.0.0.1:43220'};
  assert.equal((await app.inject({method:'POST',url,headers:host,payload:{}})).statusCode,401);
  const session=await app.inject({method:'POST',url:'/api/accounts/session',headers:{...host,'x-gand-bootstrap':'1'}});const auth={...host,cookie:session.headers['set-cookie'].split(';')[0],'x-gand-csrf':session.json().csrfToken};
  assert.equal((await app.inject({method:'POST',url,headers:{...host,cookie:auth.cookie},payload:{}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url,headers:{...auth,origin:'https://bad.invalid'},payload:{}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url,headers:auth,payload:{audience:['observer']}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url,headers:auth,payload:{}})).statusCode,200);
  const historyUrl=`/api/accounts/business/${budget.run.id}/recovery-reviews`;assert.equal((await app.inject({method:'GET',url:historyUrl,headers:host})).statusCode,401);const reviewHistory=await app.inject({method:'GET',url:historyUrl,headers:auth});assert.equal(reviewHistory.statusCode,200);assert.equal(reviewHistory.json().reviews[0].id,recovery.listBusinessRecoveryReviews(budget.run.id)[0].id);assert.equal(reviewHistory.json().reviews[0].input.reason,rb.reason);
  const invalidReview=await app.inject({method:'POST',url:historyUrl,headers:auth,payload:{...rb,clientRequestId:randomUUID(),steps:[null]}});assert.equal(invalidReview.statusCode,409);
  assert.equal(db.get('SELECT MAX(version) n FROM orchestration_schema_migrations').n,10);
  console.log(`R4 private/write stage recovery (${process.env.COORDINATION_RUNTIME_KERNEL}) verified: encrypted scope-bound checkpoint, native SDK/Codex controlled writes, before/after write timeout, owner reconciliation, immutable source, no replay, fresh files-only session, owned workspace drift, private rework, budget upper-bound carry, stale config/scope, unique successor/rollback/cold read, Owner API; R5 fee review drift, unknown retention and private successor carry. No real model requests.`);
}finally{await app.close();await (await import('../apps/server/src/execution/runner.ts')).shutdownExternalAgents();db.closeDatabase();await rm(root,{recursive:true,force:true});}

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'gand-branch-rework-'));
Object.assign(process.env, { NODE_ENV: 'test', DB_PATH: path.join(root, 'test.sqlite'), AGENTS_DIR: path.join(root, 'roles'),
  AGENT_GAND_ISOLATED_WORKER: '1', AGENT_GAND_PRIVATE_DIR: path.join(root, 'private'), LOG_LEVEL: 'silent', MCP_SERVER_CMD: '',
  COORDINATION_RUNTIME_KERNEL: process.argv.includes('--kernel-off') ? 'off' : 'execute', HOST: '127.0.0.1', PORT: '43220', ACCOUNT_TRUSTED_ORIGINS: 'http://127.0.0.1:43220' });
globalThis.fetch = () => { throw new Error('No network allowed in stage rework fixture'); };
const db = await import('../apps/server/src/db/database.ts');
const { config } = await import('../apps/server/src/config.ts'); config.sandboxDir = path.join(root, 'sandbox');
const registry = await import('../apps/server/src/agents/registry.ts');
const rooms = await import('../apps/server/src/conversations/service.ts');
const entry = await import('../apps/server/src/orchestration/entry.ts');
const trace = await import('../apps/server/src/runs/trace.ts');
const coordination = await import('../apps/server/src/coordination/runtime.ts');
const store = await import('../apps/server/src/coordination/store.ts');
const business = await import('../apps/server/src/orchestration/business.ts');
const checkpoints = await import('../apps/server/src/orchestration/businessCheckpointStore.ts');
const { previewBusinessRework, submitBusinessRework } = await import('../apps/server/src/orchestration/businessRework.ts');
const { previewRunContinuation, submitRunContinuation } = await import('../apps/server/src/orchestration/continuation.ts');
const { getRunTerminal, commitRunTerminal } = await import('../apps/server/src/runtime/terminal.ts');
const { resolveEvidence } = await import('../apps/server/src/runtime/evidence.ts');
const { mockProvider } = await import('../apps/server/src/llm/provider.ts');
const { post } = await import('../apps/server/src/messaging/inbox.ts');
const { default: Fastify } = await import('../apps/server/node_modules/fastify/fastify.js');
const { registerRoutes } = await import('../apps/server/src/api/routes.ts');
const { registerAccountRoutes } = await import('../apps/server/src/api/accountRoutes.ts');
const app = Fastify(); await registerRoutes(app); await registerAccountRoutes(app);
for (const id of ['worker', 'peer']) registry.createAgent({ id, name: id, description: 'rework fixture', systemPrompt: 'Provide substantive deliverables.', model: 'mock:' + id,
  capabilities: ['execute'], permissionMode: 'readonly', tools: [], disallowedTools: [], color: '#4477aa', avatar: '' });
const calls = []; let expireRun = null;
mockProvider.chat = async req => {
  const text = req.messages.map(m => m.content).join('\n'); calls.push({ model: req.model, text, maxTokens: req.maxTokens });
  if (expireRun && req.model.endsWith('worker')) db.run("UPDATE business_stage_executions SET started_at='2000-01-01T00:00:00.000Z' WHERE run_id=? AND stage_id='analysis'", expireRun);
  return { content: `完整交付 ${calls.length}：包含事实依据、分析步骤和可执行的建议。`, usage: { tokensIn: 1, tokensOut: 2, costUsd: 0 }, toolCalls: [], truncated: false, stopReason: 'end_turn' };
};
const action = (id, command) => business.applyBusinessCommand(id, { ...command, expectedVersion: business.getBusinessState(id).version, clientRequestId: randomUUID() });
function report(id, stageId, ref = business.listBusinessEvidence(id).filter(c => c.stageId === stageId).at(-1).ref) {
  return action(id, { action: 'report', stageId, kind: 'delivery', note: '核对实质交付', evidence: [{ deliverableId: 'result', ref }] });
}
function decide(id, stageId, verdict = 'accept') {
  return action(id, { action: 'decide', stageId, reportId: business.getBusinessState(id).stages.find(s => s.stage.id === stageId).report.id,
    verdict, checkedCriteria: verdict === 'accept' ? [0] : [], reason: verdict === 'accept' ? '确认通过' : '缺少反例依据，请补充边界分析' });
}
const code = (fn, expected) => assert.throws(fn, e => e.code === expected);
const inputFor = id => {
  const state = business.getBusinessState(id), item = state.stages.find(s => s.status === 'rejected');
  return { stageId: item.stage.id, reportId: item.report.id, expectedVersion: state.version, instruction: 'REWORK_REQUIREMENT 补充反例与限制，并给出完整修订交付。' };
};
const confirm = p => ({ ...p.input, previewId: p.preview.previewId, orchestrationFingerprint: p.preview.fingerprint });
const workerAttempts = id => db.all('SELECT * FROM coordination_step_attempts WHERE run_id=? AND output IS NOT NULL ORDER BY created_at,id', id);
async function fixture({ rejected = true, readonly = true, firstRejected = false, explicit=false, dependent=false } = {}) {
  const room = rooms.createConversation({ title: 'stage rework fixture', mode: 'collaboration', agentIds: ['worker', 'peer'], workspace: 'original-shared-workspace' });
  const contract = { version: 1, executionMode: 'stage_gated', stages: [
    { id: 'foundation', title: '基础结论', criteria: ['有依据'], deliverables: [{ id: 'result', title: '基础报告', kind: 'text' }], execution: { assignments: [{ agentId: 'worker', objective: 'FIRST_STAGE 建立基础分析' }], maxTokens: 12 } },
    { id: 'analysis', title: '边界分析', criteria: ['边界清晰'], deliverables: [{ id: 'result', title: '边界报告', kind: 'text' }], execution: { assignments: [{ agentId: 'worker', objective: 'REJECTED_STAGE 分析边界' }, { agentId: 'peer', objective: 'REJECTED_STAGE 交叉核对边界' }], maxTokens: 12, timeoutMs: 30000 } },
    { id: 'advice', title: '行动建议', criteria: ['可执行'], deliverables: [{ id: 'result', title: '建议报告', kind: 'text' }], execution: { assignments: [{ agentId: 'peer', objective: 'FUTURE_STAGE 给出行动建议' }], maxTokens: 12 } },
  ] };
  if(explicit){contract.version=2;contract.revision=1;for(const stage of contract.stages)for(const task of stage.execution.assignments)task.dependsOn=[];}
  if(dependent)contract.stages[1].execution.assignments[1].dependsOn=['worker'];
  const input = { conversationId: room.id, goal: '分阶段完成分析', agentIds: room.agentIds, strategy: 'serial', workflow: 'routine', workspace: room.workspace,
    constraints: { readonly, maxTokens: 20, deadlineMs: 30000 }, businessContract: contract, clientRequestId: randomUUID() };
  const p = await entry.previewExecutionOrchestration(input); assert.deepEqual(p.decision.issues.filter(i => i.severity === 'error'), []);
  const f = entry.submitExecutionOrchestration({ ...input, entryVersion: 1, previewId: p.previewId, orchestrationFingerprint: p.fingerprint }, room.id);
  await coordination.runCoordinationPlan(f.run, f.run.goal);
  report(f.run.id, 'foundation');
  if (firstRejected) { decide(f.run.id, 'foundation', 'reject'); return { ...f, input }; }
  decide(f.run.id, 'foundation'); await coordination.resumeCoordinationRun(f.run.id);
  report(f.run.id, 'analysis'); if (rejected) decide(f.run.id, 'analysis', 'reject');
  return { ...f, input };
}
async function waitFor(fn) { for (let n = 0; n < 500; n++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Fixture wait timed out'); }
const {previewBusinessRevision,submitBusinessRevision}=await import('../apps/server/src/orchestration/businessRevision.ts');
const {affectedMembers}=await import('../apps/server/src/orchestration/businessImpact.ts');
const {assessRunRecovery}=await import('../apps/server/src/runtime/recovery.ts');
const {buildGraphCheckpoint}=await import('../apps/server/src/orchestration/graphCheckpoint.ts');
const tasks=await import('../apps/server/src/messaging/tasks.ts');
const taskAttempts=await import('../apps/server/src/tasks/attempts.ts');
const taskAdapter=await import('../apps/server/src/runtime/taskAdapter.ts');
const {pipelineOrchestrator}=await import('../apps/server/src/orchestration/pipeline.ts');
const {applyRunAction,retryTaskExecution}=await import('../apps/server/src/orchestration/actions.ts');
const originalChat=mockProvider.chat;
const collaboration=await import('../apps/server/src/collaboration/store.ts');
const {planCollaborationAdmission}=await import('../apps/server/src/runtime/subjectContract.ts');
const {freezeRuntimeContract}=await import('../apps/server/src/runtime/controlAction.ts');
const {observeAdmission}=await import('../apps/server/src/runtime/shadow.ts');
const costs=await import('../apps/server/src/orchestration/costBudget.ts');
const artifacts=await import('../apps/server/src/artifacts/store.ts');
try {
  const independent=await fixture({explicit:true}),before=calls.length,sourceLedger=business.businessHistory(independent.run.id);
  const resumeEligibility=assessRunRecovery(independent.run.id).capabilities.actions.find(a=>a.kind==='resume');
  assert.equal(resumeEligibility.available,false);assert.deepEqual(resumeEligibility.reasonCodes,['BUSINESS_STAGE_ACCEPTANCE_REQUIRED']);
  await assert.rejects(()=>applyRunAction(independent.run.id,'resume'),e=>e.code==='BUSINESS_STAGE_ACCEPTANCE_REQUIRED');
  const partial=await previewBusinessRework(independent.run.id,{...inputFor(independent.run.id),selectedAgentIds:['worker']},true);
  assert.deepEqual(partial.checkpoint.impact.redo.filter(t=>t.stageId==='analysis').map(t=>t.agentId),['worker']);
  assert.equal(partial.checkpoint.completedWorkers,2);
  assert.equal(partial.checkpoint.rework.rejectedWorkers,1);
  const next=submitBusinessRework(independent.run.id,confirm(partial),true);
  await coordination.runCoordinationPlan(next.run,next.run.goal);
  assert.equal(calls.length,before+1,'independent successful peer never reruns');
  assert.deepEqual(business.businessHistory(independent.run.id),sourceLedger);
  assert.equal(business.listBusinessEvidence(next.run.id).filter(e=>e.stageId==='analysis').length,2,'new and retained results have trusted provenance');
  const chain={...partial.stage,execution:{assignments:[{agentId:'a',objective:'A',dependsOn:[]},{agentId:'b',objective:'B',dependsOn:['a']},{agentId:'c',objective:'C',dependsOn:[]}]},deliverables:[{kind:'text'}]};
  assert.deepEqual([...affectedMembers(chain,['a'],true).ids],['a','b']);
  assert.deepEqual([...affectedMembers({...chain,deliverables:[{kind:'file'}]},['a'],true).ids],['a','b','c']);
  const {normalizeBusinessContract}=await import('../apps/server/src/orchestration/businessContract.ts');const cycle=structuredClone(independent.input.businessContract);cycle.stages[1].execution.assignments[0].dependsOn=['peer'];code(()=>normalizeBusinessContract(cycle),'INVALID_BUSINESS_CONTRACT');
  const legacy=await fixture(),whole=await previewBusinessRework(legacy.run.id,{...inputFor(legacy.run.id),selectedAgentIds:['worker']},true);
  assert.equal(whole.checkpoint.impact.redo.filter(t=>t.stageId==='analysis').length,2);
  await assert.rejects(()=>previewBusinessRework(independent.run.id,{...inputFor(legacy.run.id),selectedAgentIds:['outsider']},true));

  const revisionSource=await fixture({explicit:true}),original=business.getBusinessState(revisionSource.run.id),contract=structuredClone(original.contract);
  contract.revision=2;contract.stages[1].criteria=['NEW_CRITERION 必须涵盖反例'];
  const revisionInput={expectedVersion:original.version,contract,instruction:'REVISION_REQUIREMENT 增加反例标准'};
  await assert.rejects(()=>previewBusinessRevision(revisionSource.run.id,revisionInput),e=>e.code==='OWNER_REQUIRED');
  const rp=await previewBusinessRevision(revisionSource.run.id,revisionInput,true);
  assert.deepEqual(rp.checkpoint.acceptedStageIds,['foundation']);assert.deepEqual(rp.checkpoint.impact.reacceptStageIds,['analysis','advice']);
  assert.equal(calls.length,before+1+6,'all previews are model-free');
  const revised=submitBusinessRevision(revisionSource.run.id,confirm(rp),true);
  assert.equal(submitBusinessRevision(revisionSource.run.id,confirm(rp),true).run.id,revised.run.id);
  code(()=>submitBusinessRevision(revisionSource.run.id,{...confirm(rp),instruction:'another'},true),'IDEMPOTENCY_CONFLICT');
  assert.equal(business.getBusinessState(revisionSource.run.id).contract.revision,1);
  assert.deepEqual(business.getBusinessState(revisionSource.run.id).stages.map(s=>s.decision),original.stages.map(s=>s.decision));
  const revisionCalls=calls.length;await coordination.runCoordinationPlan(revised.run,revised.run.goal);
  assert.equal(calls.length,revisionCalls+2);assert.ok(calls.slice(revisionCalls).every(c=>c.text.includes('NEW_CRITERION')&&c.text.includes('REVISION_REQUIREMENT')));
  assert.equal(business.getBusinessState(revised.run.id).stages[1].report,null);
  const changed=await fixture({explicit:true}),changedState=business.getBusinessState(changed.run.id),assignmentContract=structuredClone(changedState.contract);
  assignmentContract.revision=2;assignmentContract.stages[1].execution.assignments[0].objective='修订成员独立目标';
  const ap=await previewBusinessRevision(changed.run.id,{expectedVersion:changedState.version,contract:assignmentContract,instruction:'更新独立分工'},true);
  assert.equal(ap.checkpoint.completedWorkers,2);
  const bad=structuredClone(assignmentContract);bad.stages[1].execution.maxTokens++;
  await assert.rejects(()=>previewBusinessRevision(changed.run.id,{...ap.input,contract:bad},true),e=>e.code==='CONTRACT_BUDGET_CHANGED');
  // CAS and transaction failure cannot create another successor or mutate the source.
  report(changed.run.id,'analysis');code(()=>submitBusinessRevision(changed.run.id,confirm(ap),true),'BUSINESS_STATE_STALE');
  const rollback=await fixture({explicit:true}),rc=structuredClone(business.getBusinessState(rollback.run.id).contract);rc.revision=2;rc.stages[1].criteria=['修订'];
  const rr=await previewBusinessRevision(rollback.run.id,{expectedVersion:business.getBusinessState(rollback.run.id).version,contract:rc,instruction:'回滚夹具'},true),count=db.get('SELECT COUNT(*)n FROM runs').n;
  db.db.exec(`CREATE TRIGGER r6_close_failure BEFORE UPDATE ON coordination_plans WHEN OLD.run_id='${rollback.run.id}' AND NEW.status='cancelled' BEGIN SELECT RAISE(ABORT,'r6 rollback'); END`);
  assert.throws(()=>submitBusinessRevision(rollback.run.id,confirm(rr),true),/r6 rollback/);db.db.exec('DROP TRIGGER r6_close_failure');assert.equal(db.get('SELECT COUNT(*)n FROM runs').n,count);

  // An actual dependent branch reruns with its changed upstream, while an accepted earlier standard is invalidated.
  const dependent=await fixture({explicit:true,dependent:true}),dp=await previewBusinessRework(dependent.run.id,{...inputFor(dependent.run.id),selectedAgentIds:['worker']},true);
  assert.deepEqual(dp.checkpoint.impact.redo.filter(t=>t.stageId==='analysis').map(t=>t.agentId),['worker','peer']);
  const dn=submitBusinessRework(dependent.run.id,confirm(dp),true),dependentCalls=calls.length;
  await coordination.runCoordinationPlan(dn.run,dn.run.goal);assert.equal(calls.length,dependentCalls+2);
  assert.match(calls.at(-1).text,/完整交付/,'dependent peer receives the new upstream output');
  const earlier=await fixture({explicit:true}),earlierState=business.getBusinessState(earlier.run.id),earlierContract=structuredClone(earlierState.contract);earlierContract.revision=2;earlierContract.stages[0].criteria=['新的基础验收要求'];
  const ep=await previewBusinessRevision(earlier.run.id,{expectedVersion:earlierState.version,contract:earlierContract,instruction:'重新核对基础标准和所有下游工作'},true);
  assert.deepEqual(ep.checkpoint.acceptedStageIds,[]);assert.equal(ep.checkpoint.completedWorkers,0);assert.deepEqual(ep.checkpoint.impact.reacceptStageIds,['foundation','analysis','advice']);
  const en=submitBusinessRevision(earlier.run.id,confirm(ep),true),earlierCalls=calls.length;
  await coordination.runCoordinationPlan(en.run,en.run.goal);assert.equal(calls.length,earlierCalls+1);
  assert.equal(business.getBusinessState(earlier.run.id).stages[0].status,'accepted');assert.equal(business.getBusinessState(en.run.id).stages[0].status,'pending');

  // Actual mock-model parallel analysis -> failure -> graph transfer, then a second transfer.
  let failPeer=true;mockProvider.chat=async req=>{if(failPeer&&req.model.endsWith('peer'))throw new Error('r6 temporary failure');return originalChat(req);};
  registry.updateAgent('worker',{...registry.getAnyAgent('worker'),capabilities:['execute','coordinate']},registry.getAnyAgent('worker').version);
  const room=rooms.createConversation({title:'parallel graph',mode:'collaboration',agentIds:['worker','peer'],workspace:null});
  const policy={version:1,currency:'USD',maxCost:10,mode:'estimate',unknownAction:'reserve',unknownReserve:0.1,prices:room.agentIds.map(agentId=>({agentId,model:'mock:'+agentId,source:'r6 fixture tariff',version:'r6-fixture',inputPerMillion:1,outputPerMillion:2,otherCharges:'none'}))};
  const request={conversationId:room.id,goal:'各分支分析后汇总',agentIds:room.agentIds,recipientIds:room.agentIds,strategy:'parallel',workflow:'analysis_summary',aggregatorId:'worker',constraints:{readonly:true,costPolicy:policy},clientRequestId:randomUUID()};
  const pp=await entry.previewExecutionOrchestration(request);assert.deepEqual(pp.decision.issues.filter(i=>i.severity==='error'),[]);
  const source=entry.submitExecutionOrchestration({...request,entryVersion:1,previewId:pp.previewId,orchestrationFingerprint:pp.fingerprint},room.id);
  await assert.rejects(()=>coordination.runCoordinationPlan(source.run,source.run.goal));
  assert.equal(assessRunRecovery(source.run.id).continuationKind,'dependency_graph');
  await assert.rejects(()=>previewRunContinuation(source.run.id),e=>e.code==='OWNER_REQUIRED');
  const gp=await previewRunContinuation(source.run.id,true);assert.deepEqual(gp.preview.decision.issues.filter(i=>i.severity==='error'),[]);
  db.run("INSERT INTO orchestration_token_reservations(id,run_id,reserved,status,created_at) VALUES(?,?,?,'unknown',?)",'r6-unknown',source.run.id,4,new Date().toISOString());
  code(()=>buildGraphCheckpoint(source.run.id),'RESULT_UNKNOWN');db.run('DELETE FROM orchestration_token_reservations WHERE id=?','r6-unknown');
  assert.deepEqual(gp.checkpoint.graph.retainedStepIds,['work-1']);assert.deepEqual(gp.checkpoint.graph.redoStepIds,['work-2','analysis-summary']);
  const carried=submitRunContinuation(source.run.id,{previewId:gp.preview.previewId,orchestrationFingerprint:gp.preview.fingerprint},true);
  assert.equal(checkpoints.readBusinessCheckpoint(carried.run.id).version,4);
  const savedCheckpoint=db.get('SELECT manifest FROM business_run_checkpoints WHERE run_id=?',carried.run.id).manifest;
  db.run('UPDATE business_run_checkpoints SET manifest=? WHERE run_id=?',JSON.stringify({encryptedCheckpointVersion:5}),carried.run.id);
  code(()=>checkpoints.readBusinessCheckpoint(carried.run.id),'CHECKPOINT_CORRUPT');
  db.run('UPDATE business_run_checkpoints SET manifest=? WHERE run_id=?',savedCheckpoint,carried.run.id);
  assert.equal(costs.costBudgetState(carried.run.id).run.charged,costs.costBudgetState(source.run.id).run.charged,'graph carry keeps known and unknown fees');
  assert.deepEqual(gp.preview.request.constraints.costPolicy,policy);
  await assert.rejects(()=>coordination.runCoordinationPlan(carried.run,carried.run.goal));
  const again=await previewRunContinuation(carried.run.id,true);assert.deepEqual(again.checkpoint.graph.retainedStepIds,['work-1']);
  failPeer=false;const final=submitRunContinuation(carried.run.id,{previewId:again.preview.previewId,orchestrationFingerprint:again.preview.fingerprint},true),graphCalls=calls.length;
  await coordination.runCoordinationPlan(final.run,final.run.goal);assert.equal(calls.length,graphCalls+2);
  assert.ok(costs.costBudgetState(final.run.id).inheritedCalls>=costs.costRows(source.run.id).length);
  assert.equal(trace.getRun(source.run.id).status,'failed');assert.equal(trace.getRun(final.run.id).status,'completed');
  assert.ok(calls.at(-1).text.includes(gp.checkpoint.confirmedOutputs[0].excerpt),'aggregate gets retained ancestor output');

  // Existing Pipeline adapter uses real admitted turns and keeps its confirmed prefix.
  failPeer=true;const pr=rooms.createConversation({title:'pipeline graph',mode:'pipeline',agentIds:room.agentIds,workspace:null});
  const pipeline=trace.createRun('旧流水线只读任务','pipeline',room.agentIds,null,null,pr.id);
  await assert.rejects(()=>pipelineOrchestrator.start(pipeline,room.agentIds.map(registry.getAnyAgent),pipeline.goal));
  const pipelinePreview=await previewRunContinuation(pipeline.id,true);assert.equal(pipelinePreview.checkpoint.graph.sourceEngine,'pipeline');
  assert.equal(pipelinePreview.checkpoint.graph.retainedStepIds.length,1);
  failPeer=false;const pipelineNext=submitRunContinuation(pipeline.id,{previewId:pipelinePreview.preview.previewId,orchestrationFingerprint:pipelinePreview.preview.fingerprint},true),pipelineCalls=calls.length;
  await coordination.runCoordinationPlan(pipelineNext.run,pipelineNext.run.goal);assert.equal(calls.length,pipelineCalls+1);

  // Supervisor frozen DAG adapter: fixtures persist real attempt/review evidence, never fabricate successor attempts.
  registry.createAgent({id:'judge',name:'独立审查',description:'r6 review fixture',systemPrompt:'Review independently',model:'mock:judge',capabilities:['review'],permissionMode:'readonly',tools:[],disallowedTools:[],color:'#4477aa',avatar:''});
  const sr=rooms.createConversation({title:'supervisor graph',mode:'supervisor',agentIds:[...room.agentIds,'judge'],workspace:null});
  const supervisor=trace.createRun('冻结主管分工','supervisor',sr.agentIds,null,'worker',sr.id);taskAdapter.admitTaskAdapter(supervisor);
  const good=tasks.createTask({runId:supervisor.id,title:'独立成功',body:'GOOD_BRANCH',createdBy:'worker',assignee:'worker',reviewerId:'judge',maxAttempts:1,acceptanceCriteria:['完整交付']});
  taskAdapter.admitTaskSubject(good.id,'work');const claimed=tasks.claimTask(good.id,'worker');const ga=taskAttempts.createAttempt({taskId:good.id,runId:supervisor.id,agentId:'worker',kind:'work',attemptNo:claimed.attempt,inputContext:'fixture',leaseMs:30000});
  taskAttempts.completeAttempt(ga.id,'SUPERVISOR_CONFIRMED_RESULT');
  taskAdapter.admitTaskSubject(good.id,'review');const ra=taskAttempts.createAttempt({taskId:good.id,runId:supervisor.id,agentId:'judge',kind:'review',attemptNo:claimed.attempt,inputContext:'fixture review',leaseMs:30000});
  const verdict={verdict:'PASS',summary:'独立审查通过',issues:[]};taskAttempts.completeAttempt(ra.id,JSON.stringify(verdict));const reviews=await import('../apps/server/src/tasks/reviews.ts');reviews.createReview({taskId:good.id,attemptId:ga.id,reviewerId:'judge',...verdict});
  tasks.completeTask(good.id,'worker','SUPERVISOR_CONFIRMED_RESULT');
  const failed=tasks.createTask({runId:supervisor.id,title:'失败分支',body:'RETRY_BRANCH',createdBy:'worker',assignee:'peer',maxAttempts:1,acceptanceCriteria:['完整交付']});taskAdapter.admitTaskSubject(failed.id,'work');tasks.failTask(failed.id,'temporary failure');
  commitRunTerminal({runId:supervisor.id,status:'failed',disposition:'failed',source:'r6 fixture'});
  db.run('UPDATE task_attempts SET attempt_no=? WHERE id=?',claimed.attempt+1,ra.id);code(()=>buildGraphCheckpoint(supervisor.id),'CHECKPOINT_EVIDENCE_INVALID');
  db.run('UPDATE task_attempts SET attempt_no=? WHERE id=?',claimed.attempt,ra.id);
  const sp=await previewRunContinuation(supervisor.id,true);assert.equal(sp.checkpoint.graph.sourceEngine,'supervisor');assert.equal(sp.checkpoint.graph.retainedStepIds.length,2);
  assert.throws(()=>retryTaskExecution(failed.id),/任务卡预览/);
  const sn=submitRunContinuation(supervisor.id,{previewId:sp.preview.previewId,orchestrationFingerprint:sp.preview.fingerprint},true),supervisorCalls=calls.length;
  await coordination.runCoordinationPlan(sn.run,sn.run.goal);assert.equal(calls.length,supervisorCalls+2);
  assert.equal(db.get('SELECT COUNT(*)n FROM task_attempts WHERE run_id=?',sn.run.id).n,0,'successor does not fake model work attempts');

  // A persisted Collaboration all batch has known branches and an explicit aggregate.
  const cr=rooms.createConversation({title:'all batch graph',mode:'collaboration',agentIds:room.agentIds,workspace:null}),collab=trace.createRun('汇合两个咨询分支','collaboration',room.agentIds,null,null,cr.id);
  trace.setRunStatus(collab.id,'running');
  const admission=planCollaborationAdmission({runId:collab.id,objective:collab.goal,participantIds:collab.agentIds,targetAgentIds:['worker'],completionEngine:true,controlActionVersion:2,messageVisibilityVersion:1,exitGuard:{version:1,maxCorrections:0,correctionMaxTokens:512},completionCandidateVersion:1,successorObligationVersion:1,evidenceBundleVersion:1,contextContributorVersion:1,durableHoldVersion:2});freezeRuntimeContract(admission.contract);
  const msg=post({runId:collab.id,from:'user',to:'worker',kind:'user',body:collab.goal}),parent=collaboration.createDispatch({runId:collab.id,conversationId:cr.id,sourceMessageId:msg.id,kind:'initial',from:'user',targetAgentId:'worker',depth:0,idempotencyKey:'r6-parent'});observeAdmission(admission.contract,admission.subjects,[parent.id]);
  const parentClaim=collaboration.claimNextDispatch(cr.id,'r6-fixture');collaboration.finishAttempt({attemptId:parentClaim.attempt.id,dispatchId:parent.id,status:'completed',output:'明确咨询两个成员后汇总',action:{version:2,type:'consult',targetAgentIds:room.agentIds,objective:'分别分析问题',reason:'分别核验后汇合',join:'all'}});
  const batch=collaboration.createBatch({runId:collab.id,conversationId:cr.id,initiatorAgentId:'worker',sourceDispatchId:parent.id,question:'分别分析问题',targetAgentIds:room.agentIds,joinPolicy:'all'});
  for(const actor of room.agentIds) {
    const question=post({runId:collab.id,from:'worker',to:actor,kind:'agent',body:batch.question});
    const dispatch=collaboration.createDispatch({runId:collab.id,conversationId:cr.id,sourceMessageId:question.id,parentDispatchId:parent.id,batchId:batch.id,kind:'fanout',from:'worker',targetAgentId:actor,depth:1,idempotencyKey:'r6-branch-'+actor});
    const claim=collaboration.claimNextDispatch(cr.id,'r6-fixture');assert.equal(claim.dispatch.id,dispatch.id);
    collaboration.finishAttempt({attemptId:claim.attempt.id,dispatchId:dispatch.id,status:actor==='worker'?'completed':'failed',output:actor==='worker'?'COLLABORATION_INDEPENDENT_RESULT':null,error:actor==='peer'?'timeout':null,action:actor==='worker'?{version:2,type:'answer',summary:'独立回答完成'}:null});
  }
  collaboration.updateBatch(batch.id,'failed');commitRunTerminal({runId:collab.id,status:'failed',disposition:'failed',source:'r6 all batch fixture'});
  const cp=await previewRunContinuation(collab.id,true);assert.equal(cp.checkpoint.graph.sourceEngine,'collaboration');assert.equal(cp.checkpoint.graph.retainedStepIds.length,2);
  const parentAction=JSON.stringify(collaboration.listAttempts(collab.id).find(a=>a.id===parentClaim.attempt.id).controlAction);
  db.run('UPDATE collaboration_attempts SET control_action=? WHERE id=?',JSON.stringify({...JSON.parse(parentAction),objective:'未经冻结的问题'}),parentClaim.attempt.id);
  code(()=>buildGraphCheckpoint(collab.id),'GRAPH_CHECKPOINT_INCOMPATIBLE');db.run('UPDATE collaboration_attempts SET control_action=? WHERE id=?',parentAction,parentClaim.attempt.id);
  const cn=submitRunContinuation(collab.id,{previewId:cp.preview.previewId,orchestrationFingerprint:cp.preview.fingerprint},true),collabCalls=calls.length;
  await coordination.runCoordinationPlan(cn.run,cn.run.goal);assert.equal(calls.length,collabCalls+2);assert.match(calls.at(-1).text,/COLLABORATION_INDEPENDENT_RESULT/);
  db.run("UPDATE collaboration_batches SET join_policy='any' WHERE id=?",batch.id);code(()=>buildGraphCheckpoint(collab.id),'GRAPH_CHECKPOINT_INCOMPATIBLE');db.run("UPDATE collaboration_batches SET join_policy='all' WHERE id=?",batch.id);
  const privateMessage=post({runId:collab.id,from:'worker',to:'peer',kind:'agent',body:'PRIVATE_R6_MARKER',visibility:'private'});code(()=>buildGraphCheckpoint(collab.id),'PRIVATE_CHECKPOINT_UNSUPPORTED');

  // Public controlled input files are restored with exact hashes and current tool admission.
  const fr=rooms.createConversation({title:'files pipeline',mode:'pipeline',agentIds:room.agentIds,workspace:null});
  const filesSource=trace.createRun('受控输入承接','pipeline',room.agentIds,null,null,fr.id);failPeer=true;await assert.rejects(()=>pipelineOrchestrator.start(filesSource,room.agentIds.map(registry.getAnyAgent),filesSource.goal));failPeer=false;
  const inputFile=artifacts.createManagedArtifact({runId:filesSource.id,path:'input/r6.txt',content:Buffer.from('PUBLIC_CONTROLLED_INPUT_R6'),access:{visibility:'public',audience:[]},createdBy:'user'});
  const filePreview=await previewRunContinuation(filesSource.id,true);assert.ok(filePreview.preview.decision.issues.some(i=>i.code==='ATTACHMENT_BACKEND_UNSUPPORTED'));
  for(const actor of room.agentIds)registry.updateAgent(actor,{...registry.getAnyAgent(actor),tools:['fs.read']},registry.getAnyAgent(actor).version);
  const enabledFiles=await previewRunContinuation(filesSource.id,true);assert.equal(enabledFiles.preview.decision.issues.filter(i=>i.severity==='error').length,0);
  const fileNext=submitRunContinuation(filesSource.id,{previewId:enabledFiles.preview.previewId,orchestrationFingerprint:enabledFiles.preview.fingerprint},true);
  const imported=artifacts.listManagedArtifacts(fr.id).find(a=>a.runId===fileNext.run.id&&a.path===inputFile.path);assert.equal(imported.sha256,inputFile.sha256);
  await coordination.runCoordinationPlan(fileNext.run,fileNext.run.goal);

  // Owner HTTP authorization, stale confirmation and duplicate revision.
  const http=await fixture({explicit:true}),hc=structuredClone(business.getBusinessState(http.run.id).contract);hc.revision=2;hc.stages[1].criteria=['HTTP修订'];
  const body={expectedVersion:business.getBusinessState(http.run.id).version,contract:hc,instruction:'HTTP修订说明'},url=`/api/accounts/business/${http.run.id}/revision-preview`,host={host:'127.0.0.1:43220'};
  assert.equal((await app.inject({method:'POST',url,headers:host,payload:body})).statusCode,401);
  const session=await app.inject({method:'POST',url:'/api/accounts/session',headers:{...host,'x-gand-bootstrap':'1'}}),auth={...host,cookie:session.headers['set-cookie'].split(';')[0],'x-gand-csrf':session.json().csrfToken};
  assert.equal((await app.inject({method:'POST',url,headers:{...auth,origin:'https://untrusted.invalid'},payload:body})).statusCode,403);
  const response=await app.inject({method:'POST',url,headers:auth,payload:body});assert.equal(response.statusCode,200,response.body);
  const route=`/api/accounts/business/${http.run.id}/revisions`,sent=await app.inject({method:'POST',url:route,headers:auth,payload:confirm(response.json())});assert.equal(sent.statusCode,202,sent.body);
  await waitFor(()=>business.getBusinessState(sent.json().run.id).stages[1].execution.canAccept);
  const replay=await app.inject({method:'POST',url:route,headers:auth,payload:confirm(response.json())});assert.equal(replay.statusCode,200);assert.equal(replay.json().run.id,sent.json().run.id);
  const cold=execFileSync(process.execPath,['--import','./apps/server/node_modules/tsx/dist/loader.mjs','--input-type=module','-e',"const {readBusinessCheckpoint}=await import('./apps/server/src/orchestration/businessCheckpointStore.ts');const {db}=await import('./apps/server/src/db/database.ts');console.log(JSON.stringify(readBusinessCheckpoint(process.env.R6_RUN).graph));db.close();"],{env:{...process.env,R6_RUN:final.run.id},encoding:'utf8'});
  assert.equal(JSON.parse(cold.trim()).sourceEngine,'coordination');
  const legacyRun=trace.createRun('旧契约拒绝','pipeline',room.agentIds,null,null,room.id);trace.setRunStatus(legacyRun.id,'failed');code(()=>buildGraphCheckpoint(legacyRun.id),'LEGACY_CONTEXT_UNVERIFIED');
  await assert.rejects(()=>applyRunAction(legacyRun.id,'resume'),/终态任务/);
  assert.equal(db.get('SELECT MAX(version)n FROM orchestration_schema_migrations').n,11);
  console.log(`通过 R6：独立分支保留、依赖闭包/整阶段回退、契约版本及验收失效、预算限制/CAS/原子回滚、Collaboration/Coordination/Pipeline/Supervisor 图承接和二次续跑、Owner HTTP/幂等、加密 v4 冷读取、不兼容明确拒绝（kernel=${process.env.COORDINATION_RUNTIME_KERNEL}）。临时数据库和模拟模型，无真实模型调用。`);
} finally {await app.close();db.db.close();await rm(root,{recursive:true,force:true});}

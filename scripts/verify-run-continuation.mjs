import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'gand-continuation-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'test.sqlite'), NODE_ENV: 'test',
  AGENTS_DIR: path.join(root, 'roles'), SANDBOX_DIR: path.join(root, 'sandbox'), MCP_SERVER_CMD: '', LOG_LEVEL: 'silent' });
const db = await import('../apps/server/src/db/database.ts');
const registry = await import('../apps/server/src/agents/registry.ts');
const trace = await import('../apps/server/src/runs/trace.ts');
const rooms = await import('../apps/server/src/conversations/service.ts');
const inbox = await import('../apps/server/src/messaging/inbox.ts');
const store = await import('../apps/server/src/collaboration/store.ts');
const { planCollaborationAdmission } = await import('../apps/server/src/runtime/subjectContract.ts');
const { freezeRuntimeContract } = await import('../apps/server/src/runtime/controlAction.ts');
const { observeAdmission } = await import('../apps/server/src/runtime/shadow.ts');
const { commitRunTerminal, getRunTerminal } = await import('../apps/server/src/runtime/terminal.ts');
const { assembleCollaborationContext } = await import('../apps/server/src/runtime/context.ts');
const { assessRunRecovery, continuationRouteBlock } = await import('../apps/server/src/runtime/recovery.ts');
const { previewRunContinuation, submitRunContinuation } = await import('../apps/server/src/orchestration/continuation.ts');
const executions = await import('../apps/server/src/execution/store.ts');
const { config } = await import('../apps/server/src/config.ts');
const { mockProvider } = await import('../apps/server/src/llm/provider.ts');
let modelCalls = 0;
mockProvider.chat = async () => { modelCalls++; throw new Error('No model calls allowed in continuation admission test'); };
globalThis.fetch = () => { throw new Error('No network allowed in continuation test'); };
for (const id of ['host','peer']) registry.createAgent({ id, name: id, description: 'continuation fixture',
  systemPrompt: 'Deliver the requested result.', model: 'mock:' + id, capabilities: ['execute'],
  permissionMode: 'readonly', tools: [], disallowedTools: [], color: '#4477aa', avatar: '' });

function fixture(name, extra = {}, admitted = null) {
  const room = admitted?.room ?? rooms.createConversation({ title: name, mode: 'collaboration', agentIds: ['host','peer'], workspace: null });
  const source = admitted?.run ?? trace.createRun('完成分析报告', 'collaboration', ['host','peer'], null, null, room.id);
  trace.setRunStatus(source.id, 'running');
  const admission = planCollaborationAdmission({ runId: source.id, objective: source.goal, participantIds: source.agentIds,
    targetAgentIds: ['peer','host'], completionEngine: true, controlActionVersion: 2, messageVisibilityVersion: 1,
    exitGuard: { version: 1, maxCorrections: 1, correctionMaxTokens: 512 }, completionCandidateVersion: 1,
    successorObligationVersion: 1, evidenceBundleVersion: 1, contextContributorVersion: 1, durableHoldVersion: 2 });
  freezeRuntimeContract(admission.contract);
  const user = inbox.post({ runId: source.id, from: 'user', to: 'host', kind: 'user', body: source.goal });
  const question = inbox.post({ runId: source.id, from: 'host', to: 'peer', kind: 'agent', body: '查证基础事实' });
  const confirmed = store.createDispatch({ runId: source.id, conversationId: room.id, sourceMessageId: question.id,
    kind: 'initial', from: 'host', targetAgentId: 'peer', depth: 0, idempotencyKey: name + ':confirmed' });
  const pending = inbox.post({ runId: source.id, from: 'system', to: 'host', kind: 'system', body: '结合已确认事实交付最终报告' });
  const dispatch = store.createDispatch({ runId: source.id, conversationId: room.id, sourceMessageId: pending.id,
    kind: 'initial', from: 'system', targetAgentId: 'host', depth: 1, idempotencyKey: name + ':failed' });
  observeAdmission(admission.contract, admission.subjects, [confirmed.id, dispatch.id]);
  const first = store.claimNextDispatch(room.id, 'continuation-test'); assert.ok(first);
  store.finishAttempt({ attemptId: first.attempt.id, dispatchId: confirmed.id, status: 'completed', output: 'FACT_CONFIRMED_ONCE' });
  const second = store.claimNextDispatch(room.id, 'continuation-test'); assert.ok(second);
  store.finishAttempt({ attemptId: second.attempt.id, dispatchId: dispatch.id, status: 'failed', error: 'Timeout' });
  const execution = executions.createExecution({ runId: source.id, agentId: 'host', scopeId: second.attempt.id,
    driver: 'claude-sdk', agentVersion: 1, cwd: root });
  executions.updateExecution(execution.id, { status: 'failed', permissionMode: 'readonly', attemptId: second.attempt.id,
    errorCode: 'timeout', error: '已建立会话但无首响应', finishedAt: new Date().toISOString(), ...extra });
  commitRunTerminal({ runId: source.id, status: 'failed', disposition: 'failed', source: 'continuation-test',
    prepare: () => ({ reasonCodes: ['FAILED_DISPATCH'] }) });
  return { source: trace.getRun(source.id), room, dispatch, confirmed, execution, attempt: first.attempt, user };
}

try {
  const f = fixture('safe');
  const before = { run: trace.getRun(f.source.id), terminal: getRunTerminal(f.source.id), attempts: store.listAttempts(f.source.id),
    messages: inbox.listByRun(f.source.id), executions: executions.listExecutions(f.source.id) };
  assert.equal(assessRunRecovery(f.source.id).continuationAllowed, true);
  const preview = await previewRunContinuation(f.source.id);
  assert.match(preview.checkpoint.pendingObjective, /结合已确认事实交付最终报告/);
  assert.equal(preview.checkpoint.confirmedOutputs[0].excerpt, 'FACT_CONFIRMED_ONCE');
  assert.equal(preview.preview.request.constraints.readonly, true);
  assert.deepEqual(preview.preview.decision.targetIds, ['host']);
  assert.deepEqual(preview.preview.decision.issues.filter(issue => issue.severity === 'error'), []);
  assert.equal(db.get('SELECT COUNT(*) n FROM runs').n, 1, 'preview creates no Run');
  const body = { previewId: preview.preview.previewId, orchestrationFingerprint: preview.preview.fingerprint };
  const next = submitRunContinuation(f.source.id, body);
  assert.equal(next.deduplicated, false);
  assert.equal(submitRunContinuation(f.source.id, body).run.id, next.run.id);
  assert.equal(db.get('SELECT COUNT(*) n FROM runs').n, 2, 'duplicate continuation creates one Run');
  assert.deepEqual({ run: trace.getRun(f.source.id), terminal: getRunTerminal(f.source.id), attempts: store.listAttempts(f.source.id),
    messages: inbox.listByRun(f.source.id), executions: executions.listExecutions(f.source.id) }, before, 'source immutable');
  assert.equal(store.listDispatches(next.run.id).length, 0, 'admission does not replay any source dispatch');
  assert.equal(assessRunRecovery(next.run.id).sourceRunId, f.source.id);
  assert.equal(assessRunRecovery(f.source.id).continuationRunId, next.run.id);
  assert.match(continuationRouteBlock(next.run.id, ['peer'], '查证基础事实'), /已有确认输出/);
  assert.equal(continuationRouteBlock(next.run.id, ['peer'], '研究新的问题'), null);
  trace.setRunStatus(next.run.id, 'running');
  const nextAdmission = planCollaborationAdmission({ runId: next.run.id, objective: next.run.goal, participantIds: next.run.agentIds,
    targetAgentIds: ['host'], completionEngine: true, controlActionVersion: 2, contextContributorVersion: 1, messageVisibilityVersion: 1,
    exitGuard: { version: 1, maxCorrections: 1, correctionMaxTokens: 512 }, completionCandidateVersion: 1,
    successorObligationVersion: 1, evidenceBundleVersion: 1, durableHoldVersion: 2 });
  freezeRuntimeContract(nextAdmission.contract);
  const newUser = inbox.listByRun(next.run.id).find(message => message.kind === 'user');
  const d = store.createDispatch({ runId: next.run.id, conversationId: f.room.id, sourceMessageId: newUser.id,
    kind: 'initial', from: 'user', targetAgentId: 'host', depth: 0, idempotencyKey: 'continued:initial' });
  observeAdmission(nextAdmission.contract, nextAdmission.subjects, [d.id]);
  const claim = store.claimNextDispatch(f.room.id, 'continuation-test'); assert.ok(claim);
  const context = assembleCollaborationContext({ run: trace.getRun(next.run.id), dispatch: d,
    agent: registry.getAgent('host'), attemptId: claim.attempt.id });
  assert.match(context, /FACT_CONFIRMED_ONCE/); assert.match(context, /结合已确认事实交付最终报告/);
  assert.match(context, /不再重做对应确认/);
  store.finishAttempt({ attemptId: claim.attempt.id, dispatchId: d.id, status: 'failed', error: 'fixture cleanup' });
  trace.setRunStatus(next.run.id, 'failed');

  // Fee-enabled free collaboration uses owner admission and immutable carried charges.
  const entry = await import('../apps/server/src/orchestration/entry.ts');
  const costs = await import('../apps/server/src/orchestration/costBudget.ts');
  const snapshots = await import('../apps/server/src/orchestration/store.ts');
  const feeRoom = rooms.createConversation({title:'fees',mode:'collaboration',agentIds:['host','peer'],workspace:null});
  const feePolicy = {version:1,currency:'USD',mode:'estimate',maxCost:0.5,unknownAction:'reserve',unknownReserve:0.1,prices:[]};
  const feeInput = {conversationId:feeRoom.id,goal:'完成分析报告',agentIds:feeRoom.agentIds,recipientIds:['host'],strategy:'auto',workflow:'routine',workspace:null,constraints:{readonly:true,costPolicy:feePolicy}};
  const feePreview = await entry.previewExecutionOrchestration(feeInput);
  const feeSource = entry.submitExecutionOrchestration({...feeInput,entryVersion:1,clientRequestId:'fee-source',previewId:feePreview.previewId,orchestrationFingerprint:feePreview.fingerprint},feeRoom.id);
  const paid = fixture('fee-safe',{}, {room:feeRoom,run:feeSource.run});
  const knownFee = costs.reserveCost(paid.source.id,'host','mock:host','builtin-llm');costs.settleCost(knownFee,{costSource:'reported',costKnown:true,costUsd:0.02});
  const unknownFee = costs.reserveCost(paid.source.id,'peer','mock:peer','builtin-llm');costs.settleCost(unknownFee);
  await assert.rejects(()=>previewRunContinuation(paid.source.id),e=>e.code==='OWNER_REQUIRED');
  const oldFeePreview = await previewRunContinuation(paid.source.id,true);
  assert.equal(oldFeePreview.costBudget.run.charged,0.12);
  const lateFee = costs.reserveCost(paid.source.id,'host','mock:host','builtin-llm');costs.settleCost(lateFee);
  const feeConfirm = p=>({previewId:p.preview.previewId,orchestrationFingerprint:p.preview.fingerprint,costCarryDigest:p.costCarryDigest});
  assert.throws(()=>submitRunContinuation(paid.source.id,feeConfirm(oldFeePreview),true),e=>e.code==='COST_CARRY_STALE');
  const currentFeePreview = await previewRunContinuation(paid.source.id,true);
  const originalFeeRows = costs.costRows(paid.source.id);
  const feeNext = submitRunContinuation(paid.source.id,feeConfirm(currentFeePreview),true);
  assert.equal(submitRunContinuation(paid.source.id,feeConfirm(currentFeePreview),true).run.id,feeNext.run.id);
  assert.deepEqual(snapshots.getRunOrchestrationSnapshot(feeNext.run.id).request.constraints.costPolicy,feePolicy);
  assert.equal(costs.costBudgetState(feeNext.run.id).run.charged,0.22);
  assert.equal(costs.costBudgetState(feeNext.run.id).run.remaining,0.28);
  assert.equal(costs.costBudgetState(feeNext.run.id).run.unknownCalls,2);
  assert.equal(costs.costBudgetState(feeNext.run.id).inheritedCalls,3);
  assert.deepEqual(costs.costRows(paid.source.id),originalFeeRows);

  const privateRun = fixture('private');
  inbox.post({ runId: privateRun.source.id, from: 'host', to: 'peer', kind: 'agent', body: 'PRIVATE_SECRET', visibility: 'private' });
  assert.equal(assessRunRecovery(privateRun.source.id).reasonCodes[0], 'PRIVATE_CHECKPOINT_UNSUPPORTED');
  await assert.rejects(() => previewRunContinuation(privateRun.source.id), /私密状态/);
  const writeRun = fixture('write', { permissionMode: 'confirm' });
  assert.equal(assessRunRecovery(writeRun.source.id).reasonCodes[0], 'WRITE_RECONCILIATION_REQUIRED');
  const unknown = fixture('unknown', { status: 'interrupted', errorCode: 'interrupted' });
  assert.equal(assessRunRecovery(unknown.source.id).category, 'result_unknown');
  const unclassified = fixture('explicit-rejection', { errorCode: 'nonzero_exit', error: '业务要求未通过' });
  assert.equal(assessRunRecovery(unclassified.source.id).reasonCodes[0], 'FAILURE_NOT_CLASSIFIED');
  const processRun = fixture('process');
  db.run("INSERT INTO external_native_processes(token,execution_id,host,pid,status,created_at) VALUES(?,?,?,?,?,?)",
    'fake-active', processRun.execution.id, 'fixture', 999999, 'active', new Date().toISOString());
  assert.equal(assessRunRecovery(processRun.source.id).reasonCodes[0], 'RESULT_UNKNOWN');
  const changed = fixture('stale'); const oldPreview = await previewRunContinuation(changed.source.id);
  db.run("UPDATE agents SET version=version+1,definition=json_set(definition,'$.version',version+1) WHERE id='host'");
  assert.throws(() => submitRunContinuation(changed.source.id, { previewId: oldPreview.preview.previewId, orchestrationFingerprint: oldPreview.preview.fingerprint }), /已变化/);
  const savedMode = config.orchestrationRollout.entryMode;
  config.orchestrationRollout.entryMode = 'closed';
  const closed = await previewRunContinuation(changed.source.id);
  assert.ok(closed.preview.decision.issues.some(issue => issue.code === 'ORCHESTRATION_ENTRY_DISABLED'));
  config.orchestrationRollout.entryMode = savedMode;
  const { default: Fastify } = await import('../apps/server/node_modules/fastify/fastify.js');
  const { registerRoutes } = await import('../apps/server/src/api/routes.ts');
  const app = Fastify();
  try {
    await registerRoutes(app);
    const recoveryResponse = await app.inject({ method: 'GET', url: `/api/runs/${f.source.id}/recovery` });
    assert.equal(recoveryResponse.statusCode, 200);
    assert.equal(recoveryResponse.json().continuationRunId, next.run.id);
    const stateResponse = await app.inject({ method: 'GET', url: `/api/conversations/${f.room.id}/task-state` });
    assert.equal(stateResponse.statusCode, 200);
    assert.equal(stateResponse.json().tasks.find(item => item.runId === next.run.id).recovery.sourceRunId, f.source.id);
    const noConfirmation = await app.inject({ method: 'POST', url: `/api/runs/${changed.source.id}/continuations`, payload: {} });
    assert.equal(noConfirmation.statusCode, 400);
  } finally { await app.close(); }
  assert.equal(modelCalls, 0);
  console.log('通过：只读续跑预览、唯一关联 Run、终态/证据不可变、确认输出复用、重复派发阻断、私密/写入/未知进程围栏、配置漂移和入口关闭；费用 Owner 准入、账本漂移阻断、已知/未知结转及原政策冻结；零模型调用。');
} finally { db.db.close(); await rm(root, { recursive: true, force: true }); }

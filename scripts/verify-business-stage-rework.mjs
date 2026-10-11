import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'gand-stage-rework-'));
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
async function fixture({ rejected = true, readonly = true, firstRejected = false } = {}) {
  const room = rooms.createConversation({ title: 'stage rework fixture', mode: 'collaboration', agentIds: ['worker', 'peer'], workspace: 'original-shared-workspace' });
  const contract = { version: 1, executionMode: 'stage_gated', stages: [
    { id: 'foundation', title: '基础结论', criteria: ['有依据'], deliverables: [{ id: 'result', title: '基础报告', kind: 'text' }], execution: { assignments: [{ agentId: 'worker', objective: 'FIRST_STAGE 建立基础分析' }], maxTokens: 12 } },
    { id: 'analysis', title: '边界分析', criteria: ['边界清晰'], deliverables: [{ id: 'result', title: '边界报告', kind: 'text' }], execution: { assignments: [{ agentId: 'worker', objective: 'REJECTED_STAGE 分析边界' }, { agentId: 'peer', objective: 'REJECTED_STAGE 交叉核对边界' }], maxTokens: 12, timeoutMs: 30000 } },
    { id: 'advice', title: '行动建议', criteria: ['可执行'], deliverables: [{ id: 'result', title: '建议报告', kind: 'text' }], execution: { assignments: [{ agentId: 'peer', objective: 'FUTURE_STAGE 给出行动建议' }], maxTokens: 12 } },
  ] };
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
try {
  const f = await fixture(), input = inputFor(f.run.id), beforeCalls = calls.length;
  const ledger = business.businessHistory(f.run.id), attempts = workerAttempts(f.run.id);
  await assert.rejects(() => previewBusinessRework(f.run.id, input), e => e.code === 'OWNER_REQUIRED');
  code(() => submitBusinessRework(f.run.id, input), 'OWNER_REQUIRED');
  await assert.rejects(() => previewBusinessRework(f.run.id, { ...input, instruction: ' ' }, true), e => e.code === 'INVALID_REWORK_INPUT');
  await assert.rejects(() => previewBusinessRework(f.run.id, { ...input, stageId: 'foundation' }, true), e => e.code === 'STAGE_REWORK_UNAVAILABLE');
  const p = await previewBusinessRework(f.run.id, input, true);
  assert.equal(calls.length, beforeCalls); assert.equal(trace.getRun(f.run.id).status, 'waiting_for_user');
  assert.deepEqual(business.businessHistory(f.run.id), ledger); assert.deepEqual(workerAttempts(f.run.id), attempts);
  assert.deepEqual(p.checkpoint.acceptedStageIds, ['foundation']); assert.equal(p.checkpoint.rework.rejectedWorkers, 2);
  assert.equal(p.checkpoint.carriedRunTokens, 6); assert.equal(p.closesWaitingSource, true);
  assert.deepEqual(p.preview.plan.plan.steps.filter(s => s.agentId).map(s => s.id), ['stage-2-work-1', 'stage-2-work-2', 'stage-3-work-1']);
  assert.deepEqual(p.preview.request.businessContract, f.input.businessContract, 'criteria, assignments, deliverables and caps stay frozen');
  const count = db.get('SELECT COUNT(*) n FROM runs').n;
  code(() => submitBusinessRework(f.run.id, { ...confirm(p), instruction: 'Different instruction' }, true), 'PREVIEW_STALE');
  assert.equal(trace.getRun(f.run.id).status, 'waiting_for_user'); assert.equal(db.get('SELECT COUNT(*) n FROM runs').n, count, 'failed admission has no orphan Run');
  registry.updateAgent('peer', { ...registry.getAnyAgent('peer'), name: 'Updated peer' }, registry.getAnyAgent('peer').version);
  code(() => submitBusinessRework(f.run.id, confirm(p), true), 'PREVIEW_STALE');
  const fresh = await previewBusinessRework(f.run.id, input, true), next = submitBusinessRework(f.run.id, confirm(fresh), true);
  assert.equal(trace.getRun(f.run.id).status, 'cancelled'); assert.equal(next.run.workspace, null);
  if (process.env.COORDINATION_RUNTIME_KERNEL === 'execute') assert.equal(getRunTerminal(f.run.id).source, 'business_stage_rework');
  assert.equal(submitBusinessRework(f.run.id, confirm(fresh), true).run.id, next.run.id);
  code(() => submitBusinessRework(f.run.id, { ...confirm(fresh), instruction: 'different' }, true), 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(business.businessHistory(f.run.id), ledger); assert.deepEqual(workerAttempts(f.run.id), attempts, 'original deliveries stay unchanged');
  assert.equal(business.getBusinessState(f.run.id).successorRunId, next.run.id);
  code(() => action(f.run.id, { action: 'resolve', outcome: 'partial_accepted', reason: 'late decision' }), 'SOURCE_CONTINUED');
  const archive = checkpoints.readBusinessCheckpoint(next.run.id);
  assert.equal(archive.outputs.length, 1); assert.equal(archive.rework.rejectedOutputs.length, 2);
  assert.ok(!business.listBusinessEvidence(next.run.id).some(e => e.stageId === 'analysis'));
  for (const output of archive.rework.rejectedOutputs) assert.equal(resolveEvidence(next.run.id, { kind: 'attempt_output', id: output.attemptId }).trusted, false, 'rejected outputs are not evidence');
  await coordination.runCoordinationPlan(next.run, next.run.goal);
  assert.equal(calls.length, beforeCalls + 2, 'only the rejected stage is rerun before its gate');
  assert.ok(calls.slice(beforeCalls).every(c => c.text.includes('REWORK_REQUIREMENT') && c.text.includes('缺少反例依据') && c.text.includes('已拒绝候选')));
  assert.ok(calls.slice(beforeCalls).every(c => !c.text.includes('FUTURE_STAGE')));
  assert.deepEqual(calls.slice(beforeCalls).map(c => c.maxTokens), [8, 6]);
  assert.equal(business.getBusinessState(next.run.id).stages[0].status, 'accepted');
  assert.equal(business.getBusinessState(next.run.id).stages[1].report, null, 'old rejection is not a new report');
  report(next.run.id, 'analysis'); decide(next.run.id, 'analysis', 'reject');
  const secondPreview = await previewBusinessRework(next.run.id, inputFor(next.run.id), true);
  assert.equal(secondPreview.checkpoint.carriedRunTokens, 10);
  const second = submitBusinessRework(next.run.id, confirm(secondPreview), true); const secondCalls = calls.length;
  await coordination.runCoordinationPlan(second.run, second.run.goal); assert.equal(calls.length, secondCalls + 2);
  assert.deepEqual(calls.slice(secondCalls).map(c => c.maxTokens), [4, 2], 'repeated rework cannot reset caps');
  report(second.run.id, 'analysis'); decide(second.run.id, 'analysis', 'reject');
  await assert.rejects(() => previewBusinessRework(second.run.id, inputFor(second.run.id), true), e => e.code === 'CHECKPOINT_BUDGET_EXHAUSTED');
  // Fresh manual registration is still possible without pretending it reruns a member.
  report(second.run.id, 'analysis'); decide(second.run.id, 'analysis'); await coordination.resumeCoordinationRun(second.run.id);
  assert.ok(!calls.at(-1).text.includes('所有者补充修订要求'), 'rework instruction applies only to its stage');
  report(second.run.id, 'advice'); decide(second.run.id, 'advice'); await coordination.resumeCoordinationRun(second.run.id);
  assert.equal(business.getBusinessState(second.run.id).outcome, 'achieved'); assert.equal(trace.getRun(second.run.id).status, 'completed');

  const first = await fixture({ firstRejected: true }), firstPreview = await previewBusinessRework(first.run.id, inputFor(first.run.id), true);
  assert.deepEqual(firstPreview.checkpoint.acceptedStageIds, []); assert.equal(firstPreview.checkpoint.completedWorkers, 0);
  const firstNext = submitBusinessRework(first.run.id, confirm(firstPreview), true), firstCalls = calls.length;
  await coordination.runCoordinationPlan(firstNext.run, firstNext.run.goal); assert.equal(calls.length, firstCalls + 1);
  assert.equal(business.getBusinessState(firstNext.run.id).stages[0].report, null); assert.equal(business.getBusinessState(firstNext.run.id).stages[0].execution.canAccept, true);

  const notRejected = await fixture({ rejected: false });
  await assert.rejects(() => previewBusinessRework(notRejected.run.id, { ...inputFor(f.run.id), expectedVersion: 3 }, true), e => e.code === 'STAGE_REWORK_UNAVAILABLE');
  const privateRun = await fixture(); post({ runId: privateRun.run.id, from: 'worker', to: 'peer', kind: 'agent', body: 'PRIVATE_STATE', visibility: 'private' });
  await assert.rejects(() => previewBusinessRework(privateRun.run.id, inputFor(privateRun.run.id), true), e => e.code === 'PRIVATE_CHECKPOINT_UNSUPPORTED');
  const unknown = await fixture(); db.run("INSERT INTO orchestration_token_reservations(id,run_id,reserved,status,created_at) VALUES (?,?,1,'unknown',?)", randomUUID(), unknown.run.id, new Date().toISOString());
  await assert.rejects(() => previewBusinessRework(unknown.run.id, inputFor(unknown.run.id), true), e => e.code === 'RESULT_UNKNOWN');
  const writer = await fixture({ readonly: false });
  await assert.rejects(() => previewBusinessRework(writer.run.id, inputFor(writer.run.id), true), e => e.code === 'WRITE_RECONCILIATION_REQUIRED');
  const cancelled = await fixture(); coordination.cancelCoordinationRun(cancelled.run.id);
  await assert.rejects(() => previewBusinessRework(cancelled.run.id, inputFor(cancelled.run.id), true), e => e.code === 'BUSINESS_CHECKPOINT_UNSUPPORTED');
  const stale = await fixture(), stalePreview = await previewBusinessRework(stale.run.id, inputFor(stale.run.id), true);
  report(stale.run.id, 'analysis'); code(() => submitBusinessRework(stale.run.id, confirm(stalePreview), true), 'BUSINESS_STATE_STALE');
  assert.equal(trace.getRun(stale.run.id).status, 'waiting_for_user');
  const rollback = await fixture(), rollbackPreview = await previewBusinessRework(rollback.run.id, inputFor(rollback.run.id), true);
  const rollbackCount = db.get('SELECT COUNT(*) n FROM runs').n, rollbackAttempts = workerAttempts(rollback.run.id), rollbackLedger = business.businessHistory(rollback.run.id);
  const { subscribe } = await import('../apps/server/src/messaging/bus.ts'); const rollbackEvents = []; const unsubscribe = subscribe(event => rollbackEvents.push(event));
  db.db.exec(`CREATE TRIGGER fixture_rework_close_failure BEFORE UPDATE ON coordination_plans WHEN OLD.run_id='${rollback.run.id}' AND NEW.status='cancelled' BEGIN SELECT RAISE(ABORT,'fixture_source_close_failure'); END`);
  assert.throws(() => submitBusinessRework(rollback.run.id, confirm(rollbackPreview), true), /fixture_source_close_failure/);
  db.db.exec('DROP TRIGGER fixture_rework_close_failure'); unsubscribe();
  assert.equal(db.get('SELECT COUNT(*) n FROM runs').n, rollbackCount); assert.equal(trace.getRun(rollback.run.id).status, 'waiting_for_user');
  assert.equal(getRunTerminal(rollback.run.id), null); assert.equal(db.get('SELECT COUNT(*) n FROM business_run_checkpoints WHERE source_run_id=?', rollback.run.id).n, 0);
  assert.equal(db.get('SELECT COUNT(*) n FROM orchestration_run_continuations WHERE source_run_id=?', rollback.run.id).n, 0);
  assert.deepEqual(workerAttempts(rollback.run.id), rollbackAttempts); assert.deepEqual(business.businessHistory(rollback.run.id), rollbackLedger);
  assert.deepEqual(rollbackEvents, [], 'failed source closure publishes no admitted Run or terminal events');
  const terminal = await fixture(); commitRunTerminal({ runId: terminal.run.id, status: 'failed', disposition: 'failed', source: 'fixture_after_gate', closeExecution: () => store.setCoordinationPlanStatus(terminal.plan.id, 'failed') });
  const oldTerminal = getRunTerminal(terminal.run.id), terminalPreview = await previewBusinessRework(terminal.run.id, inputFor(terminal.run.id), true);
  assert.equal(terminalPreview.closesWaitingSource, false); submitBusinessRework(terminal.run.id, confirm(terminalPreview), true);
  assert.deepEqual(getRunTerminal(terminal.run.id), oldTerminal, 'failed terminal stays immutable'); assert.equal(trace.getRun(terminal.run.id).status, 'failed');

  // An execution failure during rework uses regular continuation without losing the explicit revision requirement.
  const interruption = await fixture(), interruptionPreview = await previewBusinessRework(interruption.run.id, inputFor(interruption.run.id), true);
  const interrupted = submitBusinessRework(interruption.run.id, confirm(interruptionPreview), true); expireRun = interrupted.run.id;
  await assert.rejects(() => coordination.runCoordinationPlan(interrupted.run, interrupted.run.goal)); expireRun = null;
  const continuationPreview = await previewRunContinuation(interrupted.run.id, true);
  assert.deepEqual(continuationPreview.preview.plan.plan.steps.filter(s => s.agentId).map(s => s.agentId), ['peer', 'peer']);
  const recovered = submitRunContinuation(interrupted.run.id, { previewId: continuationPreview.preview.previewId, orchestrationFingerprint: continuationPreview.preview.fingerprint }, true);
  const recoveryCalls = calls.length; await coordination.runCoordinationPlan(recovered.run, recovered.run.goal);
  assert.equal(calls.length, recoveryCalls + 1); assert.match(calls.at(-1).text, /REWORK_REQUIREMENT/);
  assert.equal(checkpoints.readBusinessCheckpoint(recovered.run.id).rework.report.id, interruptionPreview.input.reportId);
  const cold = execFileSync(process.execPath, ['--import', './apps/server/node_modules/tsx/dist/loader.mjs', '--input-type=module', '-e',
    "const {getBusinessState}=await import('./apps/server/src/orchestration/business.ts'); const {db}=await import('./apps/server/src/db/database.ts'); console.log(JSON.stringify(getBusinessState(process.env.REWORK_RUN))); db.close();"],
    { env: { ...process.env, REWORK_RUN: second.run.id }, encoding: 'utf8' });
  assert.equal(JSON.parse(cold.trim()).outcome, 'achieved'); assert.match(JSON.parse(cold.trim()).checkpoint.rework.instruction, /REWORK_REQUIREMENT/);

  // Owner HTTP auth/CSRF/origin checks + exact replay create one Run and one execution.
  const http = await fixture(), payload = inputFor(http.run.id), endpoint = `/api/accounts/business/${http.run.id}/rework-preview`, host = { host: '127.0.0.1:43220' };
  assert.equal((await app.inject({ method: 'POST', url: endpoint, headers: host, payload })).statusCode, 401);
  const session = await app.inject({ method: 'POST', url: '/api/accounts/session', headers: { ...host, 'x-gand-bootstrap': '1' } });
  const auth = { ...host, cookie: session.headers['set-cookie'].split(';')[0], 'x-gand-csrf': session.json().csrfToken };
  assert.equal((await app.inject({ method: 'POST', url: endpoint, headers: { ...auth, 'x-gand-csrf': '' }, payload })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: endpoint, headers: { ...auth, origin: 'https://untrusted.invalid' }, payload })).statusCode, 403);
  const hp = await app.inject({ method: 'POST', url: endpoint, headers: auth, payload }); assert.equal(hp.statusCode, 200, hp.body);
  const submitUrl = `/api/accounts/business/${http.run.id}/reworks`, sent = await app.inject({ method: 'POST', url: submitUrl, headers: auth, payload: confirm(hp.json()) });
  assert.equal(sent.statusCode, 202, sent.body); const id = sent.json().run.id;
  await waitFor(() => business.getBusinessState(id).stages[1].execution.canAccept);
  const repeat = await app.inject({ method: 'POST', url: submitUrl, headers: auth, payload: confirm(hp.json()) }); assert.equal(repeat.statusCode, 200); assert.equal(repeat.json().run.id, id);
  assert.equal(db.get('SELECT COUNT(*) n FROM business_run_checkpoints WHERE source_run_id=?', http.run.id).n, 1);
  console.log(`通过：Owner 阶段返工预览/确认、原验收前缀不重放、被拒绝全阶段重跑且旧输出不能验收、冻结标准/预算结转/重复返工额度上限、唯一后继及原执行原子关闭、预览漂移无孤儿 Run、私密/写入/未知/取消围栏、返工失败续跑保留要求、冷进程读取、HTTP CSRF/Origin/幂等（kernel=${process.env.COORDINATION_RUNTIME_KERNEL}）。仅临时数据库和模型模拟，无真实模型或监听端口。`);
} finally { await app.close(); db.db.close(); await rm(root, { recursive: true, force: true }); }

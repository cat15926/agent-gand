import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'gand-stage-gates-'));
const workspace = path.join(root, 'repo'); await mkdir(workspace); await writeFile(path.join(workspace, 'README.md'), 'stage fixture\n');
execFileSync('git', ['init', '-q', workspace]); execFileSync('git', ['-C', workspace, 'add', '.']);
execFileSync('git', ['-C', workspace, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
const native = path.join(root, 'native'); await copyFile(new URL('./fixtures/external-agent-o4.mjs', import.meta.url), native); await chmod(native, 0o755);
const codexHome = path.join(root, 'codex'); await mkdir(codexHome); await writeFile(path.join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: 'fixture' } }));
Object.assign(process.env, { NODE_ENV: 'test', DB_PATH: path.join(root, 'test.sqlite'), AGENTS_DIR: path.join(root, 'roles'), LOG_LEVEL: 'silent', MCP_SERVER_CMD: '',
  AGENT_GAND_ISOLATED_WORKER: '1', AGENT_GAND_PRIVATE_DIR: path.join(root, 'private'), COORDINATION_RUNTIME_KERNEL: process.argv.includes('--kernel-off') ? 'off' : 'execute',
  EXTERNAL_WORKSPACE_MODE: 'isolated', EXTERNAL_AGENT_TIMEOUT_MS: '12000', EXTERNAL_CODEX_COMMAND: native, EXTERNAL_CLAUDE_SDK_WORKER_COMMAND: native,
  EXTERNAL_CODEX_HOME: codexHome, EXTERNAL_CLAUDE_HOME: path.join(root, 'claude'), ANTHROPIC_API_KEY: 'fixture-not-used',
  FAKE_D_LOG: path.join(root, 'native.jsonl'), FAKE_O2_SERVER_ROOT: path.resolve('apps/server'), HOST: '127.0.0.1', PORT: '43220', ACCOUNT_TRUSTED_ORIGINS: 'http://127.0.0.1:43220' });
await writeFile(process.env.FAKE_D_LOG, '');
// All state is isolated before imports. No listeners or real model/account calls.
globalThis.fetch = () => { throw new Error('No real network in stage fixture'); };
const db = await import('../apps/server/src/db/database.ts');
const registry = await import('../apps/server/src/agents/registry.ts');
const entry = await import('../apps/server/src/orchestration/entry.ts');
const trace = await import('../apps/server/src/runs/trace.ts');
const coordination = await import('../apps/server/src/coordination/runtime.ts');
const store = await import('../apps/server/src/coordination/store.ts');
const business = await import('../apps/server/src/orchestration/business.ts');
const gates = await import('../apps/server/src/orchestration/businessGates.ts');
const { normalizeBusinessContract } = await import('../apps/server/src/orchestration/businessContract.ts');
const { withBusinessStageExecution } = await import('../apps/server/src/orchestration/businessStageExecution.ts');
const { budgetedChat } = await import('../apps/server/src/orchestration/executionBudget.ts');
const { applyRunAction } = await import('../apps/server/src/orchestration/actions.ts');
const { recoverDurableRuns, recoverDurableHolds } = await import('../apps/server/src/runs/recovery.ts');
const { getRunTerminal } = await import('../apps/server/src/runtime/terminal.ts');
const { mockProvider } = await import('../apps/server/src/llm/provider.ts');
const { shutdownExternalAgents } = await import('../apps/server/src/execution/runner.ts');
const { registerExternal } = await import('../apps/server/src/workspaces/external.ts');
const { config } = await import('../apps/server/src/config.ts'); config.sandboxDir = path.join(root, 'sandbox');
const workspaceId = 'ext:' + registerExternal({ path: workspace, trusted: true }).id;
const role = (id, more = {}) => ({ id, name: id, description: 'stage fixture', systemPrompt: 'Provide actual deliverables.', model: 'mock:' + id,
  permissionMode: 'readonly', tools: [], disallowedTools: [], capabilities: ['execute'], color: '#4477aa', avatar: '', ...more });
for (const id of ['worker','peer']) registry.createAgent(role(id));
for (const [id, driver] of [['sdk','claude-sdk'],['codex','codex-app-server'],['cli','claude-cli']]) registry.createAgent(role(id, { model: 'fixture-session', execution: { kind: 'external', driver, platformTools: [] } }));
registry.createAgent(role('sdk-writer', { model: 'fixture-write', permissionMode: 'confirm', execution: { kind: 'external', driver: 'claude-sdk', platformTools: [] } }));
registry.createAgent(role('codex-wait', { model: 'fixture-wait', execution: { kind: 'external', driver: 'codex-app-server', platformTools: [] } }));
const contractFor = (actors = [['worker','peer'],['worker']], budget = 12) => ({ version: 1, executionMode: 'stage_gated', stages: actors.map((members, i) => ({
  id: 'phase-' + i, title: '阶段 ' + i, criteria: ['交付实质结果'], deliverables: [{ id: 'result', title: '完整结果', kind: 'text' }],
  execution: { assignments: members.map(id => ({ agentId: id, objective: `ONLY_PHASE_${i}_${id} 完成交付` })), ...(budget ? { maxTokens: budget } : {}) },
})) });
const response = (content = '完整结果：提供原因、分析依据以及可执行方案。', tokensOut = 2) => ({ content, usage: { tokensIn: 1, tokensOut, costUsd: 0 }, toolCalls: [], stopReason: 'end_turn', truncated: false });
const calls = [];
mockProvider.chat = async req => { calls.push(req); return response(); };
const code = (fn, expected) => assert.throws(fn, e => e.code === expected);
const command = (runId, value) => ({ ...value, expectedVersion: business.getBusinessState(runId).version, clientRequestId: randomUUID() });
const apply = (runId, value) => business.applyBusinessCommand(runId, command(runId, value));
const choices = (runId, stageId) => business.listBusinessEvidence(runId).filter(c => c.stageId === stageId);
const register = (runId, stageId, ref = choices(runId, stageId)[0].ref) => apply(runId, { action: 'report', stageId, kind: 'delivery', note: '核对交付', evidence: [{ deliverableId: 'result', ref }] });
const acceptCommand = (runId, stageId) => command(runId, { action: 'decide', stageId, reportId: business.getBusinessState(runId).stages.find(s => s.stage.id === stageId).report.id, verdict: 'accept', checkedCriteria: [0], reason: '核对通过' });
const accept = (runId, stageId) => business.applyBusinessCommand(runId, acceptCommand(runId, stageId));
async function fixture(contract = contractFor(), extra = {}) {
  const actors = [...new Set(contract.stages.flatMap(s => s.execution.assignments.map(a => a.agentId)))];
  const input = { goal: '完成阶段任务', agentIds: actors, recipientIds: actors, strategy: 'serial', workflow: 'routine', workspace: workspaceId, constraints: { readonly: true }, businessContract: contract, ...extra };
  const preview = await entry.previewExecutionOrchestration(input);
  assert.ok(!preview.decision.issues.some(i => i.severity === 'error'), JSON.stringify(preview.decision.issues));
  const admitted = entry.submitExecutionOrchestration({ ...input, entryVersion: 1, clientRequestId: randomUUID(), previewId: preview.previewId, orchestrationFingerprint: preview.fingerprint });
  return { ...admitted, input, preview };
}
async function run(f) {
  try { await coordination.runCoordinationPlan(trace.getRun(f.run.id), f.run.goal); }
  catch (error) {
    const plan = store.getRunCoordinationPlan(f.run.id);
    const failed = store.listCoordinationStepStates(plan.id).filter(s => s.status === 'failed').map(s => ({ stepId:s.stepId,error:s.error }));
    const native = db.all('SELECT record FROM external_agent_executions WHERE run_id=?',f.run.id).map(r => {
      const e = JSON.parse(r.record); return { agentId:e.agentId,status:e.status,errorCode:e.errorCode,error:e.error };
    });
    throw new Error(`${error.message}; fixture diagnostics ${JSON.stringify({ failed,native })}`, { cause:error });
  }
}
async function waitFor(fn, label) { for (let n = 0; n < 600; n++) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('Timeout: ' + label); }
const { default: Fastify } = await import('../apps/server/node_modules/fastify/fastify.js');
const { registerRoutes } = await import('../apps/server/src/api/routes.ts');
const { registerAccountRoutes } = await import('../apps/server/src/api/accountRoutes.ts');
const app = Fastify({ logger: false }); await registerRoutes(app); await registerAccountRoutes(app);
try {
  const invalid = contractFor(); delete invalid.stages[0].execution;
  code(() => normalizeBusinessContract(invalid), 'INVALID_BUSINESS_CONTRACT');
  const manual = contractFor(); delete manual.executionMode;
  code(() => normalizeBusinessContract(manual), 'INVALID_BUSINESS_CONTRACT');
  for (const raw of [ { ...contractFor(), executionMode: 'unknown' }, { ...contractFor(), stages: [{ ...contractFor().stages[0], execution: { assignments: [{ agentId: 'worker', objective: '' }] } }] } ]) code(() => normalizeBusinessContract(raw), 'INVALID_BUSINESS_CONTRACT');
  assert.deepEqual(normalizeBusinessContract(contractFor()), contractFor());
  const nativeLimit = await entry.previewExecutionOrchestration({ goal: '分析', agentIds: ['sdk'], businessContract: contractFor([['sdk']], 2), workflow: 'routine', constraints: { readonly: true } });
  assert.ok(nativeLimit.decision.issues.some(i => i.code === 'HARD_TOKEN_LIMIT_UNSUPPORTED'));
  const cliPreview = await entry.previewExecutionOrchestration({ goal: '分析', agentIds: ['cli'], businessContract: contractFor([['cli']], null), workflow: 'routine', strategy: 'serial', constraints: { readonly: true } });
  assert.ok(cliPreview.decision.issues.some(i => i.code === 'STAGE_BACKEND_UNSUPPORTED'));
  const four = await entry.previewExecutionOrchestration({ goal: '按阶段分工交付', agentIds: ['worker','peer','sdk','codex'], recipientIds: ['worker','peer','sdk','codex'], workflow: 'routine', strategy: 'serial', constraints: { readonly: true }, businessContract: contractFor([['worker','peer'],['sdk','codex']], null) });
  assert.ok(!four.decision.issues.some(i => i.severity === 'error'), 'serial stage graph is not capped by dynamic per-dispatch recipient limit');
  const manyActors = ['worker','peer','sdk','codex'];
  for (let i = 0; i < 9; i++) { const id = 'extra-' + i; registry.createAgent(role(id)); manyActors.push(id); }
  const tooMany = await entry.previewExecutionOrchestration({ goal: '按阶段分工交付', agentIds: manyActors, workflow: 'routine', strategy: 'serial', constraints: { readonly: true }, businessContract: contractFor([manyActors.slice(0, 12), manyActors.slice(12)], null) });
  assert.ok(tooMany.decision.issues.some(i => i.code === 'TOO_MANY_TARGETS'));

  const f = await fixture(); const id = f.run.id;
  assert.equal(f.preview.decision.execution.engine, 'coordination');
  assert.equal(f.preview.plan.plan.steps.filter(gates.isBusinessGate).length, 2);
  assert.ok(f.preview.plan.plan.steps.filter(s => s.agentId).every(s => s.maxAttempts === 1));
  const drift = structuredClone(f.input); drift.businessContract.stages[1].execution.assignments[0].objective = '改变后续任务';
  code(() => entry.submitExecutionOrchestration({ ...drift, entryVersion: 1, clientRequestId: randomUUID(), previewId: f.preview.previewId, orchestrationFingerprint: f.preview.fingerprint }), 'PREVIEW_STALE');
  await run(f);
  assert.equal(calls.length, 2); assert.equal(trace.getRun(id).status, 'waiting_for_user');
  assert.ok(calls.every(c => !c.messages.map(m => m.content).join('\n').includes('ONLY_PHASE_1_worker')), 'future assignments must not enter current prompts');
  assert.ok(calls[0].messages.some(m => m.content.includes('ONLY_PHASE_0_worker')));
  assert.ok(calls[1].messages.some(m => m.content.includes('ONLY_PHASE_0_peer')));
  const plan = store.getRunCoordinationPlan(id);
  assert.equal(db.get("SELECT COUNT(*) n FROM coordination_step_attempts WHERE run_id=? AND step_id LIKE '%accept'", id).n, 0, 'waiting gate has no fake running attempt');
  let state = business.getBusinessState(id); assert.equal(state.outcome, 'awaiting_acceptance'); assert.equal(state.settled, false);
  assert.equal(state.stages[0].execution.chargedTokens, 4); assert.ok(state.stages[0].execution.startedAt); assert.ok(state.stages[0].execution.completedAt);
  assert.equal(state.stages[1].execution.status, 'pending'); assert.equal(state.stages[1].execution.startedAt, null);
  const unknownId = randomUUID();
  db.run("INSERT INTO business_stage_token_reservations(id,run_id,stage_id,reserved,status,created_at) VALUES (?,?,?,1,'unknown',?)", unknownId, id, 'phase-0', new Date().toISOString());
  assert.equal(business.getBusinessState(id).stages[0].execution.canAccept, false);
  code(() => register(id, 'phase-0'), 'EXECUTION_NOT_SETTLED');
  db.run('DELETE FROM business_stage_token_reservations WHERE id=?', unknownId);
  await assert.rejects(() => applyRunAction(id, 'resume'), e => e.code === 'BUSINESS_STAGE_ACCEPTANCE_REQUIRED');
  await assert.rejects(() => coordination.resumeCoordinationRun(id), e => e.code === 'BUSINESS_STAGE_ACCEPTANCE_REQUIRED');
  await assert.rejects(() => entry.previewExecutionOrchestration({ ...f.input, revisionRunId: id, conversationId: f.conversation.id }), e => e.code === 'STAGE_REVISION_UNSUPPORTED');
  code(() => register(id, 'phase-1', choices(id, 'phase-0')[0].ref), 'PREVIOUS_STAGE_REQUIRED');
  assert.ok(choices(id, 'phase-0').every(c => c.ref.kind === 'attempt_output'));
  apply(id, { action: 'report', stageId: 'phase-0', kind: 'receipt', note: '收到', evidence: [] });
  code(() => accept(id, 'phase-0'), 'RECEIPT_IS_NOT_DELIVERY');
  let report = business.getBusinessState(id).stages[0].report;
  apply(id, { action: 'decide', stageId: 'phase-0', reportId: report.id, verdict: 'reject', checkedCriteria: [], reason: '需要实际交付' });
  register(id, 'phase-0');
  report = business.getBusinessState(id).stages[0].report;
  apply(id, { action: 'decide', stageId: 'phase-0', reportId: report.id, verdict: 'reject', checkedCriteria: [], reason: '重新核对来源' });
  recoverDurableHolds(); await new Promise(r => setTimeout(r, 20)); assert.equal(calls.length, 2, 'rejection never dispatches or replays');
  register(id, 'phase-0');
  // A process can crash after ledger commit and before the HTTP wake; recovery uses only the committed decision.
  const accepted = acceptCommand(id, 'phase-0'); business.applyBusinessCommand(id, accepted);
  assert.equal(trace.getRun(id).status, 'waiting_for_user');
  assert.equal(business.applyBusinessCommand(id, accepted).version, business.getBusinessState(id).version);
  db.run("INSERT INTO business_stage_token_reservations(id,run_id,stage_id,reserved,status,created_at) VALUES (?,?,?,1,'unknown',?)", unknownId, id, 'phase-0', new Date().toISOString());
  await assert.rejects(() => coordination.resumeCoordinationRun(id), e => e.code === 'BUSINESS_STAGE_NOT_QUIESCENT');
  recoverDurableHolds(); assert.equal(calls.length, 2);
  db.run('DELETE FROM business_stage_token_reservations WHERE id=?', unknownId);
  recoverDurableRuns(); recoverDurableHolds();
  await waitFor(() => business.getBusinessState(id).stages[1].execution.canAccept, 'next stage gate');
  assert.equal(calls.length, 3); assert.equal(business.getBusinessState(id).stages[1].execution.chargedTokens, 2);
  code(() => register(id, 'phase-1', choices(id, 'phase-0')[0].ref), 'STAGE_EVIDENCE_MISMATCH');
  register(id, 'phase-1');
  const host = { host: '127.0.0.1:43220' };
  const session = await app.inject({ method: 'POST', url: '/api/accounts/session', headers: { ...host, 'x-gand-bootstrap': '1' } }); assert.equal(session.statusCode, 200);
  const auth = { ...host, cookie: session.headers['set-cookie'].split(';')[0], 'x-gand-csrf': session.json().csrfToken };
  const finalAccept = acceptCommand(id, 'phase-1');
  assert.equal((await app.inject({ method: 'POST', url: `/api/accounts/business/${id}`, headers: host, payload: finalAccept })).statusCode, 401);
  const finalResponse = await app.inject({ method: 'POST', url: `/api/accounts/business/${id}`, headers: auth, payload: finalAccept });
  assert.equal(finalResponse.statusCode, 200, finalResponse.body);
  await waitFor(() => trace.getRun(id).status === 'completed', 'final completion');
  const finalTerminal = getRunTerminal(id); assert.equal(business.getBusinessState(id).outcome, 'achieved');
  assert.equal((await app.inject({ method: 'POST', url: `/api/accounts/business/${id}`, headers: auth, payload: finalAccept })).statusCode, 200);
  recoverDurableRuns(); recoverDurableHolds(); assert.equal(calls.length, 3); assert.deepEqual(getRunTerminal(id), finalTerminal);
  assert.equal(store.listCoordinationStepStates(plan.id).filter(s => s.status === 'completed').length, plan.steps.length);

  // Cancellation never revives execution, even when owner accepts the already delivered phase afterward.
  const stopped = await fixture(); await run(stopped); register(stopped.run.id, 'phase-0');
  await applyRunAction(stopped.run.id, 'cancel'); const cancelled = getRunTerminal(stopped.run.id); const before = calls.length;
  accept(stopped.run.id, 'phase-0'); recoverDurableRuns(); recoverDurableHolds();
  assert.equal(trace.getRun(stopped.run.id).status, 'cancelled'); assert.equal(calls.length, before); assert.deepEqual(getRunTerminal(stopped.run.id), cancelled);
  assert.equal(apply(stopped.run.id, { action: 'resolve', outcome: 'partial_accepted', reason: '只接受第一阶段' }).outcome, 'partial_accepted');

  // Stage time limits cover actual requests and stop providers that ignore AbortSignal.
  const slowContract = contractFor([['worker'],['peer']]); slowContract.stages[0].execution.timeoutMs = 35;
  const slow = await fixture(slowContract); const prior = calls.length;
  mockProvider.chat = async req => { calls.push(req); await new Promise(r => setTimeout(r, 100)); req.onActivity?.('text'); return response(); };
  await assert.rejects(() => run(slow));
  assert.equal(trace.getRun(slow.run.id).status, 'failed'); assert.equal(calls.length, prior + 1); assert.equal(choices(slow.run.id, 'phase-1').length, 0);
  assert.equal(business.getBusinessState(slow.run.id).stages[0].execution.unknownCalls, 1);
  const timeoutState = store.listCoordinationStepStates(store.getRunCoordinationPlan(slow.run.id).id).find(s => s.stepId === 'stage-1-work-1'); assert.match(timeoutState.error, /阶段.*时限/); assert.equal(timeoutState.attemptNo, 1);
  await new Promise(r => setTimeout(r, 120)); assert.equal(choices(slow.run.id, 'phase-0').length, 0);
  assert.equal(apply(slow.run.id, { action: 'resolve', outcome: 'not_achieved', reason: '模型超时，本轮未达成；未知消耗保留计入预算' }).outcome, 'not_achieved');
  assert.equal(db.get("SELECT COUNT(*) n FROM business_stage_token_reservations WHERE run_id=? AND status='unknown'", slow.run.id).n, 1);
  mockProvider.chat = async req => { calls.push(req); return response(); };

  // Waiting for acceptance consumes neither another invocation nor the next stage's time budget.
  const timedContract = contractFor([['worker'],['peer']]); for (const s of timedContract.stages) s.execution.timeoutMs = 1000;
  const timed = await fixture(timedContract); await run(timed); register(timed.run.id, 'phase-0');
  db.run("UPDATE business_stage_executions SET started_at='2000-01-01T00:00:00.000Z' WHERE run_id=? AND stage_id='phase-0'", timed.run.id);
  accept(timed.run.id, 'phase-0'); await coordination.resumeCoordinationRun(timed.run.id);
  assert.ok(business.getBusinessState(timed.run.id).stages[1].execution.canAccept); assert.ok(!business.getBusinessState(timed.run.id).stages[1].execution.startedAt.startsWith('2000'));

  // Shared Run/stage reservations are atomic; unknown costs retain output allowance.
  const budgetContract = contractFor([['worker']], 3);
  const budget = await fixture(budgetContract, { constraints: { readonly: true, maxTokens: 4 } });
  await withBusinessStageExecution(budget.run.id, budgetContract.stages[0], async () => {
    let count = 0;
    const provider = { chat: async req => { count++; await new Promise(r => setTimeout(r, 20)); return response('实际输出', 1); } };
    await Promise.all([1,2,3].map(() => budgetedChat(budget.run.id, provider, { model: 'mock', messages: [], maxTokens: 2 })));
    assert.equal(count, 3); assert.equal(business.getBusinessState(budget.run.id).stages[0].execution.chargedTokens, 3);
    await assert.rejects(() => budgetedChat(budget.run.id, provider, { model: 'mock', messages: [] }), /当前阶段输出 Token 预算已耗尽/);
  });
  assert.equal(db.get("SELECT SUM(used) n FROM orchestration_token_reservations WHERE run_id=?", budget.run.id).n, 3);
  const unknown = await fixture(contractFor([['worker']], 4));
  await withBusinessStageExecution(unknown.run.id, unknown.input.businessContract.stages[0], async () => {
    const provider = { chat: async () => { throw new Error('transport lost'); } };
    await assert.rejects(() => budgetedChat(unknown.run.id, provider, { model: 'mock', messages: [] }), /transport lost/);
    await assert.rejects(() => budgetedChat(unknown.run.id, provider, { model: 'mock', messages: [] }), /消耗未知/);
  });

  // Both real native drivers run against local stdio fakes, with an owner gate between them.
  const mixed = await fixture(contractFor([['sdk'],['codex']], null)); await run(mixed);
  assert.equal(trace.getRun(mixed.run.id).status, 'waiting_for_user');
  assert.equal(db.get('SELECT COUNT(*) n FROM external_agent_executions WHERE run_id=?', mixed.run.id).n, 1);
  register(mixed.run.id, 'phase-0'); accept(mixed.run.id, 'phase-0'); await coordination.resumeCoordinationRun(mixed.run.id);
  assert.ok(business.getBusinessState(mixed.run.id).stages[1].execution.canAccept);
  assert.equal(db.get('SELECT COUNT(*) n FROM external_agent_executions WHERE run_id=?', mixed.run.id).n, 2);
  register(mixed.run.id, 'phase-1'); accept(mixed.run.id, 'phase-1'); await coordination.resumeCoordinationRun(mixed.run.id);
  assert.equal(trace.getRun(mixed.run.id).status, 'completed');
  const nativeCalls = (await readFile(process.env.FAKE_D_LOG, 'utf8')).trim().split('\n').map(JSON.parse).filter(c => c.kind === 'turn');
  assert.equal(nativeCalls.length, 2); assert.ok(!nativeCalls[0].prompt.includes('ONLY_PHASE_1_codex'));

  // A later native timeout preserves accepted work and never admits the following API stage.
  const failingContract = contractFor([['sdk'],['codex-wait'],['peer']], null); failingContract.stages[1].execution.timeoutMs = 1200;
  const failing = await fixture(failingContract); await run(failing); register(failing.run.id, 'phase-0'); accept(failing.run.id, 'phase-0');
  const failureCalls = calls.length;
  await assert.rejects(() => coordination.resumeCoordinationRun(failing.run.id));
  assert.equal(trace.getRun(failing.run.id).status, 'failed'); assert.equal(calls.length, failureCalls);
  assert.equal(business.getBusinessState(failing.run.id).stages[0].status, 'accepted');
  assert.equal(business.getBusinessState(failing.run.id).stages[2].execution.startedAt, null);
  assert.equal(db.get("SELECT COUNT(*) n FROM external_native_processes p JOIN external_agent_executions e ON e.id=p.execution_id WHERE e.run_id=? AND p.status='active'", failing.run.id).n, 0);
  assert.equal(apply(failing.run.id, { action: 'resolve', outcome: 'partial_accepted', reason: '保留已验收的前序交付' }).outcome, 'partial_accepted');

  // A linked checkpoint preserves an accepted SDK stage and retries only the Codex stage with current configuration.
  const { previewRunContinuation, submitRunContinuation } = await import('../apps/server/src/orchestration/continuation.ts');
  const linkedSource = await fixture(failingContract); await run(linkedSource); register(linkedSource.run.id, 'phase-0'); accept(linkedSource.run.id, 'phase-0');
  await assert.rejects(() => coordination.resumeCoordinationRun(linkedSource.run.id));
  const oldLinkedPreview = await previewRunContinuation(linkedSource.run.id, true);
  registry.updateAgent('codex-wait', role('codex-wait', { model: 'fixture-session', execution: { kind: 'external', driver: 'codex-app-server', platformTools: [], sessionPolicy: 'conversation' } }), registry.getAnyAgent('codex-wait').version);
  const confirmLinked = p => ({ previewId: p.preview.previewId, orchestrationFingerprint: p.preview.fingerprint });
  code(() => submitRunContinuation(linkedSource.run.id, confirmLinked(oldLinkedPreview), true), 'PREVIEW_STALE');
  const linkedPreview = await previewRunContinuation(linkedSource.run.id, true);
  const linked = submitRunContinuation(linkedSource.run.id, confirmLinked(linkedPreview), true);
  assert.deepEqual(store.getRunCoordinationPlan(linked.run.id).steps.filter(s => s.agentId).map(s => s.agentId), ['codex-wait','peer']);
  await run(linked);
  assert.equal(db.get('SELECT COUNT(*) n FROM external_agent_executions WHERE run_id=?', linked.run.id).n, 1, 'accepted SDK turn is never replayed');
  assert.equal(business.getBusinessState(linked.run.id).stages[0].status, 'accepted');
  assert.ok(business.getBusinessState(linked.run.id).stages[1].execution.canAccept);
  const linkedCount = calls.length; register(linked.run.id, 'phase-1'); accept(linked.run.id, 'phase-1'); await coordination.resumeCoordinationRun(linked.run.id);
  assert.equal(calls.length, linkedCount + 1);
  register(linked.run.id, 'phase-2'); accept(linked.run.id, 'phase-2'); await coordination.resumeCoordinationRun(linked.run.id);
  assert.equal(business.getBusinessState(linked.run.id).outcome, 'achieved');
  assert.equal(trace.getRun(linkedSource.run.id).status, 'failed');

  // Owner rejection must explicitly rerun the native stage, keep accepted SDK work, and use fresh Codex sessions.
  const { previewBusinessRework, submitBusinessRework } = await import('../apps/server/src/orchestration/businessRework.ts');
  for (const [id, driver] of [['codex', 'codex-app-server'], ['sdk', 'claude-sdk']]) registry.updateAgent(id, role(id, { model: 'fixture-session', execution: { kind: 'external', driver, platformTools: [], sessionPolicy: 'conversation' } }), registry.getAnyAgent(id).version);
  for (const [acceptedNative, rejectedNative] of [['sdk', 'codex'], ['codex', 'sdk']]) {
    const nativeReworkSource = await fixture(contractFor([[acceptedNative], [rejectedNative], ['peer']], null));
    await run(nativeReworkSource); register(nativeReworkSource.run.id, 'phase-0'); accept(nativeReworkSource.run.id, 'phase-0');
    await coordination.resumeCoordinationRun(nativeReworkSource.run.id); register(nativeReworkSource.run.id, 'phase-1');
    const nativeRejectedReport = business.getBusinessState(nativeReworkSource.run.id).stages[1].report;
    apply(nativeReworkSource.run.id, { action: 'decide', stageId: 'phase-1', reportId: nativeRejectedReport.id, verdict: 'reject', checkedCriteria: [], reason: '需要补充限制与边界' });
    const reworkBefore = (await readFile(process.env.FAKE_D_LOG, 'utf8')).trim().split('\n').map(JSON.parse).filter(c => c.kind === 'turn').length;
    const nrp = await previewBusinessRework(nativeReworkSource.run.id, { stageId: 'phase-1', reportId: nativeRejectedReport.id,
      expectedVersion: business.getBusinessState(nativeReworkSource.run.id).version, instruction: 'NATIVE_REWORK_REQUIREMENT 补充边界并重新交付' }, true);
    const nativeRework = submitBusinessRework(nativeReworkSource.run.id, { ...nrp.input, previewId: nrp.preview.previewId, orchestrationFingerprint: nrp.preview.fingerprint }, true);
    assert.deepEqual(store.getRunCoordinationPlan(nativeRework.run.id).steps.filter(s => s.agentId).map(s => s.agentId), [rejectedNative, 'peer']);
    await run(nativeRework);
    const reworkTurns = (await readFile(process.env.FAKE_D_LOG, 'utf8')).trim().split('\n').map(JSON.parse).filter(c => c.kind === 'turn').slice(reworkBefore);
    assert.equal(reworkTurns.length, 1, `accepted ${acceptedNative} is not replayed`); assert.match(reworkTurns[0].prompt, /NATIVE_REWORK_REQUIREMENT/);
    const oldNative = db.get('SELECT record FROM external_agent_executions WHERE run_id=? AND agent_id=?', nativeReworkSource.run.id, rejectedNative);
    const newNative = db.get('SELECT record FROM external_agent_executions WHERE run_id=?', nativeRework.run.id);
    assert.ok(JSON.parse(oldNative.record).sessionBindingId); assert.ok(JSON.parse(newNative.record).sessionBindingId);
    assert.notEqual(JSON.parse(oldNative.record).sessionBindingId, JSON.parse(newNative.record).sessionBindingId, 'fresh Run does not reuse a rejected native session');
    assert.equal(JSON.parse(newNative.record).sessionMode, 'cold');
    const { resolveEvidence } = await import('../apps/server/src/runtime/evidence.ts');
    assert.equal(resolveEvidence(nativeRework.run.id, nativeRejectedReport.evidence[0].resolution.ref).trusted, false);
    assert.equal(trace.getRun(nativeReworkSource.run.id).status, 'cancelled');
    register(nativeRework.run.id, 'phase-1'); accept(nativeRework.run.id, 'phase-1'); await coordination.resumeCoordinationRun(nativeRework.run.id);
    register(nativeRework.run.id, 'phase-2'); accept(nativeRework.run.id, 'phase-2'); await coordination.resumeCoordinationRun(nativeRework.run.id);
    assert.equal(business.getBusinessState(nativeRework.run.id).outcome, 'achieved');
  }

  // Writes remain subject to native approval; stage file evidence is scoped and rehashed.
  const fileContract = contractFor([['sdk-writer'],['peer']], null); fileContract.stages[0].deliverables[0].kind = 'file';
  const fileRun = await fixture(fileContract, { constraints: { readonly: false } });
  const { workspaceRootDir } = await import('../apps/server/src/tools/builtin/index.ts');
  const writing = run(fileRun);
  let approval;
  await waitFor(() => {
    approval = db.get("SELECT id FROM approvals WHERE run_id=? AND status='pending' LIMIT 1", fileRun.run.id); return approval;
  }, 'native write approval');
  const filePlan = store.getRunCoordinationPlan(fileRun.run.id);
  const filePath = path.join(workspaceRootDir({ runId: fileRun.run.id, workspace: fileRun.run.workspace, workspaceScope: filePlan.id.slice(0, 8) }), 'work.txt');
  await assert.rejects(() => readFile(filePath), e => e.code === 'ENOENT');
  code(() => business.businessFileEvidence(fileRun.run.id, { stageId: 'phase-0', path: 'work.txt' }), 'FILE_EVIDENCE_UNAVAILABLE');
  assert.equal((await app.inject({ method: 'POST', url: `/api/approvals/${approval.id}/decide`, payload: { decision: 'approve' } })).statusCode, 200);
  await writing;
  let fileEvidence = business.businessFileEvidence(fileRun.run.id, { stageId: 'phase-0', path: 'work.txt' });
  assert.equal(fileEvidence.ref.workspaceScope, filePlan.id.slice(0, 8));
  register(fileRun.run.id, 'phase-0', fileEvidence.ref);
  await writeFile(filePath, 'owner fixture changed after registration');
  code(() => accept(fileRun.run.id, 'phase-0'), 'DELIVERY_UNTRUSTED');
  const fileReport = business.getBusinessState(fileRun.run.id).stages[0].report;
  apply(fileRun.run.id, { action: 'decide', stageId: 'phase-0', reportId: fileReport.id, verdict: 'reject', checkedCriteria: [], reason: '文件已变化，重新核对' });
  fileEvidence = business.businessFileEvidence(fileRun.run.id, { stageId: 'phase-0', path: 'work.txt' }); register(fileRun.run.id, 'phase-0', fileEvidence.ref);
  accept(fileRun.run.id, 'phase-0'); await coordination.resumeCoordinationRun(fileRun.run.id);
  assert.ok(business.getBusinessState(fileRun.run.id).stages[1].execution.canAccept);
  assert.equal(db.get('SELECT COUNT(*) n FROM external_agent_executions WHERE run_id=?', fileRun.run.id).n, 1, 'file hash replacement cannot replay native writes');
  await applyRunAction(fileRun.run.id, 'cancel');

  const draft = await import('../apps/web/src/services/businessContract.ts');
  assert.deepEqual(draft.readBusinessContractDraft(contractFor()), contractFor());
  assert.equal(draft.readBusinessContractDraft(manual), null, 'damaged manual draft cannot retain hidden stage execution fields');
  assert.equal(draft.readBusinessContractDraft({ ...contractFor(), executionMode: 'bad' }), null);
  const cold = execFileSync(process.execPath, ['--import', './apps/server/node_modules/tsx/dist/loader.mjs', '--input-type=module', '-e',
    "const { getBusinessState } = await import('./apps/server/src/orchestration/business.ts'); const { db } = await import('./apps/server/src/db/database.ts'); console.log(JSON.stringify(getBusinessState(process.env.STAGE_FIXTURE_ID))); db.close();"],
    { env: { ...process.env, STAGE_FIXTURE_ID: id }, cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(JSON.parse(cold.trim()).outcome, 'achieved');
  const downgrade = execFileSync(process.execPath, ['--import', './apps/server/node_modules/tsx/dist/loader.mjs', '--input-type=module', '-e',
    "const { ORCHESTRATION_MIGRATIONS, assertOrchestrationSchemaCompatible } = await import('./apps/server/src/db/orchestrationMigrations.ts'); const { default: Database } = await import('./apps/server/node_modules/better-sqlite3/lib/index.js'); ORCHESTRATION_MIGRATIONS.pop(); const db = new Database(process.env.DB_PATH, { readonly: true }); try { assertOrchestrationSchemaCompatible(db); process.exitCode=1; } catch(e) { console.log(e.message); } finally { db.close(); }"],
    { env: process.env, cwd: process.cwd(), encoding: 'utf8' }); assert.match(downgrade, new RegExp(`迁移版本 ${db.get('SELECT MAX(version) n FROM orchestration_schema_migrations').n}`));
  console.log(`通过：冻结阶段分工、当前阶段上下文、执行门禁/拒绝/普通恢复围栏、限定证据、顺序验收、CAS/幂等、Owner HTTP 自动转移、接受后崩溃恢复、取消不复活、阶段时限/未知预算/并发总预算、Claude SDK→Codex app-server stdio、冷进程读取与降级保护（kernel=${process.env.COORDINATION_RUNTIME_KERNEL}）。无真实模型请求或监听端口。`);
} finally { await app.close(); await shutdownExternalAgents(); db.db.close(); await rm(root, { recursive: true, force: true }); }

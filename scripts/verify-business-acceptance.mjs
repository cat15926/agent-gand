import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const root = await mkdtemp(path.join(tmpdir(), 'gand-business-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'test.sqlite'), NODE_ENV: 'test', AGENTS_DIR: path.join(root, 'roles'), MCP_SERVER_CMD: '', LOG_LEVEL: 'silent', HOST: '127.0.0.1', PORT: '43220', ACCOUNT_TRUSTED_ORIGINS: 'http://127.0.0.1:43220' });
// Import only after isolated DB_PATH. No listener, native CLI or provider requests.
const db = await import('../apps/server/src/db/database.ts');
const registry = await import('../apps/server/src/agents/registry.ts');
const trace = await import('../apps/server/src/runs/trace.ts');
const inbox = await import('../apps/server/src/messaging/inbox.ts');
const entry = await import('../apps/server/src/orchestration/entry.ts');
const business = await import('../apps/server/src/orchestration/business.ts');
const { normalizeBusinessContract, businessContractInstructions } = await import('../apps/server/src/orchestration/businessContract.ts');
const { normalizeOrchestrationRequest } = await import('../apps/server/src/orchestration/normalize.ts');
const { getRunOrchestrationSnapshot } = await import('../apps/server/src/orchestration/store.ts');
const { commitRunTerminal, getRunTerminal } = await import('../apps/server/src/runtime/terminal.ts');
const { assessRunRecovery } = await import('../apps/server/src/runtime/recovery.ts');
const executions = await import('../apps/server/src/execution/store.ts');
const { config } = await import('../apps/server/src/config.ts');
config.sandboxDir = path.join(root, 'sandbox');
const { mockProvider } = await import('../apps/server/src/llm/provider.ts');
let calls = 0;
mockProvider.chat = async () => { calls++; throw new Error('No model call allowed during acceptance'); };
globalThis.fetch = () => { throw new Error('No network allowed in acceptance fixture'); };
const role = (id, more = {}) => ({ id, name: id, description: 'business fixture', systemPrompt: 'Deliver actual results.', model: 'mock:worker',
  capabilities: ['execute'], permissionMode: 'readonly', tools: [], disallowedTools: [], color: '#4477aa', avatar: '', ...more });
for (const id of ['worker', 'peer']) registry.createAgent(role(id));
registry.createAgent(role('cli', { model: 'default', execution: { kind: 'external', driver: 'claude-cli' } }));
const contract = { version: 1, stages: [
  { id: 'analysis', title: '分析', criteria: ['解释原因', '说明边界'], deliverables: [{ id: 'report', title: '分析报告', kind: 'text' }] },
  { id: 'artifact', title: '交付', criteria: ['提供最终产物'], deliverables: [{ id: 'file', title: '报告文件', kind: 'file' }] },
] };
const code = (fn, expected) => assert.throws(fn, error => error.code === expected);
async function fixture(value = contract, strategy = 'auto', agentIds = ['worker']) {
  const input = { goal: '分析并交付报告', agentIds, recipientIds: agentIds, strategy, workflow: 'routine', constraints: { readonly: true }, ...(value ? { businessContract: value } : {}) };
  const preview = await entry.previewExecutionOrchestration(input);
  assert.ok(!preview.decision.issues.some(i => i.severity === 'error'), JSON.stringify(preview.decision.issues));
  const admitted = entry.submitExecutionOrchestration({ ...input, entryVersion: 1, clientRequestId: randomUUID(), previewId: preview.previewId, orchestrationFingerprint: preview.fingerprint });
  return { ...admitted, input, preview };
}
const settle = runId => commitRunTerminal({ runId, status: 'failed', disposition: 'failed', source: 'fixture_execution_failure', prepare: () => ({ reasonCodes: ['FIXTURE_FAILURE'] }) });
const command = (runId, value) => ({ ...value, expectedVersion: business.getBusinessState(runId).version, clientRequestId: randomUUID() });
const apply = (runId, value) => business.applyBusinessCommand(runId, command(runId, value));
const reportText = (runId, messageId) => apply(runId, { action: 'report', stageId: 'analysis', kind: 'delivery', note: '登记分析报告', evidence: [{ deliverableId: 'report', ref: { kind: 'message', id: messageId } }] });
const decide = (runId, stageId, verdict = 'accept', checkedCriteria = stageId === 'analysis' ? [0, 1] : [0]) => apply(runId, { action: 'decide', stageId,
  reportId: business.getBusinessState(runId).stages.find(s => s.stage.id === stageId).report.id, verdict, checkedCriteria, reason: verdict === 'reject' ? '内容不满足交付要求，重新登记' : '逐项核对通过' });

try {
  assert.equal(normalizeBusinessContract(null), null);
  const oldRequest = normalizeOrchestrationRequest({ goal: 'old task', agentIds: ['worker'] }, 'unified_preview');
  assert.equal(Object.hasOwn(oldRequest, 'businessContract'), false, 'old request digest shape unchanged');
  for (const invalid of [{ version: 1, stages: [] }, { ...contract, extra: true }, { version: 1, stages: [contract.stages[0], contract.stages[0]] },
    { version: 1, stages: [{ ...contract.stages[0], criteria: ['x', 'x'] }] }, { version: 1, stages: [{ ...contract.stages[0], id: '__proto__' }] }]) code(() => normalizeBusinessContract(invalid), 'INVALID_BUSINESS_CONTRACT');
  assert.match(businessContractInstructions(contract), /确认收到不算交付/);
  const historical = await fixture(null);
  settle(historical.run.id);
  assert.equal(business.getBusinessState(historical.run.id).outcome, 'unverified');
  code(() => apply(historical.run.id, { action: 'resolve', outcome: 'not_achieved', reason: '旧任务' }), 'BUSINESS_CONTRACT_REQUIRED');

  const f = await fixture(); const id = f.run.id;
  assert.deepEqual(getRunOrchestrationSnapshot(id).request.businessContract, contract);
  assert.equal(business.getBusinessState(id).outcome, 'in_progress');
  const changed = structuredClone(f.input); changed.businessContract.stages[0].criteria[0] = '修改后的标准';
  code(() => entry.submitExecutionOrchestration({ ...changed, entryVersion: 1, clientRequestId: randomUUID(), previewId: f.preview.previewId, orchestrationFingerprint: f.preview.fingerprint }), 'PREVIEW_STALE');
  const message = inbox.post({ runId: id, from: 'worker', to: 'all', kind: 'agent', body: '原因：调度缺少独立业务验收。边界：此报告仅确认验收链路，不声称自动阶段调度已完成。' });
  code(() => reportText(id, message.id), 'EXECUTION_NOT_SETTLED');
  code(() => apply(id, { action: 'resolve', outcome: 'user_ended', reason: '提前停止' }), 'EXECUTION_NOT_SETTLED');
  const receiptCommand = command(id, { action: 'report', stageId: 'analysis', kind: 'receipt', note: '成员确认收到', evidence: [] });
  const receipt = business.applyBusinessCommand(id, receiptCommand);
  assert.equal(receipt.stages[0].status, 'acknowledged');
  assert.equal(business.applyBusinessCommand(id, receiptCommand).version, receipt.version, 'lost-response retry is idempotent');
  code(() => business.applyBusinessCommand(id, { ...receiptCommand, note: 'changed' }), 'IDEMPOTENCY_CONFLICT');
  settle(id);
  assert.equal(business.getBusinessState(id).outcome, 'awaiting_acceptance', 'execution failure alone does not adjudicate business failure');
  const immutable = { run: trace.getRun(id), terminal: getRunTerminal(id), messages: inbox.listByRun(id), snapshot: getRunOrchestrationSnapshot(id) };
  code(() => decide(id, 'analysis'), 'RECEIPT_IS_NOT_DELIVERY');
  decide(id, 'analysis', 'reject', []);
  const ack = inbox.post({ runId: id, from: 'worker', to: 'all', kind: 'agent', body: '收到！' });
  code(() => reportText(id, ack.id), 'RECEIPT_IS_NOT_DELIVERY');
  const user = inbox.listByRun(id).find(m => m.kind === 'user');
  code(() => reportText(id, user.id), 'AGENT_DELIVERY_REQUIRED');
  const other = inbox.post({ runId: historical.run.id, from: 'worker', to: 'all', kind: 'agent', body: '另一任务的真实结果' });
  code(() => reportText(id, other.id), 'DELIVERY_UNTRUSTED');
  const missing = apply(id, { action: 'report', stageId: 'analysis', kind: 'delivery', note: '漏了产物', evidence: [] });
  code(() => decide(id, 'analysis'), 'REQUIRED_DELIVERY_MISSING');
  code(() => business.applyBusinessCommand(id, { ...receiptCommand, clientRequestId: randomUUID() }), 'BUSINESS_STATE_STALE');
  decide(id, 'analysis', 'reject', []);
  reportText(id, message.id);
  assert.equal(business.getBusinessState(id).outcome, 'awaiting_acceptance');
  code(() => decide(id, 'analysis', 'accept', [0]), 'CRITERIA_UNCHECKED');
  code(() => decide(id, 'analysis', 'accept', [0, 0]), 'INVALID_BUSINESS_DECISION');
  db.run('UPDATE messages SET body=? WHERE id=?', '内容在登记后被修改', message.id);
  code(() => decide(id, 'analysis'), 'DELIVERY_CHANGED');
  db.run('UPDATE messages SET body=? WHERE id=?', message.body, message.id);
  const execution = executions.createExecution({ runId: id, agentId: 'worker', scopeId: 'unknown-result', driver: 'claude-sdk', agentVersion: 1, cwd: root });
  executions.updateExecution(execution.id, { status: 'interrupted', errorCode: 'interrupted' });
  code(() => decide(id, 'analysis'), 'EXECUTION_NOT_SETTLED');
  // Fixture simulates the separate recovery audit; terminal execution patching is correctly fenced.
  db.run("UPDATE external_agent_executions SET record=json_set(record,'$.recovery',json(?)) WHERE id=?", JSON.stringify({ state: 'quiesced', reason: 'fixture confirmed', recoveredAt: new Date().toISOString() }), execution.id);
  const artifactRoot = path.join(config.sandboxDir, 'workspaces', f.run.workspace);
  await mkdir(artifactRoot, { recursive: true }); await writeFile(path.join(artifactRoot, 'report.md'), 'final report v1\n');
  code(() => business.businessFileEvidence(id, { path: '../outside.txt' }), 'INVALID_FILE_EVIDENCE');
  const file = business.businessFileEvidence(id, { path: 'report.md' });
  apply(id, { action: 'report', stageId: 'artifact', kind: 'delivery', note: '登记文件', evidence: [{ deliverableId: 'file', ref: file.ref }] });
  code(() => decide(id, 'artifact'), 'PREVIOUS_STAGE_REQUIRED');
  const acceptedCommand = command(id, { action: 'decide', stageId: 'analysis', reportId: business.getBusinessState(id).stages[0].report.id, verdict: 'accept', checkedCriteria: [0, 1], reason: '确认原因和边界' });
  business.applyBusinessCommand(id, acceptedCommand);
  assert.equal(business.applyBusinessCommand(id, acceptedCommand).version, business.getBusinessState(id).version);
  code(() => reportText(id, message.id), 'STAGE_ALREADY_ACCEPTED');
  await writeFile(path.join(artifactRoot, 'report.md'), 'changed after registration\n');
  code(() => decide(id, 'artifact'), 'DELIVERY_UNTRUSTED');
  decide(id, 'artifact', 'reject', []);
  const freshFile = business.businessFileEvidence(id, { path: 'report.md' });
  apply(id, { action: 'report', stageId: 'artifact', kind: 'delivery', note: '重新核对文件', evidence: [{ deliverableId: 'file', ref: freshFile.ref }] });
  assert.equal(decide(id, 'artifact').outcome, 'achieved');
  code(() => apply(id, { action: 'resolve', outcome: 'not_achieved', reason: 'retroactive edit' }), 'BUSINESS_OUTCOME_FINAL');
  assert.deepEqual({ run: trace.getRun(id), terminal: getRunTerminal(id), messages: inbox.listByRun(id).filter(m => ![ack.id].includes(m.id)), snapshot: getRunOrchestrationSnapshot(id) }, immutable, 'acceptance cannot rewrite execution terminal, request or source messages');
  assert.equal(assessRunRecovery(id).reasonCodes[0], 'BUSINESS_CHECKPOINT_UNSUPPORTED');
  const history = business.businessHistory(id);
  assert.ok(history.some(e => e.report?.id === missing.stages[0].report.id), 'rejected candidate retained');
  assert.ok(history.some(e => e.report?.evidence[0]?.resolution.contentSha256 === file.ref.sha256), 'old file hash retained');
  assert.equal(business.businessSummary(id).outcome, 'achieved');

  for (const [strategy, outcome, actors, engine] of [['serial', 'partial_accepted', ['cli'], 'pipeline'], ['auto', 'user_ended', ['worker', 'peer'], 'coordination'], ['auto', 'not_achieved', ['worker'], 'collaboration']]) {
    const next = await fixture(contract, strategy, actors);
    assert.equal(next.preview.decision.execution.engine, engine); settle(next.run.id);
    if (outcome === 'partial_accepted') {
      code(() => apply(next.run.id, { action: 'resolve', outcome, reason: '部分验收' }), 'ACCEPTED_STAGE_REQUIRED');
      const output = inbox.post({ runId: next.run.id, from: actors[0], to: 'all', kind: 'agent', body: '原因与边界已明确，报告已交付，文件产物尚未完成。' });
      reportText(next.run.id, output.id); decide(next.run.id, 'analysis');
    }
    const before = getRunTerminal(next.run.id);
    const state = apply(next.run.id, { action: 'resolve', outcome, reason: '用户确认此轮接受范围和结束原因' });
    assert.equal(state.outcome, outcome); assert.deepEqual(getRunTerminal(next.run.id), before);
    code(() => apply(next.run.id, { action: 'resolve', outcome: 'not_achieved', reason: 'change' }), 'BUSINESS_OUTCOME_FINAL');
  }

  // Real Coordination attempt storage, with no executing worker/provider.
  const coord = await fixture(contract, 'parallel', ['worker', 'peer']);
  const coordStore = await import('../apps/server/src/coordination/store.ts');
  const plan = coordStore.getRunCoordinationPlan(coord.run.id);
  coordStore.prepareCoordinationReadySteps(plan);
  const step = plan.steps.find(s => s.agentId);
  const claimed = coordStore.claimCoordinationStep(plan, step, '明确的分析输入'); assert.ok(claimed);
  const completion = coordStore.completeCoordinationStep(plan, step.id, claimed.attempt.id, '原因和边界已形成完整分析报告。', { version: 2, type: 'complete', summary: '完整分析报告' });
  assert.equal(completion.accepted, true); settle(coord.run.id);
  const attemptRef = { kind: 'attempt_output', id: claimed.attempt.id };
  assert.ok(business.listBusinessEvidence(coord.run.id).some(c => c.ref.id === claimed.attempt.id));
  apply(coord.run.id, { action: 'report', stageId: 'analysis', kind: 'delivery', note: '使用实际步骤输出', evidence: [{ deliverableId: 'report', ref: attemptRef }] });
  assert.equal(decide(coord.run.id, 'analysis').stages[0].status, 'accepted');
  const crossAttempt = await fixture(); settle(crossAttempt.run.id);
  code(() => apply(crossAttempt.run.id, { action: 'report', stageId: 'analysis', kind: 'delivery', note: '', evidence: [{ deliverableId: 'report', ref: attemptRef }] }), 'DELIVERY_UNTRUSTED');

  const storage = new Map();
  globalThis.sessionStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const drafts = await import('../apps/web/src/services/roomDraft.ts');
  const { validateRoomPreferences } = await import('../apps/server/src/conversations/entry.ts');
  drafts.writeRoomDraft({ ...drafts.emptyPreferences(), version: 2, goal: '保留目标', title: '验收草稿', selected: ['worker'], initialTargets: ['worker'], workspace: '', businessContract: contract });
  const draft = drafts.readRoomDraft();
  assert.deepEqual(draft.businessContract, contract);
  const preferences = drafts.roomPreferencesOnly(draft);
  assert.equal(Object.hasOwn(preferences, 'businessContract'), false, 'task contract cannot leak into room defaults');
  assert.deepEqual(validateRoomPreferences(preferences, ['worker']), preferences);
  storage.set('gand:room-draft:v2', JSON.stringify({ ...draft, businessContract: { version: 1, stages: 'broken' } }));
  assert.equal(drafts.readRoomDraft().goal, '保留目标');
  assert.equal(drafts.readRoomDraft().businessContract, null);
  assert.ok(storage.has('gand:room-draft:recovery'), 'damaged contract preserved for recovery');

  const { default: Fastify } = await import('../apps/server/node_modules/fastify/fastify.js');
  const { registerRoutes } = await import('../apps/server/src/api/routes.ts');
  const app = Fastify({ logger: false });
  try {
    await registerRoutes(app);
    const { registerAccountRoutes } = await import('../apps/server/src/api/accountRoutes.ts');
    await registerAccountRoutes(app);
    const host = { host: '127.0.0.1:43220' };
    assert.equal((await app.inject({ method: 'GET', url: `/api/accounts/business/${id}`, headers: host })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: `/api/accounts/business/${id}`, headers: { ...host, origin: 'https://untrusted.invalid' } })).statusCode, 403);
    const session = await app.inject({ method: 'POST', url: '/api/accounts/session', headers: { ...host, 'x-gand-bootstrap': '1' } });
    assert.equal(session.statusCode, 200);
    const auth = { ...host, cookie: session.headers['set-cookie'].split(';')[0], 'x-gand-csrf': session.json().csrfToken };
    assert.equal((await app.inject({ method: 'POST', url: `/api/accounts/business/${id}`, headers: { ...host, cookie: auth.cookie }, payload: { action: 'decide' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: `/api/accounts/business/${id}`, headers: auth })).json().outcome, 'achieved');
    assert.ok((await app.inject({ method: 'GET', url: `/api/accounts/business/${id}/evidence`, headers: auth })).json().choices.some(c => c.ref.id === message.id));
    assert.equal((await app.inject({ method: 'GET', url: '/api/accounts/business/missing', headers: auth })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: `/api/accounts/business/${id}`, headers: auth, payload: { action: 'decide' } })).statusCode, 400);
    const fixed = await app.inject({ method: 'POST', url: `/api/accounts/business/${id}`, headers: auth, payload: command(id, { action: 'resolve', outcome: 'not_achieved', reason: 'attempted rewrite' }) });
    assert.equal(fixed.statusCode, 409); assert.equal(fixed.json().code, 'BUSINESS_OUTCOME_FINAL');
    assert.equal((await app.inject({ method: 'POST', url: `/api/accounts/business/${id}`, headers: { ...auth, 'content-type': 'application/json' }, payload: '{bad json' })).statusCode, 400);
    const task = (await app.inject({ method: 'GET', url: `/api/conversations/${f.conversation.id}/task-state` })).json().tasks.find(t => t.runId === id);
    assert.deepEqual(task.business, { version: business.getBusinessState(id).version, outcome: 'achieved', contractPresent: true, acceptedStages: 2, totalStages: 2 });
    // Verify the actual web transport bootstraps management cookies/CSRF and preserves error codes.
    const deniedFetch = globalThis.fetch; let browserCookie = '';
    globalThis.fetch = async (url, init = {}) => {
      assert.equal(init.credentials, 'same-origin');
      const headers = { ...host, ...Object.fromEntries(new Headers(init.headers).entries()), ...(browserCookie ? { cookie: browserCookie } : {}) };
      const response = await app.inject({ url: String(url), method: init.method ?? 'GET', headers, ...(init.body == null ? {} : { payload: init.body }) });
      if (response.headers['set-cookie']) browserCookie = response.headers['set-cookie'].split(';')[0];
      return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
    };
    try {
      const client = await import('../apps/web/src/services/api.ts');
      assert.equal((await client.getBusinessState(id)).outcome, 'achieved'); assert.ok(browserCookie);
      await assert.rejects(() => client.applyBusinessCommand(id, command(id, { action: 'resolve', outcome: 'not_achieved', reason: 'rewrite' })), error => error instanceof client.ApiError && error.code === 'BUSINESS_OUTCOME_FINAL');
      await assert.rejects(() => client.applyBusinessCommand(crossAttempt.run.id, { expectedVersion: 99, clientRequestId: randomUUID(), action: 'report', stageId: 'analysis', kind: 'receipt', note: 'ready', evidence: [] }), error => error instanceof client.ApiError && error.code === 'BUSINESS_STATE_STALE');
    } finally { globalThis.fetch = deniedFetch; }
  } finally { await app.close(); }
  const cold = execFileSync(process.execPath, ['--import', './apps/server/node_modules/tsx/dist/loader.mjs', '--input-type=module', '-e',
    `const { getBusinessState } = await import('./apps/server/src/orchestration/business.ts'); const { db } = await import('./apps/server/src/db/database.ts'); console.log(JSON.stringify(getBusinessState(process.env.BUSINESS_FIXTURE_RUN_ID))); db.close();`],
  { cwd: process.cwd(), env: { ...process.env, BUSINESS_FIXTURE_RUN_ID: id }, encoding: 'utf8' });
  assert.equal(JSON.parse(cold.trim()).outcome, 'achieved', 'cold process reconstructs accepted outcome from frozen contract and append-only ledger');
  assert.equal(calls, 0);
  const promptFixture = await fixture();
  apply(promptFixture.run.id, { action: 'report', stageId: 'analysis', kind: 'receipt', note: 'OWNER_ONLY_RECEIPT', evidence: [] });
  mockProvider.chat = async request => {
    calls++;
    const text = request.messages.map(m => m.content).join('\n');
    assert.match(text, /本任务冻结了以下阶段验收清单/); assert.match(text, /解释原因/); assert.doesNotMatch(text, /OWNER_ONLY_RECEIPT/);
    return { content: '提供完整分析报告，交给用户验收。', usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 }, toolCalls: [], stopReason: 'end_turn', truncated: false };
  };
  trace.setRunStatus(promptFixture.run.id, 'running');
  const { runAgentTurn } = await import('../apps/server/src/orchestration/agentStep.ts');
  await runAgentTurn({ run: trace.getRun(promptFixture.run.id), agent: registry.getAnyAgent('worker'), parentSpanId: trace.startSpan(promptFixture.run.id, { spanKind: 'agent', name: 'contract prompt fixture' }).id,
    messages: [{ role: 'user', content: '交付分析报告' }], disableTools: true });
  assert.equal(calls, 1);
  console.log('通过：契约冻结、预览漂移、交付/标准/证据漂移/未知执行围栏、顺序验收、幂等/CAS、三引擎业务状态、部分接受/提前结束、原终态不可变、冷启动和管理会话/CSRF/来源/HTTP、草稿恢复/默认偏好隔离、Agent 契约下发；1 次本地 mock 回合，无真实模型请求或监听端口。');
} finally { db.db.close(); await rm(root, { recursive: true, force: true }); }

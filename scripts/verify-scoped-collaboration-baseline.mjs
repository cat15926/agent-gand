// G0: lock down the CURRENT v2 boundary, not the future scoped-collaboration behavior.
// Only model responses are stubbed. Admission, attempts, commands, completion,
// aggregation, durable timer recovery and user-decision resolution are production code.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'gand-scoped-g0-'));
for (const key of Object.keys(process.env)) {
  if (/^(LLM_|ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_|ACCOUNT_|COLLAB_|COORDINATION_|ORCHESTRATION_|EXTERNAL_|MCP_)/.test(key)) delete process.env[key];
}
Object.assign(process.env, {
  NODE_ENV: 'test', AGENT_GAND_ISOLATED_WORKER: '1', LOG_LEVEL: 'silent',
  DB_PATH: path.join(root, 'test.sqlite'), AGENTS_DIR: path.join(root, 'roles'),
  AGENT_GAND_PRIVATE_DIR: path.join(root, 'private'),
  EXTERNAL_CODEX_HOME: path.join(root, 'codex'), EXTERNAL_CLAUDE_HOME: path.join(root, 'claude'),
  EXTERNAL_WORKSPACE_DIR: path.join(root, 'workspaces'),
  EXTERNAL_CODEX_COMMAND: path.join(root, 'disabled-codex'), EXTERNAL_CLAUDE_COMMAND: path.join(root, 'disabled-claude'),
  COORDINATION_RUNTIME_KERNEL: 'execute', COLLAB_RUNTIME_MODE: 'execute', MCP_SERVER_CMD: '',
});
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('G0 forbids network requests'); };
const requireServer = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { MockAgent, setGlobalDispatcher } = requireServer('undici');
const network = new MockAgent();
network.disableNetConnect();
const dispatchNetwork = network.dispatch.bind(network);
network.dispatch = (...args) => { networkAttempts++; return dispatchNetwork(...args); };
setGlobalDispatcher(network);

let db;
let store;
let trace;
const scenarios = new Map();
const report = { kind: 'G0 production-scheduler / mock-model integration', cases: [] };
try {
  const { config } = await import('../apps/server/src/config.ts');
  config.dataDir = root;
  config.sandboxDir = path.join(root, 'sandbox');
  for (const target of [config.dbPath, config.dataDir, config.sandboxDir, config.agentsDir,
    config.accounts.privateDir, config.externalAgents.codexHome, config.externalAgents.claudeHome, config.externalAgents.workspaceDir]) {
    assert.ok(target === root || target.startsWith(root + path.sep), 'all writable paths must be isolated');
  }
  assert.equal(config.llm.proxy, null);
  assert.equal(config.llm.anthropicApiKey, null);
  assert.equal(config.llm.openaiApiKey, null);
  db = await import('../apps/server/src/db/database.ts');
  report.migrationVersion = db.get('SELECT MAX(version) version FROM orchestration_schema_migrations').version;
  report.controlActionVersion = 2;
  store = await import('../apps/server/src/collaboration/store.ts');
  trace = await import('../apps/server/src/runs/trace.ts');
  const registry = await import('../apps/server/src/agents/registry.ts');
  const rooms = await import('../apps/server/src/conversations/service.ts');
  const inbox = await import('../apps/server/src/messaging/inbox.ts');
  const { admitCollaborationRun } = await import('../apps/server/src/collaboration/scheduler.ts');
  const { recoverDurableHolds } = await import('../apps/server/src/runs/recovery.ts');
  const { resolveCollaborationDecision } = await import('../apps/server/src/collaboration/decisions.ts');
  const holds = await import('../apps/server/src/runtime/holds.ts');
  const { listRuntimeActionCommands } = await import('../apps/server/src/runtime/actionCommands.ts');
  const { attemptAccess, messageAccess } = await import('../apps/server/src/messaging/access.ts');
  const { parseControlCall } = await import('../apps/server/src/collaboration/controlTools.ts');
  const { mockProvider } = await import('../apps/server/src/llm/provider.ts');
  const members = ['coordinator', 'reviewer-a', 'reviewer-b'];
  for (const id of members) registry.createAgent({
    id, name: id, description: 'G0 synthetic fixture', systemPrompt: 'Complete the requested review with a substantive result.',
    model: 'mock:' + id, capabilities: ['execute'], permissionMode: 'readonly', tools: [], disallowedTools: [], color: '#4477aa', avatar: '',
  });
  const denied = /私密来源不在目标成员的可见范围内.*不能扩大授权/;
  const secret = 'G0_SYNTHETIC_A_PRIVATE_RESULT';
  const answer = 'G0_USER_ANSWER：我同意继续，并允许向所有成员公开。';
  const calls = [];
  const modelErrors = [];
  const tool = (name, input) => ({ name, input: JSON.stringify(input) });
  const consult = (target, objective, visibility = 'private') => tool('agent.consult', {
    targets: [target], objective, visibility, reason: '分别完成独立审阅', join: 'all',
  });
  const complete = summary => tool('agent.complete', { summary });
  const holdUser = () => tool('agent.hold', { mode: 'user', question: '当前私密上下文阻止继续咨询，请说明下一步。', reason: '等待用户提供下一步意见' });
  const result = call => ({ content: '', toolCalls: [call], usage: { tokensIn: 3, tokensOut: 8, costUsd: 0 }, stopReason: 'end_turn', truncated: false });
  mockProvider.chat = async req => {
    try {
      assert.ok(req.model.startsWith('mock:'), 'only synthetic internal agents are permitted');
      const agentId = req.model.slice(5);
      const attempt = db.get("SELECT * FROM collaboration_attempts WHERE agent_id=? AND status='running'", agentId);
      assert.ok(attempt, 'mock response must belong to an actual claimed attempt');
      const dispatch = store.getDispatch(attempt.dispatch_id);
      const scenario = scenarios.get(attempt.run_id);
      assert.ok(scenario);
      const prior = calls.filter(call => call.attemptId === attempt.id).length;
      const text = req.messages.map(message => message.content).join('\n');
      calls.push({ runId: attempt.run_id, attemptId: attempt.id, kind: dispatch.kind, agentId });
      assert.ok(req.tools.some(t => t.name === 'agent.consult'));
      assert.ok(!req.tools.some(t => t.name === 'agent.consult_batch'), 'G0 must still exercise v2');
      if (agentId !== 'coordinator') {
        const summary = scenario.name === 'public-control'
          ? `${agentId} 已完成公开材料审阅：目标清晰、证据范围充分、无待补充事项，建议进入汇总。`
          : `${secret}：已核对咨询材料，给出独立结论和依据，无需补充资料，本次审阅已完成。`;
        return result(complete(summary));
      }
      if (dispatch.kind === 'initial') return result(consult('reviewer-a', '请独立审阅第一项材料并给出结论。', scenario.visibility));
      if (scenario.name === 'public-control') {
        assert.doesNotMatch(text, /G0_SYNTHETIC_A_PRIVATE_RESULT/);
        return result(store.listBatches(attempt.run_id).length === 1
          ? consult('reviewer-b', '请独立审阅第二项材料并给出结论。', 'public')
          : complete('两位成员均已完成公开审阅，第一项和第二项材料结论一致，证据完整，无未解决问题，汇总交付已完成。'));
      }
      assert.match(text, new RegExp(secret), 'private aggregate and its continuations still contain A result');
      if (prior) assert.match(text, denied, 'the scheduler must return the actual authorization rejection to the model');
      if (scenario.name === 'private-rewrite') {
        assert.ok(prior < 2, 'invalid controls have only one correction in current v2');
        return result(consult('reviewer-b', prior ? '仅依据你自己的材料给出独立意见，不引用任何其他成员。' : '请完成第二项独立审阅。'));
      }
      const resumes = store.listDispatches(attempt.run_id).filter(d => d.kind === 'resume').length;
      if (!prior) return result(consult(resumes === 2 ? 'reviewer-a' : 'reviewer-b', resumes ? '请重新独立审阅自己的材料。' : '请完成第二项独立审阅。'));
      assert.equal(prior, 1);
      if (dispatch.kind === 'aggregate') return result(tool('agent.hold', { mode: 'timer', delaySeconds: 1, reason: '等待一秒后再试独立咨询' }));
      if (resumes === 2) assert.ok(text.includes(answer), 'actual user answer must enter resumed context');
      return result(holdUser());
    } catch (error) { modelErrors.push(error); throw error; }
  };

  const dispatches = id => store.listDispatches(id);
  const idle = id => !dispatches(id).some(d => ['queued', 'running'].includes(d.status));
  async function until(id, predicate, tick = () => {}) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (modelErrors.length) throw modelErrors[0];
      tick();
      if (predicate() && idle(id)) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(JSON.stringify({ timeout: id, status: trace.getRun(id).status, dispatches: dispatches(id), messages: inbox.listByRun(id) }));
  }
  function start(name, visibility = 'private') {
    const room = rooms.createConversation({ title: 'G0 ' + name, mode: 'collaboration', agentIds: members, workspace: null });
    const run = trace.createRun('请协调两位成员分别独立审阅材料，然后汇总。', 'collaboration', members, null, null, room.id);
    scenarios.set(run.id, { name, visibility, roomId: room.id });
    admitCollaborationRun(run, room, { recipientIds: ['coordinator'] });
    return run.id;
  }
  const scope = (actual, audience) => {
    assert.equal(actual.visibility, audience ? 'private' : 'public');
    assert.deepEqual([...actual.audience].sort(), [...(audience ?? [])].sort());
  };
  function privateBaseline(id) {
    const items = dispatches(id);
    const initial = items.find(d => d.kind === 'initial');
    const child = items.find(d => d.kind === 'fanout');
    const aggregate = items.find(d => d.kind === 'aggregate');
    assert.ok(initial && child && aggregate);
    const attempts = store.listAttempts(id);
    const initialAttempt = attempts.find(a => a.dispatchId === initial.id);
    scope(attemptAccess(initialAttempt.id), null);
    assert.doesNotMatch(initialAttempt.inputContext, new RegExp(secret));
    scope(messageAccess(child.sourceMessageId), ['coordinator', 'reviewer-a', 'user']);
    scope(attemptAccess(attempts.find(a => a.dispatchId === child.id).id), ['coordinator', 'reviewer-a', 'user']);
    scope(messageAccess(aggregate.sourceMessageId), ['coordinator', 'user']);
    for (const d of items.filter(d => ['aggregate', 'resume'].includes(d.kind))) {
      scope(attemptAccess(attempts.find(a => a.dispatchId === d.id).id), ['coordinator', 'user']);
    }
    assert.equal(items.filter(d => d.targetAgentId === 'reviewer-a').length, 1, 'A must not be rerun');
    assert.equal(items.filter(d => d.targetAgentId === 'reviewer-b').length, 0, 'rejected consult must not create B work');
    assert.equal(db.get("SELECT COUNT(*) n FROM runtime_completion_candidates WHERE run_id=? AND status='accepted'", id).n, 1);
    assert.doesNotMatch(inbox.listByConversation(scenarios.get(id).roomId, 'reviewer-b').map(m => m.body).join('\n'), new RegExp(secret));
    const contract = JSON.parse(db.get('SELECT payload FROM runtime_contracts WHERE run_id=?', id).payload);
    assert.equal(contract.features.controlActionVersion, 2);
  }
  function record(id) {
    report.cases.push({ name: scenarios.get(id).name, runStatus: trace.getRun(id).status,
      dispatches: dispatches(id).map(d => `${d.kind}:${d.targetAgentId}:${d.status}`),
      commands: listRuntimeActionCommands(id).map(c => c.kind), modelCalls: calls.filter(c => c.runId === id).length,
      holds: holds.listDurableHolds(id).map(h => ({ condition: h.condition.kind, status: h.status })),
      wakeEvents: holds.listRuntimeWakeEvents(id).length,
    });
  }

  const rewritten = start('private-rewrite');
  await until(rewritten, () => dispatches(rewritten).some(d => d.kind === 'aggregate' && d.status === 'blocked'));
  privateBaseline(rewritten);
  assert.match(inbox.listByRun(rewritten).map(m => m.body).join('\n'), denied);
  assert.deepEqual(listRuntimeActionCommands(rewritten).map(c => c.kind).sort(), ['complete', 'consult_all']);
  assert.notEqual(trace.getRun(rewritten).status, 'completed');
  record(rewritten);

  const resumed = start('private-timer-answer');
  await until(resumed, () => holds.listDurableHolds(resumed).length === 1);
  const timer = holds.listDurableHolds(resumed)[0];
  assert.equal(timer.condition.kind, 'timer');
  await until(resumed, () => store.listDecisions(resumed).some(d => d.kind === 'agent_question' && d.status === 'pending'), () => recoverDurableHolds(resumed));
  assert.ok(Date.now() >= Date.parse(timer.condition.wakeAt), 'use the actual timer deadline, never a seeded wake');
  const firstResume = dispatches(resumed).find(d => d.kind === 'resume');
  assert.equal(firstResume.sourceMessageId, timer.recoveryPolicy.sourceMessageId);
  assert.ok(Date.parse(firstResume.createdAt) >= Date.parse(timer.condition.wakeAt), 'resume cannot be created before the deadline');
  const question = store.listDecisions(resumed).find(d => d.kind === 'agent_question' && d.status === 'pending');
  scope(messageAccess(question.promptMessageId), ['coordinator', 'user']);
  const resolved = resolveCollaborationDecision(question.id, { action: 'answer', message: answer });
  scope(messageAccess(resolved.decision.resolution.messageId), ['coordinator', 'user']);
  await until(resumed, () => store.listDecisions(resumed).some(d => d.id !== question.id && d.status === 'pending'));
  privateBaseline(resumed);
  assert.equal(trace.getRun(resumed).status, 'waiting_for_user');
  assert.equal(dispatches(resumed).filter(d => d.kind === 'resume').length, 2);
  assert.ok(dispatches(resumed).some(d => d.kind === 'resume' && d.sourceMessageId === resolved.decision.resolution.messageId));
  assert.equal(listRuntimeActionCommands(resumed).filter(c => c.kind === 'wake').length, 2);
  assert.equal(holds.listDurableHolds(resumed).filter(h => h.status === 'resumed').length, 2);
  const commandCount = listRuntimeActionCommands(resumed).length;
  resolveCollaborationDecision(question.id, { action: 'answer', message: answer });
  recoverDurableHolds(resumed);
  assert.equal(listRuntimeActionCommands(resumed).length, commandCount, 'duplicate recovery and answer must not dispatch again');
  assert.equal(holds.listRuntimeWakeEvents(resumed).length, 2);
  assert.equal(holds.listRuntimeWakeEvents(resumed).filter(event => event.kind === 'user_decision').length, 1);
  record(resumed);

  const publicRun = start('public-control', 'public');
  await until(publicRun, () => trace.getRun(publicRun).status === 'completed');
  assert.equal(store.listBatches(publicRun).length, 2);
  assert.equal(dispatches(publicRun).filter(d => d.targetAgentId === 'reviewer-b').length, 1);
  assert.equal(listRuntimeActionCommands(publicRun).filter(c => c.kind === 'consult_all').length, 2);
  for (const a of store.listAttempts(publicRun)) scope(attemptAccess(a.id), null);
  record(publicRun);

  // Ancillary parser counterfactual: retaining A in the aggregate audience alone cannot authorize B.
  assert.throws(() => parseControlCall(consult('reviewer-b', 'B 的独立问题'), members, 'coordinator', 2, {
    messageVisibilityVersion: 1, messageAccess: { visibility: 'private', audience: ['coordinator', 'reviewer-a', 'user'] },
  }), denied);
  assert.equal(networkAttempts, 0);
  assert.equal(db.get('SELECT COUNT(*) n FROM external_agent_executions').n, 0);
  report.networkAttempts = networkAttempts;
  report.nativeExecutions = 0;
  report.modelCalls = calls.length;
  report.status = 'current-v2-baseline-reproduced';
} finally {
  if (store && trace) for (const id of scenarios.keys()) {
    store.cancelCollaborationRun(id);
    if (!['completed', 'failed', 'cancelled'].includes(trace.getRun(id).status)) trace.setRunStatus(id, 'cancelled');
  }
  // Let queued scheduler notifications settle before closing the isolated database.
  await new Promise(resolve => setTimeout(resolve, 50));
  db?.closeDatabase();
  await network.close();
  await rm(root, { recursive: true, force: true });
}
assert.equal(existsSync(root), false);
report.isolatedFilesRemoved = true;
console.log(JSON.stringify(report, null, 2));

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-runtime-atomic-'));
process.env.DB_PATH = path.join(root, 'test.sqlite');
process.env.COLLAB_RUNTIME_ATOMIC = 'true';
process.env.COLLAB_MAX_ATTEMPTS = '2';
const db = await import('../apps/server/src/db/database.ts');
const store = await import('../apps/server/src/collaboration/store.ts');
const trace = await import('../apps/server/src/runs/trace.ts');
const { planCollaborationAdmission } = await import('../apps/server/src/runtime/subjectContract.ts');
const { observeAdmission, observeAction, auditShadowRun } = await import('../apps/server/src/runtime/shadow.ts');

function fixture(id) {
  const now = new Date().toISOString();
  db.run('INSERT INTO conversations (id,title,mode,agent_ids,created_at,updated_at) VALUES (?,?,?,?,?,?)', `c-${id}`, id, 'collaboration', '["a","b"]', now, now);
  db.run('INSERT INTO runs (id,goal,mode,conversation_id,turn_no,status,agent_ids,created_at) VALUES (?,?,?,?,?,?,?,?)', `r-${id}`, id, 'collaboration', `c-${id}`, 1, 'running', '["a","b"]', now);
  return { runId: `r-${id}`, conversationId: `c-${id}` };
}

function admit(id) {
  const ids = fixture(id);
  const plan = planCollaborationAdmission({ runId: ids.runId, objective: id, participantIds: ['a', 'b'], targetAgentIds: ['a'] });
  return db.tx(() => {
    const dispatch = store.createDispatch({ ...ids, sourceMessageId: `m-${id}`, kind: 'initial', from: 'user', targetAgentId: 'a', depth: 0, idempotencyKey: `initial:${id}` });
    observeAdmission(plan.contract, plan.subjects, [dispatch.id]);
    return { ...ids, dispatch };
  });
}

try {
  const handoff = admit('handoff');
  const first = store.claimNextDispatch(handoff.conversationId, 'owner');
  assert.equal(first?.dispatch.id, handoff.dispatch.id);
  assert.equal(db.get('SELECT state FROM runtime_custody WHERE subject_id=(SELECT subject_id FROM runtime_dispatch_subjects WHERE dispatch_id=?)', first.dispatch.id).state, 'owned');
  const child = db.tx(() => {
    const next = store.createDispatch({ ...handoff, sourceMessageId: 'm-handoff-b', parentDispatchId: first.dispatch.id,
      kind: 'handoff', from: 'a', targetAgentId: 'b', depth: 1, idempotencyKey: 'handoff:a:b' });
    observeAction({ dispatchId: first.dispatch.id, attemptId: first.attempt.id, agentId: 'a',
      action: { type: 'handoff', targetAgentId: 'b', message: '继续', reason: '能力' }, childDispatchIds: [next.id], batchId: null });
    store.finishAttempt({ attemptId: first.attempt.id, dispatchId: first.dispatch.id, status: 'completed' });
    return next;
  });
  const pending = db.get('SELECT * FROM runtime_custody WHERE subject_id=(SELECT subject_id FROM runtime_dispatch_subjects WHERE dispatch_id=?)', child.id);
  assert.equal(pending.state, 'transferring');
  assert.equal(pending.holder_agent_id, 'a');
  assert.equal(pending.pending_holder_agent_id, 'b');
  observeAction({ dispatchId: first.dispatch.id, attemptId: first.attempt.id, agentId: 'a',
    action: { type: 'handoff', targetAgentId: 'b', message: '继续', reason: '能力' }, childDispatchIds: [child.id], batchId: null });
  assert.equal(db.get('SELECT generation FROM runtime_custody WHERE subject_id=?', pending.subject_id).generation, pending.generation, '重复交接不得增加代际');
  const acquired = store.claimNextDispatch(handoff.conversationId, 'owner');
  assert.equal(acquired?.dispatch.id, child.id);
  assert.equal(db.get('SELECT holder_agent_id FROM runtime_custody WHERE subject_id=?', pending.subject_id).holder_agent_id, 'b');
  store.cancelCollaborationRun(handoff.runId);
  assert.equal(db.get('SELECT state FROM runtime_custody WHERE subject_id=?', pending.subject_id).state, 'cancelled');
  store.finishAttempt({ attemptId: acquired.attempt.id, dispatchId: child.id, status: 'completed' });
  assert.equal(store.getDispatch(child.id)?.status, 'cancelled', 'Stop 后的迟到 Attempt 不能改写 Dispatch');
  assert.deepEqual(auditShadowRun(handoff.runId), []);

  const recovery = admit('recovery');
  const attempt1 = store.claimNextDispatch(recovery.conversationId, 'owner');
  assert.equal(attempt1?.dispatch.id, recovery.dispatch.id);
  store.interruptExpiredAttempts();
  assert.equal(store.getDispatch(recovery.dispatch.id)?.status, 'queued');
  const attempt2 = store.claimNextDispatch(recovery.conversationId, 'owner');
  assert.equal(attempt2?.dispatch.id, recovery.dispatch.id);
  const agentSpan = trace.startSpan(recovery.runId, { spanKind: 'agent', name: 'agent:a', input: JSON.stringify({ dispatchId: recovery.dispatch.id }) });
  const toolSpan = trace.startSpan(recovery.runId, { parentId: agentSpan.id, spanKind: 'tool', name: 'tool:fs.write' });
  trace.endSpan(toolSpan, { status: 'ok', output: 'written' });
  store.interruptExpiredAttempts();
  assert.equal(store.getDispatch(recovery.dispatch.id)?.status, 'failed', '未知写副作用不能盲重放');
  assert.equal(db.get('SELECT state FROM runtime_custody WHERE subject_id=(SELECT subject_id FROM runtime_dispatch_subjects WHERE dispatch_id=?)', recovery.dispatch.id).state, 'failed');
  assert.deepEqual(auditShadowRun(recovery.runId), []);

  const fenced = admit('fenced');
  db.run('UPDATE runtime_dispatch_subjects SET expected_generation=99 WHERE dispatch_id=?', fenced.dispatch.id);
  assert.equal(store.claimNextDispatch(fenced.conversationId, 'owner'), null);
  assert.equal(store.getDispatch(fenced.dispatch.id)?.status, 'blocked', '冲突 Dispatch 应隔离，不能反复进入 claim');
  assert.match(store.getDispatch(fenced.dispatch.id)?.error ?? '', /交接代际已过期/);
  assert.equal(store.listAttempts(fenced.runId).length, 0, '接球失败须回滚 Attempt 创建');
  console.log('Runtime 原子接球、Stop 与恢复验证通过');
} finally {
  db.closeDatabase();
  await rm(root, { recursive: true, force: true });
}

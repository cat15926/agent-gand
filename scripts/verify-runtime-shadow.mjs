import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const temp = await mkdtemp(path.join(tmpdir(), 'agent-gand-runtime-shadow-'));
process.env.DB_PATH = path.join(temp, 'shadow.sqlite');
const { get, all, run, tx, closeDatabase } = await import('../apps/server/src/db/database.ts');
const { planCollaborationAdmission } = await import('../apps/server/src/runtime/subjectContract.ts');
const { observeAdmission, observeClaim, observeAction, observeAggregateLink, auditShadowRun, replayCustodyEvents } = await import('../apps/server/src/runtime/shadow.ts');

try {
  const plan = planCollaborationAdmission({ runId: 'r1', objective: '并行', participantIds: ['a', 'b', 'c'], targetAgentIds: ['a', 'b'] });
  observeAdmission(plan.contract, plan.subjects, ['d-a', 'd-b']);
  observeAdmission(plan.contract, plan.subjects, ['d-a', 'd-b']);
  assert.equal(all('SELECT id FROM runtime_subjects WHERE run_id=?', 'r1').length, 2);
  observeClaim('d-a', 'a1', 'a');
  observeAction({ dispatchId: 'd-a', attemptId: 'a1', agentId: 'a', action: { type: 'handoff', targetAgentId: 'c', message: '请继续', reason: '能力' }, childDispatchIds: ['d-c'], batchId: null });
  let custody = get(`SELECT c.* FROM runtime_custody c JOIN runtime_dispatch_subjects m ON m.subject_id=c.subject_id WHERE m.dispatch_id='d-a'`);
  assert.equal(custody.state, 'transferring');
  assert.equal(custody.holder_agent_id, 'a');
  assert.equal(custody.pending_holder_agent_id, 'c');
  observeClaim('d-c', 'c1', 'c');
  observeClaim('d-c', 'c1', 'c');
  custody = get(`SELECT c.* FROM runtime_custody c JOIN runtime_dispatch_subjects m ON m.subject_id=c.subject_id WHERE m.dispatch_id='d-a'`);
  assert.equal(custody.holder_agent_id, 'c');
  assert.equal(custody.pending_holder_agent_id, null);
  assert.equal(custody.generation, 3);
  assert.throws(() => observeClaim('d-c', 'stale-b', 'b'), /交接代际已过期/);
  const events = all('SELECT * FROM runtime_custody_events WHERE subject_id=? ORDER BY rowid', custody.subject_id);
  assert.deepEqual(replayCustodyEvents(events), {
    state: 'owned', holder_agent_id: 'c', pending_holder_agent_id: null, generation: 3, version: 3,
  });
  observeAction({ dispatchId: 'd-c', attemptId: 'c1', agentId: 'c', action: { type: 'implicit_complete' }, childDispatchIds: [], batchId: null });
  observeClaim('d-b', 'b1', 'b');
  observeAction({ dispatchId: 'd-b', attemptId: 'b1', agentId: 'b', action: { type: 'implicit_complete' }, childDispatchIds: [], batchId: null });
  assert.deepEqual(auditShadowRun('r1'), []);

  const rollback = planCollaborationAdmission({ runId: 'r3', objective: '回滚', participantIds: ['a', 'b'], targetAgentIds: ['a'] });
  assert.throws(() => tx(() => {
    observeAdmission(rollback.contract, rollback.subjects, ['d-rollback']);
    throw new Error('模拟入场提交前崩溃');
  }), /模拟入场提交前崩溃/);
  assert.equal(all('SELECT id FROM runtime_subjects WHERE run_id=?', 'r3').length, 0);
  assert.equal(all('SELECT run_id FROM runtime_contracts WHERE run_id=?', 'r3').length, 0);
  observeAdmission(rollback.contract, rollback.subjects, ['d-rollback']);
  observeClaim('d-rollback', 'a-rollback', 'a');
  assert.throws(() => tx(() => {
    observeAction({ dispatchId: 'd-rollback', attemptId: 'a-rollback', agentId: 'a',
      action: { type: 'handoff', targetAgentId: 'b', message: '继续', reason: '能力' }, childDispatchIds: ['d-rollback-b'], batchId: null });
    throw new Error('模拟交接提交前崩溃');
  }), /模拟交接提交前崩溃/);
  assert.equal(get('SELECT dispatch_id FROM runtime_dispatch_subjects WHERE dispatch_id=?', 'd-rollback-b'), undefined);
  assert.equal(get('SELECT state FROM runtime_custody WHERE subject_id=(SELECT subject_id FROM runtime_dispatch_subjects WHERE dispatch_id=?)', 'd-rollback').state, 'owned');

  const consult = planCollaborationAdmission({ runId: 'r2', objective: '征询', participantIds: ['a', 'b', 'c'], targetAgentIds: ['a'] });
  observeAdmission(consult.contract, consult.subjects, ['d-root']);
  observeClaim('d-root', 'root-a1', 'a');
  observeAction({ dispatchId: 'd-root', attemptId: 'root-a1', agentId: 'a', action: { type: 'ask_many', targetAgentIds: ['b', 'c'], question: '意见？', reason: '征询' }, childDispatchIds: ['d-b2', 'd-c2'], batchId: 'batch-1' });
  assert.equal(get(`SELECT holder_agent_id FROM runtime_custody c JOIN runtime_dispatch_subjects m ON m.subject_id=c.subject_id WHERE m.dispatch_id='d-root'`).holder_agent_id, 'a');
  assert.equal(all('SELECT id FROM runtime_subjects WHERE run_id=?', 'r2').length, 3);
  observeAggregateLink('d-root', 'd-aggregate');
  observeClaim('d-aggregate', 'agg-a1', 'a');
  assert.deepEqual(auditShadowRun('r2'), []);
  run("UPDATE runtime_custody SET state='failed' WHERE subject_id=?", custody.subject_id);
  assert.ok(auditShadowRun('r1').some((issue) => issue.includes('projection_mismatch')));
  run("UPDATE runtime_custody SET state='completed' WHERE subject_id=?", custody.subject_id);
  assert.deepEqual(auditShadowRun('r1'), []);
  console.log('Runtime Custody Shadow 验证通过');
} finally {
  closeDatabase();
  await rm(temp, { recursive: true, force: true });
}

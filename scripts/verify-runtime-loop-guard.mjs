import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-loop-guard-'));
process.env.DB_PATH = path.join(root, 'test.sqlite');
process.env.COLLAB_RUNTIME_ATOMIC = 'true';

const db = await import('../apps/server/src/db/database.ts');
const store = await import('../apps/server/src/collaboration/store.ts');
const inbox = await import('../apps/server/src/messaging/inbox.ts');
const { executeToolOnce } = await import('../apps/server/src/tools/executions.ts');
const { planCollaborationAdmission } = await import('../apps/server/src/runtime/subjectContract.ts');
const { observeAdmission } = await import('../apps/server/src/runtime/shadow.ts');
const { listRouteGuardEvents, persistRouteGuardEvent, recordEvidenceAwareRoute } = await import('../apps/server/src/runtime/loopGuard.ts');

const runId = `loop-${randomUUID()}`; const conversationId = `room-${runId}`; const now = new Date().toISOString();
try {
  db.run('INSERT INTO conversations (id,title,mode,agent_ids,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    conversationId, 'loop', 'collaboration', '["a","b"]', now, now);
  db.run('INSERT INTO runs (id,goal,mode,conversation_id,turn_no,status,agent_ids,created_at) VALUES (?,?,?,?,?,?,?,?)',
    runId, '完成同一个修复目标', 'collaboration', conversationId, 1, 'running', '["a","b"]', now);
  const message = inbox.post({ runId, from: 'user', to: 'a', kind: 'user', body: '请修复' });
  const plan = planCollaborationAdmission({ runId, objective: '完成同一个修复目标', participantIds: ['a', 'b'], targetAgentIds: ['a'],
    controlActionVersion: 2, evidenceBundleVersion: 1, evidenceLoopGuardVersion: 1 });
  const dispatch = store.createDispatch({ runId, conversationId, sourceMessageId: message.id,
    kind: 'initial', from: 'user', targetAgentId: 'a', depth: 0, idempotencyKey: 'initial' });
  observeAdmission(plan.contract, plan.subjects, [dispatch.id]);
  const claim = store.claimNextDispatch(conversationId, 'owner');
  const subjectId = db.get('SELECT subject_id FROM runtime_dispatch_subjects WHERE dispatch_id=?', dispatch.id).subject_id;
  const route = (index, fromAgentId, targetAgentId, objective = '完成同一个修复目标') => recordEvidenceAwareRoute({
    runId, subjectId, sourceDispatchId: `dispatch-${index}`, fromAgentId, targetAgentId,
    objective, warnAt: 2, blockAt: 3,
  });

  assert.deepEqual([route(1, 'a', 'b').outcome, route(2, 'b', 'a').outcome, route(3, 'a', 'b').outcome],
    ['allowed', 'warned', 'blocked']);
  assert.deepEqual(listRouteGuardEvents(runId).map((item) => item.repeatedCount), [1, 2, 3]);

  await executeToolOnce({ runId, agentId: 'a', attemptId: claim.attempt.id, toolName: 'fs.read', input: '{}',
    idempotencyKey: `loop-tool:${runId}`, replayPolicy: 'safe', spanId: 'loop-tool-span', execute: async () => '新的可验证证据' });
  const withNewEvidence = route(4, 'b', 'a');
  assert.equal(withNewEvidence.outcome, 'allowed');
  assert.equal(withNewEvidence.repeatedCount, 1, '有实质新证据时必须重置往返计数');
  assert.notEqual(withNewEvidence.evidenceFingerprint, listRouteGuardEvents(runId)[2].evidenceFingerprint);
  assert.equal(route(5, 'a', 'b').outcome, 'warned');
  assert.equal(route(6, 'b', 'a', '另一个责任目标').repeatedCount, 1,
    '目标变化不得与上一条责任链混计');

  const rollbackObjective = '验证阻断事务回滚';
  route(7, 'a', 'b', rollbackObjective);
  route(8, 'b', 'a', rollbackObjective);
  let rolledBackBlock;
  assert.throws(() => db.tx(() => {
    rolledBackBlock = route(9, 'a', 'b', rollbackObjective);
    assert.equal(rolledBackBlock.outcome, 'blocked');
    throw new Error('route transaction rollback');
  }), /route transaction rollback/u);
  assert.equal(listRouteGuardEvents(runId).some((item) => item.id === rolledBackBlock.id), false);
  db.tx(() => {
    persistRouteGuardEvent(rolledBackBlock);
    inbox.post({ runId, from: 'a', to: 'all', kind: 'agent', messageType: 'informational',
      body: '阻断前 Agent 已生成的输出', clientMessageId: 'guard-preserved-output' });
  });
  assert.equal(listRouteGuardEvents(runId).some((item) => item.id === rolledBackBlock.id), true,
    '阻断记录必须在路由事务回滚后重新落盘');
  assert.ok(inbox.listByRun(runId).some((item) => item.body === '阻断前 Agent 已生成的输出'),
    '阻断不得吞掉 Agent 输出');

  console.log('证据感知防循环的警告、阻断、新证据重置与目标隔离验证通过');
} finally {
  db.closeDatabase();
  await rm(root, { recursive: true, force: true });
}

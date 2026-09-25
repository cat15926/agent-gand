import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-obligations-'));
process.env.DB_PATH = path.join(root, 'test.sqlite');
process.env.COLLAB_RUNTIME_ATOMIC = 'true';

const db = await import('../apps/server/src/db/database.ts');
const store = await import('../apps/server/src/collaboration/store.ts');
const inbox = await import('../apps/server/src/messaging/inbox.ts');
const { planCollaborationAdmission } = await import('../apps/server/src/runtime/subjectContract.ts');
const { observeAction, observeAdmission } = await import('../apps/server/src/runtime/shadow.ts');
const {
  countUnsatisfiedRequiredObligations,
  listSuccessorObligations,
  openSuccessorObligation,
  requiredSuccessorObligationsSatisfied,
  settleSuccessorObligation,
} = await import('../apps/server/src/runtime/obligations.ts');

function fixture(name) {
  const now = new Date().toISOString(); const runId = `run-${name}`; const conversationId = `room-${name}`;
  db.run('INSERT INTO conversations (id,title,mode,agent_ids,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    conversationId, name, 'collaboration', '["a","b","c"]', now, now);
  db.run('INSERT INTO runs (id,goal,mode,conversation_id,turn_no,status,agent_ids,created_at) VALUES (?,?,?,?,?,?,?,?)',
    runId, name, 'collaboration', conversationId, 1, 'running', '["a","b","c"]', now);
  const message = inbox.post({ runId, from: 'user', to: 'a', kind: 'user', body: name });
  const plan = planCollaborationAdmission({ runId, objective: name, participantIds: ['a', 'b', 'c'], targetAgentIds: ['a'],
    controlActionVersion: 2, successorObligationVersion: 1 });
  const dispatch = db.tx(() => {
    const created = store.createDispatch({ runId, conversationId, sourceMessageId: message.id,
      kind: 'initial', from: 'user', targetAgentId: 'a', depth: 0, idempotencyKey: `initial:${name}` });
    observeAdmission(plan.contract, plan.subjects, [created.id]);
    return created;
  });
  const subjectId = db.get('SELECT subject_id FROM runtime_dispatch_subjects WHERE dispatch_id=?', dispatch.id).subject_id;
  return { runId, conversationId, message, dispatch, subjectId };
}

try {
  const handoff = fixture('handoff');
  const sourceClaim = store.claimNextDispatch(handoff.conversationId, 'owner');
  const handoffMessage = inbox.post({ runId: handoff.runId, from: 'a', to: 'b', kind: 'agent', body: '请接手' });
  const child = store.createDispatch({ runId: handoff.runId, conversationId: handoff.conversationId,
    sourceMessageId: handoffMessage.id, parentDispatchId: handoff.dispatch.id, kind: 'handoff', from: 'a',
    targetAgentId: 'b', depth: 1, idempotencyKey: 'handoff-child' });
  db.tx(() => {
    observeAction({ dispatchId: handoff.dispatch.id, attemptId: sourceClaim.attempt.id, agentId: 'a',
      action: { version: 2, type: 'handoff', targetAgentId: 'b', objective: '请接手', reason: '能力匹配' },
      childDispatchIds: [child.id], batchId: null });
    store.finishAttempt({ attemptId: sourceClaim.attempt.id, dispatchId: sourceClaim.dispatch.id, status: 'completed',
      output: '已交接', action: { version: 2, type: 'handoff', targetAgentId: 'b', objective: '请接手', reason: '能力匹配' } });
  });
  let obligations = listSuccessorObligations(handoff.runId);
  assert.equal(obligations[0]?.kind, 'handoff_acquire');
  assert.equal(obligations[0]?.status, 'open');
  const targetClaim = store.claimNextDispatch(handoff.conversationId, 'owner');
  assert.equal(targetClaim.dispatch.id, child.id);
  assert.equal(listSuccessorObligations(handoff.runId)[0]?.status, 'satisfied', '目标成功 claim 后才满足接球义务');

  const consult = fixture('consult');
  const consultClaim = store.claimNextDispatch(consult.conversationId, 'owner');
  const question = inbox.post({ runId: consult.runId, from: 'a', to: 'b', kind: 'agent', body: '请调研' });
  const fanout = store.createDispatch({ runId: consult.runId, conversationId: consult.conversationId,
    sourceMessageId: question.id, parentDispatchId: consult.dispatch.id, batchId: 'batch-1', kind: 'fanout',
    from: 'a', targetAgentId: 'b', depth: 1, idempotencyKey: 'consult-child' });
  db.tx(() => {
    observeAction({ dispatchId: consult.dispatch.id, attemptId: consultClaim.attempt.id, agentId: 'a',
      action: { version: 2, type: 'consult', targetAgentIds: ['b'], objective: '请调研', reason: '需要并行意见', join: 'all' },
      childDispatchIds: [fanout.id], batchId: 'batch-1' });
    store.finishAttempt({ attemptId: consultClaim.attempt.id, dispatchId: consultClaim.dispatch.id, status: 'completed',
      output: '等待咨询', action: { version: 2, type: 'consult', targetAgentIds: ['b'], objective: '请调研', reason: '需要并行意见', join: 'all' } });
  });
  assert.equal(countUnsatisfiedRequiredObligations(consult.subjectId), 1);
  const fanoutClaim = store.claimNextDispatch(consult.conversationId, 'owner');
  db.tx(() => {
    observeAction({ dispatchId: fanout.id, attemptId: fanoutClaim.attempt.id, agentId: 'b',
      action: { version: 2, type: 'answer_candidate' }, childDispatchIds: [], batchId: 'batch-1' });
    store.finishAttempt({ attemptId: fanoutClaim.attempt.id, dispatchId: fanout.id, status: 'completed',
      output: '调研结果', action: { version: 2, type: 'answer_candidate' } });
  });
  assert.equal(listSuccessorObligations(consult.runId)[0]?.status, 'satisfied');
  assert.equal(countUnsatisfiedRequiredObligations(consult.subjectId), 0);

  const consultAny = fixture('consult-any');
  const consultAnyClaim = store.claimNextDispatch(consultAny.conversationId, 'owner');
  const anyQuestion = inbox.post({ runId: consultAny.runId, from: 'a', to: 'b', kind: 'agent', body: '请任选一人调研' });
  const anyChildren = ['b', 'c'].map((target) => store.createDispatch({ runId: consultAny.runId,
    conversationId: consultAny.conversationId, sourceMessageId: anyQuestion.id,
    parentDispatchId: consultAny.dispatch.id, batchId: 'batch-any', kind: 'fanout', from: 'a', targetAgentId: target,
    depth: 1, idempotencyKey: `consult-any-${target}` }));
  db.tx(() => {
    observeAction({ dispatchId: consultAny.dispatch.id, attemptId: consultAnyClaim.attempt.id, agentId: 'a',
      action: { version: 2, type: 'consult', targetAgentIds: ['b', 'c'], objective: '请调研', reason: '任一结果即可', join: 'any' },
      childDispatchIds: anyChildren.map((item) => item.id), batchId: 'batch-any' });
    store.finishAttempt({ attemptId: consultAnyClaim.attempt.id, dispatchId: consultAnyClaim.dispatch.id,
      status: 'completed', output: '等待首个结果',
      action: { version: 2, type: 'consult', targetAgentIds: ['b', 'c'], objective: '请调研', reason: '任一结果即可', join: 'any' } });
  });
  assert.equal(countUnsatisfiedRequiredObligations(consultAny.subjectId), 1,
    'join=any 应以单个必需汇合义务等待首个结果');
  const anyClaim = store.claimNextDispatch(consultAny.conversationId, 'owner');
  db.tx(() => {
    observeAction({ dispatchId: anyClaim.dispatch.id, attemptId: anyClaim.attempt.id, agentId: anyClaim.attempt.agentId,
      action: { version: 2, type: 'answer_candidate' }, childDispatchIds: [], batchId: 'batch-any' });
    store.finishAttempt({ attemptId: anyClaim.attempt.id, dispatchId: anyClaim.dispatch.id,
      status: 'completed', output: '首个调研结果', action: { version: 2, type: 'answer_candidate' } });
  });
  assert.equal(countUnsatisfiedRequiredObligations(consultAny.subjectId), 0,
    'join=any 的任意子 Subject 完成后应关闭汇合义务');
  const anyObligations = listSuccessorObligations(consultAny.runId);
  assert.equal(anyObligations.filter((item) => item.required).length, 1);
  assert.equal(anyObligations.find((item) => item.required)?.status, 'satisfied');

  const decision = fixture('decision');
  const createdDecision = store.createDecision({ runId: decision.runId, conversationId: decision.conversationId,
    dispatchId: decision.dispatch.id, idempotencyKey: 'decision-1', kind: 'agent_question',
    promptMessageId: decision.message.id, payload: { question: '请选择' } });
  assert.equal(listSuccessorObligations(decision.runId)[0]?.kind, 'user_decision');
  assert.equal(requiredSuccessorObligationsSatisfied(decision.runId), false);
  store.resolveDecision(createdDecision.id, 'accepted', { answer: '继续' });
  assert.equal(listSuccessorObligations(decision.runId)[0]?.status, 'satisfied');

  const revision = fixture('review-generation');
  const first = openSuccessorObligation({ runId: revision.runId, parentSubjectId: revision.subjectId,
    targetSubjectId: revision.subjectId, kind: 'review_revision', sourceActionId: 'review-fail-1',
    stableKey: 'review:stable', advance: true, payload: { round: 1 } });
  const replay = openSuccessorObligation({ runId: revision.runId, parentSubjectId: revision.subjectId,
    targetSubjectId: revision.subjectId, kind: 'review_revision', sourceActionId: 'review-fail-1',
    stableKey: 'review:stable', advance: true, payload: { round: 1 } });
  assert.equal(replay.id, first.id, '同一 Review FAIL 重放必须幂等');
  const second = openSuccessorObligation({ runId: revision.runId, parentSubjectId: revision.subjectId,
    targetSubjectId: revision.subjectId, kind: 'review_revision', sourceActionId: 'review-fail-2',
    stableKey: 'review:stable', advance: true, payload: { round: 2 } });
  obligations = listSuccessorObligations(revision.runId);
  assert.deepEqual(obligations.map((item) => [item.generation, item.status]), [[1, 'cancelled'], [2, 'open']]);
  assert.equal(settleSuccessorObligation({ id: second.id, expectedGeneration: first.generation,
    status: 'satisfied', resolutionSourceId: 'stale-pass' }).changed, false, '旧 generation PASS 不得关闭新义务');
  assert.equal(settleSuccessorObligation({ id: second.id, expectedGeneration: second.generation,
    status: 'satisfied', resolutionSourceId: 'current-pass' }).changed, true);

  const rollback = fixture('rollback');
  assert.throws(() => db.tx(() => {
    openSuccessorObligation({ runId: rollback.runId, parentSubjectId: rollback.subjectId,
      kind: 'artifact_commit', sourceActionId: 'artifact', stableKey: 'artifact:path', payload: { path: 'x' } });
    throw new Error('fault injection');
  }), /fault injection/u);
  assert.equal(listSuccessorObligations(rollback.runId).length, 0);

  console.log('Successor Obligation 类型、接球、咨询、用户决策、代际与回滚验证通过');
} finally {
  db.closeDatabase();
  await rm(root, { recursive: true, force: true });
}

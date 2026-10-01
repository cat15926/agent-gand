import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-consult-any-'));
process.env.DB_PATH = path.join(root, 'test.sqlite');
process.env.COLLAB_RUNTIME_MODE = 'execute';

const db = await import('../apps/server/src/db/database.ts');
const store = await import('../apps/server/src/collaboration/store.ts');
const inbox = await import('../apps/server/src/messaging/inbox.ts');
const { planCollaborationAdmission } = await import('../apps/server/src/runtime/subjectContract.ts');
const { observeAction, observeAdmission, observeTechnicalBlock } = await import('../apps/server/src/runtime/shadow.ts');
const { listSuccessorObligations, settleConsultAnyJoin } = await import('../apps/server/src/runtime/obligations.ts');
const { submitCompletionCandidate } = await import('../apps/server/src/runtime/subjectCompletion.ts');
const { evaluateCompletion } = await import('../apps/server/src/runtime/completion.ts');
const { collaborationControlTools, parseControlCall } = await import('../apps/server/src/collaboration/controlTools.ts');
const { runtimeConsultAnyVersion } = await import('../apps/server/src/runtime/controlAction.ts');
const { reconcileCollaborationBatches } = await import('../apps/server/src/collaboration/scheduler.ts');

function fixture(name) {
  const now = new Date().toISOString();
  const runId = `run-${name}`; const conversationId = `room-${name}`;
  db.run('INSERT INTO conversations (id,title,mode,agent_ids,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    conversationId, name, 'collaboration', '["a","b","c"]', now, now);
  db.run('INSERT INTO runs (id,goal,mode,conversation_id,turn_no,status,agent_ids,created_at) VALUES (?,?,?,?,?,?,?,?)',
    runId, name, 'collaboration', conversationId, 1, 'running', '["a","b","c"]', now);
  const source = inbox.post({ runId, from: 'user', to: 'a', kind: 'user', body: name });
  const plan = planCollaborationAdmission({ runId, objective: name, participantIds: ['a', 'b', 'c'], targetAgentIds: ['a'],
    completionEngine: true, controlActionVersion: 2,
    exitGuard: { version: 1, maxCorrections: 1, correctionMaxTokens: 512 },
    completionCandidateVersion: 1, successorObligationVersion: 1, evidenceBundleVersion: 1,
    contextContributorVersion: 1, durableHoldVersion: 2, externalWaitVersion: 1, consultAnyVersion: 1 });
  const parent = db.tx(() => {
    const dispatch = store.createDispatch({ runId, conversationId, sourceMessageId: source.id,
      kind: 'initial', from: 'user', targetAgentId: 'a', depth: 0, idempotencyKey: `initial:${name}` });
    observeAdmission(plan.contract, plan.subjects, [dispatch.id]);
    return dispatch;
  });
  const parentClaim = store.claimNextDispatch(conversationId, 'owner-parent');
  const question = inbox.post({ runId, from: 'a', to: 'b,c', kind: 'agent', body: '请给出首个可用结果' });
  const batch = store.createBatch({ runId, conversationId, initiatorAgentId: 'a', sourceDispatchId: parent.id,
    question: question.body, targetAgentIds: ['b', 'c'], joinPolicy: 'any' });
  const children = ['b', 'c'].map((target) => store.createDispatch({ runId, conversationId,
    sourceMessageId: question.id, parentDispatchId: parent.id, batchId: batch.id, kind: 'fanout', from: 'a',
    targetAgentId: target, depth: 1, idempotencyKey: `fanout:${batch.id}:${target}` }));
  db.tx(() => {
    observeAction({ dispatchId: parent.id, attemptId: parentClaim.attempt.id, agentId: 'a',
      action: { version: 2, type: 'consult', targetAgentIds: ['b', 'c'], objective: question.body,
        reason: '首个成功即可', join: 'any' }, childDispatchIds: children.map((item) => item.id), batchId: batch.id });
    store.finishAttempt({ attemptId: parentClaim.attempt.id, dispatchId: parent.id, status: 'completed',
      output: '等待首个成功结果', action: { version: 2, type: 'consult', targetAgentIds: ['b', 'c'],
        objective: question.body, reason: '首个成功即可', join: 'any' } });
  });
  return { runId, conversationId, batch, children };
}

function acceptedCandidate(runId, claim, output) {
  return submitCompletionCandidate({ runId, dispatchId: claim.dispatch.id, attemptId: claim.attempt.id,
    agentId: claim.attempt.agentId, action: { version: 2, type: 'answer_candidate' }, summary: output,
    evidenceRefs: [{ kind: 'attempt_output', id: claim.attempt.id }],
    exitGuard: { status: 'allow_candidate', reasons: ['CONSULTATION_ANSWER'] } });
}

try {
  const historicalSchema = JSON.stringify(collaborationControlTools(2));
  assert.doesNotMatch(historicalSchema, /"join"/u, '历史 Run 的工具 schema 不得被扩宽');
  const anySchema = JSON.stringify(collaborationControlTools(2, { consultAnyVersion: 1 }));
  assert.match(anySchema, /"join"/u);
  assert.deepEqual(parseControlCall({ name: 'agent.consult', input: JSON.stringify({
    targets: ['b', 'c'], objective: '任选首个成功结果', reason: '降低延迟', join: 'any',
  }) }, ['a', 'b', 'c'], 'a', 2, { consultAnyVersion: 1 }), {
    version: 2, type: 'consult', targetAgentIds: ['b', 'c'], objective: '任选首个成功结果', reason: '降低延迟', join: 'any',
  });
  assert.throws(() => parseControlCall({ name: 'agent.consult', input: JSON.stringify({
    targets: ['b'], objective: '尝试绕过', reason: 'test', join: 'any',
  }) }, ['a', 'b'], 'a', 2), /未启用 consult join=any/u);

  const race = fixture('race');
  assert.equal(runtimeConsultAnyVersion(race.runId), 1);
  assert.deepEqual([race.batch.joinPolicy, race.batch.winnerDispatchId, race.batch.generation, race.batch.settledAt],
    ['any', null, 1, null]);
  const first = store.claimNextDispatch(race.conversationId, 'owner-b');
  const second = store.claimNextDispatch(race.conversationId, 'owner-c');
  assert.ok(first && second);
  const winner = db.tx(() => {
    const candidate = acceptedCandidate(race.runId, first, '首个通过验收的结果');
    assert.equal(candidate.evaluation.status, 'accepted');
    const selected = store.selectAnyBatchWinner({ batchId: race.batch.id, dispatchId: first.dispatch.id,
      expectedGeneration: race.batch.generation, candidateId: candidate.candidate.id });
    store.finishAttempt({ attemptId: first.attempt.id, dispatchId: first.dispatch.id, status: 'completed',
      output: '首个通过验收的结果', action: { version: 2, type: 'answer_candidate' } });
    return { candidate, selected };
  });
  assert.equal(winner.selected.selected, true);
  const settled = store.getBatch(race.batch.id);
  assert.equal(settled.winnerDispatchId, first.dispatch.id);
  assert.ok(settled.settledAt);
  assert.equal(store.getDispatch(second.dispatch.id).status, 'cancelled');
  assert.match(store.getDispatch(second.dispatch.id).error, /^CONSULT_ANY_NOT_SELECTED:/u);
  assert.equal(store.listAttempts(race.runId).find((item) => item.id === second.attempt.id).status, 'cancelled');
  assert.equal(store.isActiveAttempt(second.attempt.id, second.dispatch.id), false, '迟到 loser 必须失去提交权');
  const late = acceptedCandidate(race.runId, second, '迟到结果');
  assert.notEqual(late.evaluation.status, 'accepted');
  assert.throws(() => store.selectAnyBatchWinner({ batchId: race.batch.id, dispatchId: second.dispatch.id,
    expectedGeneration: race.batch.generation, candidateId: late.candidate.id }), /必须引用.*已通过/u);
  assert.equal(store.getBatch(race.batch.id).winnerDispatchId, first.dispatch.id, '迟到结果不能改变 winner');
  const raceObligations = listSuccessorObligations(race.runId).filter((item) => item.kind === 'consult_result');
  assert.equal(raceObligations.find((item) => item.required)?.status, 'satisfied');
  assert.equal(raceObligations.find((item) => item.targetSubjectId === winner.candidate.candidate.subjectId)?.status, 'satisfied');
  assert.ok(raceObligations.some((item) => !item.required && item.status === 'cancelled'));
  reconcileCollaborationBatches(race.runId);
  reconcileCollaborationBatches(race.runId);
  assert.equal(store.listDispatches(race.runId).filter((item) => item.kind === 'aggregate').length, 1,
    '恢复重放只能创建一个 aggregate');
  assert.equal(store.getBatch(race.batch.id).status, 'completed');
  assert.ok(store.getBatch(race.batch.id).resultDispatchId);
  assert.equal(evaluateCompletion({ contract: { version: 1, runId: 'x', objective: 'x', participantIds: [],
    requiredSubjectKeys: [], completionPolicy: 'all_required', partialFailurePolicy: 'needs_attention' }, subjects: [],
  dispatches: [{ id: 'winner', status: 'completed', error: null },
    { id: 'loser', status: 'cancelled', error: `CONSULT_ANY_NOT_SELECTED:${first.dispatch.id}` }],
  pendingDecisions: 0, batchStatuses: ['completed'], hasAnyOutput: true, dependenciesSatisfied: true,
  requiredArtifactsSatisfied: true, reviewAccepted: true, protocolTerminal: true,
  successorObligationsSatisfied: true }).status, 'accepted', '未胜出取消不能污染 Run 终局');

  const rollback = fixture('rollback');
  const rollbackClaim = store.claimNextDispatch(rollback.conversationId, 'owner-b');
  assert.throws(() => db.tx(() => {
    const candidate = acceptedCandidate(rollback.runId, rollbackClaim, '事务后不应存在');
    store.selectAnyBatchWinner({ batchId: rollback.batch.id, dispatchId: rollbackClaim.dispatch.id,
      expectedGeneration: rollback.batch.generation, candidateId: candidate.candidate.id });
    throw new Error('crash injection');
  }), /crash injection/u);
  assert.equal(store.getBatch(rollback.batch.id).winnerDispatchId, null);
  assert.ok(rollback.children.every((item) => ['queued', 'running'].includes(store.getDispatch(item.id).status)));
  assert.equal(db.get('SELECT COUNT(*) n FROM runtime_completion_candidates WHERE run_id=?', rollback.runId).n, 0);

  const timeout = fixture('timeout');
  const timeoutClaim = store.claimNextDispatch(timeout.conversationId, 'owner-b');
  assert.ok(timeoutClaim);
  const expired = store.expireBatch(timeout.batch.id);
  assert.equal(expired.status, 'timeout');
  assert.ok(expired.settledAt);
  assert.ok(timeout.children.every((item) => store.getDispatch(item.id).status === 'cancelled'));
  assert.equal(listSuccessorObligations(timeout.runId).find((item) => item.required)?.status, 'failed');

  const stopped = fixture('stop');
  store.cancelCollaborationRun(stopped.runId);
  assert.equal(store.getBatch(stopped.batch.id).status, 'cancelled');
  assert.ok(store.getBatch(stopped.batch.id).settledAt);
  assert.ok(listSuccessorObligations(stopped.runId).every((item) => item.status === 'cancelled'));

  const exhausted = fixture('exhausted');
  const exhaustedClaims = [store.claimNextDispatch(exhausted.conversationId, 'owner-b'),
    store.claimNextDispatch(exhausted.conversationId, 'owner-c')];
  db.tx(() => {
    for (const claim of exhaustedClaims) {
      store.finishAttempt({ attemptId: claim.attempt.id, dispatchId: claim.dispatch.id,
        status: 'failed', error: '候选未通过' });
      observeTechnicalBlock(claim.dispatch.id, claim.attempt.id, claim.attempt.agentId);
    }
    settleConsultAnyJoin({ runId: exhausted.runId, batchId: exhausted.batch.id, status: 'failed',
      resolutionSourceId: 'all-failed', resolution: { reason: 'all_candidates_failed' } });
    store.updateBatch(exhausted.batch.id, 'failed');
  });
  assert.equal(store.getBatch(exhausted.batch.id).status, 'failed');
  assert.equal(listSuccessorObligations(exhausted.runId).find((item) => item.required)?.status, 'failed');

  console.log('consult(any) schema、winner CAS、loser 取消、迟到隔离、回滚恢复、超时、Stop 与全失败验证通过');
} finally {
  db.closeDatabase();
  await rm(root, { recursive: true, force: true });
}

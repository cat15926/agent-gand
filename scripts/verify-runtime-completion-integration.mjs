import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-completion-integration-'));
process.env.DB_PATH = path.join(root, 'test.sqlite');
process.env.COLLAB_COMPLETION_ENGINE = 'true';
const db = await import('../apps/server/src/db/database.ts');
const store = await import('../apps/server/src/collaboration/store.ts');
const inbox = await import('../apps/server/src/messaging/inbox.ts');
const trace = await import('../apps/server/src/runs/trace.ts');
const { planCollaborationAdmission } = await import('../apps/server/src/runtime/subjectContract.ts');
const { observeAction, observeAdmission, observeTechnicalBlock } = await import('../apps/server/src/runtime/shadow.ts');
const { finalizeCollaborationRun } = await import('../apps/server/src/collaboration/scheduler.ts');
const { listCompletionEvaluations, loadCompletionSnapshot } = await import('../apps/server/src/runtime/completionStore.ts');
const { listCompletionCandidates, submitCompletionCandidate } = await import('../apps/server/src/runtime/subjectCompletion.ts');

function fixture(name, targets, completionEngine = true, completionCandidateVersion) {
  const now = new Date().toISOString(); const runId = `run-${name}`; const conversationId = `room-${name}`;
  db.run('INSERT INTO conversations (id,title,mode,agent_ids,created_at,updated_at) VALUES (?,?,?,?,?,?)', conversationId, name, 'collaboration', '["a","b"]', now, now);
  db.run('INSERT INTO runs (id,goal,mode,conversation_id,turn_no,status,agent_ids,created_at) VALUES (?,?,?,?,?,?,?,?)', runId, name, 'collaboration', conversationId, 1, 'running', '["a","b"]', now);
  const source = inbox.post({ runId, from: 'user', to: targets.join(','), kind: 'user', body: name });
  const plan = planCollaborationAdmission({ runId, objective: name, participantIds: ['a', 'b'], targetAgentIds: targets,
    completionEngine, controlActionVersion: completionCandidateVersion ? 2 : undefined, completionCandidateVersion });
  const dispatches = db.tx(() => {
    const created = targets.map((target) => store.createDispatch({ runId, conversationId, sourceMessageId: source.id,
      kind: 'initial', from: 'user', targetAgentId: target, depth: 0, idempotencyKey: `initial:${target}` }));
    observeAdmission(plan.contract, plan.subjects, created.map((item) => item.id));
    return created;
  });
  return { runId, conversationId, dispatches };
}

function complete(claimed, output) {
  db.tx(() => {
    observeAction({ dispatchId: claimed.dispatch.id, attemptId: claimed.attempt.id, agentId: claimed.attempt.agentId,
      action: { type: 'implicit_complete' }, childDispatchIds: [], batchId: null });
    store.finishAttempt({ attemptId: claimed.attempt.id, dispatchId: claimed.dispatch.id, status: 'completed',
      output, action: { type: 'implicit_complete' } });
  });
}

try {
  const multi = fixture('multi', ['a', 'b']);
  assert.ok(loadCompletionSnapshot(multi.runId).input.subjects.every((item) => item.evidenceValid === false),
    '没有最终 Attempt output 时，空 Evidence 集合不得判真');
  const first = store.claimNextDispatch(multi.conversationId, 'owner');
  const second = store.claimNextDispatch(multi.conversationId, 'owner');
  complete(first, 'A 的结果');
  const partialSnapshot = loadCompletionSnapshot(multi.runId);
  assert.equal(partialSnapshot.input.subjects.find((item) => item.key === 'root:a').evidenceValid, true);
  assert.equal(partialSnapshot.input.subjects.find((item) => item.key === 'root:b').evidenceValid, false);
  finalizeCollaborationRun(multi.runId);
  assert.equal(trace.getRun(multi.runId).status, 'running');
  assert.equal(inbox.listByRun(multi.runId).filter((item) => item.messageType === 'collaboration_result').length, 0);
  complete(second, 'B 的结果');
  finalizeCollaborationRun(multi.runId);
  finalizeCollaborationRun(multi.runId);
  assert.equal(trace.getRun(multi.runId).status, 'completed');
  const results = inbox.listByRun(multi.runId).filter((item) => item.messageType === 'collaboration_result');
  assert.equal(results.length, 1);
  assert.match(results[0].body, /A 的结果/u); assert.match(results[0].body, /B 的结果/u);
  assert.deepEqual(listCompletionEvaluations(multi.runId).map((item) => item.status), ['waiting', 'accepted']);

  const failed = fixture('failed', ['a', 'b']);
  const ok = store.claimNextDispatch(failed.conversationId, 'owner');
  const bad = store.claimNextDispatch(failed.conversationId, 'owner');
  complete(ok, '局部结果');
  db.tx(() => {
    store.finishAttempt({ attemptId: bad.attempt.id, dispatchId: bad.dispatch.id, status: 'failed', dispatchStatus: 'blocked', error: 'AGENT_TURN_TRUNCATED' });
    observeTechnicalBlock(bad.dispatch.id, bad.attempt.id, bad.attempt.agentId);
  });
  finalizeCollaborationRun(failed.runId);
  assert.equal(trace.getRun(failed.runId).status, 'failed');
  assert.equal(inbox.listByRun(failed.runId).filter((item) => item.messageType === 'collaboration_result').length, 0);
  assert.ok(listCompletionEvaluations(failed.runId).at(-1).reasons.includes('FAILED_DISPATCH'));
  assert.match(inbox.listByRun(failed.runId).at(-1).body, /Completion Engine 拒绝完成/u);

  const candidateOwned = fixture('candidate-owned', ['a'], true, 1);
  const candidateClaim = store.claimNextDispatch(candidateOwned.conversationId, 'owner');
  db.tx(() => {
    const submitted = submitCompletionCandidate({ runId: candidateOwned.runId, dispatchId: candidateClaim.dispatch.id,
      attemptId: candidateClaim.attempt.id, agentId: 'a', action: { version: 2, type: 'complete', summary: '候选结果' },
      summary: '候选结果', evidenceRefs: [{ kind: 'attempt_output', id: candidateClaim.attempt.id }],
      exitGuard: { status: 'allow_candidate', reasons: ['EXPLICIT_COMPLETE'] } });
    assert.equal(submitted.evaluation.status, 'accepted');
    store.finishAttempt({ attemptId: candidateClaim.attempt.id, dispatchId: candidateClaim.dispatch.id, status: 'completed',
      output: '候选结果', action: { version: 2, type: 'complete', summary: '候选结果' } });
  });
  const candidateSnapshot = loadCompletionSnapshot(candidateOwned.runId);
  assert.equal(candidateSnapshot.reportParts[0]?.output, '候选结果');
  assert.equal(candidateSnapshot.input.subjects[0]?.evidenceValid, true);
  finalizeCollaborationRun(candidateOwned.runId);
  assert.equal(trace.getRun(candidateOwned.runId).status, 'completed');
  assert.equal(listCompletionCandidates(candidateOwned.runId)[0]?.status, 'accepted');
  assert.match(inbox.listByRun(candidateOwned.runId).find((item) => item.messageType === 'collaboration_result').body, /候选结果/u);

  const bypass = fixture('candidate-bypass', ['a'], true, 1);
  const bypassClaim = store.claimNextDispatch(bypass.conversationId, 'owner');
  store.finishAttempt({ attemptId: bypassClaim.attempt.id, dispatchId: bypassClaim.dispatch.id, status: 'completed',
    output: '未接受的 Attempt 输出', action: { version: 2, type: 'complete', summary: '未接受的 Attempt 输出' } });
  const bypassSnapshot = loadCompletionSnapshot(bypass.runId);
  assert.equal(bypassSnapshot.reportParts.length, 0, '普通完成不得读取未接受的 Attempt 输出');
  assert.equal(bypassSnapshot.partialReportParts[0]?.output, '未接受的 Attempt 输出', '显式部分接受仍可观察现有输出');
  assert.equal(bypassSnapshot.input.subjects[0]?.hasOutput, false);
  finalizeCollaborationRun(bypass.runId);
  assert.equal(trace.getRun(bypass.runId).status, 'failed');
  assert.equal(inbox.listByRun(bypass.runId).filter((item) => item.messageType === 'collaboration_result').length, 0);

  const legacy = fixture('legacy-rollout', ['a'], false);
  complete(store.claimNextDispatch(legacy.conversationId, 'owner'), '历史 Run 结果');
  finalizeCollaborationRun(legacy.runId);
  assert.equal(trace.getRun(legacy.runId).status, 'completed');
  assert.deepEqual(listCompletionEvaluations(legacy.runId), []);
  console.log('Completion Engine 持久化、all-required 与单次发布验证通过');
} finally {
  db.closeDatabase();
  await rm(root, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-subject-completion-'));
process.env.DB_PATH = path.join(root, 'test.sqlite');
process.env.COLLAB_RUNTIME_ATOMIC = 'true';
process.env.COLLAB_MAX_ATTEMPTS = '2';

const db = await import('../apps/server/src/db/database.ts');
const store = await import('../apps/server/src/collaboration/store.ts');
const inbox = await import('../apps/server/src/messaging/inbox.ts');
const { getRun } = await import('../apps/server/src/runs/trace.ts');
const { assembleCollaborationContext } = await import('../apps/server/src/runtime/context.ts');
const { planCollaborationAdmission } = await import('../apps/server/src/runtime/subjectContract.ts');
const { observeAdmission } = await import('../apps/server/src/runtime/shadow.ts');
const {
  evaluateSubjectCompletion,
  listCompletionCandidates,
  runtimeCompletionCandidateVersion,
  submitCompletionCandidate,
} = await import('../apps/server/src/runtime/subjectCompletion.ts');

const candidate = {
  subjectId: 'subject-1', attemptId: 'attempt-1', generation: 1, agentId: 'a',
  action: { version: 2, type: 'complete', summary: '结果' }, summary: '结果',
  evidenceRefs: [{ kind: 'attempt_output', id: 'attempt-1' }],
  exitGuard: { status: 'allow_candidate', reasons: ['EXPLICIT_COMPLETE'] },
};
const base = (overrides = {}) => ({
  candidate,
  currentSubjectId: 'subject-1', subjectStatus: 'active', custodyState: 'owned', holderAgentId: 'a',
  pendingHolderAgentId: null, currentGeneration: 1, attemptStatus: 'running', attemptAgentId: 'a',
  attemptError: null, leaseValid: true, outputPresent: true, evidenceValid: true,
  openSuccessorObligations: 0, durableHoldOpen: false, dependenciesSatisfied: true,
  requiredArtifactsSatisfied: true, reviewAccepted: true, protocolTerminal: true,
  ...overrides,
});

function fixture(name) {
  const now = new Date().toISOString(); const runId = `run-${name}`; const conversationId = `room-${name}`;
  db.run('INSERT INTO conversations (id,title,mode,agent_ids,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    conversationId, name, 'collaboration', '["a"]', now, now);
  db.run('INSERT INTO runs (id,goal,mode,conversation_id,turn_no,status,agent_ids,created_at) VALUES (?,?,?,?,?,?,?,?)',
    runId, name, 'collaboration', conversationId, 1, 'running', '["a"]', now);
  const message = inbox.post({ runId, from: 'user', to: 'a', kind: 'user', body: name });
  const plan = planCollaborationAdmission({ runId, objective: name, participantIds: ['a'], targetAgentIds: ['a'],
    completionEngine: true, controlActionVersion: 2, completionCandidateVersion: 1 });
  const dispatch = db.tx(() => {
    const created = store.createDispatch({ runId, conversationId, sourceMessageId: message.id,
      kind: 'initial', from: 'user', targetAgentId: 'a', depth: 0, idempotencyKey: `initial:${name}` });
    observeAdmission(plan.contract, plan.subjects, [created.id]);
    return created;
  });
  return { runId, conversationId, dispatch };
}

try {
  assert.equal(evaluateSubjectCompletion(base()).status, 'accepted');
  assert.equal(evaluateSubjectCompletion(base({ currentSubjectId: 'subject-2' })).status, 'superseded');
  assert.equal(evaluateSubjectCompletion(base({ currentGeneration: 2 })).status, 'superseded');
  assert.deepEqual(evaluateSubjectCompletion(base({ attemptStatus: 'interrupted' })).reasons, ['ATTEMPT_NOT_COMMITTABLE']);
  assert.deepEqual(evaluateSubjectCompletion(base({ holderAgentId: 'b' })).reasons, ['CUSTODY_HOLDER_MISMATCH']);
  assert.equal(evaluateSubjectCompletion(base({ outputPresent: false })).retryable, true);
  assert.equal(evaluateSubjectCompletion(base({ evidenceValid: false })).retryable, true);
  assert.equal(evaluateSubjectCompletion(base({ openSuccessorObligations: 1 })).retryable, true);
  assert.equal(evaluateSubjectCompletion(base({ durableHoldOpen: true })).retryable, true);
  assert.deepEqual(evaluateSubjectCompletion(base({ reviewAccepted: false })).reasons, ['REVIEW_NOT_ACCEPTED']);
  assert.deepEqual(evaluateSubjectCompletion(base({ protocolTerminal: false })).reasons, ['PROTOCOL_NOT_TERMINAL']);

  const accepted = fixture('accepted');
  assert.equal(runtimeCompletionCandidateVersion(accepted.runId), 1);
  const claim = store.claimNextDispatch(accepted.conversationId, 'owner');
  const first = db.tx(() => {
    const result = submitCompletionCandidate({ runId: accepted.runId, dispatchId: claim.dispatch.id,
      attemptId: claim.attempt.id, agentId: 'a', action: { version: 2, type: 'complete', summary: '最终结果' },
      summary: '最终结果', evidenceRefs: [{ kind: 'attempt_output', id: claim.attempt.id }],
      exitGuard: { status: 'allow_candidate', reasons: ['EXPLICIT_COMPLETE'] } });
    store.finishAttempt({ attemptId: claim.attempt.id, dispatchId: claim.dispatch.id, status: 'completed',
      output: '最终结果', action: { version: 2, type: 'complete', summary: '最终结果' } });
    return result;
  });
  assert.equal(first.evaluation.status, 'accepted');
  assert.equal(listCompletionCandidates(accepted.runId)[0]?.status, 'accepted');
  const acceptedProjection = db.get(`SELECT s.status,c.state FROM runtime_subjects s
    JOIN runtime_custody c ON c.subject_id=s.id WHERE s.run_id=?`, accepted.runId);
  assert.deepEqual(acceptedProjection, { status: 'completed', state: 'completed' });
  assert.equal(db.get("SELECT COUNT(*) n FROM runtime_custody_events WHERE run_id=? AND kind='subject.completion_accepted'", accepted.runId).n, 1);
  const duplicate = submitCompletionCandidate({ runId: accepted.runId, dispatchId: claim.dispatch.id,
    attemptId: claim.attempt.id, agentId: 'a', action: { version: 2, type: 'complete', summary: '最终结果' },
    summary: '最终结果', evidenceRefs: [{ kind: 'attempt_output', id: claim.attempt.id }],
    exitGuard: { status: 'allow_candidate', reasons: ['EXPLICIT_COMPLETE'] } });
  assert.equal(duplicate.candidate.id, first.candidate.id);
  assert.equal(listCompletionCandidates(accepted.runId).length, 1, '幂等重放不得复制 Candidate');

  const stale = fixture('stale-generation');
  const staleClaim = store.claimNextDispatch(stale.conversationId, 'owner');
  const staleSubject = db.get(`SELECT c.subject_id,c.generation FROM runtime_custody c
    JOIN runtime_dispatch_subjects m ON m.subject_id=c.subject_id WHERE m.dispatch_id=?`, staleClaim.dispatch.id);
  db.run('UPDATE runtime_custody SET generation=generation+1 WHERE subject_id=?', staleSubject.subject_id);
  const superseded = submitCompletionCandidate({ runId: stale.runId, dispatchId: staleClaim.dispatch.id,
    attemptId: staleClaim.attempt.id, agentId: 'a', action: { version: 2, type: 'complete', summary: '迟到结果' },
    summary: '迟到结果', evidenceRefs: [{ kind: 'attempt_output', id: staleClaim.attempt.id }],
    exitGuard: { status: 'allow_candidate', reasons: ['EXPLICIT_COMPLETE'] } });
  assert.equal(superseded.candidate.generation, staleSubject.generation, 'Candidate 必须冻结 Attempt claim 时的 generation');
  assert.equal(superseded.evaluation.status, 'superseded');
  assert.equal(db.get('SELECT state FROM runtime_custody WHERE subject_id=?', staleSubject.subject_id).state, 'owned',
    '旧 generation Candidate 不得改变当前 Custody');

  const retry = fixture('retry');
  const retryClaim1 = store.claimNextDispatch(retry.conversationId, 'owner');
  const rejected = db.tx(() => {
    const result = submitCompletionCandidate({ runId: retry.runId, dispatchId: retryClaim1.dispatch.id,
      attemptId: retryClaim1.attempt.id, agentId: 'a', action: { version: 2, type: 'complete' }, summary: '',
      evidenceRefs: [], exitGuard: { status: 'allow_candidate', reasons: ['EXPLICIT_COMPLETE'] }, retryAllowed: true });
    store.finishAttempt({ attemptId: retryClaim1.attempt.id, dispatchId: retryClaim1.dispatch.id,
      status: 'failed', dispatchStatus: 'queued', error: 'SUBJECT_COMPLETION_REJECTED' });
    return result;
  });
  assert.equal(rejected.evaluation.status, 'rejected');
  assert.equal(rejected.evaluation.retryable, true);
  assert.equal(db.get('SELECT state FROM runtime_custody WHERE subject_id=?', rejected.candidate.subjectId).state, 'waiting');
  const retryClaim2 = store.claimNextDispatch(retry.conversationId, 'owner');
  assert.equal(retryClaim2.dispatch.id, retry.dispatch.id);
  assert.deepEqual(db.get(`SELECT s.status,c.state FROM runtime_subjects s JOIN runtime_custody c ON c.subject_id=s.id
    WHERE s.id=?`, rejected.candidate.subjectId), { status: 'active', state: 'owned' });
  const retryContext = assembleCollaborationContext({ run: getRun(retry.runId), dispatch: retryClaim2.dispatch,
    agent: { id: 'a', name: 'A', capabilities: ['execute'] }, attemptId: retryClaim2.attempt.id });
  assert.match(retryContext, /上一完成候选未通过/u);
  assert.match(retryContext, /MISSING_OUTPUT/u);

  const rollback = fixture('rollback');
  const rollbackClaim = store.claimNextDispatch(rollback.conversationId, 'owner');
  assert.throws(() => db.tx(() => {
    submitCompletionCandidate({ runId: rollback.runId, dispatchId: rollbackClaim.dispatch.id,
      attemptId: rollbackClaim.attempt.id, agentId: 'a', action: { version: 2, type: 'complete', summary: '不应提交' },
      summary: '不应提交', evidenceRefs: [{ kind: 'attempt_output', id: rollbackClaim.attempt.id }],
      exitGuard: { status: 'allow_candidate', reasons: ['EXPLICIT_COMPLETE'] } });
    throw new Error('fault injection');
  }), /fault injection/u);
  assert.equal(listCompletionCandidates(rollback.runId).length, 0);
  assert.equal(db.get('SELECT state FROM runtime_custody WHERE subject_id=(SELECT subject_id FROM runtime_dispatch_subjects WHERE dispatch_id=?)', rollback.dispatch.id).state, 'owned');

  console.log('SubjectCompletionEngine 决策矩阵、Candidate 原子提交、重试恢复与幂等验证通过');
} finally {
  db.closeDatabase();
  await rm(root, { recursive: true, force: true });
}

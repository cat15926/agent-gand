import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-responsibility-'));
process.env.DB_PATH = path.join(root, 'test.sqlite');
process.env.COLLAB_RUNTIME_MODE = 'execute';

const db = await import('../apps/server/src/db/database.ts');
const store = await import('../apps/server/src/collaboration/store.ts');
const inbox = await import('../apps/server/src/messaging/inbox.ts');
const { getRun } = await import('../apps/server/src/runs/trace.ts');
const { planCollaborationAdmission } = await import('../apps/server/src/runtime/subjectContract.ts');
const { observeAdmission } = await import('../apps/server/src/runtime/shadow.ts');
const {
  openSuccessorObligation,
  settleSuccessorObligation,
} = await import('../apps/server/src/runtime/obligations.ts');
const {
  formatCompletionBlockers,
  listResponsibilitySnapshots,
  loadResponsibilitySnapshot,
} = await import('../apps/server/src/runtime/responsibilitySnapshot.ts');
const { assembleCollaborationContext } = await import('../apps/server/src/runtime/context.ts');
const { evaluateExitGuard } = await import('../apps/server/src/runtime/exitGuard.ts');
const { evaluateCompletion } = await import('../apps/server/src/runtime/completion.ts');
const {
  evaluateSubjectCompletion,
  submitCompletionCandidate,
} = await import('../apps/server/src/runtime/subjectCompletion.ts');
const { createDurableHold } = await import('../apps/server/src/runtime/holds.ts');

function fixture(name) {
  const now = new Date().toISOString();
  const runId = `responsibility-${name}`; const conversationId = `room-${name}`;
  db.run('INSERT INTO conversations (id,title,mode,agent_ids,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    conversationId, name, 'collaboration', '["a","b"]', now, now);
  db.run('INSERT INTO runs (id,goal,mode,conversation_id,turn_no,status,agent_ids,created_at) VALUES (?,?,?,?,?,?,?,?)',
    runId, name, 'collaboration', conversationId, 1, 'running', '["a","b"]', now);
  const message = inbox.post({ runId, from: 'user', to: 'a', kind: 'user', body: name });
  const plan = planCollaborationAdmission({
    runId, objective: name, participantIds: ['a', 'b'], targetAgentIds: ['a'], completionEngine: true,
    controlActionVersion: 2, exitGuard: { version: 1, maxCorrections: 1, correctionMaxTokens: 512 },
    completionCandidateVersion: 1, successorObligationVersion: 1, evidenceBundleVersion: 1,
    evidenceLoopGuardVersion: 1, contextContributorVersion: 1, durableHoldVersion: 1,
  });
  const dispatch = db.tx(() => {
    const created = store.createDispatch({ runId, conversationId, sourceMessageId: message.id,
      kind: 'initial', from: 'user', targetAgentId: 'a', depth: 0, idempotencyKey: `initial:${name}` });
    observeAdmission(plan.contract, plan.subjects, [created.id]);
    return created;
  });
  const claim = store.claimNextDispatch(conversationId, `owner:${name}`);
  assert.ok(claim);
  const subjectId = db.get('SELECT subject_id FROM runtime_dispatch_subjects WHERE dispatch_id=?', dispatch.id).subject_id;
  return { runId, conversationId, dispatch, claim, subjectId };
}

function completionInput(snapshot, attemptId) {
  return {
    candidate: { subjectId: snapshot.subjectId, attemptId, generation: snapshot.attempt.generation, agentId: 'a',
      action: { version: 2, type: 'complete', summary: '结果' }, summary: '结果',
      evidenceRefs: [{ kind: 'attempt_output', id: attemptId }], exitGuard: { status: 'allow_candidate', reasons: ['EXPLICIT_COMPLETE'] } },
    currentSubjectId: snapshot.subjectId, subjectStatus: snapshot.subjectStatus, custodyState: snapshot.custody.state,
    holderAgentId: snapshot.custody.holderAgentId, pendingHolderAgentId: snapshot.custody.pendingHolderAgentId,
    currentGeneration: snapshot.custody.generation, attemptStatus: snapshot.attempt.status,
    attemptAgentId: snapshot.attempt.actorId, attemptError: null, leaseValid: snapshot.attempt.leaseValid,
    outputPresent: true, evidenceValid: true, openSuccessorObligations: 0, durableHoldOpen: false,
    dependenciesSatisfied: true, requiredArtifactsSatisfied: true, reviewAccepted: true, protocolTerminal: true,
    completionBlockers: snapshot.completionBlockers,
  };
}

try {
  const review = fixture('review');
  let snapshot = loadResponsibilitySnapshot({ runId: review.runId, dispatchId: review.dispatch.id,
    attemptId: review.claim.attempt.id });
  assert.ok(snapshot);
  assert.deepEqual(snapshot.completionBlockers, []);
  const obligation = openSuccessorObligation({ runId: review.runId, parentSubjectId: review.subjectId,
    kind: 'review_revision', sourceActionId: 'review:1', stableKey: 'review:required',
    payload: { requirement: '独立复核' } });
  assert.ok(obligation);
  snapshot = loadResponsibilitySnapshot({ runId: review.runId, subjectId: review.subjectId,
    attemptId: review.claim.attempt.id });
  assert.deepEqual(snapshot.completionBlockers.map((item) => item.code), ['REQUIRED_OBLIGATION_PENDING'],
    '没有 child Dispatch 时，必需 review obligation 仍必须阻止完成');
  assert.equal(snapshot.completionBlockers[0].refId, obligation.id);
  const context = assembleCollaborationContext({ run: getRun(review.runId), dispatch: review.dispatch,
    agent: { id: 'a', name: 'A', capabilities: ['execute'] }, attemptId: review.claim.attempt.id });
  assert.match(context, /REQUIRED_OBLIGATION_PENDING/u);
  assert.match(context, /status=open/u);
  const guard = evaluateExitGuard({ stopReason: 'normal', action: { version: 2, type: 'complete', summary: '结果' },
    output: '结果', hasActiveCustody: true, holderMatches: true, completionBlockers: snapshot.completionBlockers,
    allowImplicitAnswer: false, protocolRequiresExplicit: true, evidenceCount: 1, correctionAttempt: 0,
    correctionBudgetAvailable: false, policy: { version: 1, maxCorrections: 0, correctionMaxTokens: 512 } });
  assert.ok(guard.reasons.includes('REQUIRED_OBLIGATION_PENDING'));
  assert.deepEqual(evaluateSubjectCompletion(completionInput(snapshot, review.claim.attempt.id)).reasons,
    ['REQUIRED_OBLIGATION_PENDING'], 'ExitGuard 与 Completion 必须返回相同 blocker code');
  const runEvaluation = evaluateCompletion({ contract: {
    version: 1, runId: review.runId, objective: 'review', participantIds: ['a'], requiredSubjectKeys: ['root:a'],
    completionPolicy: 'all_required', partialFailurePolicy: 'needs_attention',
  }, subjects: [{ key: 'root:a', required: true, status: 'active', custodyState: 'owned', holderAgentId: 'a',
    pendingHolderAgentId: null, generation: 1, hasOutput: false, evidenceValid: false }],
  dispatches: [{ id: review.dispatch.id, status: 'blocked', error: 'required obligation' }], pendingDecisions: 0,
  batchStatuses: [], hasAnyOutput: true, dependenciesSatisfied: true, requiredArtifactsSatisfied: true,
  reviewAccepted: true, protocolTerminal: true, successorObligationsSatisfied: false,
  completionBlockers: snapshot.completionBlockers });
  assert.ok(runEvaluation.reasons.includes('REQUIRED_OBLIGATION_PENDING'),
    'Run Completion 在 Dispatch 已阻断时也必须保留同一 blocker code');

  settleSuccessorObligation({ id: obligation.id, expectedGeneration: obligation.generation,
    status: 'failed', resolutionSourceId: 'review:fail', resolution: { verdict: 'FAIL' } });
  snapshot = loadResponsibilitySnapshot({ runId: review.runId, subjectId: review.subjectId,
    attemptId: review.claim.attempt.id });
  assert.deepEqual(snapshot.completionBlockers.map((item) => item.code), ['REQUIRED_OBLIGATION_FAILED']);
  assert.match(formatCompletionBlockers(snapshot.completionBlockers), /REQUIRED_OBLIGATION_FAILED/u);

  const cancelled = openSuccessorObligation({ runId: review.runId, parentSubjectId: review.subjectId,
    kind: 'artifact_commit', sourceActionId: 'artifact:1', stableKey: 'artifact:required' });
  settleSuccessorObligation({ id: cancelled.id, expectedGeneration: cancelled.generation,
    status: 'cancelled', resolutionSourceId: 'artifact:cancel' });
  snapshot = loadResponsibilitySnapshot({ runId: review.runId, subjectId: review.subjectId,
    attemptId: review.claim.attempt.id });
  assert.deepEqual(new Set(snapshot.completionBlockers.map((item) => item.code)),
    new Set(['REQUIRED_OBLIGATION_FAILED', 'REQUIRED_OBLIGATION_CANCELLED']));
  store.finishAttempt({ attemptId: review.claim.attempt.id, dispatchId: review.dispatch.id,
    status: 'completed', output: 'review fixture done' });

  const optional = fixture('optional-consultation');
  const childId = 'optional-child'; const now = new Date().toISOString();
  db.run(`INSERT INTO runtime_subjects (id,run_id,subject_key,kind,parent_subject_id,status,objective,created_at,updated_at)
    VALUES (?,?,?,'consultation',?,'active','非必需咨询',?,?)`, childId, optional.runId, 'consult:b', optional.subjectId, now, now);
  db.run("INSERT INTO runtime_custody (subject_id,state,holder_agent_id,pending_holder_agent_id,generation,version,updated_at) VALUES (?,'owned','b',NULL,1,1,?)", childId, now);
  openSuccessorObligation({ runId: optional.runId, parentSubjectId: optional.subjectId, targetSubjectId: childId,
    kind: 'consult_result', sourceActionId: 'consult:optional', stableKey: 'consult:optional', required: false });
  const optionalSnapshot = loadResponsibilitySnapshot({ runId: optional.runId, subjectId: optional.subjectId,
    attemptId: optional.claim.attempt.id });
  assert.deepEqual(optionalSnapshot.completionBlockers, [],
    '非必需 consultation 不能按 child 数量阻断父 Subject');
  store.finishAttempt({ attemptId: optional.claim.attempt.id, dispatchId: optional.dispatch.id,
    status: 'completed', output: 'optional fixture done' });

  const held = fixture('held');
  const hold = createDurableHold({ runId: held.runId, subjectId: held.subjectId,
    sourceDispatchId: held.dispatch.id, sourceAttemptId: held.claim.attempt.id, holderAgentId: 'a',
    condition: { kind: 'event', eventKey: 'fixture:external' }, recoveryPolicy: { kind: 'wake_run' },
    idempotencyKey: 'fixture:external-hold' });
  const heldSnapshot = loadResponsibilitySnapshot({ runId: held.runId, subjectId: held.subjectId,
    attemptId: held.claim.attempt.id });
  assert.deepEqual(heldSnapshot.completionBlockers.map((item) => item.code), ['EXTERNAL_CONDITION_PENDING']);
  assert.equal(heldSnapshot.completionBlockers[0].refId, hold.id);
  store.finishAttempt({ attemptId: held.claim.attempt.id, dispatchId: held.dispatch.id,
    status: 'completed', output: 'held fixture done' });

  const stale = fixture('stale');
  db.run('UPDATE runtime_custody SET generation=generation+1,version=version+1 WHERE subject_id=?', stale.subjectId);
  const staleSnapshot = loadResponsibilitySnapshot({ runId: stale.runId, subjectId: stale.subjectId,
    attemptId: stale.claim.attempt.id });
  assert.ok(staleSnapshot.completionBlockers.some((item) => item.code === 'ATTEMPT_GENERATION_STALE'));
  const staleDecision = submitCompletionCandidate({ runId: stale.runId, dispatchId: stale.dispatch.id,
    attemptId: stale.claim.attempt.id, agentId: 'a', action: { version: 2, type: 'complete', summary: '迟到结果' },
    summary: '迟到结果', evidenceRefs: [{ kind: 'attempt_output', id: stale.claim.attempt.id }],
    exitGuard: { status: 'allow_candidate', reasons: ['EXPLICIT_COMPLETE'] } });
  assert.equal(staleDecision.evaluation.status, 'superseded');
  assert.deepEqual(staleDecision.evaluation.reasons, ['ATTEMPT_GENERATION_STALE'],
    '相同 agentId 的旧 Attempt 不能绕过 generation 校验');

  assert.equal(listResponsibilitySnapshots(review.runId).length, 1);
  const apiSource = await readFile(new URL('../apps/server/src/api/routes.ts', import.meta.url), 'utf8');
  const uiSource = await readFile(new URL('../apps/web/src/components/RightPanel.tsx', import.meta.url), 'utf8');
  assert.match(apiSource, /responsibilitySnapshots: listResponsibilitySnapshots/u);
  assert.match(apiSource, /\/api\/runs\/:runId\/responsibility/u);
  assert.match(uiSource, /blocker\.code/u);
  assert.match(uiSource, /BLOCKER_CATEGORY_LABEL/u);

  console.log('Responsibility Snapshot、Blocker Projection、Context/Exit/Completion/API/UI 统一口径验证通过');
} finally {
  db.closeDatabase();
  await rm(root, { recursive: true, force: true });
}

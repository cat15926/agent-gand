import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-evidence-bundle-'));
process.env.DB_PATH = path.join(root, 'test.sqlite');
process.env.COLLAB_RUNTIME_ATOMIC = 'true';

const db = await import('../apps/server/src/db/database.ts');
const store = await import('../apps/server/src/collaboration/store.ts');
const inbox = await import('../apps/server/src/messaging/inbox.ts');
const { startSpan, endSpan } = await import('../apps/server/src/runs/trace.ts');
const { executeToolOnce, listToolExecutions } = await import('../apps/server/src/tools/executions.ts');
const { workspaceRootDir } = await import('../apps/server/src/tools/builtin/index.ts');
const { planCollaborationAdmission } = await import('../apps/server/src/runtime/subjectContract.ts');
const { observeAdmission } = await import('../apps/server/src/runtime/shadow.ts');
const { submitCompletionCandidate } = await import('../apps/server/src/runtime/subjectCompletion.ts');
const { loadCompletionSnapshot } = await import('../apps/server/src/runtime/completionStore.ts');
const {
  createEvidenceBundle,
  createWorkspaceFileEvidence,
  listEvidenceBundles,
  validateEvidenceBundle,
} = await import('../apps/server/src/runtime/evidence.ts');

const runId = `bundle-${randomUUID()}`; const conversationId = `room-${runId}`; const now = new Date().toISOString();
const runRoot = workspaceRootDir({ runId });

try {
  db.run('INSERT INTO conversations (id,title,mode,agent_ids,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    conversationId, 'bundle', 'collaboration', '["a"]', now, now);
  db.run('INSERT INTO runs (id,goal,mode,conversation_id,turn_no,status,agent_ids,created_at) VALUES (?,?,?,?,?,?,?,?)',
    runId, '验证 EvidenceBundle', 'collaboration', conversationId, 1, 'running', '["a"]', now);
  const message = inbox.post({ runId, from: 'user', to: 'a', kind: 'user', body: '请给出有证据的结果' });
  const plan = planCollaborationAdmission({ runId, objective: '验证 EvidenceBundle', participantIds: ['a'], targetAgentIds: ['a'],
    controlActionVersion: 2, completionCandidateVersion: 1, successorObligationVersion: 1,
    evidenceBundleVersion: 1, contextContributorVersion: 1, evidenceLoopGuardVersion: 1 });
  const dispatch = store.createDispatch({ runId, conversationId, sourceMessageId: message.id,
    kind: 'initial', from: 'user', targetAgentId: 'a', depth: 0, idempotencyKey: 'initial' });
  observeAdmission(plan.contract, plan.subjects, [dispatch.id]);
  const claim = store.claimNextDispatch(conversationId, 'owner');
  assert.equal(claim.dispatch.id, dispatch.id);
  const subjectId = db.get('SELECT subject_id FROM runtime_dispatch_subjects WHERE dispatch_id=?', dispatch.id).subject_id;

  await executeToolOnce({ runId, agentId: 'a', attemptId: claim.attempt.id, toolName: 'fs.read', input: '{}',
    idempotencyKey: `bundle-tool:${runId}`, replayPolicy: 'safe', spanId: 'bundle-tool-span', execute: async () => '工具证据' });
  const toolId = listToolExecutions(runId)[0].id;
  const event = startSpan(runId, { spanKind: 'orchestration', name: 'bundle-event' });
  endSpan(event, { output: '运行事件证据', status: 'ok' });
  await mkdir(runRoot, { recursive: true });
  await writeFile(path.join(runRoot, 'proof.txt'), '冻结的文件证据');
  const fileRef = createWorkspaceFileEvidence(runId, 'proof.txt');
  store.finishAttempt({ attemptId: claim.attempt.id, dispatchId: dispatch.id, status: 'completed', output: '最终结果' });

  const refs = [
    { kind: 'message', id: message.id },
    { kind: 'attempt_output', id: claim.attempt.id },
    { kind: 'tool_execution', id: toolId },
    { kind: 'run_event', id: event.id },
    fileRef,
  ];
  const bundle = createEvidenceBundle({ runId, subjectId, ownerType: 'coordination_step', ownerId: 'all-kinds', refs,
    idempotencyKey: 'all-evidence-kinds' });
  assert.equal(bundle.version, 1);
  assert.equal(bundle.status, 'valid');
  assert.equal(bundle.resolutions.length, 5);
  assert.ok(bundle.resolutions.every((item) => item.trusted && /^[a-f0-9]{64}$/u.test(item.contentSha256)));
  assert.equal(createEvidenceBundle({ runId, subjectId, ownerType: 'coordination_step', ownerId: 'all-kinds', refs,
    idempotencyKey: 'all-evidence-kinds' }).id, bundle.id, '同一证据包重放必须幂等');

  const candidate = submitCompletionCandidate({ runId, dispatchId: dispatch.id, attemptId: claim.attempt.id, agentId: 'a',
    action: { version: 2, type: 'complete', summary: '最终结果' }, summary: '最终结果',
    evidenceRefs: [{ kind: 'attempt_output', id: claim.attempt.id }],
    exitGuard: { status: 'allow_candidate', reasons: ['EXPLICIT_COMPLETE'] } });
  assert.equal(candidate.evaluation.status, 'accepted');
  assert.ok(candidate.candidate.evidenceBundleId);
  assert.equal(validateEvidenceBundle(candidate.candidate.evidenceBundleId, runId).valid, true);
  assert.equal(loadCompletionSnapshot(runId).input.subjects[0].evidenceValid, true);

  db.run('UPDATE collaboration_attempts SET output=? WHERE id=?', '被篡改的结果', claim.attempt.id);
  const drifted = validateEvidenceBundle(candidate.candidate.evidenceBundleId, runId);
  assert.equal(drifted.valid, false);
  assert.equal(drifted.bundle.status, 'drifted');
  assert.equal(loadCompletionSnapshot(runId).input.subjects[0].evidenceValid, false,
    '冻结引用漂移后 Candidate 必须失效');
  const replay = submitCompletionCandidate({ runId, dispatchId: dispatch.id, attemptId: claim.attempt.id, agentId: 'a',
    action: { version: 2, type: 'complete', summary: '最终结果' }, summary: '最终结果',
    evidenceRefs: [{ kind: 'attempt_output', id: claim.attempt.id }],
    exitGuard: { status: 'allow_candidate', reasons: ['EXPLICIT_COMPLETE'] } });
  assert.deepEqual(replay.evaluation.reasons, ['EVIDENCE_BUNDLE_DRIFTED']);
  db.run('UPDATE collaboration_attempts SET output=? WHERE id=?', '最终结果', claim.attempt.id);
  assert.equal(validateEvidenceBundle(candidate.candidate.evidenceBundleId, runId).bundle.status, 'drifted',
    '漂移状态不得因内容恢复而静默变回 valid');

  const beforeRollback = listEvidenceBundles(runId).length;
  assert.throws(() => db.tx(() => {
    createEvidenceBundle({ runId, subjectId, ownerType: 'coordination_step', ownerId: 'rollback', refs: [fileRef],
      idempotencyKey: 'rollback-bundle' });
    throw new Error('fault injection');
  }), /fault injection/u);
  assert.equal(listEvidenceBundles(runId).length, beforeRollback);

  console.log('EvidenceBundle 全类型解析、幂等、冻结漂移、Candidate 失效与回滚验证通过');
} finally {
  db.closeDatabase();
  await rm(runRoot, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}

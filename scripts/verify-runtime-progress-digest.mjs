import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-progress-digest-'));
process.env.DB_PATH = path.join(root, 'test.sqlite');

const db = await import('../apps/server/src/db/database.ts');
const store = await import('../apps/server/src/collaboration/store.ts');
const inbox = await import('../apps/server/src/messaging/inbox.ts');
const { startSpan, endSpan } = await import('../apps/server/src/runs/trace.ts');
const { executeToolOnce, listToolExecutions } = await import('../apps/server/src/tools/executions.ts');
const { createEvidenceBundle } = await import('../apps/server/src/runtime/evidence.ts');
const { executionPolicyForProfile } = await import('../apps/server/src/runtime/runPolicy.ts');
const { planCollaborationAdmission } = await import('../apps/server/src/runtime/subjectContract.ts');
const { observeAdmission } = await import('../apps/server/src/runtime/shadow.ts');
const { listRouteGuardEvents, recordEvidenceAwareRoute } = await import('../apps/server/src/runtime/loopGuard.ts');

const runId = `progress-${randomUUID()}`; const conversationId = `room-${runId}`; const now = new Date().toISOString();
try {
  db.run('INSERT INTO conversations (id,title,mode,agent_ids,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    conversationId, 'progress', 'collaboration', '["a","b"]', now, now);
  db.run('INSERT INTO runs (id,goal,mode,conversation_id,turn_no,status,agent_ids,created_at) VALUES (?,?,?,?,?,?,?,?)',
    runId, '验证实际进展', 'collaboration', conversationId, 1, 'running', '["a","b"]', now);
  const message = inbox.post({ runId, from: 'user', to: 'a', kind: 'user', body: '验证实际进展' });
  const plan = planCollaborationAdmission({ runId, objective: '验证实际进展', participantIds: ['a', 'b'], targetAgentIds: ['a'],
    executionPolicy: executionPolicyForProfile('execute'), completionEngine: true, controlActionVersion: 2,
    exitGuard: { version: 1, maxCorrections: 1, correctionMaxTokens: 512 }, completionCandidateVersion: 1,
    successorObligationVersion: 1, evidenceBundleVersion: 1, evidenceLoopGuardVersion: 1,
    contextContributorVersion: 1, durableHoldVersion: 2, progressDigestVersion: 1 });
  const dispatch = store.createDispatch({ runId, conversationId, sourceMessageId: message.id,
    kind: 'initial', from: 'user', targetAgentId: 'a', depth: 0, idempotencyKey: 'initial' });
  observeAdmission(plan.contract, plan.subjects, [dispatch.id]);
  const claim = store.claimNextDispatch(conversationId, 'owner');
  const subjectId = db.get('SELECT subject_id FROM runtime_dispatch_subjects WHERE dispatch_id=?', dispatch.id).subject_id;
  const route = (index) => recordEvidenceAwareRoute({ runId, subjectId, sourceDispatchId: `route-${index}`,
    fromAgentId: index % 2 === 1 ? 'a' : 'b', targetAgentId: index % 2 === 1 ? 'b' : 'a',
    objective: '验证实际进展', warnAt: 2, blockAt: 6 });

  const empty = route(1);
  assert.equal(empty.progressDigest.entries.length, 0);

  await executeToolOnce({ runId, agentId: 'a', attemptId: claim.attempt.id, toolName: 'fs.read',
    input: JSON.stringify({ path: 'status.json', requestedAt: '2026-10-01T00:00:00Z' }),
    idempotencyKey: `read-1:${runId}`, replayPolicy: 'safe', spanId: 'read-1',
    execute: async () => JSON.stringify({ value: 'same', checkedAt: '2026-10-01T00:00:01Z' }) });
  const firstRead = route(2);
  assert.equal(firstRead.repeatedCount, 1);
  assert.notEqual(firstRead.progressDigest.digest, empty.progressDigest.digest);

  await executeToolOnce({ runId, agentId: 'a', attemptId: claim.attempt.id, toolName: 'fs.read',
    input: JSON.stringify({ path: 'status.json', requestedAt: '2026-10-01T01:00:00Z' }),
    idempotencyKey: `read-2:${runId}`, replayPolicy: 'safe', spanId: 'read-2',
    execute: async () => JSON.stringify({ value: 'same', checkedAt: '2026-10-01T01:00:01Z' }) });
  const duplicateRead = route(3);
  assert.notEqual(duplicateRead.evidenceFingerprint, firstRead.evidenceFingerprint,
    '新增 EvidenceRef 身份仍应保留在审计 fingerprint 中');
  assert.equal(duplicateRead.progressDigest.digest, firstRead.progressDigest.digest,
    '重复只读结果和时间戳变化不得伪造实际进展');
  assert.equal(duplicateRead.repeatedCount, 2);
  assert.equal(duplicateRead.progressDigest.excluded.duplicateReadOnlyResults, 1);
  assert.ok(duplicateRead.progressDigest.excluded.timestampNoiseFields >= 2);

  const ordinaryLog = startSpan(runId, { spanKind: 'orchestration', name: 'heartbeat' });
  endSpan(ordinaryLog, { output: 'heartbeat at 2026-10-01T02:00:00Z', status: 'ok' });
  createEvidenceBundle({ runId, subjectId, ownerType: 'coordination_step', ownerId: 'ordinary-log',
    refs: [{ kind: 'run_event', id: ordinaryLog.id }], idempotencyKey: `ordinary-log:${runId}` });
  const afterLog = route(4);
  assert.equal(afterLog.progressDigest.digest, duplicateRead.progressDigest.digest);
  assert.equal(afterLog.repeatedCount, 3);
  assert.equal(afterLog.progressDigest.excluded.ordinaryLogs, 1);

  await executeToolOnce({ runId, agentId: 'a', attemptId: claim.attempt.id, toolName: 'fs.read',
    input: JSON.stringify({ path: 'status.json', requestedAt: '2026-10-01T03:00:00Z' }),
    idempotencyKey: `read-3:${runId}`, replayPolicy: 'safe', spanId: 'read-3',
    execute: async () => JSON.stringify({ value: 'changed', checkedAt: '2026-10-01T03:00:01Z' }) });
  const changedRead = route(5);
  assert.notEqual(changedRead.progressDigest.digest, afterLog.progressDigest.digest);
  assert.equal(changedRead.repeatedCount, 1, '稳定资源的实质内容变化必须重置循环计数');

  await executeToolOnce({ runId, agentId: 'a', attemptId: claim.attempt.id, toolName: 'fs.write',
    input: JSON.stringify({ path: 'result.txt', content: 'first' }),
    idempotencyKey: `write-1:${runId}`, replayPolicy: 'manual', spanId: 'write-1',
    execute: async () => 'ok' });
  const firstWrite = route(6);
  await executeToolOnce({ runId, agentId: 'a', attemptId: claim.attempt.id, toolName: 'fs.write',
    input: JSON.stringify({ path: 'result.txt', content: 'second' }),
    idempotencyKey: `write-2:${runId}`, replayPolicy: 'manual', spanId: 'write-2',
    execute: async () => 'ok' });
  const changedWrite = route(7);
  assert.notEqual(changedWrite.progressDigest.digest, firstWrite.progressDigest.digest,
    '同一资源的不同写入内容即使回执相同，也应算实际进展');
  assert.equal(changedWrite.repeatedCount, 1);

  const substantiveEvent = startSpan(runId, { spanKind: 'orchestration', name: 'validated-milestone',
    attributes: { 'runtime.progress': true } });
  endSpan(substantiveEvent, { output: JSON.stringify({ milestone: 'validated', observedAt: '2026-10-01T05:00:00Z' }), status: 'ok' });
  createEvidenceBundle({ runId, subjectId, ownerType: 'coordination_step', ownerId: 'substantive-event',
    refs: [{ kind: 'run_event', id: substantiveEvent.id }], idempotencyKey: `substantive-event:${runId}` });
  const afterSubstantiveEvent = route(8);
  assert.notEqual(afterSubstantiveEvent.progressDigest.digest, changedWrite.progressDigest.digest,
    '显式标记的实质事件应计入进展');
  assert.equal(afterSubstantiveEvent.repeatedCount, 1);

  const stored = listRouteGuardEvents(runId);
  assert.equal(stored.length, 8);
  assert.equal(stored[2].progressDigest.digest, duplicateRead.progressDigest.digest,
    'ProgressDigest 观测快照必须可持久化读取');
  assert.equal(listToolExecutions(runId).length, 5);
  console.log('ProgressDigest 重复只读、时间戳噪声、普通日志、实质变化与持久化验证通过');
} finally {
  db.closeDatabase();
  await rm(root, { recursive: true, force: true });
}

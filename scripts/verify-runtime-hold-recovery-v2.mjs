import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-hold-v2-'));
process.env.DB_PATH = path.join(root, 'test.sqlite');

const db = await import('../apps/server/src/db/database.ts');
const store = await import('../apps/server/src/collaboration/store.ts');
const inbox = await import('../apps/server/src/messaging/inbox.ts');
const { planCollaborationAdmission } = await import('../apps/server/src/runtime/subjectContract.ts');
const { observeAction, observeAdmission } = await import('../apps/server/src/runtime/shadow.ts');
const { openSuccessorObligation, listSuccessorObligations } = await import('../apps/server/src/runtime/obligations.ts');
const holds = await import('../apps/server/src/runtime/holds.ts');
const { recoverDurableHolds } = await import('../apps/server/src/runs/recovery.ts');

function iso(time) { return new Date(time).toISOString(); }

function seed(label, version = 2) {
  const runId = `${label}-${randomUUID()}`; const conversationId = `room-${runId}`; const now = new Date().toISOString();
  db.run('INSERT INTO conversations (id,title,mode,agent_ids,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    conversationId, label, 'collaboration', '["a"]', now, now);
  db.run('INSERT INTO runs (id,goal,mode,conversation_id,turn_no,status,agent_ids,created_at) VALUES (?,?,?,?,?,?,?,?)',
    runId, label, 'collaboration', conversationId, 1, 'running', '["a"]', now);
  const message = inbox.post({ runId, from: 'user', to: 'a', kind: 'user', body: label });
  const planned = planCollaborationAdmission({ runId, objective: label, participantIds: ['a'], targetAgentIds: ['a'],
    completionEngine: true, controlActionVersion: 2, successorObligationVersion: 1, durableHoldVersion: version,
    completionCandidateVersion: 1, evidenceBundleVersion: 1, contextContributorVersion: 1,
    exitGuard: { version: 1, maxCorrections: 1, correctionMaxTokens: 1024 } });
  const dispatch = store.createDispatch({ runId, conversationId, sourceMessageId: message.id,
    kind: 'initial', from: 'user', targetAgentId: 'a', depth: 0, idempotencyKey: `initial:${runId}` });
  observeAdmission(planned.contract, planned.subjects, [dispatch.id]);
  const claim = store.claimNextDispatch(conversationId, `seed:${label}`);
  assert.ok(claim);
  observeAction({ dispatchId: dispatch.id, attemptId: claim.attempt.id, agentId: 'a',
    action: { version: 2, type: 'hold', wake: { kind: 'user_decision', decisionKind: 'agent_question', prompt: label }, reason: label },
    childDispatchIds: [], batchId: null });
  store.finishAttempt({ attemptId: claim.attempt.id, dispatchId: dispatch.id, status: 'completed', output: label,
    action: { version: 2, type: 'hold', wake: { kind: 'user_decision', decisionKind: 'agent_question', prompt: label }, reason: label } });
  db.run("UPDATE runs SET status='waiting_for_user' WHERE id=?", runId);
  const subjectId = db.get('SELECT subject_id FROM runtime_dispatch_subjects WHERE dispatch_id=?', dispatch.id).subject_id;
  return { runId, conversationId, dispatch, attempt: claim.attempt, subjectId };
}

function create(item, condition, suffix, options = {}) {
  return holds.createDurableHold({ runId: item.runId, subjectId: item.subjectId,
    sourceDispatchId: item.dispatch.id, sourceAttemptId: item.attempt.id, holderAgentId: 'a',
    condition, recoveryPolicy: { kind: 'wake_run' }, idempotencyKey: `${suffix}:${item.runId}`, ...options });
}

function runChild(runId) {
  const script = fileURLToPath(new URL('./helpers/runtime-fault-child.mjs', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', './apps/server/node_modules/tsx/dist/loader.mjs', script, 'hold_claim'], {
      cwd: path.resolve(fileURLToPath(new URL('..', import.meta.url))),
      env: { ...process.env, DB_PATH: process.env.DB_PATH, TEST_RUN_ID: runId },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `child exited ${code}`)));
  });
}

try {
  const legacy = seed('legacy-v1', 1);
  const legacyHold = create(legacy, { kind: 'timer', wakeAt: iso(Date.now() + 10_000) }, 'legacy');
  assert.equal(legacyHold.version, 1);
  assert.equal(legacyHold.wakeAt, legacyHold.condition.wakeAt, 'v1 行必须派生 wakeAt 供新读取器使用');
  assert.equal(legacyHold.timeoutAt, null);

  const boundary = seed('event-before-timeout'); const boundaryBase = Date.now();
  const boundaryTimeout = iso(boundaryBase + 1_000);
  const boundaryHold = create(boundary, { kind: 'event', eventKey: 'boundary-event' }, 'boundary',
    { timeoutAt: boundaryTimeout, onTimeout: { kind: 'fail', reason: 'event missing' } });
  assert.equal(boundaryHold.version, 2);
  assert.equal(boundaryHold.timeoutAt, boundaryTimeout);
  const boundaryEvent = holds.recordRuntimeWakeEvent({ runId: boundary.runId, kind: 'event', sourceKey: 'boundary-event',
    idempotencyKey: `boundary-event:${boundary.runId}` });
  db.run('UPDATE runtime_wake_events SET created_at=? WHERE id=?', boundaryTimeout, boundaryEvent.id);
  assert.equal(holds.claimReadyDurableHolds({ claimOwner: 'boundary-worker', runId: boundary.runId,
    now: iso(boundaryBase + 2_000) }).length, 1, '事件时间等于 timeoutAt 时事件优先');

  const late = seed('event-after-timeout'); const lateBase = Date.now();
  const lateTimeout = iso(lateBase - 1_000);
  const lateHold = create(late, { kind: 'event', eventKey: 'late-event' }, 'late',
    { timeoutAt: lateTimeout, onTimeout: { kind: 'fail', reason: '事件未按时到达' } });
  holds.recordRuntimeWakeEvent({ runId: late.runId, kind: 'event', sourceKey: 'late-event',
    idempotencyKey: `late-event:${late.runId}` });
  assert.equal(holds.claimReadyDurableHolds({ claimOwner: 'late-worker', runId: late.runId, now: iso(lateBase) }).length, 0);
  assert.equal(holds.listDurableHolds(late.runId)[0].status, 'failed');
  const lateAuditCount = holds.listRuntimeHoldRecoveryAudits(late.runId).length;
  assert.equal(holds.claimReadyDurableHolds({ claimOwner: 'late-worker-2', runId: late.runId, now: iso(lateBase + 5_000) }).length, 0);
  assert.equal(holds.listRuntimeHoldRecoveryAudits(late.runId).length, lateAuditCount,
    '永久超时结案不得反复进入恢复队列');
  assert.equal(lateHold.onTimeout.kind, 'fail');

  const timeoutWake = seed('timeout-wake'); const timeoutWakeAt = iso(Date.now() - 1_000);
  create(timeoutWake, { kind: 'event', eventKey: 'never-arrives' }, 'timeout-wake',
    { timeoutAt: timeoutWakeAt, onTimeout: { kind: 'wake', reason: '超时后进入降级恢复', payload: { fallback: true } } });
  const timeoutWakeClaim = holds.claimReadyDurableHolds({ claimOwner: 'timeout-wake-worker',
    runId: timeoutWake.runId, now: iso(Date.now()) })[0];
  assert.ok(timeoutWakeClaim);
  const syntheticTimeout = holds.listRuntimeWakeEvents(timeoutWake.runId).find((event) => event.id === timeoutWakeClaim.wakeEventId);
  assert.equal(syntheticTimeout.kind, 'timeout');
  assert.equal(syntheticTimeout.payload.fallback, true);
  holds.completeDurableHoldClaim({ id: timeoutWakeClaim.id, claimToken: timeoutWakeClaim.claimToken });

  const dependency = seed('dependency-failed'); const dependencyId = randomUUID(); const dependencyNow = new Date().toISOString();
  db.run(`INSERT INTO runtime_subjects (id,run_id,subject_key,kind,parent_subject_id,status,objective,created_at,updated_at)
    VALUES (?,?,?,'consultation',?,'failed',?,?,?)`, dependencyId, dependency.runId,
  `dep:${dependencyId}`, dependency.subjectId, '失败依赖', dependencyNow, dependencyNow);
  create(dependency, { kind: 'dependency', subjectIds: [dependencyId], policy: 'all' }, 'dependency');
  assert.equal(holds.claimReadyDurableHolds({ claimOwner: 'dependency-worker', runId: dependency.runId }).length, 0);
  assert.equal(holds.listDurableHolds(dependency.runId)[0].lastErrorCode, 'DEPENDENCY_FAILED');

  const retry = seed('transient-retry'); const retryBase = Date.now();
  create(retry, { kind: 'timer', wakeAt: iso(retryBase - 1_000) }, 'retry', { maxRetries: 2 });
  const retryClaim = holds.claimReadyDurableHolds({ claimOwner: 'retry-worker', runId: retry.runId, now: iso(retryBase) })[0];
  assert.ok(retryClaim);
  const released = holds.releaseDurableHoldClaim(retryClaim.id, retryClaim.claimToken,
    new holds.RuntimeHoldRecoveryError('transient', 'RECOVERY_TRANSIENT', '临时数据库忙'), iso(retryBase));
  assert.equal(released.retryCount, 1);
  assert.equal(released.nextRetryAt, iso(retryBase + 1_000));
  assert.equal(holds.claimReadyDurableHolds({ claimOwner: 'too-early', runId: retry.runId, now: iso(retryBase + 999) }).length, 0);
  const recovered = holds.claimReadyDurableHolds({ claimOwner: 'retry-worker-2', runId: retry.runId,
    now: iso(retryBase + 1_000) })[0];
  assert.ok(recovered, '退避到期后必须可重新认领');
  holds.completeDurableHoldClaim({ id: recovered.id, claimToken: recovered.claimToken });

  const exhausted = seed('retry-exhausted'); const exhaustedBase = Date.now();
  create(exhausted, { kind: 'timer', wakeAt: iso(exhaustedBase - 1_000) }, 'exhausted', { maxRetries: 1 });
  const first = holds.claimReadyDurableHolds({ claimOwner: 'exhausted-1', runId: exhausted.runId, now: iso(exhaustedBase) })[0];
  holds.releaseDurableHoldClaim(first.id, first.claimToken, new Error('temporary-1'), iso(exhaustedBase));
  const second = holds.claimReadyDurableHolds({ claimOwner: 'exhausted-2', runId: exhausted.runId,
    now: iso(exhaustedBase + 1_000) })[0];
  holds.releaseDurableHoldClaim(second.id, second.claimToken, new Error('temporary-2'), iso(exhaustedBase + 1_000));
  assert.equal(holds.listDurableHolds(exhausted.runId)[0].lastErrorCode, 'RETRY_EXHAUSTED');
  assert.equal(holds.claimReadyDurableHolds({ claimOwner: 'exhausted-3', runId: exhausted.runId,
    now: iso(exhaustedBase + 60_000) }).length, 0);

  const permanent = seed('permanent-source-missing');
  holds.createDurableHold({ runId: permanent.runId, subjectId: permanent.subjectId,
    sourceDispatchId: null, sourceAttemptId: permanent.attempt.id, holderAgentId: 'a',
    condition: { kind: 'timer', wakeAt: iso(Date.now() - 1_000) },
    recoveryPolicy: { kind: 'resume_dispatch', targetAgentId: 'a', sourceMessageId: `source:${permanent.runId}`,
      parentDispatchId: permanent.dispatch.id, depth: 0, reason: '永久错误分类验收' },
    idempotencyKey: `permanent:${permanent.runId}` });
  assert.equal(recoverDurableHolds(permanent.runId), 0);
  const permanentlyClosed = holds.listDurableHolds(permanent.runId)[0];
  assert.equal(permanentlyClosed.lastErrorCode, 'SOURCE_MISSING',
    `${permanentlyClosed.lastErrorCode}: ${permanentlyClosed.lastError}`);
  const permanentAudits = holds.listRuntimeHoldRecoveryAudits(permanent.runId).length;
  assert.equal(recoverDurableHolds(permanent.runId), 0);
  assert.equal(holds.listRuntimeHoldRecoveryAudits(permanent.runId).length, permanentAudits,
    '永久恢复错误不得由后台扫描重复入队');

  const stale = seed('stale-generation');
  const obligation = openSuccessorObligation({ runId: stale.runId, parentSubjectId: stale.subjectId,
    targetSubjectId: stale.subjectId, kind: 'artifact_commit', sourceActionId: `artifact:${stale.runId}`,
    stableKey: `artifact:${stale.runId}` });
  assert.ok(obligation);
  const staleHold = create(stale, { kind: 'event', eventKey: 'stale-event' }, 'stale');
  db.run('UPDATE runtime_custody SET generation=generation+1,version=version+1 WHERE subject_id=?', stale.subjectId);
  holds.recordRuntimeWakeEvent({ runId: stale.runId, kind: 'event', sourceKey: 'stale-event',
    idempotencyKey: `stale-event:${stale.runId}` });
  assert.equal(holds.claimReadyDurableHolds({ claimOwner: 'stale-worker', runId: stale.runId }).length, 0);
  assert.equal(holds.listDurableHolds(stale.runId).find((item) => item.id === staleHold.id).lastErrorCode, 'STALE_GENERATION');
  assert.equal(listSuccessorObligations(stale.runId).find((item) => item.id === obligation.id).status, 'open',
    '关闭旧 generation Hold 不得满足新一代责任的义务');

  const stopped = seed('stop-wake-v2');
  const stoppedHold = create(stopped, { kind: 'event', eventKey: 'stop-event' }, 'stop');
  holds.recordRuntimeWakeEvent({ runId: stopped.runId, kind: 'event', sourceKey: 'stop-event',
    idempotencyKey: `stop-event:${stopped.runId}` });
  const stoppedClaim = holds.claimReadyDurableHolds({ claimOwner: 'stop-worker', runId: stopped.runId })[0];
  assert.ok(stoppedClaim);
  db.run("UPDATE runs SET status='cancelled' WHERE id=?", stopped.runId);
  holds.cancelDurableHolds(stopped.runId, 'user_stop');
  assert.throws(() => holds.completeDurableHoldClaim({ id: stoppedHold.id, claimToken: stoppedClaim.claimToken }),
    /claim 已失效|Run 已终结/u);
  assert.equal(holds.listDurableHolds(stopped.runId)[0].status, 'cancelled');

  const race = seed('claim-race');
  const raceHold = create(race, { kind: 'event', eventKey: 'race-event' }, 'race');
  holds.recordRuntimeWakeEvent({ runId: race.runId, kind: 'event', sourceKey: 'race-event',
    idempotencyKey: `race-event:${race.runId}` });
  const raceResults = await Promise.all([runChild(race.runId), runChild(race.runId)]);
  assert.equal(raceResults.filter((item) => item === raceHold.id).length, 1, `跨进程 claim 必须只有一个赢家: ${raceResults}`);
  assert.equal(raceResults.filter((item) => item === 'none').length, 1);

  const audits = holds.listRuntimeHoldRecoveryAudits(retry.runId);
  assert.ok(audits.every((audit) => audit.runId && audit.subjectId && audit.holdId && audit.generation > 0 && audit.reasonCode));
  assert.ok(audits.some((audit) => audit.reasonCode === 'RETRY_SCHEDULED'));
  assert.ok(audits.some((audit) => audit.reasonCode === 'RECOVERY_SUCCEEDED'));

  console.log('Durable Hold v2 的超时边界、失败隔离、指数退避、代际栅栏、恢复审计与跨进程 claim 竞争验证通过');
} finally {
  db.closeDatabase();
  await rm(root, { recursive: true, force: true });
}

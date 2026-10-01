import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-external-waits-'));
process.env.DB_PATH = path.join(root, 'test.sqlite');

const db = await import('../apps/server/src/db/database.ts');
const store = await import('../apps/server/src/collaboration/store.ts');
const inbox = await import('../apps/server/src/messaging/inbox.ts');
const { collaborationControlTools, parseControlCall } = await import('../apps/server/src/collaboration/controlTools.ts');
const { normalizeRuntimeControlAction } = await import('../apps/server/src/runtime/controlAction.ts');
const { planCollaborationAdmission } = await import('../apps/server/src/runtime/subjectContract.ts');
const { executionPolicyForProfile } = await import('../apps/server/src/runtime/runPolicy.ts');
const { observeAction, observeAdmission } = await import('../apps/server/src/runtime/shadow.ts');
const holds = await import('../apps/server/src/runtime/holds.ts');

function seed(label, agentIds = ['a']) {
  const runId = `${label}-${randomUUID()}`;
  const conversationId = `room-${runId}`;
  const now = new Date().toISOString();
  db.run('INSERT INTO conversations (id,title,mode,agent_ids,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    conversationId, label, 'collaboration', JSON.stringify(agentIds), now, now);
  db.run('INSERT INTO runs (id,goal,mode,conversation_id,turn_no,status,agent_ids,created_at) VALUES (?,?,?,?,?,?,?,?)',
    runId, label, 'collaboration', conversationId, 1, 'running', JSON.stringify(agentIds), now);
  const message = inbox.post({ runId, from: 'user', to: agentIds.join(','), kind: 'user', body: label });
  const planned = planCollaborationAdmission({ runId, objective: label, participantIds: agentIds,
    targetAgentIds: agentIds, executionPolicy: executionPolicyForProfile('execute'), controlActionVersion: 2,
    exitGuard: { version: 1, maxCorrections: 1, correctionMaxTokens: 512 },
    completionCandidateVersion: 1, successorObligationVersion: 1, evidenceBundleVersion: 1,
    evidenceLoopGuardVersion: 1, contextContributorVersion: 1, durableHoldVersion: 2, externalWaitVersion: 1 });
  const dispatches = db.tx(() => {
    const created = agentIds.map((agentId) => store.createDispatch({ runId, conversationId,
      sourceMessageId: message.id, kind: 'initial', from: 'user', targetAgentId: agentId, depth: 0,
      idempotencyKey: `initial:${agentId}` }));
    observeAdmission(planned.contract, planned.subjects, created.map((item) => item.id));
    return created;
  });
  const subjectIds = new Map(dispatches.map((dispatch) => [dispatch.targetAgentId,
    db.get('SELECT subject_id FROM runtime_dispatch_subjects WHERE dispatch_id=?', dispatch.id).subject_id]));
  return { runId, conversationId, message, dispatches, subjectIds };
}

function claimAll(item) {
  return item.dispatches.map(() => {
    const claim = store.claimNextDispatch(item.conversationId, `worker:${randomUUID()}`);
    assert.ok(claim);
    return claim;
  });
}

function waitSubject(item, agentId = 'a') {
  const claim = store.claimNextDispatch(item.conversationId, `worker:${agentId}`);
  assert.ok(claim);
  const action = { version: 2, type: 'hold', wake: { kind: 'timer', wakeAt: new Date(Date.now() + 60_000).toISOString() },
    reason: '准备外部等待测试' };
  observeAction({ dispatchId: claim.dispatch.id, attemptId: claim.attempt.id, agentId,
    action, childDispatchIds: [], batchId: null });
  store.finishAttempt({ attemptId: claim.attempt.id, dispatchId: claim.dispatch.id,
    status: 'completed', output: '等待', action });
  return { ...item, claim, subjectId: item.subjectIds.get(agentId) };
}

try {
  const historicalHoldSchema = JSON.stringify(collaborationControlTools(2).find((tool) => tool.name === 'agent.hold'));
  const externalHoldSchema = JSON.stringify(collaborationControlTools(2, { externalWaitVersion: 1 })
    .find((tool) => tool.name === 'agent.hold'));
  assert.doesNotMatch(historicalHoldSchema, /timer|dependency/u, '存量 Contract 不得被动态扩展工具 schema');
  assert.match(externalHoldSchema, /timer/u);
  assert.match(externalHoldSchema, /dependency/u);
  assert.doesNotMatch(externalHoldSchema, /external.event|eventKey|receiver/u,
    '未注册的通用 event 不得暴露给模型');

  const baseTime = '2026-10-01T00:00:00.000Z';
  const timerAction = parseControlCall({ name: 'agent.hold', input: JSON.stringify({
    mode: 'timer', delaySeconds: 30, reason: '稍后重试',
  }) }, ['a', 'b'], 'a', 2, { externalWaitVersion: 1, now: baseTime });
  assert.deepEqual(timerAction, { version: 2, type: 'hold',
    wake: { kind: 'timer', wakeAt: '2026-10-01T00:00:30.000Z' }, reason: '稍后重试' });
  const dependencyAction = parseControlCall({ name: 'agent.hold', input: JSON.stringify({
    mode: 'dependency', targets: ['b'], policy: 'all', timeoutSeconds: 90, reason: '等待实现完成',
  }) }, ['a', 'b'], 'a', 2, { externalWaitVersion: 1, now: baseTime });
  assert.deepEqual(dependencyAction, { version: 2, type: 'hold', wake: { kind: 'dependency',
    targetAgentIds: ['b'], policy: 'all', timeoutAt: '2026-10-01T00:01:30.000Z' }, reason: '等待实现完成' });
  assert.equal(normalizeRuntimeControlAction(timerAction).ok, true);
  assert.equal(normalizeRuntimeControlAction(dependencyAction).ok, true);
  assert.throws(() => parseControlCall({ name: 'agent.hold', input: JSON.stringify({
    mode: 'timer', delaySeconds: 10, reason: '未冻结能力',
  }) }, ['a'], 'a', 2), /未启用 timer Hold/u);
  assert.throws(() => parseControlCall({ name: 'agent.hold', input: JSON.stringify({
    mode: 'event', reason: '空壳事件',
  }) }, ['a'], 'a', 2, { externalWaitVersion: 1 }), /mode 必须/u);

  const timer = waitSubject(seed('timer'));
  const timerHold = holds.createDurableHold({ runId: timer.runId, subjectId: timer.subjectId,
    sourceDispatchId: timer.claim.dispatch.id, sourceAttemptId: timer.claim.attempt.id, holderAgentId: 'a',
    condition: { kind: 'timer', wakeAt: new Date(Date.now() - 1_000).toISOString() },
    recoveryPolicy: { kind: 'wake_run' }, idempotencyKey: `timer:${timer.runId}` });
  const timerClaims = holds.claimReadyDurableHolds({ claimOwner: 'timer-worker', runId: timer.runId });
  assert.deepEqual(timerClaims.map((item) => item.id), [timerHold.id]);
  holds.completeDurableHoldClaim({ id: timerHold.id, claimToken: timerClaims[0].claimToken });

  const dependency = seed('dependency', ['a', 'b']);
  const dependencyClaims = claimAll(dependency);
  const claimA = dependencyClaims.find((item) => item.dispatch.targetAgentId === 'a');
  const claimB = dependencyClaims.find((item) => item.dispatch.targetAgentId === 'b');
  assert.ok(claimA && claimB);
  const completeB = { version: 2, type: 'complete', summary: '依赖已完成' };
  observeAction({ dispatchId: claimB.dispatch.id, attemptId: claimB.attempt.id, agentId: 'b',
    action: completeB, childDispatchIds: [], batchId: null });
  store.finishAttempt({ attemptId: claimB.attempt.id, dispatchId: claimB.dispatch.id,
    status: 'completed', output: '依赖已完成', action: completeB });
  const holdA = { version: 2, type: 'hold', wake: { kind: 'dependency', targetAgentIds: ['b'],
    policy: 'all', timeoutAt: new Date(Date.now() + 60_000).toISOString() }, reason: '等待 B' };
  observeAction({ dispatchId: claimA.dispatch.id, attemptId: claimA.attempt.id, agentId: 'a',
    action: holdA, childDispatchIds: [], batchId: null });
  store.finishAttempt({ attemptId: claimA.attempt.id, dispatchId: claimA.dispatch.id,
    status: 'completed', output: '等待 B', action: holdA });
  const dependencyIds = holds.resolveRunDependencySubjectIds({ runId: dependency.runId,
    requesterSubjectId: dependency.subjectIds.get('a'), targetAgentIds: ['b'] });
  assert.deepEqual(dependencyIds, [dependency.subjectIds.get('b')]);
  const dependencyHold = holds.createDurableHold({ runId: dependency.runId,
    subjectId: dependency.subjectIds.get('a'), sourceDispatchId: claimA.dispatch.id,
    sourceAttemptId: claimA.attempt.id, holderAgentId: 'a',
    condition: { kind: 'dependency', subjectIds: dependencyIds, policy: 'all' }, timeoutAt: holdA.wake.timeoutAt,
    onTimeout: { kind: 'fail', reason: '依赖超时' }, recoveryPolicy: { kind: 'wake_run' },
    idempotencyKey: `dependency:${dependency.runId}` });
  assert.deepEqual(holds.claimReadyDurableHolds({ claimOwner: 'dependency-worker', runId: dependency.runId })
    .map((item) => item.id), [dependencyHold.id]);
  const unrelated = seed('unrelated');
  assert.throws(() => holds.resolveRunDependencySubjectIds({ runId: unrelated.runId,
    requesterSubjectId: unrelated.subjectIds.get('a'), targetAgentIds: ['b'] }), /找不到成员 b/u);

  holds.registerRuntimeExternalEventReceiver({ id: 'test.artifact.v1', payloadSchemaVersion: 1,
    validatePayload: (payload) => typeof payload.artifact === 'string' && payload.status === 'ready' });
  const before = waitSubject(seed('event-before-hold'));
  const beforeEvent = holds.recordRegisteredRuntimeExternalEvent({ receiverId: 'test.artifact.v1',
    runId: before.runId, correlationId: 'artifact:report', generation: 1, sourceEventId: 'source-before-1',
    payload: { artifact: 'report.md', status: 'ready' } });
  assert.equal(holds.recordRegisteredRuntimeExternalEvent({ receiverId: 'test.artifact.v1',
    runId: before.runId, correlationId: 'artifact:report', generation: 1, sourceEventId: 'source-before-1',
    payload: { artifact: 'report.md', status: 'ready' } }).id, beforeEvent.id, '来源事件必须幂等去重');
  assert.throws(() => holds.recordRegisteredRuntimeExternalEvent({ receiverId: 'test.artifact.v1',
    runId: before.runId, correlationId: 'artifact:report', generation: 1, sourceEventId: 'invalid-payload',
    payload: { artifact: 42, status: 'ready' } }), /payload 不符合/u);
  const beforeHold = holds.createDurableHold({ runId: before.runId, subjectId: before.subjectId,
    sourceDispatchId: before.claim.dispatch.id, sourceAttemptId: before.claim.attempt.id, holderAgentId: 'a',
    condition: holds.registeredRuntimeExternalEventCondition({ receiverId: 'test.artifact.v1',
      correlationId: 'artifact:report', generation: 1 }), timeoutAt: new Date(Date.now() + 60_000).toISOString(),
    onTimeout: { kind: 'fail' }, recoveryPolicy: { kind: 'wake_run' }, idempotencyKey: `event:${before.runId}` });
  assert.deepEqual(holds.claimReadyDurableHolds({ claimOwner: 'event-before-worker', runId: before.runId })
    .map((item) => item.id), [beforeHold.id], 'event-before-hold 必须在订阅建立后匹配');

  const fenced = waitSubject(seed('event-fenced'));
  const other = seed('event-other');
  const fencedHold = holds.createDurableHold({ runId: fenced.runId, subjectId: fenced.subjectId,
    sourceDispatchId: fenced.claim.dispatch.id, sourceAttemptId: fenced.claim.attempt.id, holderAgentId: 'a',
    condition: holds.registeredRuntimeExternalEventCondition({ receiverId: 'test.artifact.v1',
      correlationId: 'artifact:fenced', generation: 2 }), timeoutAt: new Date(Date.now() + 60_000).toISOString(),
    onTimeout: { kind: 'fail' }, recoveryPolicy: { kind: 'wake_run' }, idempotencyKey: `event:${fenced.runId}` });
  holds.recordRegisteredRuntimeExternalEvent({ receiverId: 'test.artifact.v1', runId: fenced.runId,
    correlationId: 'artifact:fenced', generation: 1, sourceEventId: 'old-generation',
    payload: { artifact: 'old.md', status: 'ready' } });
  holds.recordRegisteredRuntimeExternalEvent({ receiverId: 'test.artifact.v1', runId: other.runId,
    correlationId: 'artifact:fenced', generation: 2, sourceEventId: 'cross-run',
    payload: { artifact: 'other.md', status: 'ready' } });
  assert.equal(holds.claimReadyDurableHolds({ claimOwner: 'fenced-worker', runId: fenced.runId }).length, 0,
    '跨 Run 或旧 generation 事件不得匹配');
  holds.recordRegisteredRuntimeExternalEvent({ receiverId: 'test.artifact.v1', runId: fenced.runId,
    correlationId: 'artifact:fenced', generation: 2, sourceEventId: 'current-generation',
    payload: { artifact: 'current.md', status: 'ready' } });
  assert.deepEqual(holds.claimReadyDurableHolds({ claimOwner: 'fenced-worker', runId: fenced.runId })
    .map((item) => item.id), [fencedHold.id]);

  const timeout = waitSubject(seed('event-timeout'));
  holds.createDurableHold({ runId: timeout.runId, subjectId: timeout.subjectId,
    sourceDispatchId: timeout.claim.dispatch.id, sourceAttemptId: timeout.claim.attempt.id, holderAgentId: 'a',
    condition: holds.registeredRuntimeExternalEventCondition({ receiverId: 'test.artifact.v1',
      correlationId: 'artifact:never', generation: 1 }), timeoutAt: new Date(Date.now() - 1_000).toISOString(),
    onTimeout: { kind: 'fail', reason: '事件未到达' }, recoveryPolicy: { kind: 'wake_run' },
    idempotencyKey: `event:${timeout.runId}` });
  assert.equal(holds.claimReadyDurableHolds({ claimOwner: 'timeout-worker', runId: timeout.runId }).length, 0);
  assert.equal(holds.listDurableHolds(timeout.runId)[0].lastErrorCode, 'HOLD_TIMEOUT');

  console.log('Runtime timer/dependency 与注册 External Event 等待入口验证通过');
} finally {
  db.closeDatabase();
  await rm(root, { recursive: true, force: true });
}

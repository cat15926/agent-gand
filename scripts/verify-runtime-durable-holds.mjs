import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function childRecovery() {
  const db = await import('../apps/server/src/db/database.ts');
  const holds = await import('../apps/server/src/runtime/holds.ts');
  try {
    const claimed = holds.claimReadyDurableHolds({ claimOwner: 'restart-worker', runId: process.env.RUNTIME_HOLD_RUN_ID });
    assert.equal(claimed.length, 1, '重启后的新进程必须能认领到期 Hold');
    const completed = holds.completeDurableHoldClaim({ id: claimed[0].id, claimToken: claimed[0].claimToken,
      resolution: { recoveredAfterRestart: true } });
    assert.equal(completed.status, 'resumed');
  } finally {
    db.closeDatabase();
  }
}

async function parentVerification() {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-durable-holds-'));
  process.env.DB_PATH = path.join(root, 'test.sqlite');
  process.env.COLLAB_RUNTIME_ATOMIC = 'true';
  const db = await import('../apps/server/src/db/database.ts');
  const store = await import('../apps/server/src/collaboration/store.ts');
  const inbox = await import('../apps/server/src/messaging/inbox.ts');
  const { planCollaborationAdmission } = await import('../apps/server/src/runtime/subjectContract.ts');
  const { observeAction, observeAdmission } = await import('../apps/server/src/runtime/shadow.ts');
  const holds = await import('../apps/server/src/runtime/holds.ts');

  const seed = (label) => {
    const runId = `${label}-${randomUUID()}`; const conversationId = `room-${runId}`; const now = new Date().toISOString();
    db.run('INSERT INTO conversations (id,title,mode,agent_ids,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      conversationId, label, 'collaboration', '["a"]', now, now);
    db.run('INSERT INTO runs (id,goal,mode,conversation_id,turn_no,status,agent_ids,created_at) VALUES (?,?,?,?,?,?,?,?)',
      runId, label, 'collaboration', conversationId, 1, 'running', '["a"]', now);
    const message = inbox.post({ runId, from: 'user', to: 'a', kind: 'user', body: label });
    const planned = planCollaborationAdmission({ runId, objective: label, participantIds: ['a'], targetAgentIds: ['a'],
      controlActionVersion: 2, durableHoldVersion: 1 });
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
    return { runId, conversationId, dispatch, attempt: claim.attempt, subjectId, message };
  };

  const create = (item, condition, suffix, recoveryPolicy = { kind: 'wake_run' }) => holds.createDurableHold({
    runId: item.runId, subjectId: item.subjectId, sourceDispatchId: item.dispatch.id,
    sourceAttemptId: item.attempt.id, holderAgentId: 'a', condition, recoveryPolicy,
    idempotencyKey: `${suffix}:${item.runId}`,
  });

  try {
    const user = seed('user-decision');
    const decision = store.createDecision({ runId: user.runId, conversationId: user.conversationId,
      dispatchId: user.dispatch.id, idempotencyKey: `decision:${user.runId}`, kind: 'agent_question',
      promptMessageId: user.message.id, payload: { agentId: 'a' } });
    const userHold = create(user, { kind: 'user_decision', decisionId: decision.id }, 'user');
    assert.equal(create(user, { kind: 'user_decision', decisionId: decision.id }, 'user').id, userHold.id,
      'Hold 幂等重放必须返回同一记录');
    const wake = holds.recordRuntimeWakeEvent({ runId: user.runId, kind: 'user_decision', sourceKey: decision.id,
      payload: { answer: '继续' }, idempotencyKey: `wake:${decision.id}` });
    assert.equal(holds.recordRuntimeWakeEvent({ runId: user.runId, kind: 'user_decision', sourceKey: decision.id,
      payload: { answer: '继续' }, idempotencyKey: `wake:${decision.id}` }).id, wake.id, '重复事件必须去重');
    const userClaim = holds.claimReadyDurableHolds({ claimOwner: 'worker-a', runId: user.runId });
    assert.equal(userClaim.length, 1);
    assert.equal(holds.claimReadyDurableHolds({ claimOwner: 'worker-b', runId: user.runId }).length, 0,
      '未过期 claim 不得被第二执行者抢走');
    holds.completeDurableHoldClaim({ id: userClaim[0].id, claimToken: userClaim[0].claimToken });

    const timer = seed('timer');
    create(timer, { kind: 'timer', wakeAt: new Date(Date.now() - 1_000).toISOString() }, 'timer');
    const timerClaim = holds.claimReadyDurableHolds({ claimOwner: 'timer-a', runId: timer.runId });
    assert.equal(timerClaim.length, 1);
    assert.equal(holds.claimReadyDurableHolds({ claimOwner: 'timer-b', runId: timer.runId }).length, 0,
      '定时器并发只能产生一个 owner');
    holds.completeDurableHoldClaim({ id: timerClaim[0].id, claimToken: timerClaim[0].claimToken });

    const event = seed('event');
    create(event, { kind: 'event', eventKey: 'artifact-ready' }, 'event');
    holds.recordRuntimeWakeEvent({ runId: event.runId, kind: 'event', sourceKey: 'artifact-ready',
      payload: { artifact: 'report.md' }, idempotencyKey: 'event:artifact-ready' });
    assert.equal(holds.claimReadyDurableHolds({ claimOwner: 'event-worker', runId: event.runId }).length, 1);

    const dependency = seed('dependency'); const completedSubjectId = randomUUID(); const now = new Date().toISOString();
    db.run(`INSERT INTO runtime_subjects (id,run_id,subject_key,kind,parent_subject_id,status,objective,created_at,updated_at)
      VALUES (?,?,?,'consultation',?,'completed',?,?,?)`, completedSubjectId, dependency.runId,
    `dep:${completedSubjectId}`, dependency.subjectId, '依赖完成', now, now);
    create(dependency, { kind: 'dependency', subjectIds: [completedSubjectId], policy: 'all' }, 'dependency');
    assert.equal(holds.claimReadyDurableHolds({ claimOwner: 'dependency-worker', runId: dependency.runId }).length, 1);

    const approval = seed('approval');
    const approvalId = `approval-${randomUUID()}`;
    db.run(`INSERT INTO approvals (id,run_id,agent_id,tool_name,input,reason,status,created_at)
      VALUES (?,?,?,?,?,?,'pending',?)`, approvalId, approval.runId, 'a', 'fs.write', '{}', '测试审批', new Date().toISOString());
    create(approval, { kind: 'approval', approvalId }, 'approval');
    holds.recordRuntimeWakeEvent({ runId: approval.runId, kind: 'approval', sourceKey: approvalId,
      payload: { status: 'approved' }, idempotencyKey: `approval:${approvalId}` });
    assert.equal(holds.claimReadyDurableHolds({ claimOwner: 'approval-worker', runId: approval.runId }).length, 1);

    const lease = seed('lease');
    db.run("UPDATE collaboration_attempts SET status='interrupted' WHERE id=?", lease.attempt.id);
    create(lease, { kind: 'lease_recovery', attemptId: lease.attempt.id,
      leaseExpiredAt: new Date(Date.now() - 1_000).toISOString() }, 'lease',
    { kind: 'requeue_dispatch', dispatchId: lease.dispatch.id });
    assert.equal(holds.claimReadyDurableHolds({ claimOwner: 'lease-worker', runId: lease.runId }).length, 1);

    const stopped = seed('stop-race');
    create(stopped, { kind: 'event', eventKey: 'late-event' }, 'stop');
    holds.recordRuntimeWakeEvent({ runId: stopped.runId, kind: 'event', sourceKey: 'late-event',
      idempotencyKey: 'event:late' });
    const stopClaim = holds.claimReadyDurableHolds({ claimOwner: 'stop-worker', runId: stopped.runId });
    assert.equal(stopClaim.length, 1);
    db.run("UPDATE runs SET status='cancelled' WHERE id=?", stopped.runId);
    holds.cancelDurableHolds(stopped.runId, 'user_stop');
    assert.throws(() => holds.completeDurableHoldClaim({ id: stopClaim[0].id, claimToken: stopClaim[0].claimToken }),
      /claim 已失效|Run 已终结/u, 'Stop 必须赢过迟到 wake');
    holds.recordRuntimeWakeEvent({ runId: stopped.runId, kind: 'event', sourceKey: 'late-event',
      payload: { late: true }, idempotencyKey: 'event:late-after-stop' });
    assert.equal(holds.claimReadyDurableHolds({ claimOwner: 'late-worker', runId: stopped.runId }).length, 0);

    const restart = seed('restart');
    create(restart, { kind: 'timer', wakeAt: new Date(Date.now() - 120_000).toISOString() }, 'restart');
    const abandoned = holds.claimReadyDurableHolds({ claimOwner: 'crashed-worker', runId: restart.runId,
      now: new Date(Date.now() - 60_000).toISOString() });
    assert.equal(abandoned.length, 1, '崩溃注入前必须留下一个已过期 claim');
    db.closeDatabase();
    const child = spawnSync(process.execPath,
      ['--import', './apps/server/node_modules/tsx/dist/loader.mjs', fileURLToPath(import.meta.url)],
      { cwd: path.resolve(fileURLToPath(new URL('..', import.meta.url))), encoding: 'utf8',
        env: { ...process.env, DB_PATH: process.env.DB_PATH, RUNTIME_HOLD_CHILD: '1', RUNTIME_HOLD_RUN_ID: restart.runId } });
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    console.log('Durable Hold/Wake 的重启、事件去重、定时器竞争、Stop 竞态、依赖、审批与租约恢复验证通过');
  } finally {
    try { db.closeDatabase(); } catch { /* already closed before restart child */ }
    await rm(root, { recursive: true, force: true });
  }
}

if (process.env.RUNTIME_HOLD_CHILD === '1') await childRecovery();
else await parentVerification();

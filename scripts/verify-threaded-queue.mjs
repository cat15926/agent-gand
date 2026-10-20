import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import { isolateRuntimeFixture, openRuntimeFixture } from './fixtures/threadedRuntimeFixture.mjs';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-threaded-queue-')));
const originalFetch = globalThis.fetch;
isolateRuntimeFixture(root);
const { config } = await import('../apps/server/src/config.ts'); config.sandboxDir = path.join(root, 'sandbox');
const { applyOrchestrationSchemaMigrations } = await import('../apps/server/src/db/orchestrationMigrations.ts');
const { createThreadedStore } = await import('../apps/server/src/threaded/store.ts');
const schema = await readFile(new URL('../apps/server/src/db/schema.sql', import.meta.url), 'utf8');
const fixtures = [], checks = [];
const count = (db, name) => db.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n;

async function fixture(name, withAccount = false) {
  const file = path.join(root, `${name}.sqlite`), db = new Database(file);
  db.pragma('foreign_keys = ON'); db.exec(schema);
  db.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER');
  applyOrchestrationSchemaMigrations(db);
  const now = new Date().toISOString();
  if (withAccount) db.prepare(`INSERT INTO accounts(id,display_name,provider,auth_type,source,version,config_version,
    credential_version,created_at,updated_at) VALUES('fixture-account','Fixture','mock','api_key','managed',1,1,1,?,?)`).run(now, now);
  for (const id of ['aa', 'bb']) db.prepare(`INSERT INTO agents(id,name,definition,source,created_at,updated_at)
    VALUES(?,?,?,'fixture',?,?)`).run(id, id, JSON.stringify({ id, name: id, model: 'mock:fixture', version: 1,
      enabled: true, tools: [], permissionMode: 'readonly', systemPrompt: 'Fixture',
      ...(withAccount ? { accountRef: 'fixture-account' } : {}) }), now, now);
  db.exec('CREATE TABLE fixture_external_calls(attempt_id TEXT PRIMARY KEY,invocation_id TEXT NOT NULL,created_at INTEGER NOT NULL)');
  const thread = createThreadedStore(db).createThread({ title: name, members: ['aa', 'bb'].map(agentId => ({
    agentId, handle: agentId, roleVersion: 1, permissionVersion: 1,
  })) });
  db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(thread.id);
  db.close();
  const f = await openRuntimeFixture(file);
  fixtures.push(f);
  const user = (values = {}) => ({ ownerId: thread.ownerId, threadId: thread.id, clientRequestId: randomUUID(),
    body: name, targets: ['aa'], ...values });
  const control = action => f.runtime.lifecycle.requestControl({ ownerId: thread.ownerId,
    scope: { kind: 'thread', threadId: thread.id }, action, requestId: randomUUID() });
  return { ...f, thread, user, control };
}

try {
  {
    const f = await fixture('notification-order');
    const first = f.runtime.messages.acceptUserMessage(f.user()), second = f.runtime.messages.acceptUserMessage(f.user());
    const late = f.runtime.queue.enqueueWake(second.wakes[0].id), early = f.runtime.queue.enqueueWake(first.wakes[0].id);
    assert.ok(early.seq < late.seq);
    assert.equal(f.runtime.queue.claimNext('fixture').queue.id, early.id);
    checks.push('Durable FIFO follows source Wake insertion order even when notifications arrive in reverse order.');
  }
  {
    const f = await fixture('pause-resume');
    const accepted = f.runtime.messages.acceptUserMessage(f.user());
    const original = f.runtime.queue.enqueueWake(accepted.wakes[0].id);
    f.control('pause');
    assert.equal(f.runtime.queue.claimNext('fixture'), null);
    assert.equal(f.runtime.queue.getQueue(original.id).state, 'blocked');
    f.control('resume');
    const claim = f.runtime.queue.claimNext('fixture');
    assert.equal(claim.queue.id, original.id); assert.equal(claim.queue.seq, original.seq);
    assert.equal(claim.queue.authorizationVersion, 2);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_wake_authorizations WHERE queue_id=?').get(original.id).n, 2);
    assert.deepEqual(f.runtime.messages.acceptUserMessage(f.user({ clientRequestId: 'new-after-resume' })).message.targets, ['aa']);
    checks.push('Explicit Owner pause/resume records a new scope/epoch authorization, preserves queue age and leaves the original Wake receipt immutable.');
  }
  {
    const f = await fixture('old-resume-proof');
    const accepted = f.runtime.messages.acceptUserMessage(f.user());
    const queue = f.runtime.queue.enqueueWake(accepted.wakes[0].id);
    f.control('pause'); f.control('resume');
    f.runtime.queue.refreshEligibility(queue.id);
    f.db.prepare('UPDATE threaded_threads SET authority_epoch=authority_epoch+1 WHERE id=?').run(f.thread.id);
    assert.equal(f.runtime.queue.claimNext('fixture'), null);
    assert.equal(f.runtime.queue.getQueue(queue.id).reason, 'THREADED_QUEUE_OWNER_RESUME_REQUIRED');
    assert.equal(count(f.db, 'runs'), 0);
    checks.push('An old resume receipt cannot authorize a later unrelated epoch change.');
  }
  {
    const f = await fixture('cancel-reopen-watermark');
    const old = f.runtime.messages.acceptUserMessage(f.user());
    f.control('stop'); f.control('resume');
    const fresh = f.runtime.messages.acceptUserMessage(f.user());
    // No queue scan happened between stop and resume.
    const claim = f.runtime.queue.claimNext('fixture');
    assert.equal(f.runtime.queue.getQueueForWake(old.wakes[0].id).state, 'cancelled');
    assert.equal(claim.queue.wakeId, fresh.wakes[0].id);
    const oldBoundary = f.db.prepare('SELECT control_seq FROM threaded_message_control_boundaries WHERE message_id=?').get(old.message.id);
    const newBoundary = f.db.prepare('SELECT control_seq FROM threaded_message_control_boundaries WHERE message_id=?').get(fresh.message.id);
    assert.ok(newBoundary.control_seq > oldBoundary.control_seq);
    checks.push('Stop/reopen cannot revive an unscanned old Wake; a new message has an atomic control watermark and remains admissible.');
  }
  {
    for (const change of ['permission', 'role', 'account']) {
      const f = await fixture(`identity-drift-${change}`, change === 'account');
      const accepted = f.runtime.messages.acceptUserMessage(f.user());
      const queued = f.runtime.queue.enqueueWake(accepted.wakes[0].id);
      f.control('pause');
      if (change === 'permission') f.db.prepare("UPDATE threaded_members SET permission_version=permission_version+1 WHERE thread_id=? AND agent_id='aa'").run(f.thread.id);
      if (change === 'role') f.db.prepare("UPDATE agents SET definition=json_set(definition,'$.systemPrompt','Changed role') WHERE id='aa'").run();
      if (change === 'account') f.db.prepare("UPDATE accounts SET config_version=config_version+1 WHERE id='fixture-account'").run();
      f.control('resume');
      assert.equal(f.runtime.queue.claimNext('fixture'), null);
      assert.equal(f.runtime.queue.getQueue(queued.id).reason, 'THREADED_QUEUE_SOURCE_AUTHORITY_CHANGED');
      assert.equal(count(f.db, 'runs'), 0);
    }
    checks.push('Owner resume cannot silently adopt changed permissions, role definition or account configuration.');
  }
  {
    for (const target of ['execution_resource_claims', 'threaded_budget_requests', 'runs', 'threaded_attempts', 'threaded_queue_claims']) {
      const f = await fixture(`claim-fault-${target}`);
      const receipt = f.runtime.messages.acceptUserMessage(f.user());
      f.runtime.queue.enqueueWake(receipt.wakes[0].id);
      f.db.exec(`CREATE TRIGGER fixture_claim_failure BEFORE INSERT ON ${target} BEGIN SELECT RAISE(ABORT,'fixture_claim_failure'); END`);
      assert.throws(() => f.runtime.queue.claimNext('fixture'), /fixture_claim_failure/);
      for (const table of ['execution_resource_claims', 'threaded_budget_requests', 'threaded_budget_attempts',
        'threaded_budget_invocations', 'threaded_attempts', 'runs', 'threaded_queue_claims']) assert.equal(count(f.db, table), 0, table);
      assert.equal(count(f.db, 'threaded_invocations'), 1, 'a waiting Invocation may exist without a Run or budget charge');
      f.db.exec('DROP TRIGGER fixture_claim_failure');
      const claimed = f.runtime.queue.claimNext('fixture'); assert.ok(claimed);
      assert.equal(count(f.db, 'threaded_invocations'), 1); assert.equal(count(f.db, 'runs'), 1);
    }
    checks.push('Resource, budget, Run, Attempt and dispatch insertion faults atomically roll back the entire claim while retaining one waiting Invocation.');
  }
  {
    const f = await fixture('blocked-no-notification-loop');
    const receipt = f.runtime.messages.acceptUserMessage(f.user({ targets: ['aa', 'bb'] }));
    f.runtime.budget.ensureRootForMessage(receipt.message.id);
    f.runtime.budget.reviseRoot({ ownerId: f.thread.ownerId, rootId: receipt.message.id, expectedVersion: 1,
      requestId: randomUUID(), reason: 'Fixture limit', patch: { maxInvocations: 1 } });
    assert.ok(f.runtime.queue.claimNext('fixture'));
    assert.equal(f.runtime.queue.claimNext('fixture'), null);
    const queueEvents = count(f.db, 'threaded_queue_events'), resourceEvents = count(f.db, 'execution_resource_availability');
    for (let i = 0; i < 4; i++) assert.equal(f.runtime.queue.claimNext('fixture'), null);
    assert.equal(count(f.db, 'threaded_queue_events'), queueEvents);
    assert.equal(count(f.db, 'execution_resource_availability'), resourceEvents);
    checks.push('A persistently budget-blocked candidate does not churn eligible flags or emit self-sustaining availability events.');
  }
  {
    const f = await fixture('commit-notification');
    const one = f.runtime.messages.acceptUserMessage(f.user()), two = f.runtime.messages.acceptUserMessage(f.user());
    const events = [];
    f.runtime.queue.onAvailable(event => { assert.equal(f.db.inTransaction, false); events.push(event); });
    assert.throws(() => f.db.transaction(() => {
      f.runtime.queue.enqueueWake(one.wakes[0].id); throw new Error('fixture_rollback');
    })(), /fixture_rollback/);
    await Promise.resolve();
    assert.equal(events.length, 0);
    f.db.transaction(() => { f.runtime.queue.enqueueWake(two.wakes[0].id); assert.equal(events.length, 0); })();
    await Promise.resolve();
    assert.ok(events.length > 0); assert.ok(events.every(event => event.queueId === f.runtime.queue.getQueueForWake(two.wakes[0].id).id));
    checks.push('Nested queue writes emit only committed durable events after the outer transaction; rollback emits none.');
  }
  {
    const f = await fixture('source-acl-after-claim');
    const source = f.runtime.messages.acceptUserMessage(f.user({ targets: [] }));
    const destination = createThreadedStore(f.db).createThread({ title: 'Destination',
      members: ['aa', 'bb'].map(agentId => ({ agentId, handle: agentId, roleVersion: 1, permissionVersion: 1 })) });
    f.db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(destination.id);
    f.runtime.messages.acceptUserMessage(f.user({ threadId: destination.id, sourceRefs: [source.message.id] }));
    const claim = f.runtime.queue.claimNext('fixture'); assert.ok(claim);
    f.db.prepare("UPDATE threaded_members SET permission_version=permission_version+1 WHERE thread_id=? AND agent_id='aa'").run(f.thread.id);
    f.runtime.authority.assertAuthorized(claim.binding); // Destination/Attempt identity itself is still current.
    assert.throws(() => f.runtime.queue.assertExecutable(claim.binding), /SOURCE_AUTHORITY_CHANGED/);
    checks.push('Effect callbacks recheck source-Thread ACL snapshots after claim, even when the destination Binding remains authorized.');
  }
  {
    const f = await fixture('blocked-fifo-resume');
    const older = f.runtime.messages.acceptUserMessage(f.user()), second = f.runtime.messages.acceptUserMessage(f.user());
    f.runtime.budget.ensureRootForMessage(older.message.id);
    f.runtime.budget.reviseRoot({ ownerId: f.thread.ownerId, rootId: older.message.id, expectedVersion: 1,
      requestId: randomUUID(), reason: 'Fixture paused root', state: 'paused' });
    const active = f.runtime.queue.claimNext('fixture');
    assert.equal(active.queue.wakeId, second.wakes[0].id);
    const original = f.runtime.queue.getQueueForWake(older.wakes[0].id);
    const younger = f.runtime.messages.acceptUserMessage(f.user());
    assert.equal(f.runtime.queue.claimNext('fixture'), null);
    f.runtime.budget.reviseRoot({ ownerId: f.thread.ownerId, rootId: older.message.id, expectedVersion: 2,
      requestId: randomUUID(), reason: 'Fixture resume root', state: 'open' });
    await f.runtime.executeClaim(active);
    const next = f.runtime.queue.claimNext('fixture');
    assert.equal(next.queue.wakeId, older.wakes[0].id);
    assert.equal(next.queue.seq, original.seq);
    assert.equal(f.runtime.queue.getQueueForWake(younger.wakes[0].id).state, 'queued');
    checks.push('A budget-blocked same-slot Wake retains its age and precedes a later waiting source after Owner budget resume.');
  }
  {
    const f = await fixture('terminal-control-recovery');
    f.runtime.messages.acceptUserMessage(f.user());
    const claim = f.runtime.queue.claimNext('fixture');
    f.control('pause');
    const quiescence = f.proof(claim.binding, { reason: 'not_started', sideEffects: 'none' });
    f.runtime.lifecycle.recordOutcome(claim.binding, { kind: 'not_started', reason: 'Fixture pause before I/O', quiescence });
    assert.equal(f.runtime.queue.getQueue(claim.queue.id).state, 'blocked');
    f.control('stop');
    assert.equal(f.db.prepare('SELECT status FROM threaded_invocations WHERE id=?').get(claim.binding.invocationId).status, 'cancelled');
    const plans = f.runtime.queue.recover();
    assert.equal(f.runtime.queue.getQueue(claim.queue.id).state, 'cancelled');
    assert.equal(plans.find(plan => plan.queueId === claim.queue.id).dispatch.phase, 'settled');
    assert.equal(f.runtime.queue.claimNext('fixture'), null);
    const events = count(f.db, 'threaded_queue_events');
    f.runtime.queue.recover();
    assert.equal(count(f.db, 'threaded_queue_events'), events);
    assert.equal(f.executionCalls, 0);
    checks.push('Recovery idempotently projects a durable control terminal after prior quiescence without executing or reclaiming its Wake.');
  }
  for (const f of fixtures) assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  console.log(JSON.stringify({ ok: true, groups: checks.length, checks,
    scope: 'T06 deterministic queue and injected fake-runtime SQLite fixtures; no production database, network or real model' }, null, 2));
} finally {
  for (const f of fixtures) f.close();
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}

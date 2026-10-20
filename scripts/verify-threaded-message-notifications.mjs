import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import { createFakeThreadedResources } from './fixtures/threadedFakeExecutor.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-threaded-notifications-'));
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DB_PATH: path.join(root, 'unused-singleton.sqlite'), AGENTS_DIR: path.join(root, 'agents') });
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('Network forbidden in notification fixture'); };
const { config } = await import('../apps/server/src/config.ts');
config.sandboxDir = path.join(root, 'sandbox');
const { applyOrchestrationSchemaMigrations } = await import('../apps/server/src/db/orchestrationMigrations.ts');
const { createThreadedStore } = await import('../apps/server/src/threaded/store.ts');
const { createThreadedAuthority } = await import('../apps/server/src/threaded/authority.ts');
const { createThreadedLifecycle } = await import('../apps/server/src/threaded/lifecycle.ts');
const { createThreadedMessaging } = await import('../apps/server/src/threaded/messaging.ts');
const schema = await readFile(new URL('../apps/server/src/db/schema.sql', import.meta.url), 'utf8');
const databases = [], services = [], checks = [], unhandled = [];
const onUnhandled = error => { unhandled.push(error); };
process.on('unhandledRejection', onUnhandled);
const tick = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const count = (db, table) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;

function fixture(name, repairIntervalMs = 0) {
  const db = new Database(':memory:'); databases.push(db);
  db.pragma('foreign_keys=ON'); db.exec(schema);
  db.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER');
  applyOrchestrationSchemaMigrations(db);
  const stamp = new Date().toISOString();
  for (const id of ['aa', 'bb']) db.prepare(`INSERT INTO agents(id,name,definition,source,created_at,updated_at)
    VALUES(?,?,?,'fixture',?,?)`).run(id, id, JSON.stringify({ id, version: 1, enabled: true,
      model: 'mock:fixture', tools: [], permissionMode: 'readonly' }), stamp, stamp);
  const store = createThreadedStore(db);
  const thread = store.createThread({ title: name,
    members: ['aa', 'bb'].map(agentId => ({ agentId, handle: agentId, roleVersion: 1, permissionVersion: 1 })) });
  db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(thread.id);
  const resources = createFakeThreadedResources(), authority = createThreadedAuthority(db, resources);
  const lifecycle = createThreadedLifecycle(db, authority, { resources });
  const newService = (interval = repairIntervalMs) => {
    const service = createThreadedMessaging(db, { authority, repairIntervalMs: interval });
    services.push(service); return service;
  };
  const service = newService();
  const user = (extra = {}) => ({ ownerId: thread.ownerId, threadId: thread.id,
    clientRequestId: randomUUID(), body: name, ...extra });
  const binding = () => {
    const invocation = lifecycle.createInvocation({ ownerId: thread.ownerId, threadId: thread.id,
      agentId: 'aa', causalRootId: randomUUID(), goal: name, requestId: randomUUID() });
    const value = lifecycle.prepareAttempt({ ownerId: thread.ownerId, invocationId: invocation.id,
      claim: resources.acquire({ ownerId: thread.ownerId, threadId: thread.id, invocationId: invocation.id,
        runId: invocation.runId, agentId: 'aa' }) });
    lifecycle.startAttempt(value); return value;
  };
  return { db, service, newService, user, binding, resources };
}

try {
  {
    const f = fixture('commit-before-hint'), hints = [];
    f.service.onNotification(hint => {
      assert.equal(f.db.inTransaction, false);
      assert.ok(f.db.prepare('SELECT 1 FROM threaded_outbox WHERE id=?').get(hint.eventId));
      assert.equal(Object.hasOwn(hint, 'body'), false); hints.push(hint);
    });
    const input = f.user({ targets: ['bb'], body: 'body must not enter notification' });
    const receipt = f.service.messages.acceptUserMessage(input);
    assert.equal(hints.length, 0, 'acceptance returns before internal microtask notification');
    await tick();
    assert.deepEqual(hints.map(hint => hint.eventId), receipt.outboxIds);
    assert.equal(count(f.db, 'threaded_outbox_receipts'), 2);
    assert.deepEqual(f.service.messages.acceptUserMessage(input), receipt);
    await tick(); assert.equal(hints.length, 2);
    assert.equal(count(f.db, 'runs'), 0);
    checks.push('Standalone acceptance commits before synchronous ID-only callbacks; duplicate acceptance does not invent notifications, receipts or Runs');
  }
  {
    const f = fixture('outer-transaction-notification'), hints = [], binding = f.binding();
    const input = { binding, responseCommitKey: 'final-response', body: 'outer response', targets: ['bb'],
      quiescence: f.resources.quiescent(binding) };
    f.service.onNotification(hint => { assert.equal(f.db.inTransaction, false); hints.push(hint); });
    assert.throws(() => f.db.transaction(() => {
      f.service.messages.appendResponseWithinTransaction(input);
      f.service.notifyCommitted();
      assert.equal(hints.length, 0);
      throw new Error('fixture_outer_rollback');
    }).immediate(), /fixture_outer_rollback/);
    await tick();
    assert.equal(hints.length, 0); assert.equal(count(f.db, 'threaded_messages'), 0);
    let receipt;
    f.db.transaction(() => {
      receipt = f.service.messages.appendResponseWithinTransaction(input);
      f.service.notifyCommitted(); assert.equal(hints.length, 0);
    }).immediate();
    assert.equal(hints.length, 0); await tick();
    assert.deepEqual(hints.map(hint => hint.eventId), receipt.outboxIds);
    assert.equal(count(f.db, 'runs'), 1, 'only the explicit fake-boundary fixture Run exists');
    checks.push('Outer response rollback emits nothing; committed response hints occur outside the transaction without scheduling another Run');
  }
  {
    const f = fixture('throwing-listener'), good = [];
    const remove = f.service.onNotification(() => { throw new Error('fixture listener'); });
    f.service.onNotification(hint => { good.push(hint); });
    const receipt = f.service.messages.acceptUserMessage(f.user());
    await tick();
    assert.equal(good.length, 1, 'one broken listener must not suppress other subscribers');
    assert.equal(count(f.db, 'threaded_outbox_receipts'), 0);
    assert.equal(f.service.diagnostics().lastError, 'THREADED_HINT_LISTENER_FAILED');
    remove(); await delay(125); f.service.recover(); await tick();
    assert.deepEqual(good.map(hint => hint.eventId), [receipt.outboxIds[0], receipt.outboxIds[0]]);
    assert.equal(count(f.db, 'threaded_outbox_receipts'), 1);
    assert.equal(f.service.diagnostics().lastError, null);
    checks.push('Thrown listener does not starve peers or undo committed work; delayed repair repeats the same event and records one consumer receipt');
  }
  {
    const f = fixture('async-listener'), good = [];
    const remove = f.service.onNotification(async () => { throw new Error('fixture async listener'); });
    f.service.onNotification(hint => { good.push(hint); });
    const receipt = f.service.messages.acceptUserMessage(f.user());
    await tick(); await tick();
    assert.equal(good.length, 1); assert.equal(count(f.db, 'threaded_outbox_receipts'), 0);
    assert.equal(unhandled.length, 0);
    remove(); await delay(125); f.service.recover(); await tick();
    assert.deepEqual(good.map(hint => hint.eventId), [receipt.outboxIds[0], receipt.outboxIds[0]]);
    assert.equal(count(f.db, 'threaded_outbox_receipts'), 1);
    checks.push('Unsupported async listener is drained without unhandled rejection and leaves its original event recoverable');
  }
  {
    const f = fixture('reentrant-enqueue'), hints = [];
    let nested;
    f.service.onNotification(hint => {
      hints.push(hint);
      if (!nested) nested = f.service.messages.acceptUserMessage(f.user({ body: 'created during first notification' }));
    });
    const original = f.service.messages.acceptUserMessage(f.user());
    await tick();
    assert.deepEqual(hints.map(hint => hint.eventId), [...original.outboxIds, ...nested.outboxIds]);
    assert.equal(count(f.db, 'threaded_outbox_receipts'), 2);
    assert.equal(f.service.outbox.scanPending().events.length, 0);
    checks.push('A synchronous listener can enqueue another durable message outside a transaction; reentrant invalidation drains both sources exactly once in the normal path');
  }
  {
    const f = fixture('bounded-drain'), expected = [], seen = [];
    for (let i = 0; i < 205; i++) expected.push(...f.service.messages.acceptUserMessage(f.user({ body: `message ${i}` })).outboxIds);
    f.service.onNotification(hint => { seen.push(hint.eventId); });
    await Promise.resolve();
    assert.equal(seen.length, 100, 'the service yields after one bounded batch');
    for (let i = 0; i < 10 && seen.length < expected.length; i++) await tick();
    assert.deepEqual(seen, expected);
    assert.equal(count(f.db, 'threaded_outbox_receipts'), 205);
    checks.push('A 205-event backlog drains in persisted sequence across bounded 100-event turns without losing low or high sequence numbers');
  }
  {
    const f = fixture('closed-service-restart', 10), before = [], after = [];
    f.service.onNotification(hint => { before.push(hint); });
    const receipt = f.service.messages.acceptUserMessage(f.user());
    f.service.close(); f.service.notifyCommitted(); await delay(25);
    assert.equal(before.length, 0); assert.equal(count(f.db, 'threaded_outbox_receipts'), 0);
    assert.throws(() => f.service.onNotification(() => {}), /MESSAGING_CLOSED/);
    const restarted = f.newService(0);
    restarted.onNotification(hint => { after.push(hint); }); await tick();
    assert.deepEqual(after.map(hint => hint.eventId), receipt.outboxIds);
    assert.equal(count(f.db, 'threaded_wakes'), 0);
    checks.push('Closing clears the repair timer and suppresses queued callbacks; a fresh service observes the original unacknowledged event');
  }
  {
    const f = fixture('close-during-listener'), afterClose = [], recovered = [];
    f.service.onNotification(() => { f.service.close(); });
    f.service.onNotification(hint => { afterClose.push(hint); });
    const receipt = f.service.messages.acceptUserMessage(f.user());
    await tick();
    assert.equal(afterClose.length, 0, 'close() must prevent later callbacks in the same listener batch');
    assert.equal(count(f.db, 'threaded_outbox_receipts'), 0, 'partial fanout must remain recoverable');
    await delay(125);
    const restarted = f.newService(0);
    restarted.onNotification(hint => { recovered.push(hint); }); await tick();
    assert.deepEqual(recovered.map(hint => hint.eventId), receipt.outboxIds);
    checks.push('Close during listener fanout stops later callbacks and preserves the original event for a replacement service');
  }
  {
    const f = fixture('timer-repairs-missed-commit', 10), seen = [];
    const remove = f.service.onNotification(() => { throw new Error('first delivery fails'); });
    f.service.onNotification(hint => { seen.push(hint); });
    const receipt = f.service.messages.acceptUserMessage(f.user());
    await tick(); remove();
    await delay(180);
    assert.deepEqual(seen.map(hint => hint.eventId), [receipt.outboxIds[0], receipt.outboxIds[0]]);
    assert.equal(count(f.db, 'threaded_outbox_receipts'), 1);
    checks.push('The bounded repair timer finds a delayed event after a lost immediate retry without any new enqueue or manual recovery call');
  }
  assert.equal(unhandled.length, 0); assert.equal(networkCalls, 0);
  console.log(JSON.stringify({ ok: true, groups: checks.length, checks, networkCalls, realModelCalls: 0,
    scope: 'Process-local T05 notification lifecycle; no network transport or execution scheduling' }, null, 2));
} finally {
  for (const service of services) service.close();
  for (const db of databases) if (db.open) db.close();
  process.off('unhandledRejection', onUnhandled);
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import { applyOrchestrationSchemaMigrations } from '../apps/server/src/db/orchestrationMigrations.ts';
import { createExecutionResourceCoordinator } from '../apps/server/src/execution/resources/coordinator.ts';
import { createThreadedStore } from '../apps/server/src/threaded/store.ts';
import { createThreadedAuthority } from '../apps/server/src/threaded/authority.ts';
import { createThreadedLifecycle } from '../apps/server/src/threaded/lifecycle.ts';

// This test represents native state using isolated SQLite rows, never a provider or real process.
const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-late-session-'));
const schema = await readFile(new URL('../apps/server/src/db/schema.sql', import.meta.url), 'utf8');
const databases = [];
const checks = [];
const fixture = name => {
  const db = new Database(path.join(root, `${name}.sqlite`)); databases.push(db);
  db.pragma('foreign_keys = ON'); db.exec(schema);
  db.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER');
  applyOrchestrationSchemaMigrations(db);
  for (const id of ['a', 'b']) {
    db.prepare("INSERT INTO agents(id,name,definition,source,created_at,updated_at) VALUES(?,?,?,'fixture','2026-10-20','2026-10-20')")
      .run(id, id, JSON.stringify({ id, version: 1, model: 'mock:fixture', tools: [], permissionMode: 'readonly' }));
    db.prepare("INSERT INTO runs(id,goal,mode,status,agent_ids,created_at) VALUES(?,'fixture','collaboration','running',?,'2026-10-20')")
      .run(`run-${id}`, JSON.stringify([id]));
  }
  const store = createThreadedStore(db), ownerId = store.getInstanceOwnerId();
  const resources = createExecutionResourceCoordinator(db, { ownerNonce: `fixture:${name}` });
  resources.configurePolicy(ownerId, { globalLimit: 1 }, 1);
  const request = (extra = {}) => {
    const id = randomUUID();
    return { requestKey: id, operationId: id, mode: 'legacy', ownerId, agentId: 'a', runId: 'run-a', attemptId: `attempt:${id}`, capacity: false, ...extra };
  };
  const acquire = input => resources.tryAcquire(resources.enqueue(input).id);
  const parent = acquire(request()); assert.ok(parent);
  const execution = (id, agent = 'a') => db.prepare(`INSERT INTO external_agent_executions(id,run_id,agent_id,scope_id,status,record)
    VALUES(?,?,?,?,'running',?)`).run(id, `run-${agent}`, agent, id, JSON.stringify({ cwd: root, processOwnership: 'guardian-v1' }));
  execution('native-one'); execution('native-two'); execution('foreign-native', 'b');
  const call = acquire(request({ parentClaim: parent, capacity: true, legacyExecutionId: 'native-one' }));
  assert.ok(call); resources.markStarted(call);
  const process = id => db.prepare(`INSERT INTO external_native_processes(token,execution_id,host,pid,status,created_at)
    VALUES(?,?,'fixture-host',0,'active','2026-10-20')`).run(`process:${id}`, id);
  process('native-one');
  const session = { id: `session:${name}`, version: 1, nativeId: randomUUID(), resourceKey: `native-session:${randomUUID()}` };
  db.prepare(`INSERT INTO execution_resource_sessions(id,owner_id,binding_key,version,native_id,resource_key,state,record,updated_at)
    VALUES(?,?,?,1,?,?,'ready','{}',1)`).run(session.id, ownerId, session.id, session.nativeId, session.resourceKey);
  const promotion = (extra = {}) => request({ parentClaim: parent, session, legacyExecutionId: 'native-one', ...extra });
  return { db, store, ownerId, resources, request, acquire, parent, call, execution, process, session, promotion };
};
try {
  {
    const f = fixture('exact-promotion');
    const unrelatedPreparation = f.resources.enqueue(f.request({ agentId: 'b', runId: 'run-b' }));
    const other = f.resources.enqueue(f.request({ agentId: 'b', runId: 'run-b', capacity: true }));
    assert.equal(f.resources.tryAcquire(other.id), null, 'Actual call capacity remains occupied');
    const before = f.resources.listClaims().filter(claim => claim.request.capacity !== false).length;
    const sessionClaim = f.acquire(f.promotion());
    assert.ok(sessionClaim, 'Exact late Session lock may join its live legacy call without another execution turn');
    assert.equal(f.resources.getTicket(unrelatedPreparation.id).status, 'waiting', 'An unrelated eligible lane does not delay identity preparation inside an admitted call');
    assert.equal(f.resources.listClaims().filter(claim => claim.request.capacity !== false).length, before);
    const secondCall = f.resources.enqueue(f.request({ parentClaim: f.parent, capacity: true, legacyExecutionId: 'native-one' }));
    assert.equal(f.resources.tryAcquire(secondCall.id), null, 'Preparation exception never starts another call or bypasses capacity');
    assert.throws(() => f.resources.recordQuiescence(f.parent, { reason: 'not_started', sideEffects: 'none' }), /RESOURCE_CHILDREN_NOT_RELEASED/);
    assert.equal(f.resources.getClaim(f.parent.claimId).state, 'reserved');
    checks.push('Legacy late native-ID promotion uses the exact admitted call, consumes no extra capacity and cannot release its active parent');
  }
  {
    const f = fixture('no-general-bypass');
    assert.throws(() => f.resources.enqueue(f.promotion({ legacyExecutionId: 'foreign-native' })), /RESOURCE_LATE_SESSION_SCOPE_MISMATCH/);
    assert.equal(f.acquire(f.promotion({ legacyExecutionId: 'native-two' })), null, 'Another native execution ID cannot borrow the started sibling');
    assert.equal(f.acquire(f.promotion({ workspaces: [{ path: root, access: 'write' }] })), null, 'A workspace request never receives late Session exemption');
    assert.equal(f.acquire(f.promotion({ session: undefined })), null, 'An arbitrary preparation claim never receives late Session exemption');
    assert.equal(f.acquire(f.promotion({ parentClaim: undefined })), null, 'An unparented request cannot borrow another call ownership');
    f.process('native-two');
    assert.equal(f.acquire(f.promotion()), null, 'Even an exact promotion cannot bypass another active process');
    f.db.prepare("UPDATE external_native_processes SET status='stopped' WHERE execution_id='native-two'").run();
    const ticket = f.resources.scanPending().tickets.find(item => item.request.legacyExecutionId === 'native-one' && item.request.session && !item.request.workspaces.length && item.request.parentClaim);
    assert.ok(ticket);
    assert.ok(f.resources.tryAcquire(ticket.id));
    checks.push('Foreign execution, workspace/general preparation, missing parent and a second active process cannot use the Session-only exemption');
  }
  {
    const f = fixture('threaded-no-late-identity');
    const thread = f.store.createThread({ title: 'Threaded fixture', members: [{ agentId: 'b', handle: 'b', roleVersion: 1, permissionVersion: 1 }] });
    f.db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(thread.id);
    const lifecycle = createThreadedLifecycle(f.db, createThreadedAuthority(f.db, f.resources), { resources: f.resources });
    const invocation = lifecycle.createInvocation({ ownerId: f.ownerId, threadId: thread.id, agentId: 'b', causalRootId: 'fixture-root', goal: 'fixture' });
    assert.throws(() => f.resources.enqueue(f.request({ mode: 'threaded', threadId: thread.id, invocationId: invocation.id,
      runId: invocation.runId, agentId: 'b', capacity: true, legacyExecutionId: 'foreign-native' })), /RESOURCE_LATE_SESSION_FORBIDDEN/);
    checks.push('Threaded rejects late native execution provenance and keeps its pre-resolved identity requirement');
  }
  console.log(JSON.stringify({ status: 'passed', scope: 'T04 legacy native-ID promotion safety; isolated SQLite only', checks }, null, 2));
} finally {
  for (const db of databases) if (db.open) db.close();
  await rm(root, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import { applyOrchestrationSchemaMigrations } from '../apps/server/src/db/orchestrationMigrations.ts';
import { createThreadedStore } from '../apps/server/src/threaded/store.ts';
import { createThreadedAuthority } from '../apps/server/src/threaded/authority.ts';
import { createThreadedLifecycle } from '../apps/server/src/threaded/lifecycle.ts';
import { createExecutionResourceCoordinator } from '../apps/server/src/execution/resources/coordinator.ts';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-threaded-resources-'));
process.env.AGENT_GAND_ISOLATED_WORKER = '1';
process.env.DB_PATH = path.join(root, 'unused-business-singleton.sqlite');
process.env.AGENTS_DIR = path.join(root, 'agents');
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('Unexpected network in resource fixture'); };
const schema = await readFile(new URL('../apps/server/src/db/schema.sql', import.meta.url), 'utf8');
const databases = [];
const children = [];
const checks = [];
const now = '2026-10-20T00:00:00.000Z';

function fixture(name, options = {}) {
  const databasePath = path.join(root, `${name}.sqlite`);
  const db = new Database(databasePath, { timeout: 10_000 });
  databases.push(db);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.exec(schema);
  db.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER');
  applyOrchestrationSchemaMigrations(db);
  const agentIds = ['a', 'b', 'c', 'd', 'e', 'f'];
  for (const id of agentIds) db.prepare(`INSERT INTO agents(id,name,definition,source,created_at,updated_at)
    VALUES(?,?,?,'fixture',?,?)`).run(id, id, JSON.stringify({ id, name: id, version: 1,
      model: 'mock:fixture', tools: [], disallowedTools: [], permissionMode: 'readonly',
      capabilities: ['execute'], systemPrompt: 'Resource fixture', enabled: true }), now, now);
  for (const id of ['fixture-account', 'account-shared', 'limited-account']) db.prepare(`INSERT INTO accounts
    (id,display_name,provider,auth_type,source,version,config_version,credential_version,created_at,updated_at)
    VALUES(?,?,'openai','api_key','managed',1,1,1,?,?)`).run(id, id, now, now);
  const store = createThreadedStore(db);
  const ownerId = store.getInstanceOwnerId();
  let clock = Date.parse(now);
  const resources = createExecutionResourceCoordinator(db, { ownerNonce: `fixture:${name}:${randomUUID()}`,
    now: () => clock, leaseMs: 1_000, validateRequest() {},
    verifyEvidence: (_request, _claim, evidence) => evidence.reference === 'fixture-confirmed-process-exit', ...options });
  const lifecycle = createThreadedLifecycle(db, createThreadedAuthority(db, resources), { resources });
  const threads = new Map();
  const thread = alias => {
    if (!threads.has(alias)) {
      const value = store.createThread({ title: `${name}:${alias}`, members: agentIds.map(agentId => ({
        agentId, handle: agentId, roleVersion: 1, permissionVersion: 1,
      })) });
      db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(value.id);
      threads.set(alias, value);
    }
    return threads.get(alias);
  };
  const request = (overrides = {}) => {
    const { threadAlias = 'one', agentId = 'a', mode = 'threaded', ...rest } = overrides;
    const operationId = randomUUID();
    const common = { requestKey: `request:${operationId}`, operationId, mode, ownerId, agentId,
      attemptId: randomUUID(), capacity: true };
    // Low-level coordinator fixtures start with an already resolved Session reference.
    // The production metadata/CAS resolver is validated separately by the integration suite.
    if (rest.session) db.prepare(`INSERT OR IGNORE INTO execution_resource_sessions
      (id,owner_id,binding_key,version,native_id,resource_key,state,record,updated_at)
      VALUES(?,?,?,?,?,?,'ready','{}',?)`).run(rest.session.id, ownerId, rest.session.id,
      rest.session.version, rest.session.nativeId, rest.session.resourceKey, Date.parse(now));
    if (mode === 'legacy') {
      const runId = randomUUID();
      db.prepare("INSERT INTO runs(id,goal,mode,status,agent_ids,created_at) VALUES(?,'fixture','collaboration','running',?,?)")
        .run(runId, JSON.stringify([agentId]), now);
      return { ...common, runId, ...rest };
    }
    const room = thread(threadAlias);
    const invocation = lifecycle.createInvocation({ ownerId, threadId: room.id, agentId, causalRootId: `root:${name}`,
      goal: name, requestId: randomUUID() });
    return { ...common, runId: invocation.runId, threadId: room.id, invocationId: invocation.id, ...rest };
  };
  return { db, databasePath, resources, lifecycle, ownerId, thread, request,
    setClock(value) { clock = value; }, advance(ms) { clock += ms; } };
}

async function worker(databasePath) {
  const child = fork(fileURLToPath(new URL('./fixtures/threadedResourceWorker.mjs', import.meta.url)),
    [databasePath, `worker:${randomUUID()}`], {
      execArgv: ['--import', fileURLToPath(new URL('../apps/server/node_modules/tsx/dist/loader.mjs', import.meta.url))],
      env: { ...process.env, AGENT_GAND_ISOLATED_WORKER: '1', DB_PATH: path.join(root, 'unused-child-singleton.sqlite'), AGENTS_DIR: path.join(root, 'agents') },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
  children.push(child);
  let sequence = 0;
  let stderr = '';
  child.stderr.on('data', value => { stderr += value; });
  const pending = new Map();
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  child.on('message', message => {
    if (message.ready) { readyResolve(); return; }
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    else waiting.resolve(message.result);
  });
  child.on('error', error => { readyReject(error); for (const promise of pending.values()) promise.reject(error); });
  child.on('exit', code => {
    if (code !== 0) {
      const error = new Error(`Resource fixture worker exited ${code}: ${stderr}`);
      readyReject(error); for (const promise of pending.values()) promise.reject(error);
    }
  });
  await ready;
  return {
    call(operation, ...args) {
      const id = ++sequence;
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.send({ id, operation, args }); });
    },
    async close() {
      if (!child.connected) return;
      const id = ++sequence;
      await new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.send({ id, operation: 'close' }); });
    },
  };
}

const rejected = error => /^RESOURCE_|^THREADED_/.test(error?.code ?? error?.message ?? '');
const held = coordinator => coordinator.listClaims().filter(claim => claim.state !== 'released');
function releaseReserved(coordinator, claim) {
  const proof = coordinator.recordQuiescence(claim, { reason: 'not_started', sideEffects: 'none' });
  coordinator.release(claim, proof);
  return proof;
}

try {
  // Tests below exercise the shared durable coordinator, not an in-memory claim stand-in.
  {
    const f = fixture('same-slot-multiprocess');
    const first = f.resources.enqueue(f.request());
    const second = f.resources.enqueue(f.request());
    const [left, right] = await Promise.all([worker(f.databasePath), worker(f.databasePath)]);
    const results = await Promise.all([left.call('tryAcquire', first.id), right.call('tryAcquire', second.id)]);
    assert.equal(results.filter(Boolean).length, 1, 'Two real SQLite worker processes cannot own one Thread/Agent slot');
    assert.ok(results[0], 'The earlier eligible ticket owns the slot regardless of worker scheduling');
    assert.equal(results[1], null);
    assert.equal(held(f.resources).length, 1);
    const proof = releaseReserved(f.resources, results[0]);
    const successor = await right.call('tryAcquire', second.id);
    assert.ok(successor);
    assert.ok(successor.generation > results[0].generation);
    await left.call('release', results[0], proof);
    f.resources.assertCurrent(successor);
    assert.equal(held(f.resources).length, 1, 'A late release from the first process cannot release its successor');
    await Promise.all([left.close(), right.close()]);
    checks.push('Q01/Q06: independent worker processes race SQLite claims; same-slot FIFO has one owner and old proof cannot release a successor');
  }

  {
    const f = fixture('cross-thread-parallel');
    const a = f.resources.enqueue(f.request({ threadAlias: 'one' }));
    const b = f.resources.enqueue(f.request({ threadAlias: 'two' }));
    const [left, right] = await Promise.all([worker(f.databasePath), worker(f.databasePath)]);
    const acquired = await Promise.all([left.call('tryAcquire', a.id), right.call('tryAcquire', b.id)]);
    // Each fairness turn chooses one candidate; the other worker may observe that turn first.
    // Rechecking after that claim must succeed without releasing either Thread slot.
    if (!acquired[0]) acquired[0] = await left.call('tryAcquire', a.id);
    if (!acquired[1]) acquired[1] = await right.call('tryAcquire', b.id);
    assert.ok(acquired.every(Boolean), 'The same Agent can hold independent Thread slots within capacity');
    assert.equal(held(f.resources).length, 2);
    await Promise.all([left.close(), right.close()]);
    checks.push('Q02: the same Agent acquires two different Thread slots across real SQLite connections');
  }

  {
    const f = fixture('legacy-exclusive-barrier');
    const active = f.resources.tryAcquire(f.resources.enqueue(f.request({ threadAlias: 'active' })).id);
    assert.ok(active);
    const exclusive = f.resources.enqueue(f.request({ mode: 'legacy' }));
    const newer = f.resources.enqueue(f.request({ threadAlias: 'newer' }));
    assert.equal(f.resources.tryAcquire(exclusive.id), null);
    assert.equal(f.resources.tryAcquire(newer.id), null, 'A queued legacy exclusive ticket is an Agent barrier');
    releaseReserved(f.resources, active);
    assert.equal(f.resources.tryAcquire(newer.id), null, 'New Thread traffic cannot overtake the waiting exclusive');
    const old = f.resources.tryAcquire(exclusive.id);
    assert.ok(old);
    assert.equal(f.resources.tryAcquire(newer.id), null);
    releaseReserved(f.resources, old);
    assert.ok(f.resources.tryAcquire(newer.id));
    checks.push('Q03: active Thread slots and legacy exclusive conflict; the oldest exclusive waiter blocks new Thread arrivals until served');
  }

  {
    const f = fixture('thread-round-robin');
    f.resources.configurePolicy(f.ownerId, { globalLimit: 1 }, 1);
    const a1 = f.resources.enqueue(f.request({ threadAlias: 'A' }));
    const a2 = f.resources.enqueue(f.request({ threadAlias: 'A' }));
    const b1 = f.resources.enqueue(f.request({ threadAlias: 'B', agentId: 'b' }));
    const first = f.resources.tryAcquire(a1.id);
    assert.ok(first);
    releaseReserved(f.resources, first);
    assert.equal(f.resources.tryAcquire(a2.id), null, 'A hot Thread yields to another unserved eligible Thread');
    const restarted = await worker(f.databasePath);
    const next = await restarted.call('tryAcquire', b1.id);
    assert.ok(next, 'Last-served fairness is persistent and visible after a worker restart');
    releaseReserved(f.resources, next);
    assert.ok(f.resources.tryAcquire(a2.id));
    await restarted.close();
    checks.push('Q03 fairness: durable last-served Thread order rotates capacity rather than letting one hot Thread drain its backlog');
  }

  {
    const f = fixture('eligible-fifo-age');
    const blocked = f.resources.enqueue(f.request({ eligible: false }));
    const newer = f.resources.enqueue(f.request());
    const claim = f.resources.tryAcquire(newer.id);
    assert.ok(claim, 'A policy-blocked ticket does not occupy execution capacity');
    releaseReserved(f.resources, claim);
    f.resources.setEligible(blocked.id, true);
    assert.equal(f.resources.getTicket(blocked.id).seq, blocked.seq);
    const last = f.resources.enqueue(f.request());
    assert.equal(f.resources.tryAcquire(last.id), null);
    assert.ok(f.resources.tryAcquire(blocked.id));
    checks.push('Blocked tickets consume no resource; becoming eligible preserves the original FIFO age');
  }

  {
    const f = fixture('actual-session-lock');
    const nativeId = randomUUID();
    const resourceKey = `claude-sdk:fixture-account:g1:fixture-host:${nativeId}`;
    const first = f.resources.enqueue(f.request({ threadAlias: 'one',
      session: { id: 'policy-binding-one', version: 1, nativeId, resourceKey } }));
    const second = f.resources.enqueue(f.request({ threadAlias: 'two', agentId: 'b',
      session: { id: 'different-policy-binding', version: 1, nativeId, resourceKey } }));
    const active = f.resources.tryAcquire(first.id);
    assert.ok(active);
    assert.equal(f.resources.tryAcquire(second.id), null, 'Different policy bindings do not allow two owners of the same actual native Session');
    assert.equal(held(f.resources).length, 1);
    releaseReserved(f.resources, active);
    assert.ok(f.resources.tryAcquire(second.id));
    checks.push('Q04: separate policy bindings that resolve to one backend/account/host/native ID cannot resume concurrently');
  }

  {
    const f = fixture('session-identity-revalidation');
    const nativeId = randomUUID();
    const request = f.request({ session: { id: 'prepared-session', version: 1, nativeId,
      resourceKey: `claude-sdk:account:g1:host:${nativeId}` } });
    const ticket = f.resources.enqueue(request);
    f.db.exec("UPDATE execution_resource_sessions SET version=2 WHERE id='prepared-session'");
    assert.throws(() => f.resources.tryAcquire(ticket.id), /RESOURCE_SESSION_CHANGED/);
    assert.equal(held(f.resources).length, 0, 'A stale prepared Session version acquires no partial resources');
    f.db.exec("UPDATE execution_resource_sessions SET version=1 WHERE id='prepared-session'");
    const claim = f.resources.tryAcquire(ticket.id);
    assert.ok(claim);
    f.db.exec("UPDATE execution_resource_sessions SET state='reconciling' WHERE id='prepared-session'");
    assert.throws(() => f.resources.assertExecutable(claim), rejected);
    f.resources.assertCurrent(claim);
    assert.equal(held(f.resources).length, 1, 'An unexpected Session identity retains the original reconciliation fence');
    checks.push('Q04: Session version is rechecked at acquisition; identity reconciliation blocks effects while retaining the existing fence');
  }

  {
    const f = fixture('workspace-atomic-set');
    const first = f.resources.tryAcquire(f.resources.enqueue(f.request({ agentId: 'a',
      workspaces: [{ path: root, access: 'read' }] })).id);
    const second = f.resources.tryAcquire(f.resources.enqueue(f.request({ agentId: 'b',
      workspaces: [{ path: root, access: 'read' }] })).id);
    assert.ok(first && second, 'Read claims may share a canonical workspace');
    const writer = f.resources.enqueue(f.request({ agentId: 'c', workspaces: [{ path: root, access: 'write' }] }));
    assert.equal(f.resources.tryAcquire(writer.id), null);
    assert.equal(held(f.resources).length, 2, 'A blocked writer leaves no partial Agent/capacity claim');
    releaseReserved(f.resources, first);
    assert.equal(f.resources.tryAcquire(writer.id), null);
    releaseReserved(f.resources, second);
    assert.ok(f.resources.tryAcquire(writer.id));
    checks.push('Workspace read/write conflicts are independent resources and a blocked complete request retains no partial claim');
  }

  {
    const f = fixture('claim-transaction-rollback');
    const ticket = f.resources.enqueue(f.request({ accountId: 'fixture-account',
      workspaces: [{ path: root, access: 'write' }] }));
    const tables = ['execution_resource_tickets', 'execution_resource_claims', 'execution_resource_claim_items',
      'execution_resource_epochs', 'execution_resource_fairness', 'execution_resource_availability'];
    const snapshot = () => Object.fromEntries(tables.map(table => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const before = snapshot();
    f.db.exec(`CREATE TRIGGER fixture_resource_insert_failure BEFORE INSERT ON execution_resource_claim_items
      WHEN NEW.kind='workspace' BEGIN SELECT RAISE(ABORT,'fixture_resource_transaction_failure'); END;`);
    assert.throws(() => f.resources.tryAcquire(ticket.id), /fixture_resource_transaction_failure/);
    assert.deepEqual(snapshot(), before, 'Claim identity, all resources, epochs and fairness roll back together');
    f.db.exec('DROP TRIGGER fixture_resource_insert_failure');
    assert.ok(f.resources.tryAcquire(ticket.id));
    checks.push('Resource-set transaction failure rolls back every partial item, epoch, ticket transition and fairness update');
  }

  {
    const f = fixture('capacity-single-operation');
    assert.deepEqual([f.resources.getPolicy().globalLimit, f.resources.getPolicy().threadLimit, f.resources.getPolicy().accountLimit], [3, 3, 3]);
    const requests = ['a', 'b', 'c', 'd'].map((agentId, index) => f.request({ agentId, threadAlias: `room-${index}`, accountId: 'account-shared' }));
    const tickets = requests.map(request => f.resources.enqueue(request));
    assert.equal(f.resources.enqueue(requests[0]).id, tickets[0].id);
    assert.throws(() => f.resources.enqueue({ ...requests[0], requestKey: 'different-key-same-call' }), rejected);
    const claims = tickets.map(ticket => f.resources.tryAcquire(ticket.id));
    assert.equal(claims.filter(Boolean).length, 3);
    assert.equal(claims[3], null);
    assert.equal(f.resources.tryAcquire(tickets[0].id).claimId, claims[0].claimId, 'Same operation lookup does not consume a second slot');
    assert.equal(held(f.resources).filter(claim => claim.request.capacity !== false).length, 3);
    assert.throws(() => f.resources.configurePolicy(f.ownerId, { globalLimit: 99 }, f.resources.getPolicy().version), rejected);
    checks.push('Global/Thread/account defaults are 3; operation identity is unique, re-entry is not charged twice and in-use policy cannot drift');
  }

  for (const capacity of ['thread', 'account', 'provider']) {
    const f = fixture(`capacity-${capacity}`);
    const patch = capacity === 'thread' ? { globalLimit: 6, threadLimit: 1 }
      : capacity === 'account' ? { globalLimit: 6, accountLimits: { 'limited-account': 1 } }
        : { globalLimit: 6, providerLimits: { 'limited-provider': 1 } };
    f.resources.configurePolicy(f.ownerId, patch, 1);
    const first = f.resources.enqueue(f.request({ agentId: 'a', accountId: 'limited-account', providerKey: 'limited-provider' }));
    const second = f.resources.enqueue(f.request({ agentId: 'b', threadAlias: capacity === 'thread' ? 'one' : 'two',
      accountId: 'limited-account', providerKey: 'limited-provider' }));
    const active = f.resources.tryAcquire(first.id);
    assert.ok(active);
    assert.equal(f.resources.tryAcquire(second.id), null);
    releaseReserved(f.resources, active);
    assert.ok(f.resources.tryAcquire(second.id));
    checks.push(`The independent ${capacity} capacity takes the stricter configured limit`);
  }

  {
    const f = fixture('preparation-does-not-double-count');
    f.resources.configurePolicy(f.ownerId, { globalLimit: 1 }, 1);
    const preparationRequest = f.request({ mode: 'legacy', capacity: false, workspaces: [{ path: root, access: 'write' }] });
    const preparationTicket = f.resources.enqueue(preparationRequest);
    const preparation = f.resources.tryAcquire(preparationTicket.id);
    assert.ok(preparation);
    const actualRequest = f.request({ mode: 'legacy', runId: preparation.runId, attemptId: preparation.attemptId, parentClaim: preparation });
    const call = f.resources.tryAcquire(f.resources.enqueue(actualRequest).id);
    assert.ok(call, 'Preparation consumes no model capacity; its actual child call fits the one-slot limit');
    assert.equal(held(f.resources).filter(claim => claim.request.capacity !== false).length, 1);
    const other = f.resources.enqueue(f.request({ mode: 'legacy', agentId: 'b' }));
    assert.equal(f.resources.tryAcquire(other.id), null);
    assert.throws(() => f.resources.recordQuiescence(preparation, { reason: 'not_started', sideEffects: 'none' }), rejected,
      'A parent cannot become quiescent while a child call still owns resources');
    releaseReserved(f.resources, call);
    const oldProof = releaseReserved(f.resources, preparation);
    assert.ok(f.resources.tryAcquire(other.id));
    const reopened = f.resources.requeuePreparation(preparationTicket.id);
    assert.equal(reopened.seq, preparationTicket.seq);
    const successor = f.resources.tryAcquire(reopened.id);
    assert.ok(successor);
    assert.ok(successor.generation > preparation.generation);
    f.resources.release(preparation, oldProof);
    f.resources.assertCurrent(successor);
    checks.push('Legacy preparation and the actual call share ancestry without double-counting capacity; parent release waits for child and requeue preserves age/fence');
  }

  {
    const f = fixture('builtin-preparation-tools');
    const request = f.request({ mode: 'legacy', capacity: false, workspaces: [{ path: root, access: 'write' }] });
    const claim = f.resources.tryAcquire(f.resources.enqueue(request).id); assert.ok(claim);
    f.db.prepare(`INSERT INTO tool_executions(id,run_id,agent_id,tool_name,idempotency_key,input,replay_policy,status,created_at,started_at)
      VALUES('builtin-tool',?,?,'fs.write','builtin-tool','{}','manual','running',?,?)`).run(claim.runId, claim.agentId, now, now);
    for (const status of ['running', 'needs_attention']) {
      f.db.prepare('UPDATE tool_executions SET status=? WHERE id=\'builtin-tool\'').run(status);
      assert.throws(() => f.resources.recordQuiescence(claim, { reason: 'not_started', sideEffects: 'none' }), /RESOURCE_QUIESCENCE_PENDING_TOOLS/);
      assert.throws(() => f.resources.recordQuiescence(claim, { reason: 'process_exited', sideEffects: 'reconciled', reference: 'fixture-confirmed-process-exit' }), /RESOURCE_QUIESCENCE_PENDING_TOOLS/);
      assert.equal(f.resources.getClaim(claim.claimId).state, 'reserved');
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM execution_resource_quiescence WHERE claim_id=?').get(claim.claimId).n, 0);
    }
    f.db.prepare("UPDATE tool_executions SET status='failed',ended_at=? WHERE id='builtin-tool'").run(now);
    releaseReserved(f.resources, claim);
    const nativeId = 'native-exact-tool-fixture';
    f.db.prepare(`INSERT INTO external_agent_executions(id,run_id,agent_id,scope_id,status,record)
      VALUES(?,?,?,'native-fixture','running','{}')`).run(nativeId, claim.runId, claim.agentId);
    const nativeRequest = f.request({ mode: 'legacy', capacity: false, runId: claim.runId, legacyExecutionId: nativeId });
    const nativeClaim = f.resources.tryAcquire(f.resources.enqueue(nativeRequest).id); assert.ok(nativeClaim);
    f.db.prepare("UPDATE tool_executions SET status='needs_attention' WHERE id='builtin-tool'").run();
    const nativeProof = f.resources.recordQuiescence(nativeClaim, { reason: 'process_exited', sideEffects: 'reconciled', reference: 'fixture-confirmed-process-exit' });
    f.resources.release(nativeClaim, nativeProof);
    checks.push('Builtin preparation cannot prove quiescence while its scoped tool is running or needs attention, even through a trusted callback; ended failures and exact native proof keep their distinct handling');
  }
  {
    const f = fixture('builtin-tool-proof-release-gap');
    const request = f.request({ mode: 'legacy', capacity: false });
    const claim = f.resources.tryAcquire(f.resources.enqueue(request).id); assert.ok(claim);
    const evidence = { reason: 'not_started', sideEffects: 'none' };
    const proof = f.resources.recordQuiescence(claim, evidence);
    f.db.prepare(`INSERT INTO tool_executions(id,run_id,agent_id,tool_name,idempotency_key,input,replay_policy,status,created_at,started_at)
      VALUES('late-tool',?,?,'shell.exec','late-tool','{}','manual','running',?,?)`).run(claim.runId, claim.agentId, now, now);
    assert.throws(() => f.resources.recordQuiescence(claim, evidence), /RESOURCE_QUIESCENCE_PENDING_TOOLS/);
    assert.throws(() => f.resources.release(claim, proof), /RESOURCE_QUIESCENCE_PENDING_TOOLS/);
    assert.equal(f.resources.getClaim(claim.claimId).state, 'quiescent');
    f.db.prepare("UPDATE tool_executions SET status='completed',ended_at=? WHERE id='late-tool'").run(now);
    f.resources.release(claim, proof);
    assert.equal(f.resources.getClaim(claim.claimId).state, 'released');
    checks.push('Builtin tool state is rechecked at release as well as proof creation; a tool starting in between retains the fence until it finishes');
  }
  {
    const f = fixture('policy-preparation-freeze');
    const ticket = f.resources.enqueue(f.request({ mode: 'legacy', capacity: false }));
    const first = f.resources.tryAcquire(ticket.id); assert.ok(first);
    releaseReserved(f.resources, first);
    assert.throws(() => f.resources.configurePolicy(f.ownerId, { globalLimit: 1 }, 1), /RESOURCE_POLICY_REOPENABLE_PREPARATION/);
    assert.equal(f.resources.getPolicy().version, 1);
    f.resources.requeuePreparation(ticket.id);
    const resumed = f.resources.tryAcquire(ticket.id); assert.ok(resumed);
    assert.ok(resumed.generation > first.generation);
    releaseReserved(f.resources, resumed);
    f.db.prepare("UPDATE runs SET status='completed' WHERE id=?").run(first.runId);
    const changed = f.resources.configurePolicy(f.ownerId, { globalLimit: 1 }, 1);
    assert.equal(changed.version, 2); assert.equal(changed.globalLimit, 1);
    assert.throws(() => f.resources.requeuePreparation(ticket.id), /RESOURCE_LEGACY_SCOPE_UNAVAILABLE/);
    checks.push('Policy changes reject still-reopenable legacy preparations, preserving their frozen policy and FIFO age until the old Run is terminal');
  }
  {
    const f = fixture('unknown-never-expires');
    const request = f.request({ workspaces: [{ path: root, access: 'write' }],
      session: { id: 'unknown-session', version: 1, nativeId: 'fixture-unknown-native', resourceKey: 'fixture-unknown-native-lock' } });
    const first = f.resources.tryAcquire(f.resources.enqueue(request).id);
    assert.ok(first);
    f.resources.markStarted(first);
    assert.throws(() => f.resources.recordQuiescence(first, { reason: 'not_started', sideEffects: 'none' }), rejected);
    assert.throws(() => f.resources.recordQuiescence(first, { reason: 'process_exited', sideEffects: 'reconciled', reference: 'untrusted-client-assertion' }), rejected);
    f.resources.markUnknown(first);
    assert.throws(() => f.resources.assertExecutable(first), rejected);
    f.resources.assertCurrent(first);
    f.advance(60_000);
    f.resources.recoverExpired();
    const waiting = f.resources.enqueue(f.request({ mode: 'legacy', workspaces: [{ path: root, access: 'write' }] }));
    assert.equal(f.resources.tryAcquire(waiting.id), null);
    assert.equal(f.resources.getClaim(first.claimId).state, 'unknown');
    assert.equal(held(f.resources).length, 1);
    assert.deepEqual(f.db.prepare('SELECT kind FROM execution_resource_claim_items WHERE claim_id=? ORDER BY kind').all(first.claimId)
      .map(row => row.kind), ['agent', 'capacity', 'capacity', 'session', 'workspace']);
    assert.throws(() => f.resources.renew({ ...first, fencingToken: 'old-owner-forgery' }), rejected);
    const proof = f.resources.recordQuiescence(first, { reason: 'process_exited', sideEffects: 'reconciled', reference: 'fixture-confirmed-process-exit' });
    assert.throws(() => f.resources.verifyQuiescence(first, { ...proof, id: 'forged-proof-id' }), rejected);
    assert.throws(() => f.db.prepare('UPDATE execution_resource_claims SET fencing_token=? WHERE id=?').run('forged', first.claimId), /IMMUTABLE/);
    assert.throws(() => f.db.exec('DELETE FROM execution_resource_epochs'), /RETAINED/);
    assert.throws(() => f.db.prepare('UPDATE execution_resource_quiescence SET proof=? WHERE id=?').run('{}', proof.id), /IMMUTABLE/);
    const restarted = await worker(f.databasePath);
    await restarted.call('verifyQuiescence', first, proof);
    await restarted.call('release', first, proof);
    const next = await restarted.call('tryAcquire', waiting.id);
    assert.ok(next);
    await restarted.call('release', first, proof);
    f.resources.assertCurrent(next);
    await restarted.close();
    checks.push('Q06/REC03: unknown retains Agent/Session/workspace/capacity after lease expiry; durable verified proof survives restart and never releases a newer claim');
  }

  {
    const f = fixture('release-enqueue-notifications');
    f.resources.configurePolicy(f.ownerId, { globalLimit: 1 }, 1);
    const first = f.resources.tryAcquire(f.resources.enqueue(f.request({ agentId: 'a', threadAlias: 'A' })).id);
    assert.ok(first);
    await Promise.resolve();
    const waiting = f.resources.enqueue(f.request({ agentId: 'b', threadAlias: 'B' }));
    await Promise.resolve();
    let injected;
    let acquiredB;
    let acquiredC;
    let observeB;
    let observeC;
    const bReady = new Promise(resolve => { observeB = resolve; });
    const cReady = new Promise(resolve => { observeC = resolve; });
    const events = [];
    const unsubscribe = f.resources.onAvailable(event => {
      events.push(event);
      if (event.reason === 'released' && !injected) {
        injected = f.resources.enqueue(f.request({ agentId: 'c', threadAlias: 'C' }));
      }
      // Exercise listener re-entry through the actual notification path, with no timer scanner.
      for (const ticket of f.resources.scanPending(event.seq).tickets) {
        const claim = f.resources.tryAcquire(ticket.id);
        if (claim && ticket.id === waiting.id) { acquiredB = claim; observeB(); }
        if (claim && ticket.id === injected?.id) { acquiredC = claim; observeC(); }
      }
    });
    const bounded = async promise => {
      let timer;
      try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Active resource notification was lost')), 2_000); })]); }
      finally { clearTimeout(timer); }
    };
    releaseReserved(f.resources, first);
    await bounded(bReady);
    assert.ok(injected && acquiredB);
    assert.equal(acquiredC, undefined);
    releaseReserved(f.resources, acquiredB);
    await bounded(cReady);
    assert.ok(acquiredC);
    assert.ok(events.some(event => event.reason === 'enqueued' && event.agentId === 'c'), 'Enqueue during release notification is delivered in the next active drain');
    unsubscribe();
    const connection = new Database(f.databasePath, { timeout: 10_000 });
    databases.push(connection);
    const restarted = createExecutionResourceCoordinator(connection, { ownerNonce: 'restarted-notification-reader' });
    const history = restarted.scanPending(0);
    assert.ok(history.events.length >= events.length);
    const late = f.resources.enqueue(f.request({ agentId: 'd', threadAlias: 'D' }));
    const recovered = restarted.scanPending(history.cursor);
    assert.ok(recovered.events.some(event => event.reason === 'enqueued' && event.agentId === 'd'));
    assert.ok(recovered.tickets.some(ticket => ticket.id === late.id));
    assert.equal(new Set(history.events.map(event => event.seq)).size, history.events.length);
    checks.push('Q05 resource subcase: release and reentrant enqueue actively drain without timer scans; another connection recovers missed notifications by durable cursor');
  }

  assert.equal(networkCalls, 0);
  console.log(`Threaded resources passed (${checks.length} groups):\n${checks.map(value => `- ${value}`).join('\n')}`);
} finally {
  for (const child of children) if (child.connected) child.kill();
  for (const db of databases) if (db.open) db.close();
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}

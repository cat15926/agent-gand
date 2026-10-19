import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-legacy-resources-')));
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test',
  DB_PATH: path.join(root, 'fixture.sqlite'), AGENTS_DIR: path.join(root, 'agents'),
  MCP_SERVER_CMD: '', LOG_LEVEL: 'silent', THREADED_COLLABORATION_MODE: 'closed' });
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('Network forbidden in resource bridge fixture'); };
let database, dispatcher, originalDispatcher, setGlobalDispatcher;
const checks = [];
const response = { content: 'isolated fixture', toolCalls: [], usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 }, stopReason: 'stop', truncated: false };
const request = signal => ({ model: 'mock:fixture', messages: [{ role: 'user', content: 'isolated fixture' }], ...(signal ? { signal } : {}) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function eventually(condition, label) {
  const until = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() >= until) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

try {
  const { config } = await import('../apps/server/src/config.ts');
  config.sandboxDir = path.join(root, 'sandbox'); config.llm.proxy = null;
  const undici = await import('../apps/server/node_modules/undici/index.js');
  originalDispatcher = undici.getGlobalDispatcher(); setGlobalDispatcher = undici.setGlobalDispatcher;
  dispatcher = new undici.MockAgent(); dispatcher.disableNetConnect(); setGlobalDispatcher(dispatcher);
  database = await import('../apps/server/src/db/database.ts');
  const { db } = database;
  const { createAgent } = await import('../apps/server/src/agents/registry.ts');
  const { createRun, setRunStatus } = await import('../apps/server/src/runs/trace.ts');
  const { enterMember } = await import('../apps/server/src/execution/memberAdmission.ts');
  const { budgetedChat } = await import('../apps/server/src/orchestration/executionBudget.ts');
  const { queueModelCall } = await import('../apps/server/src/orchestration/modelCalls.ts');
  const { executionResources: resources } = await import('../apps/server/src/execution/resources/service.ts');
  const { acquireLegacyResources, acquireLegacyModelCall, releaseLegacyNativeResource } = await import('../apps/server/src/execution/resources/legacy.ts');
  const { createExecution, updateExecution } = await import('../apps/server/src/execution/store.ts');
  const { acquireDurableLease } = await import('../apps/server/src/execution/leases.ts');
  const { hostOwner, ownerAlive } = await import('../apps/server/src/execution/host.ts');
  for (const id of ['aa', 'bb', 'cc', 'dd']) createAgent({ id, name: id, description: 'resource fixture',
    systemPrompt: 'No external calls.', model: 'mock:fixture', tools: [], disallowedTools: [],
    permissionMode: 'readonly', capabilities: ['execute'], color: '#4477aa', avatar: '' });
  const ownerId = db.prepare('SELECT instance_owner_id FROM threaded_instances WHERE singleton=1').get().instance_owner_id;
  resources.configurePolicy(ownerId, { globalLimit: 1 }, resources.getPolicy().version);
  const run = (agentId, label) => { const value = createRun(label, 'collaboration', [agentId]); setRunStatus(value.id, 'running'); return value; };
  const member = (value, agentId, signal = new AbortController().signal) => enterMember({ runId: value.id, agentId,
    scope: randomUUID(), signal, authorized: () => true });
  const claims = runId => resources.listClaims().filter(claim => claim.identity.runId === runId);
  const charged = () => resources.listClaims().filter(claim => claim.request.capacity !== false);

  for (const lowerProviderLimit of [false, true]) {
    if (lowerProviderLimit) resources.configurePolicy(ownerId, { globalLimit: 3, accountLimit: 3, providerLimits: { mock: 1 } }, resources.getPolicy().version);
    const a = run('aa', 'capacity one'), b = run('bb', 'capacity two');
    const releaseA = await member(a, 'aa'), releaseB = await member(b, 'bb');
    assert.equal(resources.listClaims().length, 2);
    assert.equal(charged().length, 0, 'member preparation does not consume model capacity');
    const finishA = deferred(), finishB = deferred();
    let calls = 0, live = 0, peak = 0;
    const provider = gate => ({ async chat() { calls++; live++; peak = Math.max(peak, live); await gate.promise; live--; return response; } });
    const first = budgetedChat(a.id, provider(finishA), request(), undefined, 'aa');
    const second = budgetedChat(b.id, provider(finishB), request(), undefined, 'bb');
    await eventually(() => calls === 1, 'first provider enters');
    assert.equal(charged().length, 1);
    assert.equal(charged()[0].request.providerKey, 'mock', 'actual frozen provider identity is used for capacity');
    assert.equal(resources.listClaims().length, 3, 'two parent preparations plus one actual request');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM orchestration_model_calls WHERE status='started'").get().n, 1);
    finishA.resolve(); await first;
    await eventually(() => calls === 2, 'release wakes second provider');
    assert.equal(charged().length, 1); assert.equal(peak, 1);
    finishB.resolve(); await second; releaseA(); releaseB();
    assert.equal(resources.listClaims().length, 0);
    setRunStatus(a.id, 'completed'); setRunStatus(b.id, 'completed');
    checks.push(lowerProviderLimit
      ? 'Legacy built-in calls use the actual provider key; providerLimit=1 remains stricter than global/account limits of 3'
      : 'Real enterMember + budgetedChat share the singleton coordinator; preparation/Run/Attempt do not double-charge actual model concurrency');
  }
  resources.configurePolicy(ownerId, { globalLimit: 1, providerLimits: {} }, resources.getPolicy().version);

  {
    const a = run('aa', 'abort ignoring provider'), b = run('bb', 'blocked by unknown');
    const releaseA = await member(a, 'aa'), releaseB = await member(b, 'bb');
    const controller = new AbortController(), actual = deferred();
    let firstCalls = 0, secondCalls = 0, lateDelta;
    const deltas = [];
    const first = budgetedChat(a.id, { chat(_request, delta) { firstCalls++; lateDelta = delta; return actual.promise; } },
      request(controller.signal), text => deltas.push(text), 'aa');
    const rejected = assert.rejects(first, /fixture abort/);
    await eventually(() => firstCalls === 1, 'abort ignoring provider enters');
    controller.abort(new Error('fixture abort')); await rejected;
    const old = charged()[0]; assert.equal(old.state, 'unknown');
    assert.equal(db.prepare('SELECT status FROM orchestration_model_calls WHERE run_id=?').get(a.id).status, 'unknown');
    releaseA();
    assert.equal(claims(a.id).length, 2, 'parent remains fenced while actual provider promise remains pending');
    const second = budgetedChat(b.id, { async chat() { secondCalls++; return response; } }, request(), undefined, 'bb');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(secondCalls, 0); assert.equal(charged().length, 1);
    lateDelta('late output'); assert.deepEqual(deltas, []);
    actual.resolve(response);
    await second; releaseB();
    assert.equal(resources.getClaim(old.identity.claimId).state, 'released');
    assert.equal(resources.listClaims().length, 0);
    checks.push('Caller abort leaves an abort-ignoring provider unknown with its parent/capacity held; only actual promise settlement releases it and late output is discarded');
  }

  {
    const one = path.join(root, 'workspace-one'), two = path.join(root, 'workspace-two');
    await mkdir(one); await mkdir(two);
    const a = run('aa', 'complete workspace set'), b = run('bb', 'conflicting workspace set');
    const first = await acquireLegacyResources({ runId: a.id, agentId: 'aa', operationId: randomUUID(),
      workspaces: [{ path: one, access: 'write' }, { path: two, access: 'write' }] });
    const stop = new AbortController();
    let entered = false;
    const pending = acquireLegacyResources({ runId: b.id, agentId: 'bb', operationId: randomUUID(), signal: stop.signal,
      workspaces: [{ path: two, access: 'write' }, { path: one, access: 'write' }] }).then(value => { entered = true; return value; });
    const rejected = assert.rejects(pending, /fixture cancelled queued workspace/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(entered, false); assert.equal(claims(b.id).length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM execution_resource_claim_items WHERE claim_id=?').get(first.claim.claimId).n, 3);
    stop.abort(new Error('fixture cancelled queued workspace')); await rejected;
    assert.equal(first.release(), true); assert.equal(resources.listClaims().length, 0);
    checks.push('Legacy workspace group is acquired atomically, including Agent; a reversed conflicting group holds no partial resource and queued cancellation leaves no claim');
  }

  {
    const { createThreadedStore } = await import('../apps/server/src/threaded/store.ts');
    const { createThreadedLifecycle } = await import('../apps/server/src/threaded/lifecycle.ts');
    const { createThreadedAuthority } = await import('../apps/server/src/threaded/authority.ts');
    const { prepareThreadedSession } = await import('../apps/server/src/execution/resources/sessions.ts');
    const store = createThreadedStore(db), lifecycle = createThreadedLifecycle(db, createThreadedAuthority(db, resources), { resources });
    const threadedTicket = label => {
      const room = store.createThread({ title: label, members: [{ agentId: 'aa', handle: 'aa', roleVersion: 1, permissionVersion: 1 }] });
      db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(room.id);
      const invocation = lifecycle.createInvocation({ ownerId, threadId: room.id, agentId: 'aa', causalRootId: randomUUID(), goal: label, requestId: randomUUID() });
      const session = prepareThreadedSession(db, { ownerId, threadId: room.id, agentId: 'aa', backend: 'api',
        backendVersion: 'fixture', model: 'mock:fixture', workspace: root, informationBoundary: 'fixture' });
      return resources.enqueue({ requestKey: randomUUID(), operationId: randomUUID(), mode: 'threaded',
        ownerId, threadId: room.id, invocationId: invocation.id, runId: invocation.runId, agentId: 'aa',
        attemptId: randomUUID(), capacity: true, session, workspaces: [{ path: root, access: 'read' }] });
    };
    const first = resources.tryAcquire(threadedTicket('thread before legacy').id);
    assert.ok(first);
    const old = run('aa', 'actual legacy barrier');
    let oldEntered = false;
    const queued = member(old, 'aa').then(release => { oldEntered = true; return release; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(oldEntered, false);
    const later = threadedTicket('thread after legacy');
    assert.equal(resources.tryAcquire(later.id), null);
    const firstProof = resources.recordQuiescence(first, { reason: 'not_started', sideEffects: 'none' });
    resources.release(first, firstProof);
    assert.equal(resources.tryAcquire(later.id), null, 'older eligible legacy member remains the exclusive barrier');
    await eventually(() => oldEntered, 'legacy waiter resumes after Thread release');
    const releaseOld = await queued;
    assert.equal(resources.tryAcquire(later.id), null, 'actual legacy parent excludes every Thread slot for this Agent');
    releaseOld();
    const next = resources.tryAcquire(later.id); assert.ok(next);
    resources.release(next, resources.recordQuiescence(next, { reason: 'not_started', sideEffects: 'none' }));
    assert.equal(resources.listClaims().length, 0);
    checks.push('Actual legacy member admission and metadata-prepared Threaded tickets share one FIFO exclusive barrier; release wakes the old waiter before a newer Thread');
  }

  {
    const a = run('cc', 'native process evidence');
    const releaseMember = await member(a, 'cc');
    const native = createExecution({ runId: a.id, agentId: 'cc', scopeId: randomUUID(), driver: 'claude-cli', agentVersion: 1, cwd: root });
    const callId = queueModelCall(a.id, 'cc', 'mock:fixture', 'claude-cli');
    const resource = await acquireLegacyModelCall(callId, undefined, native.id);
    resource.start();
    updateExecution(native.id, { progress: { nativeInvokedAt: new Date().toISOString() } });
    const processToken = randomUUID();
    db.prepare("INSERT INTO external_native_processes(token,execution_id,host,pid,status,created_at) VALUES(?,?,?,?,'active',?)")
      .run(processToken, native.id, 'fixture-host', 123456789, new Date().toISOString());
    assert.equal(releaseLegacyNativeResource(resource, native.id), false);
    assert.equal(resources.getClaim(resource.claim.claimId).state, 'unknown');
    releaseMember(); assert.equal(claims(a.id).length, 2);
    assert.throws(() => resources.recordQuiescence(resource.claim, { reason: 'process_exited', sideEffects: 'reconciled', reference: `legacy-native:${native.id}` }), /UNVERIFIED/);
    const unrelated = createExecution({ runId: a.id, agentId: 'cc', scopeId: randomUUID(), driver: 'claude-cli', agentVersion: 1, cwd: root });
    assert.throws(() => resources.recordQuiescence(resource.claim, { reason: 'process_exited', sideEffects: 'reconciled', reference: `legacy-native:${unrelated.id}` }),
      /UNVERIFIED/, 'a different quiescent execution in the same Run/Agent cannot prove this live call has stopped');
    db.prepare("UPDATE external_native_processes SET status='stopped' WHERE token=?").run(processToken);
    assert.equal(releaseLegacyNativeResource(resource, native.id), true);
    assert.equal(resources.listClaims().length, 0);
    checks.push('Native release uses persisted process ownership: an active process remains unknown; a stopped guardian record allows verified cleanup of child and parent without launching a process');
  }

  for (const scoped of [false, true]) {
    const { prepareNativeSession } = await import('../apps/server/src/execution/sessions.ts');
    const a = run('dd', scoped ? 'scoped ephemeral session' : 'transient turn session');
    const releaseMember = await member(a, 'dd');
    const parent = claims(a.id).find(claim => !claim.request.parentClaim).identity;
    const runtimeHome = path.join(root, scoped ? 'unused-account-home' : 'turn-home');
    const scopeHome = path.join(root, 'scope-home');
    const native = createExecution({ runId: a.id, agentId: 'dd', scopeId: randomUUID(), driver: 'claude-sdk', agentVersion: 1, cwd: root });
    let authorized = 0;
    const opts = { run: a, agent: { id: 'dd', version: 1, model: 'mock:fixture',
      execution: { kind: 'external', driver: 'claude-sdk', sessionPolicy: 'turn' } },
      messages: [{ role: 'user', content: 'fixture-secret-context-not-for-session-ledger' }],
      ...(scoped ? { scopedNative: { home: scopeHome, cwd: root, boundary: { sessionBoundaryId: 'fixture-scope' },
        assertAuthorized() { authorized++; } } } : {}) };
    const connection = { managed: true, accountId: 'fixture-native-metadata', runtimeHome,
      binding: { identityGeneration: 1 } };
    const session = await prepareNativeSession(opts, native, new AbortController().signal, false, connection, parent);
    assert.ok(session.input.id); assert.equal(session.input.resume, false);
    assert.equal(session.input[scoped ? 'ephemeral' : 'transient'], true);
    assert.equal(session.input.configDir, scoped ? scopeHome : runtimeHome);
    assert.equal(authorized, scoped ? 1 : 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM external_agent_sessions').get().n, 0, 'cold metadata never persists transcript text');
    const indexed = db.prepare('SELECT * FROM execution_resource_sessions WHERE native_id=?').get(session.input.id);
    assert.ok(indexed); assert.equal(indexed.state, 'ready'); assert.ok(indexed.resource_key);
    assert.ok(!indexed.record.includes('fixture-secret-context'));
    const ref = { id: indexed.id, version: indexed.version, nativeId: indexed.native_id, resourceKey: indexed.resource_key };
    const b = run('bb', 'conflicting cold session');
    const competitor = resources.enqueue({ requestKey: randomUUID(), operationId: randomUUID(), mode: 'legacy',
      ownerId, runId: b.id, agentId: 'bb', attemptId: randomUUID(), capacity: false, session: ref });
    assert.equal(resources.tryAcquire(competitor.id), null, 'another Agent cannot take the preallocated native ID');
    resources.cancelTicket(competitor.id);
    session.bind(session.input.id);
    assert.throws(() => session.bind(randomUUID()), error => error.code === 'protocol_error');
    assert.equal(db.prepare('SELECT state FROM execution_resource_sessions WHERE id=?').get(indexed.id).state, 'reconciling');
    assert.ok(claims(a.id).some(claim => claim.request.session?.id === indexed.id && claim.state === 'unknown'));
    session.finish(false); session.release(); releaseMember();
    assert.equal(resources.listClaims().length, 0);
    checks.push(scoped
      ? 'Scoped ephemeral native preparation keeps its isolated home and preallocated native-ID lock without transcript storage or invocation; mismatched IDs reconcile and unstarted cleanup is verified'
      : 'Turn-scoped transient native preparation indexes and locks its preallocated native ID without transcript storage or invocation; conflicting use is blocked and unexpected IDs require reconciliation');
  }

  {
    const parent = path.join(root, 'raw-parent'), child = path.join(parent, 'child');
    await mkdir(child, { recursive: true });
    const a = run('dd', 'raw lease ancestor interoperability');
    const write = await acquireLegacyResources({ runId: a.id, agentId: 'dd', operationId: randomUUID(),
      workspaces: [{ path: child, access: 'write' }] });
    for (const readonly of [true, false]) assert.throws(() => acquireDurableLease(`workspace:${parent}`, randomUUID(), readonly),
      error => error.code === 'policy_rejected');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM external_workspace_leases').get().n, 0);
    assert.equal(write.release(), true);
    const read = await acquireLegacyResources({ runId: a.id, agentId: 'dd', operationId: randomUUID(),
      workspaces: [{ path: child, access: 'read' }] });
    const releaseRaw = acquireDurableLease(`workspace:${parent}`, randomUUID(), true);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM external_workspace_leases').get().n, 1);
    assert.throws(() => acquireDurableLease(`workspace:${parent}`, randomUUID(), false), error => error.code === 'policy_rejected');
    releaseRaw(); assert.equal(read.release(), true);
    assert.equal(resources.listClaims().length, 0);
    checks.push('A new child-directory write claim excludes legacy raw parent-directory reads/writes; ancestor read/read sharing remains allowed');
  }

  {
    assert.ok(hostOwner.identity, 'current fixture process identity must be observable; never substitute a fake live result');
    assert.equal(ownerAlive(hostOwner), true);
    const workspace = path.join(root, 'raw-owner-nonce'); await mkdir(workspace);
    const key = `workspace:${workspace}`, holder = randomUUID();
    const releaseOld = acquireDurableLease(key, holder, true);
    const old = db.prepare('SELECT * FROM external_workspace_leases WHERE resource=? AND holder=?').get(key, holder);
    db.prepare('UPDATE external_workspace_leases SET expires_at=? WHERE resource=? AND holder=?')
      .run('2000-01-01T00:00:00.000Z', key, holder);
    assert.throws(() => acquireDurableLease(key, holder, true), error => error.code === 'policy_rejected',
      'same resource/holder cannot replace a live read lease');
    assert.throws(() => acquireDurableLease(key, randomUUID(), false), error => error.code === 'policy_rejected',
      'expiry does not reclaim the current live process');
    assert.equal(db.prepare('SELECT owner FROM external_workspace_leases WHERE resource=? AND holder=?').get(key, holder).owner, old.owner);
    releaseOld();
    const releaseNew = acquireDurableLease(key, holder, true);
    const successor = db.prepare('SELECT owner FROM external_workspace_leases WHERE resource=? AND holder=?').get(key, holder).owner;
    assert.notEqual(successor, old.owner);
    releaseOld();
    assert.equal(db.prepare('SELECT owner FROM external_workspace_leases WHERE resource=? AND holder=?').get(key, holder).owner, successor);
    releaseNew();
    assert.equal(db.prepare('SELECT COUNT(*) n FROM external_workspace_leases WHERE resource=?').get(key).n, 0);
    checks.push('Raw live leases survive expiry and reject duplicate read holders; an old release callback cannot erase a later lease with the same holder and a new owner nonce');
  }

  {
    const workspace = path.join(root, 'raw-native-fence'); await mkdir(workspace);
    const a = run('cc', 'raw native fence');
    const native = createExecution({ runId: a.id, agentId: 'cc', scopeId: randomUUID(), driver: 'claude-cli', agentVersion: 1, cwd: workspace });
    const key = `workspace:${workspace}`, release = acquireDurableLease(key, native.id, false);
    const token = randomUUID();
    db.prepare("INSERT INTO external_native_processes(token,execution_id,host,pid,status,created_at) VALUES(?,?,?,?,'active',?)")
      .run(token, native.id, 'fixture-host', 123456789, new Date().toISOString());
    db.prepare('UPDATE external_workspace_leases SET expires_at=?,identity=? WHERE resource=? AND holder=?')
      .run('2000-01-01T00:00:00.000Z', 'fixture-stale-process-identity', key, native.id);
    const prior = db.prepare('SELECT * FROM external_workspace_leases WHERE resource=? AND holder=?').get(key, native.id);
    assert.equal(ownerAlive(prior), false, 'only the current process identity is queried; the deliberately stale stored identity does not match');
    assert.throws(() => acquireDurableLease(key, randomUUID(), false), error => error.code === 'policy_rejected');
    release();
    assert.equal(db.prepare('SELECT owner FROM external_workspace_leases WHERE resource=? AND holder=?').get(key, native.id).owner, prior.owner,
      'an active native record prevents both expired-owner reclaim and callback release');
    db.prepare("UPDATE external_native_processes SET status='stopped' WHERE token=?").run(token);
    release();
    assert.equal(db.prepare('SELECT COUNT(*) n FROM external_workspace_leases').get().n, 0);
    checks.push('Raw leases with expired/stale service ownership retain an active native-process fence; cleanup succeeds only after the process ledger is stopped');
  }

  assert.equal(networkCalls, 0);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  console.log(JSON.stringify({ ok: true, checks, groups: checks.length, networkCalls,
    scope: 'T04 legacy bridge with isolated SQLite and controlled fake provider/process records only; no real model or native process execution' }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  database?.closeDatabase();
  if (setGlobalDispatcher && originalDispatcher) setGlobalDispatcher(originalDispatcher);
  await dispatcher?.close();
  await rm(root, { recursive: true, force: true });
}

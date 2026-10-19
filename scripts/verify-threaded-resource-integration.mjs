import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-resource-integration-'));
process.env.AGENT_GAND_ISOLATED_WORKER = '1';
process.env.DB_PATH = path.join(root, 'unused-singleton.sqlite');
process.env.AGENTS_DIR = path.join(root, 'agents');
const { config } = await import('../apps/server/src/config.ts');
config.sandboxDir = path.join(root, 'sandbox');
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('Fixture forbids network'); };
const { applyOrchestrationSchemaMigrations } = await import('../apps/server/src/db/orchestrationMigrations.ts');
const { createThreadedStore } = await import('../apps/server/src/threaded/store.ts');
const { createThreadedAuthority } = await import('../apps/server/src/threaded/authority.ts');
const { createThreadedLifecycle } = await import('../apps/server/src/threaded/lifecycle.ts');
const { createThreadedResourceAdmission } = await import('../apps/server/src/threaded/resourceAdmission.ts');
const { createThreadedRunner } = await import('../apps/server/src/threaded/runner.ts');
const { createExecutionResourceCoordinator } = await import('../apps/server/src/execution/resources/coordinator.ts');
const { prepareThreadedSession, assertResourceSessionCurrent, assertExpectedNativeSession } = await import('../apps/server/src/execution/resources/sessions.ts');
const schema = await readFile(new URL('../apps/server/src/db/schema.sql', import.meta.url), 'utf8');
const databases = [];
const checks = [];
const count = (db, table) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
async function fixture(name, withAccount = false) {
  const db = new Database(path.join(root, `${name}.sqlite`)); databases.push(db);
  db.pragma('foreign_keys=ON'); db.exec(schema); db.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER');
  applyOrchestrationSchemaMigrations(db);
  const now = new Date().toISOString();
  if (withAccount) db.prepare(`INSERT INTO accounts(id,display_name,provider,auth_type,source,version,config_version,credential_version,created_at,updated_at)
    VALUES('fixture-account','Fixture','openai','api_key','managed',1,1,1,?,?)`).run(now, now);
  db.prepare(`INSERT INTO agents(id,name,definition,source,created_at,updated_at) VALUES('agent-a','A',?,'fixture',?,?)`)
    .run(JSON.stringify({ id: 'agent-a', name: 'A', version: 1, enabled: true, model: 'mock:fixture', tools: [], systemPrompt: 'fixture',
      ...(withAccount ? { accountRef: 'fixture-account' } : {}) }), now, now);
  const store = createThreadedStore(db);
  const thread = store.createThread({ title: name, members: [{ agentId: 'agent-a', handle: 'a', roleVersion: 1, permissionVersion: 1 }] });
  db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(thread.id);
  const workspace = path.join(root, name); await mkdir(workspace);
  const evidence = new Set();
  const resources = createExecutionResourceCoordinator(db, { ownerNonce: `fixture:${name}`,
    validateRequest: request => assertResourceSessionCurrent(db, request),
    verifyEvidence: (_request, claim, proof) => proof.reference === `fixture:${claim.claimId}` && evidence.has(claim.claimId),
  });
  const authority = createThreadedAuthority(db, resources);
  const lifecycle = createThreadedLifecycle(db, authority, { resources });
  const admission = createThreadedResourceAdmission(db, resources, lifecycle);
  const prepInput = { ownerId: thread.ownerId, threadId: thread.id, agentId: 'agent-a', backend: 'claude-sdk',
    backendVersion: 'fixture-only', model: 'mock:fixture', workspace, informationBoundary: 'thread-members-v1' };
  const invocation = () => lifecycle.createInvocation({ ownerId: thread.ownerId, threadId: thread.id, agentId: 'agent-a',
    causalRootId: `root:${name}`, goal: 'fixture' });
  const enqueue = (inv = invocation(), session = prepareThreadedSession(db, prepInput)) => resources.enqueue({
    requestKey: randomUUID(), operationId: randomUUID(), mode: 'threaded', ownerId: thread.ownerId, threadId: thread.id,
    invocationId: inv.id, runId: inv.runId, attemptId: randomUUID(), agentId: 'agent-a', session,
    ...(withAccount ? { accountId: 'fixture-account' } : {}),
    workspaces: [{ path: workspace, access: 'write' }],
  });
  const proof = claim => { evidence.add(claim.claimId); return resources.recordQuiescence(claim,
    { reason: 'process_exited', sideEffects: 'reconciled', reference: `fixture:${claim.claimId}` }); };
  return { db, resources, authority, lifecycle, admission, prepInput, invocation, enqueue, proof, thread, workspace };
}
try {
  {
    const f = await fixture('metadata-cas');
    const first = prepareThreadedSession(f.db, { ...f.prepInput, expectedVersion: 0 });
    assert.match(first.nativeId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(prepareThreadedSession(f.db, f.prepInput), first);
    assert.equal(count(f.db, 'execution_resource_claims'), 0);
    assert.equal(count(f.db, 'runs'), 0);
    assert.throws(() => prepareThreadedSession(f.db, { ...f.prepInput, expectedVersion: 0 }), /CAS_CONFLICT/);
    const ticket = f.enqueue(f.invocation(), first);
    f.db.prepare('UPDATE threaded_members SET permission_version=permission_version+1').run();
    assert.throws(() => f.resources.tryAcquire(ticket.id), /POLICY_CHANGED/);
    assert.equal(count(f.db, 'execution_resource_claims'), 0);
    const cold = prepareThreadedSession(f.db, { ...f.prepInput, expectedVersion: first.version });
    assert.equal(cold.version, 2); assert.notEqual(cold.nativeId, first.nativeId);
    assert.equal(count(f.db, 'execution_resource_session_versions'), 2);
    assert.throws(() => f.db.prepare('DELETE FROM execution_resource_session_versions').run(), /VERSION_RETAINED/);
    assert.throws(() => f.resources.tryAcquire(ticket.id), /SESSION_CHANGED/);
    const api = prepareThreadedSession(f.db, { ...f.prepInput, backend: 'api' });
    assert.equal(api.nativeId, null); assert.equal(api.resourceKey, null);
    assert.throws(() => prepareThreadedSession(f.db, { ...f.prepInput, backend: 'codex-app-server' }), /BACKEND_DISABLED/);
    checks.push('Session short CAS/preallocated UUID/reuse/cold-on-permission/API reconstruction/version history; preparation charges zero');
  }
  {
    const f = await fixture('canonical-workspace');
    const other = path.join(root, 'other-workspace'); await mkdir(other);
    const link = path.join(root, 'workspace-link'); await symlink(f.workspace, link);
    const session = prepareThreadedSession(f.db, { ...f.prepInput, workspace: link });
    const ticket = f.enqueue(f.invocation(), session);
    await unlink(link); await symlink(other, link);
    assert.throws(() => f.resources.tryAcquire(ticket.id), /POLICY_CHANGED/);
    assert.equal(count(f.db, 'execution_resource_claims'), 0);
    checks.push('Canonical workspace alias change between prepare and claim rejects with no capacity/resource partial hold');
  }
  {
    const f = await fixture('atomic-attempt'); const ticket = f.enqueue();
    const initialFairness = f.db.prepare('SELECT * FROM execution_resource_fairness').all();
    const failedAdmission = createThreadedResourceAdmission(f.db, f.resources, { ...f.lifecycle, prepareAttempt(input) {
      f.lifecycle.prepareAttempt(input); throw new Error('fixture after authority capture');
    } });
    assert.throws(() => failedAdmission.prepareAttempt(ticket.id), /fixture after authority/);
    for (const table of ['runs', 'threaded_attempts', 'execution_resource_claims', 'execution_resource_epochs']) assert.equal(count(f.db, table), 0, table);
    assert.deepEqual(f.db.prepare('SELECT * FROM execution_resource_fairness').all(), initialFairness);
    assert.equal(f.resources.getTicket(ticket.id).status, 'waiting');
    const binding = f.admission.prepareAttempt(ticket.id);
    const claim = f.authority.claim(binding);
    const runner = createThreadedRunner(f.authority, f.lifecycle, { async execute(input) {
      assert.equal(f.resources.getClaim(claim.claimId).state, 'started');
      input.assertAuthorized();
      const quiescence = f.proof(claim);
      assert.throws(input.assertAuthorized, /RESOURCE/);
      return { kind: 'completed', content: 'verified output', budgetState: 'settled', quiescence };
    } });
    const result = await runner.execute({ binding, contextManifestId: 'fixture', sessionBindingId: ticket.request.session.id, budgetAuthorizationId: 'fixture' });
    assert.equal(result.status, 'completed'); assert.equal(result.resourceReleasePending, false);
    assert.equal(f.resources.getClaim(claim.claimId).state, 'released');
    assert.equal(count(f.db, 'threaded_outputs'), 1); assert.equal(count(f.db, 'threaded_invocation_terminals'), 1);
    checks.push('Complete claim + Run/Attempt atomic rollback; start transition shared; proof permits terminal output but denies late effects');
  }
  {
    const f = await fixture('unknown-runner'); const ticket = f.enqueue(); const binding = f.admission.prepareAttempt(ticket.id);
    const claim = f.authority.claim(binding);
    const runner = createThreadedRunner(f.authority, f.lifecycle, { async execute() { throw new Error('fake runner failed; fake process remains live'); } });
    const result = await runner.execute({ binding, contextManifestId: 'fixture', sessionBindingId: ticket.request.session.id, budgetAuthorizationId: 'fixture' });
    assert.equal(result.status, 'unknown'); assert.equal(f.resources.getClaim(claim.claimId).state, 'unknown');
    const next = f.enqueue(); assert.equal(f.admission.prepareAttempt(next.id), null);
    assert.throws(() => f.resources.recordQuiescence(claim, { reason: 'process_exited', sideEffects: 'reconciled' }), /UNVERIFIED/);
    assert.throws(() => f.authority.assertAuthorized(binding), /RESOURCE|THREADED/);
    f.lifecycle.requestControl({ ownerId: f.thread.ownerId, scope: { kind: 'invocation', threadId: f.thread.id, invocationId: binding.invocationId }, action: 'stop', requestId: 'stop-unknown' });
    const quiescence = f.proof(claim);
    const settled = f.lifecycle.recordOutcome(binding, { kind: 'cancelled', reason: 'fixture reconciled', budgetState: 'unknown', quiescence });
    assert.equal(settled.status, 'cancelled'); assert.equal(f.resources.getClaim(claim.claimId).state, 'released');
    const successor = f.admission.prepareAttempt(next.id); assert.ok(successor);
    f.resources.release(claim, quiescence); f.resources.assertCurrent(f.authority.claim(successor));
    checks.push('Throwing runner retains unknown claim; stop cannot steal; verified quiet release, old finally cannot release successor');
  }
  {
    const f = await fixture('quiescence-control-race'); const ticket = f.enqueue(); const binding = f.admission.prepareAttempt(ticket.id);
    const claim = f.authority.claim(binding); f.lifecycle.startAttempt(binding);
    const quiescence = f.proof(claim);
    const control = f.lifecycle.requestControl({ ownerId: f.thread.ownerId, scope: { kind: 'invocation', threadId: f.thread.id,
      invocationId: binding.invocationId }, action: 'stop', requestId: 'stop-after-proof' });
    assert.equal(control.status, 'pending');
    assert.equal(f.resources.getClaim(claim.claimId).state, 'quiescent');
    assert.throws(() => f.authority.assertAuthorized(binding), /RESOURCE|THREADED/);
    const result = f.lifecycle.recordOutcome(binding, { kind: 'cancelled', reason: 'owner stopped after process exit', budgetState: 'settled', quiescence });
    assert.equal(result.status, 'cancelled'); assert.equal(f.resources.getClaim(claim.claimId).state, 'released');
    checks.push('Proof-before-outcome race: stop commits while preserving quiescence, then the original proof settles cancellation and releases');
  }
  {
    const f = await fixture('quiescence-revocation-race', true); const ticket = f.enqueue(); const binding = f.admission.prepareAttempt(ticket.id);
    const claim = f.authority.claim(binding); f.lifecycle.startAttempt(binding); const quiescence = f.proof(claim);
    f.db.prepare("INSERT INTO account_revocations(account_id,revoked_at) VALUES('fixture-account','2026-10-20')").run();
    assert.deepEqual(f.lifecycle.revokeAccount('fixture-account').affectedRunIds, [binding.runId]);
    assert.equal(f.resources.getClaim(claim.claimId).state, 'quiescent');
    const result = f.lifecycle.recordOutcome(binding, { kind: 'cancelled', reason: 'account revoked after process exit', budgetState: 'unknown', quiescence });
    assert.equal(result.status, 'cancelled'); assert.equal(f.resources.getClaim(claim.claimId).state, 'released');
    assert.equal(count(f.db, 'threaded_outputs'), 0);
    checks.push('Account revocation after a durable quiescence proof fences the Invocation atomically and permits verified cancellation without output');
  }
  {
    const f = await fixture('quiescence-late-callback'); const ticket = f.enqueue(); const binding = f.admission.prepareAttempt(ticket.id);
    const claim = f.authority.claim(binding); f.lifecycle.startAttempt(binding); const quiescence = f.proof(claim);
    const unknown = f.lifecycle.recordOutcome(binding, { kind: 'unknown', reason: 'late callback failed after process exit' });
    assert.equal(unknown.status, 'unknown'); assert.equal(f.resources.getClaim(claim.claimId).state, 'quiescent');
    f.resources.verifyQuiescence(claim, quiescence);
    f.lifecycle.requestControl({ ownerId: f.thread.ownerId, scope: { kind: 'invocation', threadId: f.thread.id,
      invocationId: binding.invocationId }, action: 'stop', requestId: 'stop-late-callback' });
    const result = f.lifecycle.recordOutcome(binding, { kind: 'cancelled', reason: 'late callback reconciled', budgetState: 'settled', quiescence });
    assert.equal(result.status, 'cancelled'); assert.equal(f.resources.getClaim(claim.claimId).state, 'released');
    checks.push('Late unknown callbacks cannot erase verified process quiescence or prevent subsequent controlled settlement');
  }
  {
    const f = await fixture('unexpected-native'); const ticket = f.enqueue(); const binding = f.admission.prepareAttempt(ticket.id);
    f.lifecycle.startAttempt(binding);
    assert.throws(() => assertExpectedNativeSession(f.db, ticket.request.session, randomUUID()), /IDENTITY_RECONCILIATION_REQUIRED/);
    f.lifecycle.recordOutcome(binding, { kind: 'unknown', reason: 'SESSION_IDENTITY_RECONCILIATION_REQUIRED' });
    assert.throws(() => f.authority.assertAuthorized(binding), /RESOURCE|THREADED/);
    assert.throws(() => prepareThreadedSession(f.db, f.prepInput), /RECONCILIATION_REQUIRED/);
    assert.equal(f.resources.listClaims().length, 1);
    assert.equal(f.db.prepare('SELECT native_id FROM execution_resource_sessions WHERE id=?').get(ticket.request.session.id).native_id, ticket.request.session.nativeId);
    checks.push('Unexpected native ID retains original identity and fences; further effects and silent cold replacement denied');
  }
  assert.equal(networkCalls, 0);
  console.log(JSON.stringify({ ok: true, groups: checks.length, checks, networkCalls, realModelCalls: 0 }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  for (const db of databases) if (db.open) db.close();
  await rm(root, { recursive: true, force: true });
}

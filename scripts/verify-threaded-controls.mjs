import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFakeThreadedResources } from './fixtures/threadedFakeExecutor.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-threaded-controls-'));
Object.assign(process.env, {
  AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', DB_PATH: path.join(root, 'fixture.sqlite'),
  AGENTS_DIR: path.join(root, 'agents'), HOST: '127.0.0.1', PORT: '3010', LOG_LEVEL: 'silent',
  ACCOUNT_TRUSTED_ORIGINS: 'http://127.0.0.1:3010', THREADED_COLLABORATION_MODE: 'closed',
});
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('No external requests in control fixture'); };
let database, app, access;
try {
  const { config } = await import('../apps/server/src/config.ts');
  config.sandboxDir = path.join(root, 'sandbox');
  database = await import('../apps/server/src/db/database.ts');
  const { db } = database;
  const { default: Fastify } = await import('../apps/server/node_modules/fastify/fastify.js');
  const { default: websocket } = await import('../apps/server/node_modules/@fastify/websocket/index.js');
  const { createThreadedStore } = await import('../apps/server/src/threaded/store.ts');
  const { createThreadedAuthority } = await import('../apps/server/src/threaded/authority.ts');
  const { createThreadedLifecycle } = await import('../apps/server/src/threaded/lifecycle.ts');
  const { createThreadedAccess } = await import('../apps/server/src/threaded/access.ts');
  const { abortThreadedExecution, watchThreadedExecution } = await import('../apps/server/src/threaded/executionSignals.ts');
  const { registerThreadedAccessBridge, registerThreadedRoutes } = await import('../apps/server/src/api/threadedRoutes.ts');
  const management = await import('../apps/server/src/accounts/access.ts');
  const { revokeAccount } = await import('../apps/server/src/accounts/actions.ts');
  const { threadedLifecycle: productionLifecycle } = await import('../apps/server/src/threaded/service.ts');
  const timestamp = new Date().toISOString();
  db.prepare(`INSERT INTO accounts(id,display_name,provider,auth_type,source,version,config_version,created_at,updated_at)
    VALUES('fixture-account','fixture','openai','api_key','managed',1,1,?,?)`).run(timestamp, timestamp);
  db.prepare(`INSERT INTO account_versions(account_id,version,connection,created_at) VALUES('fixture-account',1,?,?)`)
    .run(JSON.stringify({ provider: 'openai', protocols: ['openai-chat-completions'], baseUrl: 'https://fixture.invalid', timeoutMs: 1000, defaultModel: 'fixture' }), timestamp);
  for (const id of ['agent-a', 'agent-b']) db.prepare(`INSERT INTO agents(id,name,definition,source,created_at,updated_at)
    VALUES(?,?,?,'fixture',?,?)`).run(id, id, JSON.stringify({ id, name: id, model: 'mock:fixture', accountRef: 'fixture-account' }), timestamp, timestamp);
  const store = createThreadedStore(db);
  const room = title => {
    const t = store.createThread({ title, members: ['agent-a', 'agent-b'].map(agentId => ({ agentId, handle: agentId, roleVersion: 1, permissionVersion: 1 })) });
    db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(t.id);
    return t;
  };
  const thread = room('control room'), other = room('other room');
  const resources = createFakeThreadedResources();
  const authority = createThreadedAuthority(db, resources);
  const lifecycle = createThreadedLifecycle(db, authority, { resources, onInvalidate: ids => {
    for (const id of ids) abortThreadedExecution(id);
  } });
  const prepare = (t = thread, agentId = 'agent-a') => {
    const invocation = lifecycle.createInvocation({ ownerId: t.ownerId, threadId: t.id, agentId,
      causalRootId: randomUUID(), goal: 'control fixture', requestId: randomUUID() });
    const claim = resources.acquire({ ownerId: t.ownerId, threadId: t.id, invocationId: invocation.id,
      runId: invocation.runId, agentId });
    const binding = lifecycle.prepareAttempt({ ownerId: t.ownerId, invocationId: invocation.id, claim });
    lifecycle.startAttempt(binding);
    return binding;
  };
  const first = prepare(), sibling = prepare(thread, 'agent-b');
  const controller = new AbortController();
  const unwatch = watchThreadedExecution(first.invocationId, controller);
  access = createThreadedAccess(() => store.getInstanceOwnerId());
  const context = { store, access, lifecycle };
  app = Fastify({ logger: false });
  await app.register(websocket);
  await app.register(async accounts => {
    accounts.addHook('onRequest', async request => {
      management.assertManagementBoundary(request);
      if (request.routeOptions.url !== '/api/accounts/session' || request.method !== 'POST') management.requireManagementSession(request);
    });
    accounts.post('/api/accounts/session', async (request, reply) => management.createManagementSession(request, reply));
    accounts.delete('/api/accounts/session', async (request, reply) => management.deleteManagementSession(request, reply));
    await registerThreadedAccessBridge(accounts, context);
  });
  await registerThreadedRoutes(app, context);
  await app.ready();
  const request = (url, payload, auth = {}) => app.inject({ method: 'POST', url,
    headers: { host: '127.0.0.1:3010', origin: 'http://127.0.0.1:3010', ...auth }, payload });
  const parent = await request('/api/accounts/session', undefined, { 'x-gand-bootstrap': '1' });
  assert.equal(parent.statusCode, 200);
  const parentAuth = { cookie: parent.headers['set-cookie'].split(';')[0], 'x-gand-csrf': parent.json().csrfToken };
  const bridge = await request('/api/accounts/threaded/access-session', undefined, parentAuth);
  assert.equal(bridge.statusCode, 200);
  const auth = { cookie: bridge.headers['set-cookie'].split(';')[0], 'x-gand-csrf': bridge.json().csrfToken };
  const controlUrl = `/api/threaded/threads/${thread.id}/invocations/${first.invocationId}/controls`;
  const action = { action: 'pause', requestId: 'pause-once' };
  assert.equal((await request(controlUrl, action)).statusCode, 401);
  assert.equal((await request(controlUrl, action, { ...auth, 'x-gand-csrf': 'bad' })).statusCode, 403);
  assert.equal((await request(controlUrl, { ...action, ownerId: thread.ownerId }, auth)).statusCode, 400);
  assert.equal((await request(controlUrl, { ...action, claimId: 'forged' }, auth)).statusCode, 400);
  const wrongScope = await request(`/api/threaded/threads/${other.id}/invocations/${first.invocationId}/controls`, action, auth);
  assert.ok([404, 409].includes(wrongScope.statusCode), wrongScope.body);
  assert.equal(authority.authorized(first), true);
  const paused = await request(controlUrl, action, auth);
  assert.equal(paused.statusCode, 200, paused.body);
  assert.equal(controller.signal.aborted, true);
  assert.equal(authority.authorized(first), false);
  assert.equal(authority.authorized(sibling), true, 'Invocation-scoped pause must preserve its sibling');
  assert.deepEqual((await request(controlUrl, action, auth)).json(), paused.json());
  assert.equal((await request(controlUrl, { ...action, action: 'stop' }, auth)).statusCode, 409);
  assert.equal((await request('/api/threaded/threads', { title: 'still closed' }, auth)).statusCode, 403);
  unwatch();

  const approvalBinding = prepare(other);
  const approval = lifecycle.registerApproval(approvalBinding, { requestKey: 'tool-approval', record: { purpose: 'fixture' } });
  const decision = { decision: 'approve', requestId: 'approval-once' };
  const wrongApproval = await request(`/api/threaded/threads/${thread.id}/approvals/${approval.id}/decision`, decision, auth);
  assert.ok([404, 409].includes(wrongApproval.statusCode), wrongApproval.body);
  assert.equal(db.prepare('SELECT status FROM threaded_approvals WHERE id=?').get(approval.id).status, 'pending');
  const approvalUrl = `/api/threaded/threads/${other.id}/approvals/${approval.id}/decision`;
  assert.equal((await request(approvalUrl, decision, { ...auth, 'x-gand-csrf': 'bad' })).statusCode, 403);
  const approved = await request(approvalUrl, decision, auth);
  assert.equal(approved.statusCode, 200, approved.body);
  assert.deepEqual((await request(approvalUrl, decision, auth)).json(), approved.json());
  assert.equal(authority.authorized(approvalBinding), true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM threaded_attempts WHERE invocation_id=?').get(approvalBinding.invocationId).n, 1);

  // A management cookie expiring does not revoke work which was already authorized.
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/threaded/session',
    headers: { host: '127.0.0.1:3010', origin: 'http://127.0.0.1:3010', ...auth } })).statusCode, 200);
  assert.equal(authority.authorized(sibling), true);
  const accountAbort = new AbortController();
  const unwatchAccount = watchThreadedExecution(sibling.invocationId, accountAbort);
  db.exec(`CREATE TRIGGER fixture_revoke_rollback BEFORE UPDATE ON threaded_invocations
    BEGIN SELECT RAISE(ABORT,'fixture-revoke-failure'); END;`);
  await assert.rejects(() => revokeAccount('fixture-account', { expectedVersion: 1 }), /fixture-revoke-failure/);
  assert.equal(db.prepare("SELECT enabled FROM accounts WHERE id='fixture-account'").get().enabled, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM account_revocations WHERE account_id='fixture-account'").get().n, 0);
  assert.equal(accountAbort.signal.aborted, false, 'Rolled-back revocation cannot abort a live execution');
  db.exec('DROP TRIGGER fixture_revoke_rollback');
  await revokeAccount('fixture-account', { expectedVersion: 1 });
  assert.equal(authority.authorized(sibling), false);
  assert.equal(accountAbort.signal.aborted, true);
  assert.equal(db.prepare('SELECT finished_at FROM runs WHERE id=?').get(sibling.runId).finished_at, null,
    'Account revocation must not invent process quiescence');
  unwatchAccount();
  productionLifecycle.recoverAll();
  const after = db.prepare('SELECT * FROM threaded_invocations ORDER BY id').all();
  productionLifecycle.recoverAll();
  assert.deepEqual(db.prepare('SELECT * FROM threaded_invocations ORDER BY id').all(), after);
  assert.equal(resources.releases.length, 0, 'Controls never unconditionally release an unknown process');
  assert.equal(networkCalls, 0);
  console.log('threaded controls passed: authenticated scoped HTTP, CSRF, idempotency, sibling isolation, logout independence, atomic account revoke/abort, production recovery, zero network');
} finally {
  if (app) await app.close();
  access?.close();
  database?.closeDatabase();
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}

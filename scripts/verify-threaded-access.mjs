import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-threaded-access-'));
Object.assign(process.env, {
  AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', DB_PATH: path.join(root, 'test.sqlite'),
  AGENTS_DIR: path.join(root, 'agents'), HOST: '127.0.0.1', PORT: '3010', LOG_LEVEL: 'silent',
  ACCOUNT_TRUSTED_ORIGINS: 'http://127.0.0.1:3010',
});
delete process.env.THREADED_COLLABORATION_MODE;
const origin = 'http://127.0.0.1:3010';
const baseHeaders = { host: '127.0.0.1:3010', origin };
let app, database, access;
const sockets = new Set();
const timeout = (promise, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), 3000);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

try {
  const { default: Fastify } = await import('../apps/server/node_modules/fastify/fastify.js');
  const { default: websocket } = await import('../apps/server/node_modules/@fastify/websocket/index.js');
  database = await import('../apps/server/src/db/database.ts');
  const { createThreadedStore } = await import('../apps/server/src/threaded/store.ts');
  const { createThreadedAccess } = await import('../apps/server/src/threaded/access.ts');
  const { threadedCapabilities, threadedAdmissionMode } = await import('../apps/server/src/threaded/policy.ts');
  const { registerThreadedAccessBridge, registerThreadedRoutes } = await import('../apps/server/src/api/threadedRoutes.ts');
  const management = await import('../apps/server/src/accounts/access.ts');
  const { emit } = await import('../apps/server/src/messaging/bus.ts');
  const { THREADED_HTTP_VERSION, THREADED_TOOL_VERSION } = await import('../packages/shared/src/threaded.ts');
  const store = createThreadedStore(database.db);
  const timestamp = new Date().toISOString();
  database.db.prepare('INSERT INTO agents(id,name,definition,source,enabled,created_at,updated_at) VALUES(?,?,?,?,1,?,?)')
    .run('threaded-fixture', 'Fixture', '{}', 'fixture', timestamp, timestamp);
  const thread = store.createThread({ title: 'Private snapshot fixture', members: [
    { agentId: 'threaded-fixture', handle: 'fixture', roleVersion: 1, permissionVersion: 1 },
  ] });
  const owner = store.getInstanceOwnerId();
  assert.equal(thread.state, 'closed');
  assert.equal(store.getThread(thread.id, 'forged-owner'), null);
  assert.deepEqual(store.listMembers(thread.id, 'forged-owner'), []);
  let clock = Date.now();
  access = createThreadedAccess(() => store.getInstanceOwnerId(), { now: () => clock, lifetimeMs: 60_000 });
  const context = { store, access };
  app = Fastify({ logger: false });
  await app.register(websocket);
  // Use the real management primitives with the same encapsulation as accountRoutes,
  // without loading account providers or any inference/worker entry point.
  await app.register(async accounts => {
    accounts.addHook('onRequest', async request => {
      management.assertManagementBoundary(request);
      if (!(request.routeOptions.url === '/api/accounts/session' && request.method === 'POST')) management.requireManagementSession(request);
    });
    accounts.setErrorHandler((error, _request, reply) => reply.code(error.status ?? 500).send({ error: error.message }));
    accounts.post('/api/accounts/session', async (request, reply) => management.createManagementSession(request, reply));
    accounts.delete('/api/accounts/session', async (request, reply) => management.deleteManagementSession(request, reply));
    await registerThreadedAccessBridge(accounts, context);
  });
  await registerThreadedRoutes(app, context);
  await app.ready();

  const request = (url, method = 'GET', headers = {}, payload) => app.inject({
    method, url, headers: { ...baseHeaders, ...headers }, ...(payload === undefined ? {} : { payload }),
  });
  const response = async (...args) => { const result = await request(...args); return { status: result.statusCode, data: result.json(), headers: result.headers }; };
  const connectManagement = async () => {
    const result = await response('/api/accounts/session', 'POST', { 'x-gand-bootstrap': '1' });
    assert.equal(result.status, 200);
    assert.match(result.headers['set-cookie'], /Path=\/api\/accounts;/);
    return { cookie: result.headers['set-cookie'].split(';')[0], 'x-gand-csrf': result.data.csrfToken };
  };
  const bridge = async parent => {
    const result = await response('/api/accounts/threaded/access-session', 'POST', parent);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.match(result.headers['set-cookie'], /Path=\/api\/threaded; HttpOnly; SameSite=Strict/);
    assert.equal(result.data.httpVersion, THREADED_HTTP_VERSION);
    return { cookie: result.headers['set-cookie'].split(';')[0], 'x-gand-csrf': result.data.csrfToken };
  };
  const openSocket = async auth => {
    const messages = [];
    let firstResolve, closedResolve;
    const first = new Promise(resolve => { firstResolve = resolve; });
    const closed = new Promise(resolve => { closedResolve = resolve; });
    const socket = await app.injectWS(`/api/threaded/ws?threadId=${thread.id}&httpVersion=${THREADED_HTTP_VERSION}`, {
      headers: { ...baseHeaders, ...auth }, socket: { remoteAddress: '127.0.0.1' },
    }, { onInit: ws => {
      ws.on('message', data => { const value = JSON.parse(String(data)); messages.push(value); firstResolve(value); });
      ws.on('close', (code, reason) => closedResolve({ code, reason: String(reason) }));
    } });
    sockets.add(socket);
    const initial = await timeout(first, 'authenticated snapshot');
    assert.equal(initial.type, 'threaded.snapshot');
    assert.equal(initial.thread.id, thread.id);
    assert.equal(initial.thread.ownerId, owner);
    assert.equal(initial.members[0].agentId, 'threaded-fixture');
    return { socket, messages, closed };
  };

  assert.equal(threadedAdmissionMode(), 'closed');
  assert.equal((await response('/api/threaded/capabilities')).status, 401);
  assert.equal((await response('/api/threaded/threads')).status, 401);
  assert.equal((await response('/api/accounts/threaded/access-session', 'POST')).status, 401);
  const parent = await connectManagement();
  assert.equal((await response('/api/accounts/threaded/access-session', 'POST', { ...parent, 'x-gand-csrf': 'wrong' })).status, 403);
  assert.equal((await response('/api/accounts/threaded/access-session', 'POST', parent, { ownerId: 'forged' })).data.code, 'THREADED_IDENTITY_FIELD_REJECTED');
  assert.equal((await response('/api/accounts/threaded/access-session', 'POST', parent, { schemaVersion: 2 })).data.code, 'THREADED_VERSION_UNSUPPORTED');
  assert.equal((await response('/api/threaded/threads', 'GET', parent)).status, 401, 'management cookie must not authenticate threaded routes');
  const auth = await bridge(parent);
  assert.notEqual(auth.cookie, parent.cookie);
  const capabilities = await response('/api/threaded/capabilities', 'GET', auth);
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.data.toolVersion, THREADED_TOOL_VERSION);
  assert.equal(capabilities.data.schemaVersion, 1);
  assert.equal(capabilities.data.implemented.admission, false);
  assert.equal(capabilities.data.implemented.execution, false);
  assert.equal(capabilities.data.implemented.tools, false);
  assert.ok(Object.values(capabilities.data.verified).every(value => value === false));
  assert.equal(capabilities.headers['cache-control'], 'no-store');
  assert.equal((await response('/api/threaded/threads', 'GET', auth)).data.threads.length, 1);
  assert.equal((await response(`/api/threaded/threads/${thread.id}`, 'GET', auth)).data.thread.ownerId, owner);
  assert.equal((await response(`/api/threaded/threads/${thread.id}/members`, 'GET', auth)).data.members.length, 1);
  assert.equal((await response('/api/threaded/threads/foreign-or-missing', 'GET', auth)).status, 404);
  assert.equal((await response('/api/threaded/threads?ownerId=forged', 'GET', auth)).data.code, 'THREADED_IDENTITY_FIELD_REJECTED');
  for (const extra of [
    { origin: 'https://evil.invalid' }, { host: 'evil.invalid', 'x-forwarded-host': '127.0.0.1:3010' },
    { 'sec-fetch-site': 'cross-site' },
  ]) assert.equal((await response('/api/threaded/threads', 'GET', { ...auth, ...extra })).status, 403);
  for (const extra of [
    { 'x-gand-threaded-http-version': 'threaded-http-v2' },
    { 'x-gand-threaded-tool-version': 'threaded-tools-v2' },
    { 'x-gand-threaded-schema-version': '2' },
  ]) assert.equal((await response('/api/threaded/threads', 'GET', { ...auth, ...extra })).data.code, 'THREADED_VERSION_UNSUPPORTED');
  assert.equal((await response('/api/threaded/threads?httpVersion=unknown', 'GET', auth)).status, 409);
  assert.equal((await response('/api/threaded/threads', 'POST', { ...auth, 'x-gand-csrf': '' }, {})).status, 403);
  assert.equal((await response('/api/threaded/threads', 'POST', auth, { ownerId: owner })).status, 400);
  for (const mode of ['closed', 'observe', 'execute']) {
    process.env.THREADED_COLLABORATION_MODE = mode;
    assert.equal(threadedCapabilities().configured.mode, mode);
    const rejected = await response('/api/threaded/threads', 'POST', auth, { title: 'Must not create', members: [] });
    assert.equal(rejected.status, mode === 'closed' ? 403 : 501);
    assert.equal((await response('/api/threaded/tools/post_message', 'POST', auth, { body: 'must not send' })).status, mode === 'closed' ? 403 : 501);
  }
  process.env.THREADED_COLLABORATION_MODE = 'unknown';
  assert.throws(threadedAdmissionMode, error => error.code === 'THREADED_CONFIGURATION_INVALID');
  delete process.env.THREADED_COLLABORATION_MODE;
  assert.equal(store.listThreads(owner).length, 1);

  const upgrade = headers => ({ headers: { ...baseHeaders, ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  await assert.rejects(app.injectWS(`/api/threaded/ws?threadId=${thread.id}`, upgrade({})), /401/);
  await assert.rejects(app.injectWS(`/api/threaded/ws?threadId=${thread.id}`, upgrade({ ...auth, origin: 'https://evil.invalid' })), /403/);
  await assert.rejects(app.injectWS('/api/threaded/ws?threadId=foreign-or-missing', upgrade(auth)), /404/);
  await assert.rejects(app.injectWS(`/api/threaded/ws?threadId=${thread.id}&httpVersion=unknown`, upgrade(auth)), /409/);
  const live = await openSocket(auth);
  emit({ type: 'run.updated', run: { id: 'legacy-private-sentinel' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(live.messages.length, 1, 'threaded WS must not subscribe to the unfiltered legacy bus');
  assert.equal((await response('/api/threaded/session', 'DELETE', { ...auth, 'x-gand-csrf': 'wrong' })).status, 403);
  assert.equal((await response('/api/threaded/session', 'GET', auth)).status, 200);
  assert.equal((await response('/api/threaded/session', 'DELETE', auth)).status, 200);
  assert.equal((await timeout(live.closed, 'threaded logout closes socket')).code, 1008);
  assert.equal((await response('/api/threaded/threads', 'GET', auth)).status, 401);
  const secondAuth = await bridge(parent);
  const parentBoundSocket = await openSocket(secondAuth);
  let laterInvalidations = 0;
  const removeFaultyListener = management.onManagementSessionInvalidated(() => { throw new Error('fixture subscriber failure'); });
  const removeLaterListener = management.onManagementSessionInvalidated(() => { laterInvalidations++; });
  assert.equal((await response('/api/accounts/session', 'DELETE', parent)).status, 200);
  assert.equal(laterInvalidations, 1, 'one faulty derived subscriber must not prevent logout or later invalidations');
  removeFaultyListener();
  removeLaterListener();
  assert.equal((await timeout(parentBoundSocket.closed, 'management logout closes derived socket')).code, 1008);
  assert.equal((await response('/api/threaded/threads', 'GET', secondAuth)).status, 401);

  const newParent = await connectManagement();
  const expiryAuth = await bridge(newParent);
  assert.equal((await response(`/api/threaded/threads/${thread.id}`, 'GET', expiryAuth)).data.thread.ownerId, owner, 'relogin must retain stable business owner');
  const expiring = await openSocket(expiryAuth);
  clock += 60_001;
  assert.equal((await timeout(expiring.closed, 'expiry closes long-lived socket without new HTTP request')).code, 1008);
  assert.equal((await response('/api/threaded/threads', 'GET', expiryAuth)).status, 401);
  const readOnlyAuth = await bridge(newParent);
  const readOnlySocket = await openSocket(readOnlyAuth);
  readOnlySocket.socket.send(JSON.stringify({ type: 'post_message', body: 'not accepted' }));
  assert.equal((await timeout(readOnlySocket.closed, 'WS writes rejected')).code, 1008);

  for (const table of ['runs', 'messages', 'tool_executions', 'threaded_invocations', 'threaded_attempts', 'threaded_run_bindings']) {
    assert.equal(database.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, `${table}: access verification must not admit execution`);
  }
  assert.equal(store.getInstanceOwnerId(), owner);
  console.log('threaded access fixtures passed: management bridge, stable owner, HTTP/WS ACL, CSRF, versions, expiry/logout, disabled admission, no execution');
} finally {
  for (const socket of sockets) socket.terminate();
  for (const socket of app?.websocketServer.clients ?? []) socket.terminate();
  if (app) await app.close();
  access?.close();
  database?.closeDatabase();
  await rm(root, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakeThreadedResources } from './fixtures/threadedFakeExecutor.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-message-api-'));
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DB_PATH: path.join(root, 'fixture.sqlite'), AGENTS_DIR: path.join(root, 'agents'),
  HOST: '127.0.0.1', PORT: '3010', ACCOUNT_TRUSTED_ORIGINS: 'http://127.0.0.1:3010', THREADED_COLLABORATION_MODE: 'closed' });
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('No external requests in message API fixture'); };
let database, app, access, messaging;
const sockets = new Set(), checks = [];
try {
  const { config } = await import('../apps/server/src/config.ts'); config.sandboxDir = path.join(root, 'sandbox');
  database = await import('../apps/server/src/db/database.ts'); const { db } = database;
  const { default: Fastify } = await import('../apps/server/node_modules/fastify/fastify.js');
  const { default: websocket } = await import('../apps/server/node_modules/@fastify/websocket/index.js');
  const { createThreadedStore } = await import('../apps/server/src/threaded/store.ts');
  const { createThreadedAccess } = await import('../apps/server/src/threaded/access.ts');
  const { createThreadedAuthority } = await import('../apps/server/src/threaded/authority.ts');
  const { createThreadedMessageAcl } = await import('../apps/server/src/threaded/acl.ts');
  const { createThreadedMessaging } = await import('../apps/server/src/threaded/messaging.ts');
  const { registerThreadedAccessBridge, registerThreadedRoutes } = await import('../apps/server/src/api/threadedRoutes.ts');
  const { rejectThreadedAdmission } = await import('../apps/server/src/threaded/policy.ts');
  const management = await import('../apps/server/src/accounts/access.ts');
  const now = new Date().toISOString();
  for (const id of ['aa', 'bb']) db.prepare(`INSERT INTO agents(id,name,definition,source,created_at,updated_at)
    VALUES(?,?,?,'fixture',?,?)`).run(id, id, JSON.stringify({ id, model: 'mock:fixture', version: 1 }), now, now);
  const store = createThreadedStore(db);
  const room = label => {
    const value = store.createThread({ title: label, members: ['aa', 'bb'].map(agentId => ({ agentId, handle: agentId, roleVersion: 1, permissionVersion: 1 })) });
    db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(value.id); return value;
  };
  const thread = room('API'), other = room('Other');
  const graph = new Map(); let sourceLoads = 0, revokeSource = false;
  for (let i = 0; i <= 20; i++) graph.set(`graph-${i}`, { id: `graph-${i}`, ownerId: thread.ownerId,
    threadId: thread.id, sender: { kind: 'user' }, visibility: 'public', state: 'published', audience: [],
    sourceRefs: Array.from({ length: i }, (_, j) => `graph-${j}`) });
  const graphAcl = createThreadedMessageAcl(db, { loadMessage(id) {
    sourceLoads++; assert.ok(sourceLoads < 128, 'Shared provenance must not expand exponentially');
    return revokeSource && id === 'graph-0' ? null : graph.get(id) ?? null;
  } });
  const graphScope = { ownerId: thread.ownerId, threadId: thread.id, viewer: { kind: 'owner' } };
  assert.equal(graphAcl.canRead(graphScope, graph.get('graph-20')), true); assert.equal(sourceLoads, 20);
  revokeSource = true; sourceLoads = 0;
  assert.equal(graphAcl.canRead(graphScope, graph.get('graph-20')), false, 'Each read must observe current source authorization');
  checks.push('Shared provenance DAG reads are bounded by distinct sources while every new authorization decision rechecks revocation');
  messaging = createThreadedMessaging(db, { authority: createThreadedAuthority(db, createFakeThreadedResources()), repairIntervalMs: 0 });
  const secret = messaging.messages.acceptUserMessage({ ownerId: thread.ownerId, threadId: thread.id, clientRequestId: 'secret',
    body: 'private marker', visibility: 'private', audience: ['aa'], targets: ['aa'],
    attachments: [{ name: '来源.txt', mediaType: 'text/plain', contentBase64: Buffer.from('private attachment').toString('base64') }] });
  const publicMessage = messaging.messages.acceptUserMessage({ ownerId: thread.ownerId, threadId: thread.id,
    clientRequestId: 'public', body: 'public marker', targets: ['bb'] });
  const derived = messaging.messages.acceptUserMessage({ ownerId: thread.ownerId, threadId: thread.id,
    clientRequestId: 'derived', body: 'private summary', visibility: 'private', audience: ['aa'], sourceRefs: [secret.message.id] });
  access = createThreadedAccess(() => store.getInstanceOwnerId());
  let admit = false;
  const context = { store, access, messages: messaging.messages, onMessageNotification: messaging.onNotification,
    messageAdmission: () => { if (!admit) rejectThreadedAdmission(); } };
  app = Fastify({ logger: false }); await app.register(websocket);
  await app.register(async accounts => {
    accounts.addHook('onRequest', async request => {
      management.assertManagementBoundary(request);
      if (request.routeOptions.url !== '/api/accounts/session' || request.method !== 'POST') management.requireManagementSession(request);
    });
    accounts.post('/api/accounts/session', async (request, reply) => management.createManagementSession(request, reply));
    await registerThreadedAccessBridge(accounts, context);
  });
  await registerThreadedRoutes(app, context); await app.ready();
  const headers = { host: '127.0.0.1:3010', origin: 'http://127.0.0.1:3010' };
  const request = (url, method = 'GET', auth = {}, payload) => app.inject({ method, url,
    headers: { ...headers, ...auth }, ...(payload === undefined ? {} : { payload }) });
  const parent = await request('/api/accounts/session', 'POST', { 'x-gand-bootstrap': '1' });
  assert.equal(parent.statusCode, 200, parent.body);
  const parentAuth = { cookie: parent.headers['set-cookie'].split(';')[0], 'x-gand-csrf': parent.json().csrfToken };
  const grant = await request('/api/accounts/threaded/access-session', 'POST', parentAuth);
  assert.equal(grant.statusCode, 200, grant.body);
  const auth = { cookie: grant.headers['set-cookie'].split(';')[0], 'x-gand-csrf': grant.json().csrfToken };
  const url = `/api/threaded/threads/${thread.id}/messages`;
  const exact = `${url}/${secret.message.id}`, attachment = `/api/threaded/threads/${thread.id}/attachments/${secret.message.attachments[0].id}`;
  for (const endpoint of [url, exact, `${url}/search?q=private`, attachment, `${url}/${derived.message.id}/sources`]) {
    assert.equal((await request(endpoint)).statusCode, 401);
    assert.equal((await request(endpoint, 'GET', parentAuth)).statusCode, 401);
  }
  assert.equal((await request(url, 'GET', { ...auth, origin: 'https://evil.invalid' })).statusCode, 403);
  assert.equal((await request(`${url}?ownerId=forged`, 'GET', auth)).statusCode, 400);
  assert.equal((await request(`${url}?agentId=aa`, 'GET', auth)).statusCode, 400);
  assert.equal((await request(`${url}?httpVersion=unknown`, 'GET', auth)).statusCode, 409);
  checks.push('HTTP owner/session/origin/version checks apply to exact messages, history, search, attachment and source expansion; browser clients cannot choose an Agent principal');

  assert.equal((await request(exact, 'GET', auth)).json().message.body, 'private marker');
  assert.deepEqual((await request(`${url}?afterSeq=${secret.message.seq}&limit=1`, 'GET', auth)).json().messages.map(m => m.id), [publicMessage.message.id]);
  assert.equal((await request(`${url}/search?q=private`, 'GET', auth)).json().messages.length, 2);
  const download = await request(attachment, 'GET', auth);
  assert.equal(download.statusCode, 200); assert.equal(download.body, 'private attachment');
  assert.equal(download.headers['x-content-type-options'], 'nosniff');
  assert.match(download.headers['content-disposition'], /attachment; filename\*=UTF-8''/);
  assert.ok(!JSON.stringify((await request(url, 'GET', auth)).json()).includes('contentBase64'));
  assert.deepEqual((await request(`${url}/${derived.message.id}/sources`, 'GET', auth)).json().messages.map(m => m.id), [secret.message.id]);
  for (const endpoint of [
    `/api/threaded/threads/${other.id}/messages/${secret.message.id}`,
    `/api/threaded/threads/${other.id}/attachments/${secret.message.attachments[0].id}`,
    `${url}/absent`, `${url}/absent/sources`,
  ]) assert.equal((await request(endpoint, 'GET', auth)).statusCode, 404, endpoint);
  for (const suffix of ['?limit=0', '?limit=101', '?afterSeq=-1', '?afterSeq=1.5', '/search?q=']) {
    assert.equal((await request(`${url}${suffix}`, 'GET', auth)).statusCode, 400, suffix);
  }
  checks.push('Authenticated Owner historical reads return exact scoped content/owned attachment bytes and source provenance; foreign scopes and malformed pagination reject');

  const input = { clientRequestId: 'http-request', body: 'HTTP acceptance', targets: ['aa'] };
  const before = db.prepare('SELECT COUNT(*) n FROM threaded_messages').get().n;
  for (const mode of ['closed', 'observe', 'execute']) {
    process.env.THREADED_COLLABORATION_MODE = mode;
    assert.equal((await request(url, 'POST', auth, input)).statusCode, mode === 'closed' ? 403 : 501);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM threaded_messages').get().n, before);
  assert.equal((await request(url, 'POST', { ...auth, 'x-gand-csrf': 'bad' }, input)).statusCode, 403);
  process.env.THREADED_COLLABORATION_MODE = 'closed';
  admit = true; // Explicit isolated route dependency only. Production installs no admission override.
  for (const extra of [{ ownerId: thread.ownerId }, { actor: 'system' }, { binding: {} }, { causalRootId: 'forged' }, { fromAgent: 'aa' }]) {
    assert.equal((await request(url, 'POST', auth, { ...input, ...extra })).statusCode, 400);
  }
  const [accepted, duplicate] = await Promise.all([request(url, 'POST', auth, input), request(url, 'POST', auth, input)]);
  assert.equal(accepted.statusCode, 200, accepted.body); assert.equal(duplicate.statusCode, 200, duplicate.body);
  assert.deepEqual(accepted.json(), duplicate.json());
  assert.equal((await request(url, 'POST', auth, { ...input, body: 'changed' })).statusCode, 409);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM runs').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get().n, 0);
  checks.push('Production admission stays closed in all configured modes; isolated injected acceptance has CSRF/identity validation, durable stable retries/conflicts, and zero Runs/legacy messages');

  const hints = [], socketEvents = [];
  const socket = await app.injectWS(`/api/threaded/ws?threadId=${thread.id}`, { headers: { ...headers, ...auth },
    socket: { remoteAddress: '127.0.0.1' } }, { onInit(ws) { ws.on('message', raw => socketEvents.push(JSON.parse(String(raw)))); } });
  sockets.add(socket);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(socketEvents[0].type, 'threaded.snapshot');
  const unwatch = messaging.onNotification(hint => { hints.push(hint); });
  const pushed = await request(url, 'POST', auth, { clientRequestId: 'hint', body: 'hint secret not in notification', targets: ['aa'] });
  assert.equal(pushed.statusCode, 200, pushed.body);
  await new Promise(resolve => setImmediate(resolve));
  const id = pushed.json().receipt.message.id;
  assert.ok(hints.some(hint => hint.sourceId === id));
  assert.ok(socketEvents.some(event => event.type === 'threaded.change' && event.sourceId === id));
  assert.ok(!JSON.stringify(socketEvents).includes('hint secret not in notification'));
  assert.ok(!JSON.stringify(hints).includes('hint secret not in notification'));
  const countBeforeOther = socketEvents.length;
  messaging.messages.acceptUserMessage({ ownerId: other.ownerId, threadId: other.id, clientRequestId: 'other-hint', body: 'other private', targets: ['aa'] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(socketEvents.length, countBeforeOther);
  await request('/api/threaded/session', 'DELETE', auth);
  const countBeforeLogout = socketEvents.length;
  messaging.messages.acceptUserMessage({ ownerId: thread.ownerId, threadId: thread.id, clientRequestId: 'after-logout', body: 'after logout' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(socketEvents.length, countBeforeLogout); unwatch();
  checks.push('Commit notifications actively reach the authorized Thread socket as IDs only, skip other Threads, and stop after session logout');

  assert.equal(networkCalls, 0);
  console.log(JSON.stringify({ ok: true, groups: checks.length, checks, networkCalls, realModelCalls: 0 }, null, 2));
} finally {
  for (const socket of sockets) socket.terminate();
  for (const socket of app?.websocketServer?.clients ?? []) socket.terminate();
  await app?.close(); access?.close(); messaging?.close(); database?.closeDatabase();
  globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true });
}

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openBackendRuntimeFixture } from './threadedBackendRuntimeFixture.mjs';

// This is a complete isolated API/backend/lifecycle composition, not index.ts
// and not a real supplier. Every database/configuration is explicitly temporary.
const [root, name, restore, initialClock] = process.argv.slice(2);
if (!path.isAbsolute(root ?? '')) throw new Error('Explicit temporary root required');
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DB_PATH: path.join(root, `t12-unused-${process.pid}.sqlite`), AGENTS_DIR: path.join(root, 'agents'),
  HOST: '127.0.0.1', PORT: '3010', ACCOUNT_TRUSTED_ORIGINS: 'http://127.0.0.1:3010',
  AGENT_GAND_PRIVATE_DIR: path.join(root, 'private'), THREADED_COLLABORATION_MODE: 'closed' });
let forbiddenNetworkCalls = 0, clock = Number(initialClock) || Date.now() + 60_000, activeClaim, plan;
globalThis.fetch = async () => { forbiddenNetworkCalls++; throw new Error('T12 external network forbidden'); };
const { THREADED_APPLICATION_TOOL_NAMES } = await import('../../apps/server/src/threaded/tools.ts');
const stamp = new Date().toISOString();
const f = await openBackendRuntimeFixture(root, name, { restore: restore === 'restore', now: () => clock,
  agentIds: ['api-member', 'other-member', 'fourth-member'], applicationTools: THREADED_APPLICATION_TOOL_NAMES,
  account: { id: 't12-account', rows: { accounts: [{ id: 't12-account', display_name: 'T12 synthetic account',
    provider: 'mock', auth_type: 'api_key', source: 'fixture', enabled: 1, archived: 0, version: 1,
    config_version: 1, credential_version: null, created_at: stamp, updated_at: stamp }] } },
  fetch: async () => {
    f.db.prepare('INSERT INTO fixture_t12_requests(attempt_id,invocation_id,created_at) VALUES(?,?,?)')
      .run(activeClaim.binding.attemptId, activeClaim.binding.invocationId, clock);
    const results = [];
    for (const call of plan?.tools ?? []) {
      const result = JSON.parse(await f.runtime.collaboration.tools.execute(activeClaim.binding, call.name,
        call.input, call.key ?? randomUUID(), THREADED_APPLICATION_TOOL_NAMES));
      if (!result.ok) throw new Error(JSON.stringify(result)); results.push(result.result);
    }
    if (plan?.approval) {
      const approval = f.runtime.lifecycle.registerApproval(activeClaim.binding,
        { requestKey: 't12-pending-approval', record: { purpose: 'isolated approval recovery' } });
      process.send?.({ event: 'approval-pending', approval, claim: activeClaim });
      await new Promise(() => {});
    }
    if (plan?.holdRequest) {
      process.send?.({ event: 'request-started', claim: activeClaim });
      await new Promise(() => {});
    }
    process.send?.({ event: 'tools-complete', results });
    return new Response(JSON.stringify({ id: randomUUID(), type: 'message',
      content: [{ type: 'text', text: plan?.body ?? 'T12 synthetic final' }], stop_reason: 'end_turn',
      usage: { input_tokens: 20, output_tokens: 7 } }), { headers: { 'content-type': 'application/json' } });
  } });
if (restore !== 'restore') {
  f.db.exec('CREATE TABLE fixture_t12_requests(attempt_id TEXT PRIMARY KEY,invocation_id TEXT NOT NULL,created_at INTEGER NOT NULL)');
  f.runtime.collaboration.routing.configure(f.thread.ownerId, f.thread.id,
    { preferred: [], defaultAgent: 'api-member', groups: {} }, 0);
  f.db.prepare(`INSERT INTO messages(id,run_id,from_agent,to_agent,kind,body,created_at)
    VALUES('t12-legacy-message','t12-legacy-run','api-member','other-member','text','T12_LEGACY_ONLY',?)`).run(stamp);
}
const { default: Fastify } = await import('../../apps/server/node_modules/fastify/fastify.js');
const { default: websocket } = await import('../../apps/server/node_modules/@fastify/websocket/index.js');
const { createThreadedStore } = await import('../../apps/server/src/threaded/store.ts');
const { createThreadedAccess } = await import('../../apps/server/src/threaded/access.ts');
const { createThreadedView } = await import('../../apps/server/src/threaded/view.ts');
const { registerThreadedAccessBridge, registerThreadedRoutes } = await import('../../apps/server/src/api/threadedRoutes.ts');
const management = await import('../../apps/server/src/accounts/access.ts');
const store = createThreadedStore(f.db), access = createThreadedAccess(() => f.thread.ownerId);
const context = { store, access, messages: f.runtime.messages, lifecycle: f.runtime.lifecycle,
  collaboration: f.runtime.collaboration, onMessageNotification: f.runtime.messaging.onNotification,
  messageAdmission() {}, view: createThreadedView(f.db, { store, messages: f.runtime.messages }) };
const app = Fastify({ logger: false }); await app.register(websocket);
await app.register(async accounts => {
  accounts.addHook('onRequest', async request => { management.assertManagementBoundary(request);
    if (request.routeOptions.url !== '/api/accounts/session' || request.method !== 'POST') management.requireManagementSession(request); });
  accounts.post('/api/accounts/session', async (request, reply) => management.createManagementSession(request, reply));
  await registerThreadedAccessBridge(accounts, context);
});
await registerThreadedRoutes(app, context); await app.ready();
const api = async (url, payload, auth = {}, method = 'POST') => {
  const response = await app.inject({ method, url, headers: { host: '127.0.0.1:3010',
    origin: 'http://127.0.0.1:3010', ...auth }, ...(payload === undefined ? {} : { payload }) });
  return { statusCode: response.statusCode, body: response.json(), cookie: response.headers['set-cookie']?.split(';')[0] };
};
let auth;
async function login() {
  const parent = await api('/api/accounts/session', undefined, { 'x-gand-bootstrap': '1' });
  if (parent.statusCode !== 200) throw new Error(JSON.stringify(parent));
  const bridge = await api('/api/accounts/threaded/access-session', undefined,
    { cookie: parent.cookie, 'x-gand-csrf': parent.body.csrfToken });
  if (bridge.statusCode !== 200) throw new Error(JSON.stringify(bridge));
  return auth = { cookie: bridge.cookie, 'x-gand-csrf': bridge.body.csrfToken };
}
const tables = ['threaded_messages', 'threaded_wakes', 'threaded_outbox', 'threaded_invocations', 'runs',
  'threaded_attempts', 'threaded_invocation_terminals', 'threaded_backend_requests', 'threaded_budget_roots',
  'threaded_budget_requests', 'execution_resource_claims', 'threaded_consultation_settlements',
  'threaded_collaboration_callbacks', 'fixture_t12_requests'];
const snap = () => ({ clock, thread: f.thread, forbiddenNetworkCalls,
  counts: Object.fromEntries(tables.map(table => [table, f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n])),
  messages: f.db.prepare('SELECT id,origin,body,causal_root_id FROM threaded_messages ORDER BY seq').all(),
  queue: f.db.prepare('SELECT id,state,reason,causal_root_id,invocation_id FROM threaded_wake_queue ORDER BY seq').all(),
  attempts: f.db.prepare('SELECT id,invocation_id,status,execution_stage,resource_release_state FROM threaded_attempts ORDER BY rowid').all(),
  budgets: f.db.prepare('SELECT * FROM threaded_budget_requests ORDER BY rowid').all(),
  claims: f.db.prepare('SELECT state FROM execution_resource_claims ORDER BY rowid').all(),
  approvals: f.db.prepare('SELECT id,status FROM threaded_approvals ORDER BY rowid').all(),
  settlements: f.db.prepare('SELECT record FROM threaded_consultation_settlements ORDER BY rowid').all().map(row => JSON.parse(row.record)),
  callbacks: f.db.prepare('SELECT id,state,message_id,reason FROM threaded_collaboration_callbacks ORDER BY rowid').all(),
  legacy: f.db.prepare('SELECT * FROM messages ORDER BY rowid').all(),
  foreignKeys: f.db.pragma('foreign_key_check') });
process.on('message', async message => {
  const { id, operation, args = [] } = message;
  try {
    let result;
    if (operation === 'login') result = await login();
    else if (operation === 'api') result = await api(args[0], args[1], args[2] ?? auth, args[3]);
    else if (operation === 'accept') result = f.user(args[0], args[1] ?? ['api-member'], args[2]);
    else if (operation === 'acceptAndDie') { f.user(args[0]); process.kill(process.pid, 'SIGKILL'); return; }
    else if (operation === 'claim') result = f.runtime.queue.claimNext(`t12-process:${process.pid}`);
    else if (operation === 'execute') {
      activeClaim = args[0] ?? f.runtime.queue.claimNext(`t12-process:${process.pid}`); plan = args[1] ?? {};
      if (!activeClaim) throw new Error('T12 claim required');
      if (plan.killAfterCommit) f.resources.release = () => { process.kill(process.pid, 'SIGKILL'); };
      result = { claim: activeClaim, outcome: await f.runtime.executeClaim(activeClaim) }; activeClaim = undefined;
    } else if (operation === 'recover') result = f.runtime.recover();
    else if (operation === 'clock') result = clock = args[0];
    else if (operation === 'snapshot') result = snap();
    else if (operation === 'budgetUsage') result = f.runtime.budget.getUsage(args[0]);
    else if (operation === 'queryOnly') result = f.db.pragma(`query_only=${args[0] ? 'ON' : 'OFF'}`);
    else if (operation === 'restrict') {
      if (args[0] === 'member-left') f.db.prepare("UPDATE threaded_members SET status='left',version=version+1 WHERE thread_id=? AND agent_id='api-member'").run(f.thread.id);
      else if (args[0] === 'permission') f.db.prepare("UPDATE threaded_members SET permission_version=permission_version+1,version=version+1 WHERE thread_id=? AND agent_id='api-member'").run(f.thread.id);
      else if (args[0] === 'account') {
        f.db.prepare("UPDATE accounts SET enabled=0,version=version+1 WHERE id='t12-account'").run();
        f.db.prepare("INSERT OR IGNORE INTO account_revocations VALUES('t12-account',?)").run(stamp);
        f.runtime.lifecycle.revokeAccount('t12-account');
      } else if (args[0] === 'stop') f.runtime.lifecycle.requestControl({ ownerId: f.thread.ownerId,
        scope: { kind: 'thread', threadId: f.thread.id }, action: 'stop', requestId: randomUUID() });
      result = snap();
    } else if (operation === 'close') { await app.close(); access.close(); f.close();
      process.send?.({ id, result: true }); process.disconnect(); return; }
    else throw new Error(`Unknown T12 operation ${operation}`);
    process.send?.({ id, result });
  } catch (error) { process.send?.({ id, error: { code: error.code, message: error.message } }); }
});
process.send?.({ ready: true, pid: process.pid, thread: f.thread, clock,
  composition: ['Fastify registered threaded routes', 'authenticated access', 'createThreadedBackendRuntime',
    'createThreadedLifecycle', 'createThreadedCollaboration', 'createThreadedView'], transport: 'injected synthetic API response',
  mainIndex: false, externalProviders: false });

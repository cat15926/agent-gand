import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'gand-threaded-boundary-'));
await mkdir(path.join(root, 'agents'));
Object.assign(process.env, {
  AGENT_GAND_ISOLATED_WORKER: '1', DB_PATH: path.join(root, 'test.sqlite'),
  AGENTS_DIR: path.join(root, 'agents'),
  HOST: '127.0.0.1', PORT: '41973', ACCOUNT_TRUSTED_ORIGINS: 'http://127.0.0.1:41973',
  MCP_SERVER_CMD: '', THREADED_COLLABORATION_MODE: 'closed',
});
let networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { networkCalls++; throw new Error('Unexpected external call in boundary fixture'); };
const { config } = await import('../apps/server/src/config.ts');
config.sandboxDir = path.join(root, 'sandbox');
await mkdir(path.join(config.sandboxDir, 'workspaces', 'shared-fixture'), { recursive: true });
const database = await import('../apps/server/src/db/database.ts');
const { references } = await import('../apps/server/src/accounts/store.ts');
const { default: Fastify } = await import('../apps/server/node_modules/fastify/fastify.js');
const { default: websocket } = await import('../apps/server/node_modules/@fastify/websocket/index.js');
const { registerRoutes } = await import('../apps/server/src/api/routes.ts');
const { registerAccountRoutes } = await import('../apps/server/src/api/accountRoutes.ts');
const { registerWs } = await import('../apps/server/src/api/ws.ts');
const { emit } = await import('../apps/server/src/messaging/bus.ts');
const { isLegacyEvent, hasThreadedReference } = await import('../apps/server/src/threaded/legacyBoundary.ts');
const { getRun } = await import('../apps/server/src/runs/trace.ts');
const app = Fastify();
let ws;
try {
  await app.register(websocket);
  await app.register(registerRoutes);
  await registerAccountRoutes(app);
  await app.register(registerWs);
  const now = '2026-10-19T00:00:00Z';
  for (const [id, mode] of [['legacy', 'pipeline'], ['private', 'threaded']]) {
    database.run('INSERT INTO conversations(id,title,mode,agent_ids,created_at,updated_at) VALUES (?,?,?,?,?,?)', id + '-room', id + '-title', mode, '[]', now, now);
    database.run('INSERT INTO runs(id,conversation_id,turn_no,goal,mode,status,agent_ids,created_at) VALUES (?,?,?,?,?,?,?,?)', id + '-run', id + '-room', 1, id + '-secret-goal', mode, 'waiting_for_user', '[]', now);
    database.run('INSERT INTO tasks(id,run_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?)', id + '-task', id + '-run', id + '-task-title', 'pending', now, now);
    database.run('INSERT INTO approvals(id,run_id,agent_id,tool_name,status,created_at) VALUES (?,?,?,?,?,?)', id + '-approval', id + '-run', 'fixture-agent', 'fixture-tool', 'pending', now);
    database.run('INSERT INTO run_events(id,run_id,span_kind,name,status,tokens_in,tokens_out,cost_usd,started_at) VALUES (?,?,?,?,?,?,?,?,?)', id + '-span', id + '-run', 'llm', id + '-span-title', 'ok', 11, 22, 0.01, now);
    database.run('INSERT INTO managed_artifact_versions(id,conversation_id,run_id,path,version,record,content,created_at) VALUES (?,?,?,?,?,?,?,?)', id + '-artifact', id + '-room', id + '-run', 'fixture.txt', 1, '{}', id + '-content', now);
    database.run('INSERT INTO artifact_snapshots(id,run_id,manifest,digest,payload,created_at) VALUES (?,?,?,?,?,?)', id + '-snapshot', id + '-run', '{}', 'fixture', '{}', now);
    database.run("UPDATE runs SET workspace='shared-fixture' WHERE id=?", id + '-run');
    database.run('INSERT INTO run_agent_snapshots(run_id,agent_id,version,definition,created_at) VALUES (?,?,?,?,?)', id + '-run', 'fixture-agent', 1, JSON.stringify({ accountRef: 'fixture-account' }), now);
  }
  const { createThreadedStore } = await import('../apps/server/src/threaded/store.ts');
  const { createThreadedMessages } = await import('../apps/server/src/threaded/messages.ts');
  database.run(`INSERT INTO agents(id,name,definition,source,created_at,updated_at)
    VALUES('t05-fixture','T05','{}','fixture',?,?)`, now, now);
  const messageThread = createThreadedStore(database.db).createThread({ title: 'private-T05-room', members: [
    { agentId: 't05-fixture', handle: 't05', roleVersion: 1, permissionVersion: 1 },
  ] });
  database.run("UPDATE threaded_threads SET state='open' WHERE id=?", messageThread.id);
  const authored = createThreadedMessages(database.db).acceptUserMessage({ ownerId: messageThread.ownerId,
    threadId: messageThread.id, clientRequestId: 'private-source', visibility: 'private', audience: ['t05-fixture'],
    body: 'private-T05-authored-body', targets: ['t05-fixture'],
    attachments: [{ name: 'private-T05.txt', mediaType: 'text/plain', contentBase64: Buffer.from('private-T05-attachment').toString('base64') }] });
  await app.ready();
  const headers = { host: '127.0.0.1:41973' };
  const call = (url, method = 'GET', payload, extra = {}) => app.inject({ method, url, headers: { ...headers, ...extra }, ...(payload === undefined ? {} : { payload }) });
  const forbidden = [
    '/api/runs/private-run', '/api/runs/private-run/observability', '/api/runs/private-run/spans/private-span',
    '/api/runs/private-run/checkpoints', '/api/runs/private-run/tool-executions', '/api/runs/private-run/executions',
    '/api/runs/private-run/workspace/patch', '/api/runs/private-run/recovery',
    '/api/conversations/private-room', '/api/conversations/private-room/history',
    '/api/conversations/private-room/history/search?q=secret', '/api/conversations/private-room/task-state',
    '/api/tasks/private-task', '/api/tasks/private-task/attempts', '/api/tasks/private-task/reviews',
    '/api/messages?runId=private-run', '/api/tasks?runId=private-run',
    '/api/conversations/legacy-room/task-state?runIds=private-run',
    `/api/conversations/${messageThread.conversationId}/history`,
    `/api/conversations/${messageThread.conversationId}/history/search?q=private-T05`,
    `/api/messages/${authored.message.id}`,
  ];
  for (const url of forbidden) assert.equal((await call(url)).statusCode, 404, url);
  for (const [url, method, body] of [
    ['/api/runs/private-run/stop', 'POST', {}], ['/api/tasks/private-task/complete', 'POST', { agentId: 'fixture-agent' }],
    ['/api/approvals/private-approval/decide', 'POST', { decision: 'approve' }],
    ['/api/conversations/private-room', 'PATCH', { title: 'changed' }],
    ['/api/messages', 'POST', { runId: 'private-run', from: 'user', to: 'all', kind: 'user', body: 'forbidden' }],
    ['/api/tasks', 'POST', { runId: 'private-run', title: 'forbidden' }],
    ['/api/conversations/empty', 'POST', { mode: 'threaded', title: 'forbidden' }],
    ['/api/orchestration/preview', 'POST', { mode: 'threaded', goal: 'forbidden' }],
    ['/api/runs', 'POST', { conversationId: 'private-room', goal: 'forbidden' }],
  ]) assert.equal((await call(url, method, body)).statusCode, 404, url);

  for (const url of ['/api/runs', '/api/conversations', '/api/tasks', '/api/approvals', '/api/usage', '/api/health']) {
    const result = await call(url);
    assert.equal(result.statusCode, 200, result.body);
    assert.ok(!result.body.includes('private-'), url + ' leaked private records');
    if (url !== '/api/health') assert.ok(result.body.includes('legacy-'), url + ' lost legacy records');
    else assert.equal(result.json().runs, 1);
  }
  assert.equal((await call('/api/tasks/legacy-task')).statusCode, 200);
  assert.equal((await call('/api/runs/legacy-run/checkpoints')).statusCode, 200);
  const workspaces = await call('/api/workspaces');
  assert.equal(workspaces.statusCode, 200, workspaces.body);
  assert.equal(workspaces.json()[0].runCount, 1);
  assert.equal(workspaces.json()[0].lastGoal, 'legacy-secret-goal');
  assert.deepEqual(references('fixture-account', { legacyOnly: true }).activeRuns.map(row => row.id), ['legacy-run']);
  assert.equal(references('fixture-account').activeRuns.length, 2, 'Internal revocation still sees every account use');

  const login = await call('/api/accounts/session', 'POST', undefined, { 'x-gand-bootstrap': '1' });
  assert.equal(login.statusCode, 200, login.body);
  const auth = { cookie: login.headers['set-cookie'].split(';')[0], 'x-gand-csrf': login.json().csrfToken };
  database.run("INSERT INTO information_release_workflows VALUES ('private-run','legacy-run','fixture-agent','{}')");
  database.run("INSERT INTO information_release_policies VALUES ('private-policy','private-run',1,'proposed',?,'{}')", now);
  database.run("INSERT INTO information_release_grants VALUES ('private-grant','private-policy','private-run','ready','{}')");
  for (const url of ['/api/accounts/information-release-policies/private-policy/revoke', '/api/accounts/information-releases/grants/private-grant/publish']) {
    assert.equal((await call(url, 'POST', {}, auth)).statusCode, 404, url);
  }
  assert.deepEqual(database.get("SELECT status,version FROM information_release_policies WHERE id='private-policy'"), { status: 'proposed', version: 1 }, 'refusal must occur before policy mutation');
  assert.equal(database.get("SELECT status FROM information_release_grants WHERE id='private-grant'").status, 'ready');
  for (const url of ['/api/accounts/business/private-run', '/api/accounts/artifacts/rooms/private-room', '/api/accounts/artifacts/private-artifact/content', '/api/accounts/artifact-snapshots/private-snapshot/content/file/0']) {
    assert.equal((await call(url, 'GET', undefined, auth)).statusCode, 404, url);
  }

  assert.equal(hasThreadedReference({ body: 'private-run is ordinary text', id: 'private-run' }), false);
  assert.equal(hasThreadedReference({ references: [{ sourceRunId: 'private-run' }] }), true);
  assert.equal(isLegacyEvent({ type: 'threaded.message', body: 'secret' }), false);
  const received = [];
  ws = await app.injectWS('/ws');
  ws.on('message', data => received.push(JSON.parse(data.toString())));
  for (const id of ['private', 'legacy']) {
    emit({ type: 'run.updated', run: getRun(id + '-run') });
    emit({ type: 'llm.delta', runId: id + '-run', spanId: id + '-span', text: id + '-token' });
    emit({ type: 'usage', usage: { runId: id + '-run', tokensIn: 11, tokensOut: 22, costUsd: .01, llmCalls: 1, toolCalls: 0 } });
  }
  emit({ type: 'threaded.message', threadId: messageThread.id, message: authored.message });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(received.some(event => event.type === 'run.updated'), 'legacy WS lost events');
  assert.ok(!JSON.stringify(received).includes('private-'), 'legacy WS leaked a scoped event');
  assert.equal(database.get('SELECT COUNT(*) n FROM runs').n, 2);
  assert.equal(database.get('SELECT COUNT(*) n FROM messages').n, 0);
  assert.equal(database.get('SELECT COUNT(*) n FROM threaded_messages').n, 1);
  assert.equal(database.get('SELECT COUNT(*) n FROM tasks').n, 2);
  assert.equal(database.get("SELECT status FROM approvals WHERE id='private-approval'").status, 'pending');
  assert.equal(getRun('private-run').status, 'waiting_for_user');
  assert.equal(networkCalls, 0);
  console.log('T02 legacy boundary passed: mixed HTTP reads/writes/derived IDs/lists and WS isolate Threaded; legacy records remain usable; zero external calls. ISO01/ISO02/ISO03 and CTX02/UI01 transport subcases only.');
} finally {
  ws?.terminate();
  await app.close();
  database.closeDatabase();
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}

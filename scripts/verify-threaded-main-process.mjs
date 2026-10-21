import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-threaded-t12-main-')));
await mkdir(path.join(root, 'agents')); const children = [], checks = [], evidence = [];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const file = path.join(root, 'main.sqlite'), stdoutLimit = 15_000;
const guard = new URL('./fixtures/threadedT12MainGuard.mjs', import.meta.url).pathname;
const loader = new URL('../apps/server/node_modules/tsx/dist/loader.mjs', import.meta.url).pathname;
const entry = new URL('../apps/server/src/index.ts', import.meta.url).pathname;
async function unusedPort() {
  const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function start(mode, dbPath = file, expectFailure = false) {
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  // Do not inherit model keys, proxy, MCP commands, configured accounts, homes or
  // .env. ISOLATED_WORKER disables repository .env loading before any import.
  const env = { PATH: process.env.PATH, LANG: 'en_US.UTF-8', NODE_ENV: 'test',
    AGENT_GAND_ISOLATED_WORKER: '1', DB_PATH: dbPath, AGENTS_DIR: path.join(root, 'agents'),
    AGENT_GAND_PRIVATE_DIR: path.join(root, 'private'), T12_MAIN_ROOT: root,
    HOST: '127.0.0.1', PORT: String(port), LOG_LEVEL: 'silent',
    ACCOUNT_TRUSTED_ORIGINS: origin, THREADED_COLLABORATION_MODE: mode };
  const child = fork(entry, [], { execArgv: ['--import', loader, '--import', guard], env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], cwd: root });
  children.push(child); let output = '', sequence = 0;
  child.stdout.on('data', data => { output = (output + data).slice(-stdoutLimit); });
  child.stderr.on('data', data => { output = (output + data).slice(-stdoutLimit); });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  const pending = new Map(); child.on('message', message => { const waiter = pending.get(message.id); if (!waiter) return;
    pending.delete(message.id); if (message.error) waiter.reject(new Error(message.error)); else waiter.resolve(message.result); });
  const request = async (url, payload, auth = {}, method = 'POST') => {
    const response = await fetch(`${origin}${url}`, { method, headers: { origin,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...auth },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    return { statusCode: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const end = Date.now() + 20_000; let ready = false;
  while (Date.now() < end) {
    if (child.exitCode !== null || child.signalCode) break;
    try { const response = await request('/api/health', undefined, {}, 'GET'); if (response.statusCode === 200) { ready = true; break; } } catch {}
    await delay(50);
  }
  if (expectFailure) { assert.equal(ready, false, 'unsupported schema must never listen');
    const status = await Promise.race([exited, delay(2000).then(() => { throw new Error('unsupported schema process did not exit'); })]);
    assert.notEqual(status.code, 0); return { child, port, origin, output, exited, status }; }
  assert.equal(ready, true, `actual index startup failed: ${output}`);
  const call = () => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => reject(new Error('main diagnostics timeout')), 5000);
    pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
    child.send({ id, operation: 't12-diagnostics' }); });
  let auth;
  const login = async () => {
    const parent = await request('/api/accounts/session', undefined, { 'x-gand-bootstrap': '1' }); assert.equal(parent.statusCode, 200, JSON.stringify(parent));
    const bridge = await request('/api/accounts/threaded/access-session', undefined,
      { cookie: parent.cookie, 'x-gand-csrf': parent.body.csrfToken }); assert.equal(bridge.statusCode, 200, JSON.stringify(bridge));
    return auth = { cookie: bridge.cookie, 'x-gand-csrf': bridge.body.csrfToken };
  };
  return { child, port, origin, exited, call, login, request: (url, payload, method = 'POST', headers = auth) => request(url, payload, headers, method),
    async kill(signal = 'SIGKILL') { child.kill(signal); const status = await exited; assert.equal(status.signal, signal); return status; },
    async close() { child.kill('SIGTERM'); const result = await Promise.race([exited, delay(10_000).then(() => { throw new Error('main graceful shutdown timeout'); })]);
      assert.equal(result.code, 0, output); return result; } };
}
function businessSnapshot(dbPath = file) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'threaded_%' ORDER BY name").all().map(row => row.name);
    const tables = Object.fromEntries(names.map(name => { const rows = db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(); return [name, { rows: rows.length, sha256: hash(rows) }]; }));
    const result = { tables, messages: db.prepare('SELECT id,body,origin FROM threaded_messages ORDER BY seq').all(),
      migrations: db.prepare('SELECT * FROM orchestration_schema_migrations ORDER BY version').all(), foreignKeys: db.pragma('foreign_key_check') };
    assert.deepEqual(result.foreignKeys, []); return result;
  } finally { db.close(); }
}
function assertNoExecution(diag) {
  assert.equal(diag.entry, 'apps/server/src/index.ts'); assert.equal(diag.forbiddenFetchAttempts, 0);
  assert.equal(diag.diagnostics.executionEnabled, false);
  for (const [name, value] of Object.entries(diag.counts)) assert.equal(value, 0, name);
}
try {
  const first = await start('closed'); await first.login(); const initial = await first.call(); assertNoExecution(initial);
  const closedCapabilities = await first.request('/api/threaded/capabilities', undefined, 'GET'); assert.equal(closedCapabilities.body.configured.mode, 'closed');
  assert.equal((await first.request('/api/threaded/threads', { title: 'T12 forbidden new work', clientRequestId: randomUUID() })).statusCode, 403);
  await first.close(); checks.push({ id: 'MAIN01', passed: true, description: 'Actual index.ts starts all production routes/recovery services on a real loopback listener with a clean isolated configuration and zero execution.' });

  Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', DB_PATH: path.join(root, 'unused-parent.sqlite'),
    AGENTS_DIR: path.join(root, 'agents'), LOG_LEVEL: 'silent' });
  const { createThreadedStore } = await import('../apps/server/src/threaded/store.ts');
  const { createThreadedMessages } = await import('../apps/server/src/threaded/messages.ts');
  const { createThreadedMessageAcl } = await import('../apps/server/src/threaded/acl.ts');
  const db = new Database(file); db.pragma('foreign_keys=ON'); const stamp = new Date().toISOString();
  const def = { id: 't12-main-member', name: 'T12 isolated member', model: 'mock:fixture', version: 1, enabled: true, tools: [], permissionMode: 'readonly' };
  db.prepare(`INSERT INTO agents(id,name,definition,source,created_at,updated_at) VALUES(?,?,?,'fixture',?,?)`)
    .run(def.id, def.name, JSON.stringify(def), stamp, stamp);
  const store = createThreadedStore(db), thread = store.createThread({ title: 'T12 actual main historical Thread',
    members: [{ agentId: def.id, handle: def.id, roleVersion: 1, permissionVersion: 1 }] });
  db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(thread.id);
  const messages = createThreadedMessages(db, { authority: { assertAuthorized() { throw new Error('No fixture execution authority'); } }, acl: createThreadedMessageAcl(db) });
  messages.acceptUserMessage({ ownerId: thread.ownerId, threadId: thread.id, clientRequestId: randomUUID(), body: 'T12_MAIN_HISTORICAL_MESSAGE', targets: [] });
  db.pragma('wal_checkpoint(TRUNCATE)'); db.close();
  const before = businessSnapshot();
  const second = await start('closed'); const secondAuth = await second.login();
  const view = await second.request(`/api/threaded/threads/${thread.id}/view`, undefined, 'GET');
  assert.equal(view.statusCode, 200); assert.ok(JSON.stringify(view.body).includes('T12_MAIN_HISTORICAL_MESSAGE'));
  const release = await second.request('/api/threaded/release', undefined, 'GET');
  assert.equal(release.statusCode, 200, JSON.stringify(release)); assert.equal(release.body.readOnly, true);
  const closedDiag = await second.call(); assertNoExecution(closedDiag); await second.kill();
  const third = await start('closed');
  const stale = await third.request('/api/threaded/session', undefined, 'GET', secondAuth); assert.equal(stale.statusCode, 401);
  await third.login(); assert.equal((await third.request(`/api/threaded/threads/${thread.id}/view`, undefined, 'GET')).statusCode, 200);
  const after = businessSnapshot(); assert.deepEqual(after.tables, before.tables);
  const restartDiag = await third.call(); assertNoExecution(restartDiag); await third.close();
  checks.push({ id: 'MAIN02', passed: true, description: 'SIGKILL and actual main restart preserve historical Thread/message/outbox rows byte-for-byte; Owner session expires and reauthenticated view/release plan remain available without an executor.' });
  evidence.push({ label: 'closed actual main before/after SIGKILL', before, after, first: initial, closed: closedDiag, restarted: restartDiag, release: release.body });

  const observeBefore = businessSnapshot(), observed = await start('observe'); await observed.login();
  const capabilities = await observed.request('/api/threaded/capabilities', undefined, 'GET');
  assert.equal(capabilities.body.configured.mode, 'observe'); assert.equal(capabilities.body.implemented.execution, false);
  const attempted = await observed.request(`/api/threaded/threads/${thread.id}/messages`,
    { clientRequestId: randomUUID(), body: 'T12_OBSERVE_MUST_NOT_SAVE', targets: [def.id] });
  assert.ok([403, 501].includes(attempted.statusCode), JSON.stringify(attempted));
  const observeRelease = await observed.request('/api/threaded/release', undefined, 'GET'); assert.equal(observeRelease.statusCode, 200);
  const observeDiag = await observed.call(); assertNoExecution(observeDiag); const observeAfter = businessSnapshot();
  assert.deepEqual(observeAfter.tables, observeBefore.tables); await observed.close();
  checks.push({ id: 'MAIN03', passed: true, description: 'Actual observe-mode main serves diagnostics/release plan but rejects new message ingress and leaves every threaded business-table row unchanged.' });
  evidence.push({ label: 'observe actual main read-only', before: observeBefore, after: observeAfter, diagnostics: observeDiag, rejectedIngress: attempted, release: observeRelease.body });

  const futureFile = path.join(root, 'unsupported.sqlite'); await copyFile(file, futureFile);
  const future = new Database(futureFile); future.prepare('INSERT INTO orchestration_schema_migrations(version,name,checksum,applied_at) VALUES(99999,?,?,?)')
    .run('t12-future-worker-contract', 'future', stamp); future.close();
  const futureBefore = await (await import('node:fs/promises')).readFile(futureFile); const rejected = await start('closed', futureFile, true);
  const futureAfter = await (await import('node:fs/promises')).readFile(futureFile); assert.equal(hash(futureAfter), hash(futureBefore));
  assert.match(rejected.output, /99999|不受此 worker 支持/);
  checks.push({ id: 'MAIN04', passed: true, description: 'Actual index.ts refuses a future migration before listening or mutating the SQLite file; schema downgrade is never attempted.' });
  evidence.push({ label: 'future schema refusal', exit: rejected.status, databaseDigestBefore: hash(futureBefore), databaseDigestAfter: hash(futureAfter), diagnosticMentionsUnsupportedSchema: true });
  const result = { ok: true, groups: checks.length, checks, actualMainEntry: 'apps/server/src/index.ts',
    realLoopbackListen: true, cleanEnvironment: true, realModelCalls: 0, realSupplierTokens: 0, remoteWrites: 0,
    limitations: ['No release member pack, real supplier or execute-mode release is configured in this main-entry smoke.',
      'A preload guard redirects only data/sandbox paths and denies fetch; production startup, recovery order, routes and lifecycle are unchanged.'], evidence };
  const output = path.resolve('docs/reports/evidence/threaded-t12-service-recovery/main-process.json');
  await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ...result, evidence: undefined, output }, null, 2));
} finally {
  for (const child of children) if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
  await rm(root, { recursive: true, force: true });
}

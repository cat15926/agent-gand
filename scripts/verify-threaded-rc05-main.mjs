import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { tmpdir, hostname } from 'node:os';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';

const args = process.argv.slice(2), real = args.includes('--authorized-real');
const option = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
const selected = option('--case', 'all');
assert.ok(['all', 'extended', 'activity', 'prepared', 'terminal', 'api-unknown', 'sdk-unknown', 'approval', 'revoke', 'storage', 'receipt-io', 'activity-default', 'activity-target'].includes(selected));
const tokenLimit = Number(option('--token-limit', '500000'));
assert.ok(Number.isSafeInteger(tokenLimit) && tokenLimit > 0 && tokenLimit <= 10000000);
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-rc05-index-')));
await mkdir(path.join(root, 'agents'));
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DB_PATH: path.join(root, 'credential-loader.sqlite'), AGENTS_DIR: path.join(root, 'agents'),
  AGENT_GAND_PRIVATE_DIR: path.join(root, 'private-loader') });
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const stamp = new Date().toISOString();
let account = { id: 'rc05-fixture-account', display_name: 'RC05 injected', provider: 'anthropic', auth_type: 'api_key',
  source: 'managed', enabled: 1, archived: 0, version: 1, config_version: 1, credential_version: 1,
  identity_generation: null, created_at: stamp, updated_at: stamp };
let version = { account_id: account.id, version: 1,
  connection: JSON.stringify({ baseUrl: 'https://rc05.invalid', protocols: ['anthropic-messages'], defaultModel: 'fixture-model', timeoutMs: 120000 }), created_at: stamp };
let apiKey = 'RC05_SYNTHETIC_KEY', redact = v => String(v), closeCredentialDb = () => {}, ledger, priorRows = [];
const ledgerFile = '/tmp/agent-gand-t07-authorized-token-ledger.sqlite';
if (real) {
  assert.ok(args.includes('--account') && args.includes('--token-ledger'), 'Real execution requires an explicit configured account and existing shared ledger');
  assert.equal(await realpath(option('--token-ledger')), await realpath(ledgerFile));
  const sourcePath = path.resolve(option('--source-db', 'apps/server/data/agent-gand.sqlite'));
  process.env.AGENT_GAND_PRIVATE_DIR = path.join(path.dirname(sourcePath), 'private');
  let loaderMasterKey = process.env.ACCOUNT_MASTER_KEY ?? null;
  if (!loaderMasterKey) {
    const env = await readFile(new URL('../apps/server/.env', import.meta.url), 'utf8').catch(() => '');
    const line = env.split('\n').find(v => /^\s*ACCOUNT_MASTER_KEY\s*=/.test(v));
    if (line) loaderMasterKey = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
  }
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  account = source.prepare('SELECT * FROM accounts WHERE id=? AND enabled=1 AND archived=0').get(option('--account'));
  assert.ok(account?.auth_type === 'api_key' && account.source === 'managed');
  assert.equal(source.prepare('SELECT 1 FROM account_revocations WHERE account_id=?').get(account.id), undefined);
  version = source.prepare('SELECT * FROM account_versions WHERE account_id=? AND version=?').get(account.id, account.config_version);
  const credential = source.prepare('SELECT * FROM account_credentials WHERE account_id=? AND version=?').get(account.id, account.credential_version);
  source.close(); assert.ok(version && credential);
  const connection = JSON.parse(version.connection), endpoint = new URL(connection.baseUrl);
  assert.equal(endpoint.protocol, 'https:'); assert.equal(endpoint.hostname, 'open.bigmodel.cn');
  assert.ok(connection.protocols.includes('anthropic-messages'));
  const { config: loaderConfig } = await import('../apps/server/src/config.ts');
  loaderConfig.accounts.masterKey = loaderMasterKey; loaderMasterKey = null;
  const { db: loaderDb, closeDatabase } = await import('../apps/server/src/db/database.ts'); closeCredentialDb = closeDatabase;
  for (const [table, row] of [['accounts', account], ['account_versions', version], ['account_credentials', credential]]) {
    const keys = Object.keys(row); loaderDb.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...Object.values(row));
  }
  apiKey = (await import('../apps/server/src/accounts/credentials.ts')).readCredential(account.id, account.credential_version);
  redact = (await import('../apps/server/src/accounts/secrets.ts')).redactSecrets;
  ledger = new Database(ledgerFile, { fileMustExist: true, timeout: 10000 });
  priorRows = ledger.prepare('SELECT * FROM request_tokens ORDER BY id').all();
}
const ledgerUsage = () => ledger ? ledger.prepare('SELECT COALESCE(SUM(actual),0) knownTokens, COALESCE(SUM(CASE WHEN actual IS NULL THEN reserved ELSE 0 END),0) unknownReserve FROM request_tokens').get() : { knownTokens: 0, unknownReserve: 0 };
const priorUsage = ledgerUsage(); assert.ok(priorUsage.knownTokens + priorUsage.unknownReserve < tokenLimit);
const children = [], checks = [], evidence = [], failures = [], processes = [];
const ephemeralKeys = new Map(), transientSecrets = new Set(), cleanup = [];
const reportPath = path.resolve(option('--report', `docs/reports/evidence/threaded-rc05/${real ? 'live' : 'main-injected'}-${selected}-${stamp.replace(/[:.]/g, '-')}.json`));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function deadline(promise, ms, code) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {timer=setTimeout(()=>reject(new Error(code)),ms);})]); }
  finally {clearTimeout(timer);}
}
const loader = new URL('../apps/server/node_modules/tsx/dist/loader.mjs', import.meta.url).pathname;
const preload = new URL('./fixtures/threadedRc05MainGuard.mjs', import.meta.url).pathname;
const entry = new URL('../apps/server/src/index.ts', import.meta.url).pathname;
const members = [['rc05-api', 'api'], ['rc05-sdk', 'claude-sdk'], ['rc05-other', 'api']].map(([agentId, backend]) => ({
  agentId, backend, backendVersion: backend === 'api' ? 'threaded-http-v1' : '0.3.288', model: JSON.parse(version.connection).defaultModel,
  roleVersion: 1, permissionVersion: 1, accountId: account.id, accountConfigVersion: account.config_version,
  accountCredentialVersion: account.credential_version, accountIdentityGeneration: account.identity_generation ?? null }));
let latest;
async function unusedPort() {
  const s = net.createServer(); await new Promise((y, n) => { s.once('error', n); s.listen(0, '127.0.0.1', y); });
  const port = s.address().port; await new Promise(y => s.close(y)); return port;
}
async function start(name, restore = false) {
  const dir = path.join(root, name); await mkdir(path.join(dir, 'agents'), { recursive: true });
  const pack = path.join(dir, 'release.json');
  if (!restore) await writeFile(pack, JSON.stringify({ schemaVersion: 1, platform: 'darwin', members,
    applicationTools: [], maxOutputTokens: 4096, maxInputTokens: 98304, maxRequests: 2 }), { mode: 0o600 });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const child = fork(entry, [], { cwd: dir, execArgv: ['--import', loader, '--import', preload],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', NODE_ENV: 'test',
      AGENT_GAND_ISOLATED_WORKER: '1', RC05_MAIN_ROOT: dir, DB_PATH: path.join(dir, 'main.sqlite'), AGENTS_DIR: path.join(dir, 'agents'),
      AGENT_GAND_PRIVATE_DIR: path.join(dir, 'private'), HOST: '127.0.0.1', PORT: String(port), LOG_LEVEL: 'silent',
      ACCOUNT_TRUSTED_ORIGINS: origin, THREADED_COLLABORATION_MODE: 'execute', THREADED_RELEASE_MEMBERS_FILE: pack } });
  const processRecord = { name, restore, pid: child.pid, diagnostics: [] };
  children.push(child); processes.push(processRecord);
  let output = '', seq = 0, auth; const pending = new Map(), events = [], waiters = [];
  child.stdout.on('data', d => { output = (output + d).slice(-10000); });
  child.stderr.on('data', d => { output = (output + d).slice(-10000); });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => {
    const error = new Error(redact(`RC05_INDEX_EXIT ${code}/${signal}: ${output}`));
    for (const p of pending.values()) p.reject(error); pending.clear();
    for (const w of waiters) w.reject(error); waiters.length = 0;
    resolve({ code, signal });
  }); });
  child.on('message', m => {
    if (m.event) { if (m.event.startsWith('operation-')) processRecord.diagnostics.push({event:m.event,operation:m.operation});
      const w = waiters.find(w => w.kind === m.event); if (w) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } else events.push(m); return; }
    const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
  });
  // Only private IPC carries plaintext. The DB copy is encrypted under a fresh,
  // process-memory key retained by this parent solely for same-run restart.
  if (!ephemeralKeys.has(name)) ephemeralKeys.set(name, randomBytes(32).toString('hex'));
  const ephemeralMasterKey = ephemeralKeys.get(name);
  child.send({ operation: 'initialize', root: dir, account, version, members, apiKey, ephemeralMasterKey, restore, real,
    ledgerFile, tokenLimit, captureDiagnostics: name === 'receipt-io' });
  const request = async (url, payload, method = 'POST', headers = auth) => {
    const r = await fetch(origin + url, { method, headers: { origin, ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(15000) });
    return { statusCode: r.status, body: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] };
  };
  const end = Date.now() + 30000; let ready = false;
  while (Date.now() < end && child.exitCode === null && !child.signalCode) {
    try { ready = (await request('/api/health', undefined, 'GET')).statusCode === 200; if (ready) break; } catch {}
    await delay(50);
  }
  assert.equal(ready, true, redact(output));
  const call = (operation, extra = {}) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error(`RC05_TIMEOUT_${operation}`)); }, 15000);
    pending.set(id, { resolve(v) { clearTimeout(timer); resolve(v); }, reject(e) { clearTimeout(timer); reject(e); } }); child.send({ id, operation, ...extra });
  });
  return { child, name, dir, exit, request, call,
    async event(kind) {
      const e = events.find(e => e.event === kind); if (e) { events.splice(events.indexOf(e), 1); return e; }
      return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`RC05_EVENT_TIMEOUT_${kind}`)), 180000);
        waiters.push({ kind, resolve(e) { clearTimeout(timer); resolve(e); }, reject(e) { clearTimeout(timer); reject(e); } }); });
    },
    async login() {
      const a = await request('/api/accounts/session', undefined, 'POST', { 'x-gand-bootstrap': '1' }); assert.equal(a.statusCode, 200, 'RC05_MANAGEMENT_LOGIN_FAILED');
      if (a.cookie) transientSecrets.add(a.cookie); if (a.body.csrfToken) transientSecrets.add(a.body.csrfToken);
      const b = await request('/api/accounts/threaded/access-session', undefined, 'POST', { cookie: a.cookie, 'x-gand-csrf': a.body.csrfToken }); assert.equal(b.statusCode, 200, 'RC05_THREADED_LOGIN_FAILED');
      if (b.cookie) transientSecrets.add(b.cookie); if (b.body.csrfToken) transientSecrets.add(b.body.csrfToken);
      return auth = { cookie: b.cookie, 'x-gand-csrf': b.body.csrfToken };
    },
    async kill() { child.kill('SIGKILL'); const r = await exit; assert.equal(r.signal, 'SIGKILL'); return r; },
    async close() { child.kill('SIGTERM'); const result = await deadline(exit,20000,'RC05_SHUTDOWN_TIMEOUT'); assert.equal(result.code, 0); return result; }
  };
}
async function controls(w, admissionOpen, dispatchOpen) {
  const a = await w.request('/api/threaded/release', undefined, 'GET'); assert.equal(a.statusCode, 200);
  const b = await w.request('/api/threaded/release/controls', { expectedVersion: a.body.control.version, requestId: randomUUID(),
    admissionOpen, dispatchOpen, reason: 'Authorized isolated RC05 main-index fault acceptance' }); assert.equal(b.statusCode, 200, JSON.stringify(b));
}
async function fresh(name) {
  const w = await start(name); await w.login(); await controls(w, true, false);
  const r = await w.request('/api/threaded/threads', { title: `RC05 ${name}`, clientRequestId: randomUUID() }); assert.equal(r.statusCode, 200, JSON.stringify(r));
  return { w, threadId: r.body.thread?.id ?? r.body.id };
}
async function submit(w, threadId, agentId = 'rc05-api', body = 'Reply exactly RC05_ACK. No tools or reasoning.', activityAllowanceMs = 10000) {
  const r = await w.request(`/api/threaded/threads/${threadId}/messages`, { clientRequestId: randomUUID(), body, targets: [agentId] });
  assert.equal(r.statusCode, 200, JSON.stringify(r)); const m = (r.body.receipt ?? r.body).message;
  // The target release slice is explicit; default 1s is independently verified.
  await w.call('budget', { messageId: m.id, activityAllowanceMs }); return m;
}
async function snapshot(w, messageId, label) {
  const f = await w.call('facts', { messageId }); assert.deepEqual(f.foreignKeys, []); assert.equal(f.deniedEgress, 0);
  latest = { worker: w.name, label, ...f }; evidence.push(latest); return f;
}
async function until(w, messageId, predicate) {
  const end = Date.now() + 180000;
  while (Date.now() < end) { const f = await w.call('facts', { messageId }); latest = f;
    if (predicate(f)) return f;
    if (f.invocation && ['failed', 'cancelled', 'unknown'].includes(f.invocation.status)) throw new Error(`RC05_UNEXPECTED_STATE_${f.invocation.status}:${f.invocation.recovery_reason}`);
    await delay(250);
  }
  throw new Error('RC05_COMPLETION_TIMEOUT');
}
async function stableUnknown(w, m, old, label) {
  await w.login(); await w.call('recover'); await w.call('recover');
  const f = await snapshot(w, m.id, label);
  assert.equal(f.calls, 0); assert.equal(f.invocation.status, 'unknown'); assert.equal(f.queue.state, 'unknown');
  assert.equal(f.invocation.id, old.invocation.id); assert.equal(f.invocation.reserved_run_id, old.invocation.reserved_run_id);
  assert.equal(f.attempts.length, 1); assert.equal(f.requests.length, old.requests.length);
  assert.equal(f.terminals.length, 0); assert.ok(f.budget.unknownRequests >= 1);
  assert.equal(f.messages.filter(m => m.origin === 'agent_response').length, 0);
  await controls(w, true, true); await delay(1200);
  const again = await snapshot(w, m.id, `${label}; rescan after dispatch reopened`);
  assert.equal(again.calls, 0); assert.equal(again.requests.length, f.requests.length); return again;
}
async function caseRun(name, fn) {
  if (selected !== 'all' && selected !== name && !(selected === 'extended' && ['receipt-io', 'activity-default', 'activity-target'].includes(name))
    && !(selected === 'activity' && name.startsWith('activity-'))) return;
  const began = Date.now(); latest = null;
  try { await fn(); checks.push({ id: name, passed: true, elapsedMs: Date.now() - began }); }
  catch (e) { failures.push({ id: name, reason: redact(e.message), facts: latest }); throw e; }
}
try {
  await caseRun('prepared', async () => {
    const { w, threadId } = await fresh('prepared'); const m = await submit(w, threadId);
    await w.call('arm', { plan: { boundary: 'prepared-crash' } });
    const dispatch = controls(w, true, true).catch(() => {});
    const boundary = await w.event('prepared-boundary'); await w.kill(); await dispatch;
    const n = await start('prepared', true); await n.login();
    const done = await until(n, m.id, f => f.invocation?.status === 'completed');
    assert.equal(done.invocation.id, boundary.binding.invocationId); assert.equal(done.invocation.reserved_run_id, boundary.binding.runId);
    assert.equal(done.attempts.length, 2); assert.equal(done.calls, 1); assert.equal(done.requests.length, 1);
    assert.equal(done.terminals.length, 1); assert.equal(done.budget.actualRequests, 1);
    assert.equal(done.messages.filter(m => m.origin === 'agent_response').length, 1);
    evidence.push({ label: 'prepared exact crash boundary before any backend send', boundary });
    await snapshot(n, m.id, 'same Invocation/Run/root; one replacement Attempt and one actual send'); await n.close();
  });
  await caseRun('terminal', async () => {
    const { w, threadId } = await fresh('terminal');
    const m = await submit(w, threadId, 'rc05-api', 'Final answer exactly the concatenation of an at-sign, the handle rc05-other, one space and RC05_HANDOFF. Do not use any tools or other text.');
    await w.call('arm', { plan: { boundary: 'terminal-crash', answer: '@rc05-other RC05_HANDOFF' } });
    const dispatch = controls(w, true, true).catch(() => {});
    const boundary = await w.event('terminal-boundary'); await w.kill(); await dispatch;
    const n = await start('terminal', true); await n.login();
    const done = await until(n, m.id, f => f.terminals.length === 2);
    assert.equal(done.calls, 1, 'Only the successor may make a new request after restart');
    assert.equal(done.requests.length, 2); assert.equal(done.counts.threaded_budget_roots, 1);
    const originalResponse = done.messages.filter(m => m.origin === 'agent_response' && m.source_attempt_id === boundary.binding.attemptId);
    assert.equal(originalResponse.length, 1); assert.equal(originalResponse[0].body.trim(), '@rc05-other RC05_HANDOFF');
    assert.equal(done.budget.actualRequests, 2);
    assert.ok(done.terminals.every(t => t.status === 'completed'));
    assert.ok(done.invocations.every(i => i.status === 'completed' && i.causal_root_id === m.causalRootId));
    assert.deepEqual(done.invocations.map(i => i.agent_id).sort(), ['rc05-api', 'rc05-other']);
    for (const terminal of done.terminals) {
      const invocation = done.invocations.find(i => i.id === terminal.invocation_id);
      assert.equal(terminal.run_id, invocation.reserved_run_id);
      assert.equal(done.runs.find(r => r.id === terminal.run_id)?.status, 'completed');
      assert.equal(done.requests.filter(r => r.attempt_id === terminal.attempt_id).length, 1);
    }
    assert.equal(done.budget.outputTokens, done.requests.reduce((n, r) => n + r.output_tokens, 0));
    assert.ok(done.budget.costMicrousd >= 2000000, 'Unknown supplier price stays conservatively reserved');
    evidence.push({ label: 'post-terminal commit exact PID crash', boundary });
    await controls(n, true, false); await n.call('recover');
    await snapshot(n, m.id, 'original response/terminal/Run/fees once, exactly one successor under original root'); await n.close();
  });
  for (const backend of ['api', 'sdk']) await caseRun(`${backend}-unknown`, async () => {
    const name = `${backend}-unknown`, { w, threadId } = await fresh(name);
    const m = await submit(w, threadId, `rc05-${backend}`);
    await w.call('arm', { plan: { boundary: 'headers-crash' } });
    const dispatch = controls(w, true, true).catch(() => {});
    const boundary = await w.event('headers-boundary');
    assert.ok(boundary.pathname.endsWith('/v1/messages') && !boundary.pathname.endsWith('/count_tokens'));
    assert.equal(boundary.headersReceived, true); assert.ok(boundary.status >= 200 && boundary.status < 300);
    // Read the committed boundary while this exact index PID is stopped.
    const db = new Database(path.join(w.dir, 'main.sqlite'), { readonly: true, fileMustExist: true });
    const q = db.prepare('SELECT invocation_id FROM threaded_wake_queue WHERE source_message_id=?').get(m.id);
    const old = { invocation: db.prepare('SELECT * FROM threaded_invocations WHERE id=?').get(q.invocation_id),
      requests: db.prepare('SELECT id,state FROM threaded_backend_requests ORDER BY rowid').all(),
      processes: db.prepare('SELECT token,host,pid,state FROM threaded_backend_processes ORDER BY rowid').all() }; db.close();
    assert.ok(old.requests.length >= 1); assert.equal(old.requests.find(r => r.id === boundary.requestId)?.state, 'sending');
    if (backend === 'sdk') assert.ok(old.processes.some(p => p.state === 'registered'));
    await w.kill(); await dispatch;
    const stopped = [];
    for (const p of old.processes) {
      assert.equal(p.host, hostname());
      const end = Date.now() + 5000; let live;
      do { live = execFileSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8' }).split('\n').some(l => {
        const [g, status] = l.trim().split(/\s+/); return Number(g) === p.pid && status && !status.startsWith('Z');
      }); if (live) await delay(50); } while (live && Date.now() < end);
      assert.equal(live, false, 'Owned SDK guardian group must actually stop after index IPC disconnect'); stopped.push({ ...p, groupStopped: true });
    }
    evidence.push({ label: `${real ? 'configured supplier' : 'injected transport'} generation response headers received before mid-flight index SIGKILL`, boundary, nativeProcesses: stopped });
    const n = await start(name, true); await stableUnknown(n, m, old, `${backend} possible-send retained unknown; no replay`);
    await controls(n, false, false); await n.close();
  });
  await caseRun('approval', async () => {
    const { w, threadId } = await fresh('approval'); const m = await submit(w, threadId);
    await w.call('arm', { plan: { boundary: 'headers-hold' } }); await controls(w, true, true); await w.event('headers-held');
    const old = await snapshot(w, m.id, 'actual request active at lifecycle approval fault hook');
    const approval = await w.call('approval', { invocationId: old.invocation.id }); assert.equal(approval.status, 'pending');
    const staleAuth = await w.login(); await w.kill(); const n = await start('approval', true);
    assert.equal((await n.request('/api/threaded/session', undefined, 'GET', staleAuth)).statusCode, 401); await n.login();
    const decision = await n.request(`/api/threaded/threads/${threadId}/approvals/${approval.id}/decision`, { decision: 'approve', requestId: randomUUID() });
    assert.equal(decision.statusCode, 409, JSON.stringify(decision));
    const f = await stableUnknown(n, m, old, 'old approval expired; reauthenticated approval cannot revive interrupted driver');
    assert.equal(f.approvals[0].status, 'expired'); await controls(n, false, false); await n.close();
  });
  await caseRun('revoke', async () => {
    const { w, threadId } = await fresh('revoke'); const m = await submit(w, threadId);
    await w.call('arm', { plan: { boundary: 'headers-hold' } }); await controls(w, true, true); await w.event('headers-held');
    const old = await snapshot(w, m.id, 'actual request active before account revocation');
    await w.call('revoke'); await delay(500); await w.kill(); const n = await start('revoke', true); await n.login();
    const f = await snapshot(n, m.id, 'account disabled in isolated DB survives restart; no driver/output authority');
    assert.equal(f.calls, 0); assert.equal(f.requests.length, old.requests.length);
    assert.equal(f.messages.filter(m => m.origin === 'agent_response').length, 0);
    assert.equal(f.budget.unknownRequests, 1); assert.equal(f.terminals.length, 0); await n.close();
  });
  await caseRun('storage', async () => {
    const { w, threadId } = await fresh('storage'); const before = await snapshot(w, undefined, 'before index SQLite write fault');
    await w.call('queryOnly', { value: true });
    const r = await w.request(`/api/threaded/threads/${threadId}/messages`, { clientRequestId: randomUUID(), body: 'RC05_NOT_SAVED', targets: ['rc05-api'] });
    assert.equal(r.statusCode, 500); assert.equal(r.body.code, 'THREADED_OPERATION_FAILED'); await w.call('queryOnly', { value: false });
    const after = await snapshot(w, undefined, 'actual index HTTP fails closed on readonly SQLite'); assert.deepEqual(after.counts, before.counts);
    await w.kill(); const n = await start('storage', true); await n.login();
    const restored = await snapshot(n, undefined, 'no phantom success after actual index restart'); assert.deepEqual(restored.counts, before.counts); assert.equal(restored.calls, 0); await n.close();
  });
  await caseRun('receipt-io', async () => {
    const { w, threadId } = await fresh('receipt-io'); const m = await submit(w, threadId);
    await w.call('arm', { plan: { boundary: 'headers-hold', streaming: args.includes('--streaming-fixture') } }); await controls(w, true, true);
    const headers = await w.event('headers-held'); assert.ok(headers.status >= 200 && headers.status < 300);
    const old = await snapshot(w, m.id, 'generation headers received before actual index receipt I/O fault');
    await controls(w, true, false); await w.call('queryOnly', { value: true }); await w.call('releaseHeaders');
    const failed = await until(w, m.id, f => f.diagnostics.active === 0);
    assert.equal(failed.messages.filter(m => m.origin === 'agent_response').length, 0);
    assert.equal(failed.terminals.length, 0); assert.ok(failed.requests.some(r => r.state === 'sending'));
    await w.call('queryOnly', { value: false });
    await snapshot(w, m.id, 'receipt and unknown persistence denied by real SQLite READONLY; no false terminal');
    await w.kill(); const n = await start('receipt-io', true);
    await stableUnknown(n, m, old, 'receipt I/O failure after a real generation request recovers unknown without replay');
    await controls(n, false, false); await n.close();
  });
  for (const target of [false, true]) await caseRun(target ? 'activity-target' : 'activity-default', async () => {
    const name = target ? 'activity-target' : 'activity-default', { w, threadId } = await fresh(name);
    const m = await submit(w, threadId, 'rc05-api', undefined, target ? 10000 : 0);
    await w.call('arm', { plan: { boundary: 'slow-preparation' } }); await controls(w, true, true);
    const f = await until(w, m.id, f => f.invocation?.status === (target ? 'completed' : 'unknown'));
    assert.equal(f.slowApplied, true); assert.equal(f.rootPolicy.activityAllowanceMs, target ? 10000 : 1000);
    if (target) {
      assert.equal(f.calls, 1); assert.equal(f.requests.length, 1); assert.equal(f.terminals.length, 1);
      await snapshot(w, m.id, 'actual index explicit Owner 10s slice survives injected 1250ms synchronous preparation and supplier request'); await w.close();
    } else {
      assert.equal(f.calls, 0); assert.equal(f.requests.length, 0); assert.equal(f.terminals.length, 0);
      const reason = f.invocation.recovery_reason; await snapshot(w, m.id, 'actual index default 1s long preparation availability limit; no supplier send');
      await w.kill(); const n = await start(name, true); await n.login(); await n.call('recover'); await n.call('recover');
      const restored = await snapshot(n, m.id, 'default slice unknown activity retains first cause across actual index restart');
      assert.equal(restored.calls, 0); assert.equal(restored.requests.length, 0); assert.equal(restored.terminals.length, 0);
      assert.equal(restored.invocation.recovery_reason, reason); assert.equal(restored.invocation.status, 'unknown'); await n.close();
    }
  });
} catch (error) {
  if (!failures.length) failures.push({ reason: redact(error.message), facts: latest }); process.exitCode = 1;
} finally {
  for (const c of children) if (c.exitCode === null && !c.signalCode) { c.kill('SIGKILL'); await new Promise(y => c.once('exit', y)); }
  // Cleanup runs even when the SDK boundary assertion itself fails. Signal only
  // an owned guardian whose exact token/host/path still match this run's DB.
  for (const name of new Set(processes.map(p => p.name))) {
    let db;
    try {
      db = new Database(path.join(root, name, 'main.sqlite'), { readonly: true, fileMustExist: true });
      for (const p of db.prepare('SELECT token,host,pid FROM threaded_backend_processes').all()) {
        const groupAlive = () => execFileSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8' }).split('\n').some(l => {
          const [g, status] = l.trim().split(/\s+/); return Number(g) === p.pid && status && !status.startsWith('Z');
        });
        let signalled = false;
        if (groupAlive()) {
          const command = execFileSync('ps', ['-p', String(p.pid), '-o', 'command='], { encoding: 'utf8' });
          assert.equal(p.host, hostname()); assert.ok(command.includes('/execution/guardian.mjs') && command.includes(p.token), 'RC05_CLEANUP_OWNERSHIP_UNCONFIRMED');
          try { process.kill(-p.pid, 'SIGTERM'); signalled = true; } catch (e) { if (e.code !== 'ESRCH') throw e; }
          const end = Date.now() + 1500; while (groupAlive() && Date.now() < end) await delay(50);
          if (groupAlive()) process.kill(-p.pid, 'SIGKILL');
        }
        const end = Date.now() + 1500; while (groupAlive() && Date.now() < end) await delay(50);
        assert.equal(groupAlive(), false); cleanup.push({ name, pid: p.pid, groupStopped: true, signalled });
      }
    } catch (e) { failures.push({ id: 'cleanup', reason: redact(e.code ?? e.message) }); process.exitCode = 1; }
    finally { db?.close(); }
  }
  const usage = ledgerUsage();
  if (ledger) assert.deepEqual(priorRows.map(r => ledger.prepare('SELECT * FROM request_tokens WHERE id=?').get(r.id)), priorRows);
  const result = { ok: failures.length === 0, stage: 'RC05', date: new Date().toISOString(), case: selected, groups: checks.length, checks, failures,
    actualMainIndex: true, entry: 'apps/server/src/index.ts', actualPids: processes, realSupplier: real,
    account: { id: account.id, name: account.display_name, model: JSON.parse(version.connection).defaultModel, endpointHost: new URL(JSON.parse(version.connection).baseUrl).hostname },
    operatorTokenLimit: tokenLimit, priorUsage, usage, priorLedgerRowsUnchanged: true, priorLedgerDigest: hash(priorRows),
    knownTokensThisRun: usage.knownTokens - priorUsage.knownTokens, unknownReserveThisRun: usage.unknownReserve - priorUsage.unknownReserve,
    targetActivityAllowanceMs: 10000, productionDefaultActivityAllowanceMs: 1000, casePoliciesInEvidence: true, dailyConfigurationChanged: false,
    sourceDbReadOnly: real, dailyMessagesRead: false, keyInArgvEnvReports: false, keyTransferredViaPrivateIPC: real,
    limitations: ['Preload supplies isolated paths, pinned account metadata and fault barriers; actual index startup/recovery, production singleton, routes, release and authority guards execute unchanged.',
      'Approval is created through the real lifecycle at a controlled in-flight fault hook; it is not a naturally model-triggered approval.',
      'Ten-second activity slice is a regular Owner CAS on synthetic roots, not a change to the one-second production default.',
      'Process exit proof never settles unknown remote usage or releases unknown execution authority.'], cleanup, evidence };
  let encoded = JSON.stringify(result, null, 2);
  for (const secret of [...transientSecrets, ...ephemeralKeys.values()]) encoded = encoded.replaceAll(secret, '[REDACTED]');
  assert.ok(!encoded.includes(apiKey), 'Secret exclusion');
  assert.ok(usage.knownTokens + usage.unknownReserve <= tokenLimit);
  await mkdir(path.dirname(reportPath), { recursive: true }); await writeFile(reportPath, encoded + '\n', { flag: 'wx' });
  ledger?.close(); closeCredentialDb(); await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: result.ok, groups: checks.length, failures: failures.length, actualPids: processes.length,
    realSupplier: real, knownTokensThisRun: result.knownTokensThisRun, unknownReserveThisRun: result.unknownReserveThisRun, reportPath }));
}

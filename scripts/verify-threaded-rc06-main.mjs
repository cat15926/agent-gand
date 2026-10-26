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
assert.ok(['all', 'retry', 'slot', 'parallel', 'cancel', 'capacity'].includes(selected));
const tokenLimit = Number(option('--token-limit', '500000'));
assert.ok(Number.isSafeInteger(tokenLimit) && tokenLimit > 0 && tokenLimit <= 10000000);
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-rc06-index-')));
await mkdir(path.join(root, 'agents'));
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DB_PATH: path.join(root, 'credential-loader.sqlite'), AGENTS_DIR: path.join(root, 'agents'),
  AGENT_GAND_PRIVATE_DIR: path.join(root, 'private-loader') });
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const stamp = new Date().toISOString();
let account = { id: 'rc06-fixture-account', display_name: 'RC06 injected', provider: 'anthropic', auth_type: 'api_key',
  source: 'managed', enabled: 1, archived: 0, version: 1, config_version: 1, credential_version: 1,
  identity_generation: null, created_at: stamp, updated_at: stamp };
let version = { account_id: account.id, version: 1,
  connection: JSON.stringify({ baseUrl: 'https://rc06.invalid', protocols: ['anthropic-messages'], defaultModel: 'fixture-model', timeoutMs: 120000 }), created_at: stamp };
let apiKey = 'RC06_SYNTHETIC_KEY', redact = v => String(v), closeCredentialDb = () => {}, ledger, priorRows = [];
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
const reportPath = path.resolve(option('--report', `docs/reports/evidence/threaded-rc06/${real ? 'live' : 'main-injected'}-${selected}-${stamp.replace(/[:.]/g, '-')}.json`));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function deadline(promise, ms, code) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {timer=setTimeout(()=>reject(new Error(code)),ms);})]); }
  finally {clearTimeout(timer);}
}
const loader = new URL('../apps/server/node_modules/tsx/dist/loader.mjs', import.meta.url).pathname;
const preload = new URL('./fixtures/threadedRc06MainGuard.mjs', import.meta.url).pathname;
const entry = new URL('../apps/server/src/index.ts', import.meta.url).pathname;
const members = [['rc06-api', 'api'], ['rc06-sdk', 'claude-sdk'], ['rc06-api-b', 'api'], ['rc06-sdk-b', 'claude-sdk']].map(([agentId, backend]) => ({
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
      AGENT_GAND_ISOLATED_WORKER: '1', RC06_MAIN_ROOT: dir, DB_PATH: path.join(dir, 'main.sqlite'), AGENTS_DIR: path.join(dir, 'agents'),
      AGENT_GAND_PRIVATE_DIR: path.join(dir, 'private'), HOST: '127.0.0.1', PORT: String(port), LOG_LEVEL: 'silent',
      ACCOUNT_TRUSTED_ORIGINS: origin, THREADED_COLLABORATION_MODE: 'execute', THREADED_RELEASE_MEMBERS_FILE: pack } });
  const processRecord = { name, restore, pid: child.pid, diagnostics: [] };
  children.push(child); processes.push(processRecord);
  let output = '', seq = 0, auth; const pending = new Map(), events = [], waiters = [];
  child.stdout.on('data', d => { output = (output + d).slice(-10000); });
  child.stderr.on('data', d => { output = (output + d).slice(-10000); });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => {
    const error = new Error(redact(`RC06_INDEX_EXIT ${code}/${signal}: ${output}`));
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
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error(`RC06_TIMEOUT_${operation}`)); }, 15000);
    pending.set(id, { resolve(v) { clearTimeout(timer); resolve(v); }, reject(e) { clearTimeout(timer); reject(e); } }); child.send({ id, operation, ...extra });
  });
  return { child, name, dir, exit, request, call,
    async event(kind) {
      const e = events.find(e => e.event === kind); if (e) { events.splice(events.indexOf(e), 1); return e; }
      return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`RC06_EVENT_TIMEOUT_${kind}`)), 180000);
        waiters.push({ kind, resolve(e) { clearTimeout(timer); resolve(e); }, reject(e) { clearTimeout(timer); reject(e); } }); });
    },
    async login() {
      const a = await request('/api/accounts/session', undefined, 'POST', { 'x-gand-bootstrap': '1' }); assert.equal(a.statusCode, 200, 'RC06_MANAGEMENT_LOGIN_FAILED');
      if (a.cookie) transientSecrets.add(a.cookie); if (a.body.csrfToken) transientSecrets.add(a.body.csrfToken);
      const b = await request('/api/accounts/threaded/access-session', undefined, 'POST', { cookie: a.cookie, 'x-gand-csrf': a.body.csrfToken }); assert.equal(b.statusCode, 200, 'RC06_THREADED_LOGIN_FAILED');
      if (b.cookie) transientSecrets.add(b.cookie); if (b.body.csrfToken) transientSecrets.add(b.body.csrfToken);
      return auth = { cookie: b.cookie, 'x-gand-csrf': b.body.csrfToken };
    },
    async kill() { child.kill('SIGKILL'); const r = await exit; assert.equal(r.signal, 'SIGKILL'); return r; },
    async close() { child.kill('SIGTERM'); const result = await deadline(exit,20000,'RC06_SHUTDOWN_TIMEOUT'); assert.equal(result.code, 0); return result; }
  };
}
async function controls(w, admissionOpen, dispatchOpen) {
  const a = await w.request('/api/threaded/release', undefined, 'GET'); assert.equal(a.statusCode, 200);
  const b = await w.request('/api/threaded/release/controls', { expectedVersion: a.body.control.version, requestId: randomUUID(),
    admissionOpen, dispatchOpen, reason: 'Authorized isolated RC06 main-index fault acceptance' }); assert.equal(b.statusCode, 200, JSON.stringify(b));
}
async function fresh(name) {
  const w = await start(name); await w.login(); await controls(w, true, false);
  const r = await w.request('/api/threaded/threads', { title: `RC06 ${name}`, clientRequestId: randomUUID() }); assert.equal(r.statusCode, 200, JSON.stringify(r));
  return { w, threadId: r.body.thread?.id ?? r.body.id };
}
async function submit(w, threadId, agentId = 'rc06-api', body = 'Reply exactly RC06_ACK. No tools or reasoning.', activityAllowanceMs = 10000) {
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
    await delay(250);
  }
  throw new Error('RC06_COMPLETION_TIMEOUT');
}
async function caseRun(name, fn) {
  if (selected !== 'all' && selected !== name) return;
  const began = Date.now(); latest = null;
  try { await fn(); checks.push({ id: name, passed: true, elapsedMs: Date.now() - began }); }
  catch (e) { failures.push({ id: name, reason: redact(e.message), facts: latest }); throw e; }
}
function invocationFor(f,m){return f.invocations.find(i=>f.queue.some(q=>q.source_message_id===m.id&&q.invocation_id===i.id));}
function effectFor(f,m){return f.effects.find(e=>e.sourceMessageId===m.id&&e.generation);}
async function arm(w,body=false){await w.call('arm',{send:true,body});}
async function createThread(w,title){const r=await w.request('/api/threaded/threads',{title,clientRequestId:randomUUID()});assert.equal(r.statusCode,200);return r.body.thread?.id??r.body.id;}
async function ready(w,n){const values=[];for(let i=0;i<n;i++)values.push(await w.event('request-ready'));return values;}
async function release(w,messages,stage='send'){return w.call('release',{messageIds:messages.map(m=>m.id),stage});}
function complete(f,m){return invocationFor(f,m)?.status==='completed';}
function assertOne(f,m){
 const inv=invocationFor(f,m);assert.ok(inv);assert.equal(inv.status,'completed');
 assert.equal(f.attempts.filter(a=>a.invocation_id===inv.id).length,1);
 assert.equal(f.terminals.filter(t=>t.invocation_id===inv.id&&t.status==='completed').length,1);
 assert.equal(f.messages.filter(r=>r.origin==='agent_response'&&r.source_attempt_id===inv.current_attempt_id).length,1);
 assert.equal(f.requests.filter(r=>r.invocation_id===inv.id&&r.backend==='api').length,1);
}
try{
 await caseRun('retry',async()=>{
  const {w,threadId}=await fresh('retry');await arm(w);
  const payload={clientRequestId:randomUUID(),body:'Reply exactly RC06_ACK.',targets:['rc06-api']};
  const replies=await Promise.all(Array.from({length:8},()=>w.request(`/api/threaded/threads/${threadId}/messages`,payload)));
  assert.ok(replies.every(r=>r.statusCode===200));const messages=replies.map(r=>(r.body.receipt??r.body).message);
  assert.equal(new Set(messages.map(m=>m.id)).size,1);const m=messages[0];await w.call('budget',{messageId:m.id});
  const conflict=await w.request(`/api/threaded/threads/${threadId}/messages`,{...payload,body:'Conflicting same key'});assert.equal(conflict.statusCode,409);
  await controls(w,true,true);await ready(w,1);const before=await snapshot(w,m.id,'8 concurrent authenticated ingress retries: one durable source/wake/claim');
  assert.equal(before.messages.filter(m=>m.origin==='user').length,1);assert.equal(before.queue.length,1);assert.equal(before.invocations.length,1);
  await release(w,[m]);const done=await until(w,m.id,f=>complete(f,m));assertOne(done,m);
  await snapshot(w,m.id,'one provider request and terminal after 8 retries');await w.close();
 });
 await caseRun('slot',async()=>{
  const {w,threadId}=await fresh('slot');await arm(w);const a=await submit(w,threadId);await controls(w,true,true);await ready(w,1);
  await controls(w,true,false);const b=await submit(w,threadId);await controls(w,true,true);
  const blocked=await snapshot(w,a.id,'same Thread/Agent A in flight and B queued');
  assert.equal(blocked.effects.filter(e=>e.generation).length,1);
  assert.equal(blocked.claims.filter(c=>['reserved','started'].includes(c.state)&&c.request.capacity!==false).length,1);
  await release(w,[a]);const second=(await ready(w,1))[0];assert.equal(second.sourceMessageId,b.id);
  const handoff=await snapshot(w,b.id,'A released before B obtains the same slot');assert.equal(invocationFor(handoff,a).status,'completed');
  await release(w,[b]);const done=await until(w,b.id,f=>complete(f,b));assertOne(done,a);assertOne(done,b);assert.equal(done.invocations.length,2);
  await snapshot(w,b.id,'both logical messages complete once with distinct retained roots');await w.close();
 });
 await caseRun('parallel',async()=>{
  const {w,threadId}=await fresh('parallel');const other=await createThread(w,'RC06 same Agent second Thread');await arm(w,true);
  const a=await submit(w,threadId),b=await submit(w,other);await controls(w,true,true);await ready(w,2);
  const prepared=await snapshot(w,a.id,'same Agent simultaneously admitted in two Thread slots');
  assert.equal(prepared.claims.filter(c=>['reserved','started'].includes(c.state)&&c.request.capacity!==false).length,2);
  await release(w,[a,b]);await w.event('headers-held');await w.event('headers-held');
  const inflight=await snapshot(w,a.id,'two actual transports have both reached generation headers');const ea=effectFor(inflight,a),eb=effectFor(inflight,b);
  assert.notEqual(ea.threadId,eb.threadId);assert.equal(ea.agentId,eb.agentId);
  assert.ok([ea,eb].every(e=>e.networkStartedAt<e.headersAt),'Each actual send-to-headers interval must have positive duration');
  assert.ok(Math.max(ea.networkStartedAt,eb.networkStartedAt)<Math.min(ea.headersAt,eb.headersAt),'Actual send-to-headers intervals must have positive overlap');
  assert.ok([ea,eb].every(e=>e.status>=200&&e.status<300));
  await release(w,[a,b],'body');const done=await until(w,a.id,f=>complete(f,a)&&complete(f,b));assertOne(done,a);assertOne(done,b);
  await snapshot(w,a.id,'same Agent two real requests completed independently');await w.close();
 });
 await caseRun('cancel',async()=>{
  const {w,threadId}=await fresh('cancel');await arm(w,true);
  const a=await submit(w,threadId,'rc06-sdk','Return the integers from 1 through 100 separated by commas. No tools or member mentions.'),
    b=await submit(w,threadId,'rc06-sdk-b','Return the integers from 1 through 300 separated by commas. No tools or member mentions.');
  await controls(w,true,true);await ready(w,2);const before=await snapshot(w,a.id,'two actual SDK guardians awaiting only their own generation barriers');
  assert.equal(before.processes.filter(p=>p.state==='registered').length,2);
  const ia=invocationFor(before,a),ib=invocationFor(before,b);assert.notEqual(ia.id,ib.id);
  await release(w,[a,b]);await w.event('headers-held');await w.event('headers-held');
  const headers=await snapshot(w,a.id,'both SDK generation requests reached supplier headers before cancelling only A');
  const stop=await w.request(`/api/threaded/threads/${threadId}/invocations/${ia.id}/controls`,{action:'stop',requestId:randomUUID()});assert.equal(stop.statusCode,200);
  const stopped=await until(w,a.id,f=>{
   const binding=f.bindings.find(x=>x.invocation_id===ia.id);return f.processes.some(p=>p.binding_id===binding?.id&&p.state==='verified_stopped');
  });
  assert.equal(invocationFor(stopped,b).status,'running');
  const bb=stopped.bindings.find(x=>x.invocation_id===ib.id),pa=stopped.bindings.find(x=>x.invocation_id===ia.id);
  assert.ok(stopped.processes.some(p=>p.binding_id===bb.id&&p.state==='registered'));
  assert.equal(stopped.requests.find(r=>r.invocation_id===ib.id).state,'sending');
  evidence.push({label:'B remained running after A guardian independently stopped',networkObservationAtStop:effectFor(stopped,b),facts:stopped});
  // The initial overlap/cancellation proof is now complete. Subsequent native
  // helper/continuation requests remain individually budgeted, without another
  // test barrier that would strand this still-authorized B driver.
  await w.call('arm',{send:false,body:false});
  await release(w,[b],'body');const done=await until(w,b.id,f=>complete(f,b));
  assert.equal(invocationFor(done,a).status,'unknown');assert.equal(done.terminals.filter(t=>t.invocation_id===ia.id).length,0);
  assert.equal(done.requests.find(r=>r.invocation_id===ia.id).state,'unknown');
  assert.equal(done.claims.find(c=>c.identity.claimId===pa.claim_id).state,'unknown');
  assert.equal(done.terminals.filter(t=>t.invocation_id===ib.id&&t.status==='completed').length,1);
  assert.ok(done.processes.every(p=>p.state==='verified_stopped'));
  await snapshot(w,b.id,'cancel A retains its unknown fence; B completes with stopped native process and no replay');await w.close();
 });
 await caseRun('capacity',async()=>{
  const {w,threadId}=await fresh('capacity');await arm(w);await w.call('policy',{patch:{globalLimit:2,threadLimit:2,accountLimit:2,providerLimits:{anthropic:1}}});
  const a=await submit(w,threadId),b=await submit(w,threadId,'rc06-api-b');await controls(w,true,true);const first=(await ready(w,1))[0];
  assert.equal(first.sourceMessageId,a.id);const blocked=await snapshot(w,a.id,'provider limit 1 reserves one actual capacity despite global limit 2');
  assert.equal(blocked.effects.filter(e=>e.generation).length,1);
  assert.equal(blocked.claims.filter(c=>['reserved','started'].includes(c.state)&&c.request.capacity!==false).length,1);
  await release(w,[a]);const next=(await ready(w,1))[0];assert.equal(next.sourceMessageId,b.id);
  const freed=await snapshot(w,b.id,'release notification admits waiting B');assert.ok(freed.notifications.length>0);assert.equal(invocationFor(freed,a).status,'completed');
  await controls(w,true,false);const c=await submit(w,threadId);await controls(w,true,true);await release(w,[b]);const third=(await ready(w,1))[0];assert.equal(third.sourceMessageId,c.id);
  await release(w,[c]);const done=await until(w,c.id,f=>complete(f,c));for(const m of [a,b,c])assertOne(done,m);
  await snapshot(w,c.id,'capacity release and new ingress retain every logical work item exactly once');await w.close();
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
          assert.equal(p.host, hostname()); assert.ok(command.includes('/execution/guardian.mjs') && command.includes(p.token), 'RC06_CLEANUP_OWNERSHIP_UNCONFIRMED');
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
  const result = { ok: failures.length === 0, stage: 'RC06', date: new Date().toISOString(), case: selected, groups: checks.length, checks, failures,
    actualMainIndex: true, entry: 'apps/server/src/index.ts', actualPids: processes, realSupplier: real,
    account: { id: account.id, name: account.display_name, model: JSON.parse(version.connection).defaultModel, endpointHost: new URL(JSON.parse(version.connection).baseUrl).hostname },
    operatorTokenLimit: tokenLimit, priorUsage, usage, priorLedgerRowsUnchanged: true, priorLedgerDigest: hash(priorRows),
    knownTokensThisRun: usage.knownTokens - priorUsage.knownTokens, unknownReserveThisRun: usage.unknownReserve - priorUsage.unknownReserve,
    targetActivityAllowanceMs: 10000, productionDefaultActivityAllowanceMs: 1000, casePoliciesInEvidence: true, dailyConfigurationChanged: false,
    sourceDbReadOnly: real, dailyMessagesRead: false, keyInArgvEnvReports: false, keyTransferredViaPrivateIPC: real,
    limitations: ['Preload pins an isolated account and supplies transport barriers; actual index startup, production singleton, HTTP, release and authority guards run without a fixture execution bypass.',
      'Injected transport deliberately has 50ms asynchronous latency. Only real-supplier reports can demonstrate real HTTP send-to-headers overlap.',
      'Cancel proof concerns actual concurrent native drivers. A supplier body may already be buffered; network end observations are recorded separately and never treated as unknown-fee settlement.',
      'Every SDK helper or continuation HTTP has its own durable request and operator reservation. The cancellation barrier is removed for still-authorized B after the initial proof.',
      'Only synthetic roots explicitly select a 10000ms slice through Owner CAS; production default remains 1000ms.',
      'General engineering source edits/merge, full legacy-supplier mixed execution and other platforms are not established by these five main-entry cases.' ], cleanup, evidence };
  let encoded = JSON.stringify(result, null, 2);
  for (const secret of [...transientSecrets, ...ephemeralKeys.values()]) encoded = encoded.replaceAll(secret, '[REDACTED]');
  assert.ok(!encoded.includes(apiKey), 'Secret exclusion');
  assert.ok(usage.knownTokens + usage.unknownReserve <= tokenLimit);
  await mkdir(path.dirname(reportPath), { recursive: true }); await writeFile(reportPath, encoded + '\n', { flag: 'wx' });
  ledger?.close(); closeCredentialDb(); await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: result.ok, groups: checks.length, failures: failures.length, actualPids: processes.length,
    realSupplier: real, knownTokensThisRun: result.knownTokensThisRun, unknownReserveThisRun: result.unknownReserveThisRun, reportPath }));
}

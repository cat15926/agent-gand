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
assert.equal(selected, 'all');
const tokenLimit = Number(option('--token-limit', '1000000'));
assert.ok(Number.isSafeInteger(tokenLimit) && tokenLimit > 0 && tokenLimit <= 10000000);
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-rc10-index-')));
await mkdir(path.join(root, 'agents'));
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DB_PATH: path.join(root, 'credential-loader.sqlite'), AGENTS_DIR: path.join(root, 'agents'),
  AGENT_GAND_PRIVATE_DIR: path.join(root, 'private-loader') });
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const stamp = new Date().toISOString();
let account = { id: 'rc10-fixture-account', display_name: 'RC10 injected', provider: 'anthropic', auth_type: 'api_key',
  source: 'managed', enabled: 1, archived: 0, version: 1, config_version: 1, credential_version: 1,
  identity_generation: null, created_at: stamp, updated_at: stamp };
let version = { account_id: account.id, version: 1,
  connection: JSON.stringify({ baseUrl: 'https://rc10.invalid', protocols: ['anthropic-messages'], defaultModel: 'fixture-model', timeoutMs: 120000 }), created_at: stamp };
let apiKey = 'RC10_SYNTHETIC_KEY', redact = v => String(v), closeCredentialDb = () => {}, ledger, priorRows = [];
const ledgerFile = '/tmp/agent-gand-t07-authorized-token-ledger.sqlite';
const reportPath = path.resolve(option('--report', `docs/reports/evidence/threaded-rc10/${real ? 'live' : 'main-injected'}-${selected}-${stamp.replace(/[:.]/g, '-')}.json`));
const ledgerUsage = () => ledger ? ledger.prepare('SELECT COALESCE(SUM(actual),0) knownTokens, COALESCE(SUM(CASE WHEN actual IS NULL THEN reserved ELSE 0 END),0) unknownReserve FROM request_tokens').get() : { knownTokens: 0, unknownReserve: 0 };
let priorUsage;
try {
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
  let credential;
  try {
  account = source.prepare('SELECT * FROM accounts WHERE id=? AND enabled=1 AND archived=0').get(option('--account'));
  assert.ok(account?.auth_type === 'api_key' && account.source === 'managed');
  assert.equal(source.prepare('SELECT 1 FROM account_revocations WHERE account_id=?').get(account.id), undefined);
  version = source.prepare('SELECT * FROM account_versions WHERE account_id=? AND version=?').get(account.id, account.config_version);
  credential = source.prepare('SELECT * FROM account_credentials WHERE account_id=? AND version=?').get(account.id, account.credential_version);
  } finally { source.close(); }
  assert.ok(version && credential);
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
priorUsage = ledgerUsage(); assert.ok(priorUsage.knownTokens + priorUsage.unknownReserve < tokenLimit);
} catch (error) {
  // Initialization has not started an index process or sent a supplier request.
  // Release partially opened loaders even when account/ledger validation fails.
  const cleanupErrors = [];
  try { ledger?.close(); } catch { cleanupErrors.push('RC10_LEDGER_CLOSE_FAILED'); }
  try { closeCredentialDb(); } catch { cleanupErrors.push('RC10_CREDENTIAL_LOADER_CLOSE_FAILED'); }
  try { await rm(root, { recursive: true, force: true }); } catch { cleanupErrors.push('RC10_TEMP_CLEANUP_FAILED'); }
  const code = String(error.code ?? '');
  const safeReason = /^(?:RC10|THREADED|RESOURCE|ACCOUNT|SQLITE)_[A-Z0-9_]+$/.test(code) ? code : 'RC10_INITIALIZATION_FAILED';
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify({ ok: false, stage: 'RC10', phase: 'initialization', date: new Date().toISOString(),
    reason: safeReason, cleanupErrors, externalSupplierRequests: 0, indexProcessesStarted: 0,
    credentialsIncluded: false, temporaryRootRemoved: cleanupErrors.length === 0 }, null, 2) + '\n', { flag: 'wx' });
  throw new Error(safeReason);
}
const children = [], checks = [], evidence = [], failures = [], processes = [];
const ephemeralKeys = new Map(), transientSecrets = new Set(), cleanup = [], finalAudit = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function deadline(promise, ms, code) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {timer=setTimeout(()=>reject(new Error(code)),ms);})]); }
  finally {clearTimeout(timer);}
}
const loader = new URL('../apps/server/node_modules/tsx/dist/loader.mjs', import.meta.url).pathname;
const preload = new URL('./fixtures/threadedRc10MainGuard.mjs', import.meta.url).pathname;
const entry = new URL('../apps/server/src/index.ts', import.meta.url).pathname;
const members = [['rc10-a', 'api'], ['rc10-c', 'claude-sdk'], ['rc10-b', 'api'], ['rc10-d', 'api']].map(([agentId, backend]) => ({
  agentId, backend, backendVersion: backend === 'api' ? 'threaded-http-v1' : '0.3.288', model: JSON.parse(version.connection).defaultModel,
  roleVersion: 1, permissionVersion: 1, accountId: account.id, accountConfigVersion: account.config_version,
  accountCredentialVersion: account.credential_version, accountIdentityGeneration: account.identity_generation ?? null }));
const acceptanceTools=['post_message','cross_post_message','multi_mention','review_context','read_review_workflow','transfer_action','submit_review','complete_action','start_review_revision','check_review_gate'];
const registrations = new Map();
const clockOffsets=new Map();
let latest;
async function unusedPort() {
  const s = net.createServer(); await new Promise((y, n) => { s.once('error', n); s.listen(0, '127.0.0.1', y); });
  const port = s.address().port; await new Promise(y => s.close(y)); return port;
}
async function start(name, restore = false) {
  const dir = path.join(root, name); await mkdir(path.join(dir, 'agents'), { recursive: true });
  const pack = path.join(dir, 'release.json');
  if (!restore) await writeFile(pack, JSON.stringify({ schemaVersion: 1, platform: 'darwin', members,
    applicationTools: acceptanceTools, maxOutputTokens: 2048, maxInputTokens: 100000, maxRequests: 12 }), { mode: 0o600 });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const child = fork(entry, [], { cwd: dir, execArgv: ['--import', loader, '--import', preload],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', NODE_ENV: 'test',
      AGENT_GAND_ISOLATED_WORKER: '1', RC10_MAIN_ROOT: dir, DB_PATH: path.join(dir, 'main.sqlite'), AGENTS_DIR: path.join(dir, 'agents'),
      AGENT_GAND_PRIVATE_DIR: path.join(dir, 'private'), HOST: '127.0.0.1', PORT: String(port), LOG_LEVEL: 'silent',
      ACCOUNT_TRUSTED_ORIGINS: origin, THREADED_COLLABORATION_MODE: 'execute', THREADED_RELEASE_MEMBERS_FILE: pack, ...(registrations.has(name)?{THREADED_GITHUB_REGISTRATIONS_FILE:registrations.get(name),THREADED_GITHUB_TOKEN_RC10:'RC10_SYNTHETIC_GITHUB_TOKEN'}:{}) } });
  const processRecord = { name, restore, pid: child.pid, diagnostics: [] };
  children.push(child); processes.push(processRecord);
  let output = '', seq = 0, auth; const pending = new Map(), events = [], waiters = [];
  child.stdout.on('data', d => { output = (output + d).slice(-10000); });
  child.stderr.on('data', d => { output = (output + d).slice(-10000); });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => {
    const error = new Error(redact(`RC10_INDEX_EXIT ${code}/${signal}: ${output}`));
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
    ledgerFile, tokenLimit, applicationTools: acceptanceTools, scenario:name, clockOffset:clockOffsets.get(name)??0, targets:['rc10-c','rc10-d'] });
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
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error(`RC10_TIMEOUT_${operation}`)); }, 15000);
    pending.set(id, { resolve(v) { clearTimeout(timer); resolve(v); }, reject(e) { clearTimeout(timer); reject(e); } }); child.send({ id, operation, ...extra });
  });
  return { child, name, dir, exit, request, call,
    async event(kind) {
      const e = events.find(e => e.event === kind); if (e) { events.splice(events.indexOf(e), 1); return e; }
      return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`RC10_EVENT_TIMEOUT_${kind}`)), 180000);
        waiters.push({ kind, resolve(e) { clearTimeout(timer); resolve(e); }, reject(e) { clearTimeout(timer); reject(e); } }); });
    },
    async login() {
      const a = await request('/api/accounts/session', undefined, 'POST', { 'x-gand-bootstrap': '1' }); assert.equal(a.statusCode, 200, 'RC10_MANAGEMENT_LOGIN_FAILED');
      if (a.cookie) transientSecrets.add(a.cookie); if (a.body.csrfToken) transientSecrets.add(a.body.csrfToken);
      const b = await request('/api/accounts/threaded/access-session', undefined, 'POST', { cookie: a.cookie, 'x-gand-csrf': a.body.csrfToken }); assert.equal(b.statusCode, 200, 'RC10_THREADED_LOGIN_FAILED');
      if (b.cookie) transientSecrets.add(b.cookie); if (b.body.csrfToken) transientSecrets.add(b.body.csrfToken);
      return auth = { cookie: b.cookie, 'x-gand-csrf': b.body.csrfToken };
    },
    async kill() { child.kill('SIGKILL'); const r = await exit; assert.equal(r.signal, 'SIGKILL'); return r; },
    async close() { child.kill('SIGTERM'); const result = await deadline(exit,20000,'RC10_SHUTDOWN_TIMEOUT'); assert.equal(result.code, 0); return result; }
  };
}
async function controls(w, admissionOpen, dispatchOpen) {
  const a = await w.request('/api/threaded/release', undefined, 'GET'); assert.equal(a.statusCode, 200);
  const b = await w.request('/api/threaded/release/controls', { expectedVersion: a.body.control.version, requestId: randomUUID(),
    admissionOpen, dispatchOpen, reason: 'Authorized isolated RC10 main-index context acceptance' }); assert.equal(b.statusCode, 200, JSON.stringify(b));
}
async function fresh(name) {
  const w = await start(name); await w.login(); await controls(w, true, false);
  const r = await w.request('/api/threaded/threads', { title: `RC10 ${name}`, clientRequestId: randomUUID() }); assert.equal(r.statusCode, 200, JSON.stringify(r));
  return { w, threadId: r.body.thread?.id ?? r.body.id };
}
async function submit(w, threadId, agentId = 'rc10-a', body = 'Reply exactly RC10_ACK. No tools or reasoning.', activityAllowanceMs = 10000) {
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
  const end = Date.now() + 360000;
  while (Date.now() < end) { const f = await w.call('facts', { messageId }); latest = f;
    if (f.toolErrors?.length) throw new Error('RC10_TOOL_FAILED');
    // Same-HEAD reviewer updates are legal product operations, but cannot stand
    // in for this scenario's required new-HEAD revision. Fail before waiting on
    // a blocked first-generation gate that can no longer appear.
    if (f.reviewReports?.some(row => row.generation === 1 && JSON.parse(row.record).verdict !== 'changes_requested'))
      throw new Error('RC10_SCENARIO_REVIEW_DEVIATION');
    if (f.invocations?.some(invocation => invocation.status === 'unknown')) throw new Error('RC10_INVOCATION_UNKNOWN');
    if (f.invocations?.some(invocation => invocation.status === 'failed')) throw new Error('RC10_INVOCATION_FAILED');
    if (predicate(f)) return f;
    await delay(250);
  }
  throw new Error('RC10_COMPLETION_TIMEOUT');
}
async function caseRun(name, fn) {
  if (selected !== 'all' && selected !== name) return;
  const began = Date.now(); latest = null;
  try { await fn(); checks.push({ id: name, passed: true, elapsedMs: Date.now() - began }); }
  catch (e) { failures.push({ id: name, reason: redact(e.message), facts: latest }); throw e; }
}
async function createThread(w,title){const r=await w.request('/api/threaded/threads',{title,clientRequestId:randomUUID()});assert.equal(r.statusCode,200);return r.body.thread?.id??r.body.id;}
async function memberControl(w,threadId,agentId,action){const r=await w.request(`/api/threaded/threads/${threadId}/members/${agentId}/controls`,{action,requestId:randomUUID()});assert.equal(r.statusCode,200,JSON.stringify(r));}
const quiet=f=>f.queue.every(q=>['settled','blocked'].includes(q.state))&&!f.attempts.some(a=>a.status==='running')&&!f.requests.some(r=>r.state==='sending')&&f.processes.every(p=>p.state==='verified_stopped');
try{
 await caseRun('comprehensive_chain',async()=>{
  const {w:setup,threadId:home}=await fresh('chain');const work=await createThread(setup,'RC10 review work Thread');
  const facts=await setup.call('facts');
  const file=path.join(setup.dir,'github.json');
  await writeFile(file,JSON.stringify({schemaVersion:1,version:1,ownerId:facts.ownerId,
   credential:{source:'environment',name:'THREADED_GITHUB_TOKEN_RC10',version:1},
   repositories:[{repository:'rc10-fixture/review',pullNumbers:[16],threadIds:[home,work],actors:members.map(m=>({agentId:m.agentId,githubLogin:'rc10-review-principal',mayAssign:m.agentId==='rc10-b'}))}]}),{mode:0o600});
  await setup.close();registrations.set('chain',file);
  const w=await start('chain',true);await w.login();await memberControl(w,work,'rc10-d','pause');
  const m=await submit(w,home,'rc10-a',`RC10_START home=${home} work=${work}. Perform the synthetic acceptance workflow in your role instructions. Publicly hand off to rc10-b; retain this home/work routing in the message. The PR source is injected and no real code or GitHub approval is claimed.`);
  await controls(w,true,true);
  await until(w,m.id,f=>f.groups.length===1&&f.targets.some(t=>t.agent_id==='rc10-c'&&t.status==='responded')&&quiet(f));
  const before=await snapshot(w,m.id,'A publicly relays to B; B crosses to work Thread and consults C/D; actual SDK C answered, D explicitly paused');
  assert.equal(before.groups[0].state,'collecting');const originalGroup=before.groups[0];
  const answer=before.messages.find(v=>v.id===before.targets.find(t=>t.agent_id==='rc10-c').response_message_id);
  assert.ok(answer?.body.trim());assert.ok(before.effects.some(e=>e.agentId==='rc10-c'&&e.generation));
  await controls(w,true,false);await w.kill();
  const next=await start('chain',true);await next.login();
  const recovered=await snapshot(next,m.id,'New actual index PID retains group/deadline/original independent SDK answer; no supplier replay');
  assert.notEqual(next.child.pid,w.child.pid);assert.deepEqual(recovered.groups,[originalGroup]);assert.deepEqual(recovered.messages.find(v=>v.id===answer.id),answer);assert.equal(recovered.effects.length,0);
  clockOffsets.set('chain',await next.call('advance-deadline',{groupId:originalGroup.id}));
  await controls(next,true,true);
  await until(next,m.id,f=>f.gates.some(g=>g.stage==='revision')&&f.actions.some(a=>a.generation===1&&a.state==='completed')&&f.reviewGates.some(g=>g.status==='blocked'));
  const first=await snapshot(next,m.id,'One timeout settlement/callback; first independent review requests changes, responsibility completed but review gate blocked');
  assert.equal(first.settlements.length,1);assert.equal(first.callbacks.filter(c=>c.kind==='consultation').length,1);assert.equal(first.callbacks.find(c=>c.kind==='consultation').state,'delivered');
  const settled=JSON.parse(first.settlements[0].record);assert.equal(settled.kind,'partial');
  assert.deepEqual(Object.fromEntries(settled.responses.map(r=>[r.agentId,r.status])),{'rc10-c':'responded','rc10-d':'timeout'});
  assert.equal(settled.responses.find(r=>r.agentId==='rc10-c').body,answer.body);
  await next.call('head',{head:'b'.repeat(40)});await next.call('release',{stage:'revision'});
  await until(next,m.id,f=>f.gates.some(g=>g.stage==='return')&&f.actions.some(a=>a.generation===2&&a.state==='completed')&&f.reviewGates.some(g=>g.status==='approved'));
  await next.call('release',{stage:'return'});
  await until(next,m.id,f=>f.messages.some(v=>v.thread_id===home&&v.sender_agent_id==='rc10-a'&&v.origin==='agent_response'&&v.body.includes('RC10_DONE'))&&quiet(f));
  const final=await snapshot(next,m.id,'New injected HEAD attested, independently re-reviewed and resolved; explicit return to original Thread');
  assert.equal(final.actions.length,1);assert.equal(final.actions[0].generation,2);assert.equal(final.actions[0].state,'completed');
  assert.equal(final.workflows.length,1);assert.equal(final.workflows[0].version,3);assert.ok(final.workflows[0].findings.every(f=>f.state==='verified'));
  assert.ok(final.messages.every(v=>v.causal_root_id===m.causalRootId));assert.ok(final.invocations.every(v=>v.causal_root_id===m.causalRootId));
  assert.equal(final.budgetRoots.length,1);assert.equal(final.workflows[0].rootId,m.causalRootId);
  assert.equal(final.callbacks.filter(c=>c.kind==='consultation').length,1);assert.equal(final.callbacks.filter(c=>c.kind==='action_completed').length,2);assert.equal(new Set(final.callbacks.map(c=>c.kind+':'+c.source_id)).size,final.callbacks.length);assert.equal(final.settlements.length,1);assert.equal(final.reviewReports.length,2);
  assert.ok(final.reviewGates.filter(g=>g.status==='approved').every(g=>JSON.parse(g.record).externalApprovalGranted===false));
  assert.ok(final.effects.every(e=>!e.localFault));assert.equal(final.toolErrors.length,0,JSON.stringify(final.toolErrors));
  const counts=f=>[f.messages.length,f.invocations.length,f.callbacks.length,f.settlements.length,f.reviewReports.length,f.actionGenerations.length];
  await memberControl(next,work,'rc10-d','resume');await next.call('recover-cooperation');await next.call('recover-cooperation');
  const repeat=await snapshot(next,m.id,'Resuming expired target and repeated recovery retain a unique callback and do not replay the chain');assert.deepEqual(counts(repeat),counts(final));assert.equal(repeat.effects.filter(e=>e.agentId==='rc10-d').length,0);
  await next.close();
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
          assert.equal(p.host, hostname()); assert.ok(command.includes('/execution/guardian.mjs') && command.includes(p.token), 'RC10_CLEANUP_OWNERSHIP_UNCONFIRMED');
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
  // Export a fixed table allowlist after every index exits and native cleanup is
  // attempted, before removing temporary SQLite. This also preserves the final
  // request/usage facts when the last live polling snapshot preceded a failure.
  // No account/config/credential/auth-session or raw native transcript table is read.
  const auditTables = [
    'threaded_backend_requests', 'threaded_backend_processes', 'threaded_backend_quiescence',
    'threaded_budget_roots', 'threaded_budget_versions', 'threaded_budget_invocations',
    'threaded_budget_attempts', 'threaded_budget_requests', 'threaded_budget_activity',
    'threaded_budget_outcomes', 'threaded_budget_reconciliations',
    'threaded_invocations', 'threaded_attempts', 'threaded_invocation_terminals',
    'threaded_tool_receipts', 'threaded_context_send_receipts',
    'threaded_messages', 'threaded_consultations', 'threaded_consultation_targets',
    'threaded_consultation_settlements', 'threaded_collaboration_callbacks',
    'threaded_actions', 'threaded_action_generations', 'threaded_review_workflows',
    'threaded_review_reports', 'threaded_review_gate_checks',
  ];
  for (const name of new Set(processes.map(p => p.name))) {
    const audit = { name, capturedAfterIndexExit: true, nativeCleanupSucceeded: !failures.some(f => f.id === 'cleanup'),
      readonly: true, tableAllowlist: auditTables, tables: {}, exportErrors: [] };
    finalAudit.push(audit);
    let database;
    try {
      database = new Database(path.join(root, name, 'main.sqlite'), { readonly: true, fileMustExist: true });
      database.transaction(() => {
        for (const table of auditTables) {
          try { audit.tables[table] = database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(); }
          catch (error) { audit.exportErrors.push({ table, reason: String(error.code ?? 'RC10_AUDIT_TABLE_EXPORT_FAILED') }); }
        }
        audit.foreignKeys = database.pragma('foreign_key_check');
      })();
    } catch (error) { audit.exportErrors.push({ reason: String(error.code ?? 'RC10_AUDIT_DATABASE_EXPORT_FAILED') }); }
    finally { database?.close(); }
    audit.complete = audit.exportErrors.length === 0;
    if (!audit.complete) { failures.push({ id: 'final-audit-export', name, errors: audit.exportErrors }); process.exitCode = 1; }
  }
  const usage = ledgerUsage();
  if (ledger) assert.deepEqual(priorRows.map(r => ledger.prepare('SELECT * FROM request_tokens WHERE id=?').get(r.id)), priorRows);
  const result = { ok: failures.length === 0, stage: 'RC10', date: new Date().toISOString(), case: selected, groups: checks.length, checks, failures,
    actualMainIndex: true, entry: 'apps/server/src/index.ts', actualPids: processes, realSupplier: real,
    account: { id: account.id, name: account.display_name, model: JSON.parse(version.connection).defaultModel, endpointHost: new URL(JSON.parse(version.connection).baseUrl).hostname },
    operatorTokenLimit: tokenLimit, priorUsage, usage, priorLedgerRowsUnchanged: true, priorLedgerDigest: hash(priorRows),
    knownTokensThisRun: usage.knownTokens - priorUsage.knownTokens, unknownReserveThisRun: usage.unknownReserve - priorUsage.unknownReserve,
    targetActivityAllowanceMs: 10000, productionDefaultActivityAllowanceMs: 1000, casePoliciesInEvidence: true, dailyConfigurationChanged: false,
    sourceDbReadOnly: real, dailyMessagesRead: false, keyInArgvEnvReports: false, keyTransferredViaPrivateIPC: real,
    limitations: ['Actual index/production singleton, authenticated loopback HTTP and release grants; no factory execution bypass.',
      'Real mode uses actual configured API and SDK model replies/tools; GitHub GET principal/PR facts and HEAD transition are explicitly injected, never a natural remote PR event or code review.',
      'D is paused via authenticated controls; the original persisted consultation deadline is crossed with an explicit isolated clock offset after all attempts and native groups stop.',
      'A review-to-author model request is held until the reviewer completes the Action and checks its gate; this deterministic acceptance barrier is not a product scheduling guarantee.',
      'Only synthetic root uses explicit activity/quota CAS; production defaults, schema35, daily closed remain unchanged.',
      'Permission/stale callback/budget rejection negative branches are independently covered by the isolated RC10 chain suite, not claimed as real supplier failures.'
 ], cleanup, finalAudit, evidence };
  let encoded = redact(JSON.stringify(result, null, 2));
  for (const secret of [...transientSecrets, ...ephemeralKeys.values()]) encoded = encoded.replaceAll(secret, '[REDACTED]');
  assert.ok(!encoded.includes(apiKey), 'Secret exclusion');
  assert.ok(usage.knownTokens + usage.unknownReserve <= tokenLimit);
  await mkdir(path.dirname(reportPath), { recursive: true }); await writeFile(reportPath, encoded + '\n', { flag: 'wx' });
  ledger?.close(); closeCredentialDb(); await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: result.ok, groups: checks.length, failures: failures.length, actualPids: processes.length,
    realSupplier: real, knownTokensThisRun: result.knownTokensThisRun, unknownReserveThisRun: result.unknownReserveThisRun, reportPath }));
}

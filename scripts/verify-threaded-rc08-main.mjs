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
assert.ok(['all', 'partial_failure', 'timeout_restart', 'callback_pause', 'callback_revoke', 'lost_receipt'].includes(selected));
const tokenLimit = Number(option('--token-limit', '500000'));
assert.ok(Number.isSafeInteger(tokenLimit) && tokenLimit > 0 && tokenLimit <= 10000000);
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-rc08-index-')));
await mkdir(path.join(root, 'agents'));
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DB_PATH: path.join(root, 'credential-loader.sqlite'), AGENTS_DIR: path.join(root, 'agents'),
  AGENT_GAND_PRIVATE_DIR: path.join(root, 'private-loader') });
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const stamp = new Date().toISOString();
let account = { id: 'rc08-fixture-account', display_name: 'RC08 injected', provider: 'anthropic', auth_type: 'api_key',
  source: 'managed', enabled: 1, archived: 0, version: 1, config_version: 1, credential_version: 1,
  identity_generation: null, created_at: stamp, updated_at: stamp };
let version = { account_id: account.id, version: 1,
  connection: JSON.stringify({ baseUrl: 'https://rc08.invalid', protocols: ['anthropic-messages'], defaultModel: 'fixture-model', timeoutMs: 120000 }), created_at: stamp };
let apiKey = 'RC08_SYNTHETIC_KEY', redact = v => String(v), closeCredentialDb = () => {}, ledger, priorRows = [];
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
const reportPath = path.resolve(option('--report', `docs/reports/evidence/threaded-rc08/${real ? 'live' : 'main-injected'}-${selected}-${stamp.replace(/[:.]/g, '-')}.json`));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function deadline(promise, ms, code) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {timer=setTimeout(()=>reject(new Error(code)),ms);})]); }
  finally {clearTimeout(timer);}
}
const loader = new URL('../apps/server/node_modules/tsx/dist/loader.mjs', import.meta.url).pathname;
const preload = new URL('./fixtures/threadedRc08MainGuard.mjs', import.meta.url).pathname;
const entry = new URL('../apps/server/src/index.ts', import.meta.url).pathname;
const members = [['rc08-api', 'api'], ['rc08-sdk', 'claude-sdk'], ['rc08-api-b', 'api'], ['rc08-api-c', 'api']].map(([agentId, backend]) => ({
  agentId, backend, backendVersion: backend === 'api' ? 'threaded-http-v1' : '0.3.288', model: JSON.parse(version.connection).defaultModel,
  roleVersion: 1, permissionVersion: 1, accountId: account.id, accountConfigVersion: account.config_version,
  accountCredentialVersion: account.credential_version, accountIdentityGeneration: account.identity_generation ?? null }));
const acceptanceTools=['multi_mention','multi_mention_status'];
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
    applicationTools: acceptanceTools, maxOutputTokens: 1024, maxInputTokens: 65536, maxRequests: 4 }), { mode: 0o600 });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const child = fork(entry, [], { cwd: dir, execArgv: ['--import', loader, '--import', preload],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', NODE_ENV: 'test',
      AGENT_GAND_ISOLATED_WORKER: '1', RC08_MAIN_ROOT: dir, DB_PATH: path.join(dir, 'main.sqlite'), AGENTS_DIR: path.join(dir, 'agents'),
      AGENT_GAND_PRIVATE_DIR: path.join(dir, 'private'), HOST: '127.0.0.1', PORT: String(port), LOG_LEVEL: 'silent',
      ACCOUNT_TRUSTED_ORIGINS: origin, THREADED_COLLABORATION_MODE: 'execute', THREADED_RELEASE_MEMBERS_FILE: pack } });
  const processRecord = { name, restore, pid: child.pid, diagnostics: [] };
  children.push(child); processes.push(processRecord);
  let output = '', seq = 0, auth; const pending = new Map(), events = [], waiters = [];
  child.stdout.on('data', d => { output = (output + d).slice(-10000); });
  child.stderr.on('data', d => { output = (output + d).slice(-10000); });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => {
    const error = new Error(redact(`RC08_INDEX_EXIT ${code}/${signal}: ${output}`));
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
    ledgerFile, tokenLimit, applicationTools: acceptanceTools, scenario:name, clockOffset:clockOffsets.get(name)??0, targets:name==='timeout_restart'?['rc08-sdk','rc08-api-b','rc08-api-c']:['rc08-sdk','rc08-api-b'] });
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
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error(`RC08_TIMEOUT_${operation}`)); }, 15000);
    pending.set(id, { resolve(v) { clearTimeout(timer); resolve(v); }, reject(e) { clearTimeout(timer); reject(e); } }); child.send({ id, operation, ...extra });
  });
  return { child, name, dir, exit, request, call,
    async event(kind) {
      const e = events.find(e => e.event === kind); if (e) { events.splice(events.indexOf(e), 1); return e; }
      return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`RC08_EVENT_TIMEOUT_${kind}`)), 180000);
        waiters.push({ kind, resolve(e) { clearTimeout(timer); resolve(e); }, reject(e) { clearTimeout(timer); reject(e); } }); });
    },
    async login() {
      const a = await request('/api/accounts/session', undefined, 'POST', { 'x-gand-bootstrap': '1' }); assert.equal(a.statusCode, 200, 'RC08_MANAGEMENT_LOGIN_FAILED');
      if (a.cookie) transientSecrets.add(a.cookie); if (a.body.csrfToken) transientSecrets.add(a.body.csrfToken);
      const b = await request('/api/accounts/threaded/access-session', undefined, 'POST', { cookie: a.cookie, 'x-gand-csrf': a.body.csrfToken }); assert.equal(b.statusCode, 200, 'RC08_THREADED_LOGIN_FAILED');
      if (b.cookie) transientSecrets.add(b.cookie); if (b.body.csrfToken) transientSecrets.add(b.body.csrfToken);
      return auth = { cookie: b.cookie, 'x-gand-csrf': b.body.csrfToken };
    },
    async kill() { child.kill('SIGKILL'); const r = await exit; assert.equal(r.signal, 'SIGKILL'); return r; },
    async close() { child.kill('SIGTERM'); const result = await deadline(exit,20000,'RC08_SHUTDOWN_TIMEOUT'); assert.equal(result.code, 0); return result; }
  };
}
async function controls(w, admissionOpen, dispatchOpen) {
  const a = await w.request('/api/threaded/release', undefined, 'GET'); assert.equal(a.statusCode, 200);
  const b = await w.request('/api/threaded/release/controls', { expectedVersion: a.body.control.version, requestId: randomUUID(),
    admissionOpen, dispatchOpen, reason: 'Authorized isolated RC08 main-index context acceptance' }); assert.equal(b.statusCode, 200, JSON.stringify(b));
}
async function fresh(name) {
  const w = await start(name); await w.login(); await controls(w, true, false);
  const r = await w.request('/api/threaded/threads', { title: `RC08 ${name}`, clientRequestId: randomUUID() }); assert.equal(r.statusCode, 200, JSON.stringify(r));
  return { w, threadId: r.body.thread?.id ?? r.body.id };
}
async function submit(w, threadId, agentId = 'rc08-api', body = 'Reply exactly RC08_ACK. No tools or reasoning.', activityAllowanceMs = 10000) {
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
  throw new Error('RC08_COMPLETION_TIMEOUT');
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
function manifestFor(f,m,agent='rc08-api'){return f.manifests.find(v=>v.sourceMessageId===m.id&&v.agentId===agent);}
function included(m){return m.items.filter(v=>v.decision==='included').map(v=>v.messageId).sort();}
function assertDelivery(f,m,agent='rc08-api'){
 const manifest=manifestFor(f,m,agent);assert.ok(manifest);const expected=included(manifest);
 const intent=f.sendIntents.find(i=>i.manifest_id===manifest.id);assert.equal(intent.status,'delivered');
 assert.deepEqual(f.deliveries.filter(d=>d.manifest_id===manifest.id).map(d=>d.message_id).sort(),expected);
 const effect=f.effects.find(e=>e.invocationId===manifest.invocationId&&e.generation);
 if(effect)assert.deepEqual(effect.wireMessages.map(v=>v.id).sort(),expected);
 assert.ok(f.cursorFacts.filter(v=>v.kind==='delivery'&&v.binding_id===manifest.bindingId).every(v=>expected.includes(v.message_id)));
 return manifest;
}
async function history(w,threadId,body,extra={}){return w.call('seed-history',{threadId,requestId:randomUUID(),body,...extra});}
function frozenResponse(f,t){return {target:t,body:f.messages.find(m=>m.id===t.response_message_id).body};}
async function memberControl(w,threadId,agentId,action){
 const r=await w.request(`/api/threaded/threads/${threadId}/members/${agentId}/controls`,{action,requestId:randomUUID()});assert.equal(r.statusCode,200,JSON.stringify(r));
}
function group(f){assert.equal(f.groups.length,1);return f.groups[0];}
function response(f,agent){return f.targets.find(t=>t.agent_id===agent)?.response_message_id;}
function terminalCaller(f){return f.invocations.some(i=>i.agent_id==='rc08-api'&&i.status==='completed'&&f.queue.some(q=>q.invocation_id===i.id&&f.messages.some(m=>m.id===q.source_message_id&&m.origin==='system')));}
function logicalCounts(f){return {groups:f.groups.length,targets:f.targets.length,settlements:f.settlements.length,callbacks:f.callbacks.length,callbackMessages:f.callbacks.filter(c=>c.message_id).map(c=>c.message_id),wakes:f.wakes.length,queue:f.queue.length};}
function verifySettlement(f,kind,statuses){
 const g=group(f);assert.equal(g.state,'settled');assert.equal(f.settlements.length,1);assert.equal(f.callbacks.length,1);
 const s=f.settlements[0],v=JSON.parse(s.record);assert.equal(s.kind,kind);assert.equal(v.kind,kind);
 assert.deepEqual(Object.fromEntries(v.responses.map(r=>[r.agentId,r.status])),statuses);
 for(const r of v.responses){if(r.status==='responded'){const m=f.messages.find(m=>m.id===r.responseMessageId);assert.ok(m);assert.equal(r.body,m.body);assert.ok(r.body.trim());}else assert.equal(r.responseMessageId,null);}
 assert.ok(f.messages.every(m=>m.causal_root_id===g.root_id));assert.ok(f.invocations.every(i=>i.causal_root_id===g.root_id));
 assert.ok(f.targets.every(t=>f.wakes.filter(w=>w.source_message_id===t.question_message_id).length===1));
 assert.equal(f.callbacks[0].source_id,g.id);return v;
}
async function initialize(name,paused=[]){
 const {w,threadId}=await fresh(name);for(const a of paused)await memberControl(w,threadId,a,'pause');
 const targets=name==='timeout_restart'?['rc08-sdk','rc08-api-b','rc08-api-c']:['rc08-sdk','rc08-api-b'];
 const payload={idempotencyKey:'rc08-consult-once',targets,question:'Reply with your own member ID and a brief independent opinion. Do not call any tools or mention other members.',callbackTo:'rc08-api',timeoutMinutes:3,overrideReason:'Explicit synthetic reliability acceptance; no external research needed'};
 const m=await submit(w,threadId,'rc08-api',`Call multi_mention exactly once with this JSON: ${JSON.stringify(payload)}. After its result reply exactly REGISTERED without more tools. When later invoked by the system settlement, reply CALLBACK only; never register another consultation for that callback.`);
 await controls(w,true,true);return {w,threadId,m};
}
async function expire(w){const f=await w.call('facts');assert.ok(f.groups.length===1);const offset=await w.call('advance-deadline',{groupId:f.groups[0].id});clockOffsets.set(w.name,offset);}
async function assertIdempotent(w,before){await w.call('recover-cooperation');await w.call('recover-cooperation');const after=await w.call('facts');assert.deepEqual(logicalCounts(after),logicalCounts(before));assert.deepEqual(after.settlements,before.settlements);return after;}
try{
 await caseRun('partial_failure',async()=>{
  const {w,m}=await initialize('partial_failure');
  await until(w,m.id,f=>terminalCaller(f));const f=await snapshot(w,m.id,'Actual API caller and actual SDK answer; other target HTTP400 is explicitly injected before supplier egress');
  verifySettlement(f,'partial',{'rc08-sdk':'responded','rc08-api-b':'failed'});assert.equal(f.callbacks[0].state,'delivered');
  assert.equal(f.effects.filter(e=>e.localFault).length,1);assert.ok(f.processes.every(p=>p.state==='verified_stopped'));
  assert.ok(f.invocations.some(i=>i.agent_id==='rc08-sdk'&&i.status==='completed'));await assertIdempotent(w,f);await w.close();
 });
 await caseRun('timeout_restart',async()=>{
  const {w,m,threadId}=await initialize('timeout_restart',['rc08-api-c']);
  await until(w,m.id,f=>f.groups.length===1&&f.targets.filter(t=>t.status==='responded').length===2&&complete(f,m));
  const first=await snapshot(w,m.id,'Three targets; two original answers retained and paused third pending before actual index SIGKILL');
  assert.equal(group(first).state,'collecting');const original=first.groups[0],answers=first.targets.filter(t=>t.response_message_id).map(t=>frozenResponse(first,t));
  await controls(w,true,false);await w.kill();const next=await start('timeout_restart',true);await next.login();
  const recovered=await snapshot(next,m.id,'New index retains exact group, deadline and two original replies without replay');
  assert.notEqual(next.child.pid,w.child.pid);assert.deepEqual(recovered.groups,[original]);assert.deepEqual(recovered.targets.filter(t=>t.response_message_id).map(t=>frozenResponse(recovered,t)),answers);assert.equal(recovered.effects.length,0);
  await expire(next);await controls(next,true,true);await until(next,m.id,f=>terminalCaller(f));
  const f=await snapshot(next,m.id,'Original deadline crossed by explicit isolated clock; unique partial and callback');
  verifySettlement(f,'partial',{'rc08-sdk':'responded','rc08-api-b':'responded','rc08-api-c':'timeout'});assert.equal(group(f).deadline,original.deadline);
  const old=logicalCounts(f);await memberControl(next,threadId,'rc08-api-c','resume');await next.call('recover-cooperation');
  const after=await snapshot(next,m.id,'Expired target remains retired after resume; no extra invocation or request');
  assert.deepEqual(logicalCounts(after),old);assert.equal(after.effects.filter(e=>e.agentId==='rc08-api-c').length,0);await assertIdempotent(next,after);await next.close();
 });
 await caseRun('callback_pause',async()=>{
  const {w,m,threadId}=await initialize('callback_pause',['rc08-api-b']);
  await until(w,m.id,f=>response(f,'rc08-sdk')&&complete(f,m));await memberControl(w,threadId,'rc08-api','pause');await expire(w);
  const waiting=await snapshot(w,m.id,'Deadline partial is durable while caller pause retains callback waiting');
  verifySettlement(waiting,'partial',{'rc08-sdk':'responded','rc08-api-b':'timeout'});assert.equal(waiting.callbacks[0].state,'waiting');assert.equal(waiting.callbacks[0].message_id,null);
  await w.kill();const next=await start('callback_pause',true);await next.login();const restored=await snapshot(next,m.id,'New index still waits on original caller control');assert.deepEqual(restored.settlements,waiting.settlements);assert.equal(restored.callbacks[0].state,'waiting');assert.equal(restored.effects.length,0);
  await memberControl(next,threadId,'rc08-api','resume');await until(next,m.id,f=>terminalCaller(f));const f=await snapshot(next,m.id,'Authenticated resume delivers exactly original callback and invokes caller once');
  assert.equal(f.callbacks[0].id,waiting.callbacks[0].id);assert.equal(f.callbacks[0].state,'delivered');await assertIdempotent(next,f);await next.close();
 });
 await caseRun('callback_revoke',async()=>{
  const {w,m}=await initialize('callback_revoke',['rc08-api-b']);await until(w,m.id,f=>response(f,'rc08-sdk')&&complete(f,m));
  await w.call('revoke-caller',{threadId:group(await w.call('facts')).thread_id});await expire(w);
  const f=await snapshot(w,m.id,'Isolated permission-version mutation rejects frozen caller authority; original answers/settlement retained');
  verifySettlement(f,'partial',{'rc08-sdk':'responded','rc08-api-b':'timeout'});assert.equal(f.callbacks[0].state,'rejected');assert.equal(f.callbacks[0].reason,'THREADED_CALLBACK_AUTHORITY_CHANGED');assert.equal(f.callbacks[0].message_id,null);
  assert.equal(f.messages.filter(m=>m.origin==='system').length,0);await assertIdempotent(w,f);await w.close();
 });
 await caseRun('lost_receipt',async()=>{
  const {w,m}=await initialize('lost_receipt');await until(w,m.id,f=>terminalCaller(f));
  const f=await snapshot(w,m.id,'Committed multi_mention tool reply deliberately withheld at broker boundary then exact same-binding retry returns durable result');
  verifySettlement(f,'complete',{'rc08-sdk':'responded','rc08-api-b':'responded'});assert.equal(f.callbacks[0].state,'delivered');assert.equal(f.toolReplay.length,1);assert.equal(f.toolReplay[0].sameResult,true);assert.deepEqual(f.toolReplay[0].before,f.toolReplay[0].after);
  await assertIdempotent(w,f);await w.close();
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
          assert.equal(p.host, hostname()); assert.ok(command.includes('/execution/guardian.mjs') && command.includes(p.token), 'RC08_CLEANUP_OWNERSHIP_UNCONFIRMED');
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
  const result = { ok: failures.length === 0, stage: 'RC08', date: new Date().toISOString(), case: selected, groups: checks.length, checks, failures,
    actualMainIndex: true, entry: 'apps/server/src/index.ts', actualPids: processes, realSupplier: real,
    account: { id: account.id, name: account.display_name, model: JSON.parse(version.connection).defaultModel, endpointHost: new URL(JSON.parse(version.connection).baseUrl).hostname },
    operatorTokenLimit: tokenLimit, priorUsage, usage, priorLedgerRowsUnchanged: true, priorLedgerDigest: hash(priorRows),
    knownTokensThisRun: usage.knownTokens - priorUsage.knownTokens, unknownReserveThisRun: usage.unknownReserve - priorUsage.unknownReserve,
    targetActivityAllowanceMs: 10000, productionDefaultActivityAllowanceMs: 1000, casePoliciesInEvidence: true, dailyConfigurationChanged: false,
    sourceDbReadOnly: real, dailyMessagesRead: false, keyInArgvEnvReports: false, keyTransferredViaPrivateIPC: real,
    limitations: ['Actual index runs production singleton/release/authority without execution bypass; preload configures synthetic data and bounded transport faults.',
      'partial_failure uses an injected HTTP400 for one target before supplier egress even in real mode; completed caller/SDK peer/callback use the configured supplier.',
      'Timeout tests advance an explicit isolated Date.now offset across the persisted original deadline; they do not claim wall-clock timing accuracy.',
      'Lost tool receipt is withheld and retried at the trusted broker under the same still-authorized binding; this is not automatic replay of an unknown crashed invocation.',
      'Caller permission-version revocation is an isolated fixture mutation, not a product membership-edit UI.',
      'Only synthetic roots select 10000ms activity; default1000ms, schema35 and daily closed configuration remain unchanged.'
 ], cleanup, evidence };
  let encoded = JSON.stringify(result, null, 2);
  for (const secret of [...transientSecrets, ...ephemeralKeys.values()]) encoded = encoded.replaceAll(secret, '[REDACTED]');
  assert.ok(!encoded.includes(apiKey), 'Secret exclusion');
  assert.ok(usage.knownTokens + usage.unknownReserve <= tokenLimit);
  await mkdir(path.dirname(reportPath), { recursive: true }); await writeFile(reportPath, encoded + '\n', { flag: 'wx' });
  ledger?.close(); closeCredentialDb(); await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: result.ok, groups: checks.length, failures: failures.length, actualPids: processes.length,
    realSupplier: real, knownTokensThisRun: result.knownTokensThisRun, unknownReserveThisRun: result.unknownReserveThisRun, reportPath }));
}

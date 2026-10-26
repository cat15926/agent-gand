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
assert.ok(['all', 'overflow', 'gaps', 'wave', 'cursor', 'envelope'].includes(selected));
const tokenLimit = Number(option('--token-limit', '500000'));
assert.ok(Number.isSafeInteger(tokenLimit) && tokenLimit > 0 && tokenLimit <= 10000000);
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-rc07-index-')));
await mkdir(path.join(root, 'agents'));
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DB_PATH: path.join(root, 'credential-loader.sqlite'), AGENTS_DIR: path.join(root, 'agents'),
  AGENT_GAND_PRIVATE_DIR: path.join(root, 'private-loader') });
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const stamp = new Date().toISOString();
let account = { id: 'rc07-fixture-account', display_name: 'RC07 injected', provider: 'anthropic', auth_type: 'api_key',
  source: 'managed', enabled: 1, archived: 0, version: 1, config_version: 1, credential_version: 1,
  identity_generation: null, created_at: stamp, updated_at: stamp };
let version = { account_id: account.id, version: 1,
  connection: JSON.stringify({ baseUrl: 'https://rc07.invalid', protocols: ['anthropic-messages'], defaultModel: 'fixture-model', timeoutMs: 120000 }), created_at: stamp };
let apiKey = 'RC07_SYNTHETIC_KEY', redact = v => String(v), closeCredentialDb = () => {}, ledger, priorRows = [];
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
const reportPath = path.resolve(option('--report', `docs/reports/evidence/threaded-rc07/${real ? 'live' : 'main-injected'}-${selected}-${stamp.replace(/[:.]/g, '-')}.json`));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function deadline(promise, ms, code) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {timer=setTimeout(()=>reject(new Error(code)),ms);})]); }
  finally {clearTimeout(timer);}
}
const loader = new URL('../apps/server/node_modules/tsx/dist/loader.mjs', import.meta.url).pathname;
const preload = new URL('./fixtures/threadedRc07MainGuard.mjs', import.meta.url).pathname;
const entry = new URL('../apps/server/src/index.ts', import.meta.url).pathname;
const members = [['rc07-api', 'api'], ['rc07-sdk', 'claude-sdk'], ['rc07-api-b', 'api'], ['rc07-sdk-b', 'claude-sdk']].map(([agentId, backend]) => ({
  agentId, backend, backendVersion: backend === 'api' ? 'threaded-http-v1' : '0.3.288', model: JSON.parse(version.connection).defaultModel,
  roleVersion: 1, permissionVersion: 1, accountId: account.id, accountConfigVersion: account.config_version,
  accountCredentialVersion: account.credential_version, accountIdentityGeneration: account.identity_generation ?? null }));
const acceptanceTools=(await import('../apps/server/src/threaded/tools.ts')).THREADED_APPLICATION_TOOL_NAMES;
let latest;
async function unusedPort() {
  const s = net.createServer(); await new Promise((y, n) => { s.once('error', n); s.listen(0, '127.0.0.1', y); });
  const port = s.address().port; await new Promise(y => s.close(y)); return port;
}
async function start(name, restore = false) {
  const dir = path.join(root, name); await mkdir(path.join(dir, 'agents'), { recursive: true });
  const pack = path.join(dir, 'release.json');
  if (!restore) await writeFile(pack, JSON.stringify({ schemaVersion: 1, platform: 'darwin', members,
    applicationTools: name==='envelope'?acceptanceTools:[], maxOutputTokens: 1024, maxInputTokens: 8192, maxRequests: 2 }), { mode: 0o600 });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const child = fork(entry, [], { cwd: dir, execArgv: ['--import', loader, '--import', preload],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', NODE_ENV: 'test',
      AGENT_GAND_ISOLATED_WORKER: '1', RC07_MAIN_ROOT: dir, DB_PATH: path.join(dir, 'main.sqlite'), AGENTS_DIR: path.join(dir, 'agents'),
      AGENT_GAND_PRIVATE_DIR: path.join(dir, 'private'), HOST: '127.0.0.1', PORT: String(port), LOG_LEVEL: 'silent',
      ACCOUNT_TRUSTED_ORIGINS: origin, THREADED_COLLABORATION_MODE: 'execute', THREADED_RELEASE_MEMBERS_FILE: pack } });
  const processRecord = { name, restore, pid: child.pid, diagnostics: [] };
  children.push(child); processes.push(processRecord);
  let output = '', seq = 0, auth; const pending = new Map(), events = [], waiters = [];
  child.stdout.on('data', d => { output = (output + d).slice(-10000); });
  child.stderr.on('data', d => { output = (output + d).slice(-10000); });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => {
    const error = new Error(redact(`RC07_INDEX_EXIT ${code}/${signal}: ${output}`));
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
    ledgerFile, tokenLimit, applicationTools: name==='envelope'?acceptanceTools:[], captureDiagnostics: name === 'receipt-io' });
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
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error(`RC07_TIMEOUT_${operation}`)); }, 15000);
    pending.set(id, { resolve(v) { clearTimeout(timer); resolve(v); }, reject(e) { clearTimeout(timer); reject(e); } }); child.send({ id, operation, ...extra });
  });
  return { child, name, dir, exit, request, call,
    async event(kind) {
      const e = events.find(e => e.event === kind); if (e) { events.splice(events.indexOf(e), 1); return e; }
      return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`RC07_EVENT_TIMEOUT_${kind}`)), 180000);
        waiters.push({ kind, resolve(e) { clearTimeout(timer); resolve(e); }, reject(e) { clearTimeout(timer); reject(e); } }); });
    },
    async login() {
      const a = await request('/api/accounts/session', undefined, 'POST', { 'x-gand-bootstrap': '1' }); assert.equal(a.statusCode, 200, 'RC07_MANAGEMENT_LOGIN_FAILED');
      if (a.cookie) transientSecrets.add(a.cookie); if (a.body.csrfToken) transientSecrets.add(a.body.csrfToken);
      const b = await request('/api/accounts/threaded/access-session', undefined, 'POST', { cookie: a.cookie, 'x-gand-csrf': a.body.csrfToken }); assert.equal(b.statusCode, 200, 'RC07_THREADED_LOGIN_FAILED');
      if (b.cookie) transientSecrets.add(b.cookie); if (b.body.csrfToken) transientSecrets.add(b.body.csrfToken);
      return auth = { cookie: b.cookie, 'x-gand-csrf': b.body.csrfToken };
    },
    async kill() { child.kill('SIGKILL'); const r = await exit; assert.equal(r.signal, 'SIGKILL'); return r; },
    async close() { child.kill('SIGTERM'); const result = await deadline(exit,20000,'RC07_SHUTDOWN_TIMEOUT'); assert.equal(result.code, 0); return result; }
  };
}
async function controls(w, admissionOpen, dispatchOpen) {
  const a = await w.request('/api/threaded/release', undefined, 'GET'); assert.equal(a.statusCode, 200);
  const b = await w.request('/api/threaded/release/controls', { expectedVersion: a.body.control.version, requestId: randomUUID(),
    admissionOpen, dispatchOpen, reason: 'Authorized isolated RC07 main-index context acceptance' }); assert.equal(b.statusCode, 200, JSON.stringify(b));
}
async function fresh(name) {
  const w = await start(name); await w.login(); await controls(w, true, false);
  const r = await w.request('/api/threaded/threads', { title: `RC07 ${name}`, clientRequestId: randomUUID() }); assert.equal(r.statusCode, 200, JSON.stringify(r));
  return { w, threadId: r.body.thread?.id ?? r.body.id };
}
async function submit(w, threadId, agentId = 'rc07-api', body = 'Reply exactly RC07_ACK. No tools or reasoning.', activityAllowanceMs = 10000) {
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
  throw new Error('RC07_COMPLETION_TIMEOUT');
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
function manifestFor(f,m,agent='rc07-api'){return f.manifests.find(v=>v.sourceMessageId===m.id&&v.agentId===agent);}
function included(m){return m.items.filter(v=>v.decision==='included').map(v=>v.messageId).sort();}
function assertDelivery(f,m,agent='rc07-api'){
 const manifest=manifestFor(f,m,agent);assert.ok(manifest);const expected=included(manifest);
 const intent=f.sendIntents.find(i=>i.manifest_id===manifest.id);assert.equal(intent.status,'delivered');
 assert.deepEqual(f.deliveries.filter(d=>d.manifest_id===manifest.id).map(d=>d.message_id).sort(),expected);
 const effect=f.effects.find(e=>e.invocationId===manifest.invocationId&&e.generation);
 if(effect)assert.deepEqual(effect.wireMessages.map(v=>v.id).sort(),expected);
 assert.ok(f.cursorFacts.filter(v=>v.kind==='delivery'&&v.binding_id===manifest.bindingId).every(v=>expected.includes(v.message_id)));
 return manifest;
}
async function history(w,threadId,body,extra={}){return w.call('seed-history',{threadId,requestId:randomUUID(),body,...extra});}
try{
 await caseRun('overflow',async()=>{
  const {w,threadId}=await fresh('overflow');const m=await submit(w,threadId,'rc07-api','RC07_OVERSIZED_SOURCE '+('x'.repeat(20000)));
  await controls(w,true,true);await until(w,m.id,f=>!!manifestFor(f,m)&&f.queue.some(q=>q.source_message_id===m.id&&q.state==='blocked'));
  const f=await snapshot(w,m.id,'actual HTTP accepted oversized source; complete immutable manifest blocked before external transport');
  const manifest=manifestFor(f,m);assert.equal(manifest.state,'blocked');assert.equal(manifest.reason,'THREADED_CONTEXT_SOURCE_OVER_BUDGET');
  assert.equal(manifest.items.find(v=>v.messageId===m.id).truncated,false);
  for(const key of ['effects','requests','sendIntents','deliveries','cursorFacts','cursors'])assert.equal(f[key].length,0,key);
  await w.close();
 });
 await caseRun('gaps',async()=>{
  const {w,threadId}=await fresh('gaps');
  const old=await history(w,threadId,'Historical whole item. '+('h'.repeat(2300)));
  const secret=await history(w,threadId,'RC07_PRIVATE_SENTINEL',{visibility:'private',audience:['rc07-api-b']});
  const draft=await history(w,threadId,'RC07_DRAFT_SENTINEL',{state:'draft'});
  const a=await submit(w,threadId,'rc07-api','Ignore filler and reply exactly RC07_ACK. Filler: '+('z'.repeat(2200)));
  await arm(w);await controls(w,true,true);await ready(w,1);const first=await snapshot(w,a.id,'higher source selected while older whole history is deferred and private/draft sequences are filtered');
  const ma=manifestFor(first,a);assert.equal(ma.items.find(v=>v.messageId===old.id).decision,'deferred_budget');
  assert.equal(ma.items.find(v=>v.messageId===secret.id).decision,'denied_acl');assert.equal(ma.items.find(v=>v.messageId===draft.id).decision,'unpublished');
  assert.deepEqual(included(ma),[a.id]);assert.equal(first.effects[0].privateSentinelIncluded,false);assert.equal(first.effects[0].draftSentinelIncluded,false);
  await release(w,[a]);const doneA=await until(w,a.id,f=>complete(f,a));assertDelivery(doneA,a);
  const cursorA=doneA.cursors.find(v=>v.agent_id==='rc07-api'&&v.kind==='delivery');assert.equal(cursorA.max_seq,a.seq);
  assert.ok(!doneA.cursorFacts.some(v=>v.message_id===old.id));
  await controls(w,true,false);const b=await submit(w,threadId);await controls(w,true,true);await ready(w,1);
  const second=await snapshot(w,b.id,'small next source fills exact older hole below existing high delivery cursor');const mb=manifestFor(second,b);
  assert.equal(mb.items.find(v=>v.messageId===old.id).decision,'included');assert.ok(old.seq<cursorA.max_seq);
  const eb=effectFor(second,b);assert.ok(eb.wireMessages.some(v=>v.id===old.id));assert.equal(eb.privateSentinelIncluded,false);assert.equal(eb.draftSentinelIncluded,false);
  await release(w,[b]);const doneB=await until(w,b.id,f=>complete(f,b));assertDelivery(doneB,b);assert.ok(doneB.cursorFacts.some(v=>v.message_id===old.id));
  assert.ok(!doneB.cursorFacts.some(v=>[secret.id,draft.id].includes(v.message_id)));
  await snapshot(w,b.id,'exact delivery ledger contains the supplemented old message, while hidden sequences never advanced exposure');await w.close();
 });
 await caseRun('wave',async()=>{
  const {w,threadId}=await fresh('wave');await w.call('policy',{patch:{globalLimit:1}});await arm(w);
  const r=await w.request(`/api/threaded/threads/${threadId}/messages`,{clientRequestId:randomUUID(),body:'[ideate] Reply exactly RC07_ACK. Do not mention other members.',targets:['rc07-api','rc07-api-b']});
  assert.equal(r.statusCode,200,JSON.stringify(r));const m=(r.body.receipt??r.body).message;await w.call('budget',{messageId:m.id});
  await controls(w,true,true);await ready(w,1);const a=await snapshot(w,m.id,'two members share one frozen wave; capacity deliberately starts A first');
  const firstEffect=a.effects[0],firstAgent=firstEffect.agentId;assert.equal(a.queue.length,2);assert.equal(a.effects.length,1);await release(w,[m]);await ready(w,1);
  const b=await snapshot(w,m.id,'B prepares after A has already published its response');
  const firstInvocation=b.invocations.find(v=>v.agent_id===firstAgent);assert.equal(firstInvocation.status,'completed');
  const answer=b.messages.find(v=>v.source_attempt_id===firstInvocation.current_attempt_id&&v.origin==='agent_response');assert.ok(answer);
  const secondEffect=b.effects.find(v=>v.agentId!==firstAgent);assert.ok(secondEffect);const mb=manifestFor(b,m,secondEffect.agentId);const ma=manifestFor(b,m,firstAgent);
  assert.equal(ma.waveId,mb.waveId);assert.equal(ma.inputMaxSeq,mb.inputMaxSeq);assert.ok(answer.seq>mb.inputMaxSeq);
  assert.ok(!mb.items.some(v=>v.messageId===answer.id));assert.ok(!secondEffect.wireMessages.some(v=>v.id===answer.id));
  await release(w,[m]);const done=await until(w,m.id,f=>f.invocations.length===2&&f.invocations.every(i=>i.status==='completed'));
  assertDelivery(done,m,firstAgent);assertDelivery(done,m,secondEffect.agentId);
  await snapshot(w,m.id,'both real completions retain the original wave boundary, without B absorbing A answer');await w.close();
 });
 await caseRun('cursor',async()=>{
  const {w,threadId}=await fresh('cursor');await history(w,threadId,'RC07 preceding public context');await arm(w);
  const m=await submit(w,threadId);await controls(w,true,true);await ready(w,1);await w.call('cursor-fault',{enabled:true});
  await release(w,[m]);await until(w,m.id,f=>f.requests.some(r=>r.state==='complete')&&f.invocations.some(i=>['failed','unknown'].includes(i.status)));
  const failed=await snapshot(w,m.id,'verified provider receipt retained, while injected SQLite cursor failure rolls back the entire delivery transaction');
  assert.equal(failed.requests.length,1);assert.equal(failed.requests[0].state,'complete');
  for(const key of ['sendReceipts','deliveries','cursorFacts','cursors'])assert.equal(failed[key].length,0,key);
  assert.equal(failed.sendIntents[0].status,'sending');const oldRequest=failed.requests[0];await w.call('cursor-fault',{enabled:false});await w.kill();
  const restarted=await start('cursor',true);await restarted.login();const repaired=await snapshot(restarted,m.id,'new actual index PID repairs only the original exact receipt; no external replay');
  assert.notEqual(repaired.pid,failed.pid);assert.equal(repaired.effects.length,0);assert.deepEqual(repaired.requests,[oldRequest]);assertDelivery(repaired,m);
  const counts={receipts:repaired.sendReceipts.length,deliveries:repaired.deliveries.length,facts:repaired.cursorFacts.length};
  assert.equal((await restarted.call('recover-facts')).contextRepaired,0);const again=await snapshot(restarted,m.id,'duplicate recovery is idempotent and publishes no lost response');
  assert.deepEqual({receipts:again.sendReceipts.length,deliveries:again.deliveries.length,facts:again.cursorFacts.length},counts);
  assert.equal(again.messages.filter(v=>v.origin==='agent_response').length,0);assert.equal(again.effects.length,0);await restarted.close();
 });
 await caseRun('envelope',async()=>{
  const {w,threadId}=await fresh('envelope');const a=await submit(w,threadId);await controls(w,true,true);
  await until(w,a.id,f=>invocationFor(f,a)?.status==='failed');const rejected=await snapshot(w,a.id,'complete tool envelope exceeds 8192 while manifest is ready; no external request or phantom exposure');
  assert.equal(manifestFor(rejected,a).state,'ready');
  for(const key of ['effects','requests','sendIntents','inputIntents','deliveries','cursorFacts'])assert.equal(rejected[key].length,0,key);
  const oldSession=rejected.sessions[0];await w.kill();const packPath=path.join(w.dir,'release.json');const pack=JSON.parse(await readFile(packPath,'utf8'));pack.maxInputTokens=65536;await writeFile(packPath,JSON.stringify(pack));
  const restarted=await start('envelope',true);await restarted.login();await controls(restarted,true,false);const b=await submit(restarted,threadId);await controls(restarted,true,true);
  const done=await until(restarted,b.id,f=>complete(f,b));assertOne(done,b);assertDelivery(done,b);
  assert.equal(done.sessions[0].id,oldSession.id);assert.equal(done.sessions[0].version,oldSession.version);assert.equal(done.requests.length,1);
  await snapshot(restarted,b.id,'same API Session and valid grant run normally after explicit larger pack; rejected prior source was never replayed');await restarted.close();
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
          assert.equal(p.host, hostname()); assert.ok(command.includes('/execution/guardian.mjs') && command.includes(p.token), 'RC07_CLEANUP_OWNERSHIP_UNCONFIRMED');
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
  const result = { ok: failures.length === 0, stage: 'RC07', date: new Date().toISOString(), case: selected, groups: checks.length, checks, failures,
    actualMainIndex: true, entry: 'apps/server/src/index.ts', actualPids: processes, realSupplier: real,
    account: { id: account.id, name: account.display_name, model: JSON.parse(version.connection).defaultModel, endpointHost: new URL(JSON.parse(version.connection).baseUrl).hostname },
    operatorTokenLimit: tokenLimit, priorUsage, usage, priorLedgerRowsUnchanged: true, priorLedgerDigest: hash(priorRows),
    knownTokensThisRun: usage.knownTokens - priorUsage.knownTokens, unknownReserveThisRun: usage.unknownReserve - priorUsage.unknownReserve,
    targetActivityAllowanceMs: 10000, productionDefaultActivityAllowanceMs: 1000, casePoliciesInEvidence: true, dailyConfigurationChanged: false,
    sourceDbReadOnly: real, dailyMessagesRead: false, keyInArgvEnvReports: false, keyTransferredViaPrivateIPC: real,
    limitations: ['Preload seeds synthetic historical messages through the production message port; task sources use authenticated HTTP. These history seeds are not evidence of the UI authoring workflow.',
      'Actual index, production singleton and execution guards run without an isolated execution bypass. A test-only SQLite trigger injects the cursor fault.',
      'The wave test deliberately serializes capacity to exercise B preparation after A publication while preserving one frozen parallel wave.',
      'History-hole live requests use API reconstruction. Native incremental history and compaction are recorded separately, not inferred from API results.',
      'An oversized source is rejected before any supplier call; real-supplier mode does not mean that blocked case called the provider.',
      'Only synthetic roots explicitly select a 10000ms activity slice; production default remains 1000ms.',
      'The envelope test explicitly restarts its isolated pack at 65536 input bytes after a pre-send refusal at 8192; daily release settings are unchanged.'
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

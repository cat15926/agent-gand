import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, writeFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';

const args = process.argv.slice(2), option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const report = path.resolve(option('--report', 'docs/reports/evidence/threaded-rc11/modes.json'));
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-rc11-modes-')));
const children = [], processes = [], checks = [], evidence = [], failures = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const loader = new URL('../apps/server/node_modules/tsx/dist/loader.mjs', import.meta.url).pathname;
const entry = new URL('../apps/server/src/index.ts', import.meta.url).pathname;
const preload = new URL('./fixtures/threadedRc11ModesGuard.mjs', import.meta.url).pathname;
const ephemeralMasterKey = randomBytes(32).toString('hex'), stamp = new Date().toISOString();
const account = {id: 'rc11-synthetic-account', display_name: 'RC11 synthetic only', provider: 'anthropic', auth_type: 'api_key', source: 'managed', enabled: 1, archived: 0, version: 1, config_version: 1, credential_version: 1, identity_generation: null, created_at: stamp, updated_at: stamp};
const version = {account_id: account.id, version: 1, connection: JSON.stringify({baseUrl: 'https://rc11.invalid', protocols: ['anthropic-messages'], defaultModel: 'fixture-model', timeoutMs: 10000}), created_at: stamp};
const member = {agentId: 'rc11-api', backend: 'api', backendVersion: 'threaded-http-v1', model: 'fixture-model', roleVersion: 1, permissionVersion: 1, accountId: account.id, accountConfigVersion: 1, accountCredentialVersion: 1, accountIdentityGeneration: null};
async function bounded(promise, ms, reason) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(reason)), ms); })]); } finally { clearTimeout(timer); } }
async function freePort() { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function start(mode, restore = true) {
  await mkdir(path.join(root, 'agents'), {recursive: true});
  const pack = path.join(root, 'pack.json');
  if (!restore) await writeFile(pack, JSON.stringify({schemaVersion: 1, platform: 'darwin', members: [member], applicationTools: ['hold_ball'], maxOutputTokens: 256, maxInputTokens: 65536, maxRequests: 4}), {mode: 0o600});
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const child = fork(entry, [], {cwd: root, execArgv: ['--import', loader, '--import', preload], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {
    PATH: process.env.PATH, LANG: 'en_US.UTF-8', NODE_ENV: 'test', AGENT_GAND_ISOLATED_WORKER: '1', RC11_MODES_ROOT: root,
    DB_PATH: path.join(root, 'main.sqlite'), AGENTS_DIR: path.join(root, 'agents'), AGENT_GAND_PRIVATE_DIR: path.join(root, 'private'),
    HOST: '127.0.0.1', PORT: String(port), LOG_LEVEL: 'silent', ACCOUNT_TRUSTED_ORIGINS: origin,
    THREADED_COLLABORATION_MODE: mode, THREADED_RELEASE_MEMBERS_FILE: pack,
  }});
  children.push(child); processes.push({mode, restore, pid: child.pid});
  let seq = 0, auth, output = ''; const pending = new Map();
  child.stdout.on('data', data => { output = (output + data).slice(-10000); });
  child.stderr.on('data', data => { output = (output + data).slice(-10000); });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { for (const p of pending.values()) p.reject(new Error(`RC11_INDEX_EXIT_${code}_${signal}`)); pending.clear(); resolve({code, signal}); }); });
  child.on('message', message => { const p = pending.get(message.id); if (!p) return; pending.delete(message.id); message.error ? p.reject(new Error(message.error)) : p.resolve(message.result); });
  child.send({operation: 'initialize', root, restore, account, version, member, ephemeralMasterKey});
  const request = async (url, payload, method = 'POST', headers = auth) => {
    const response = await fetch(origin + url, {method, headers: {origin, ...(payload === undefined ? {} : {'content-type': 'application/json'}), ...headers}, ...(payload === undefined ? {} : {body: JSON.stringify(payload)}), signal: AbortSignal.timeout(10000)});
    return {status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0]};
  };
  let ready = false; const deadline = Date.now() + 30000;
  while (Date.now() < deadline && child.exitCode === null && !child.signalCode) { try { ready = (await request('/api/health', undefined, 'GET')).status === 200; if (ready) break; } catch {} await delay(50); }
  assert.ok(ready, output);
  return {child, request,
    call(operation, extra = {}) { return bounded(new Promise((resolve, reject) => { const id = ++seq; pending.set(id, {resolve, reject}); child.send({id, operation, ...extra}); }), 15000, 'RC11_IPC_TIMEOUT'); },
    async login() { const accountLogin = await request('/api/accounts/session', undefined, 'POST', {'x-gand-bootstrap': '1'}); assert.equal(accountLogin.status, 200); const access = await request('/api/accounts/threaded/access-session', undefined, 'POST', {cookie: accountLogin.cookie, 'x-gand-csrf': accountLogin.body.csrfToken}); assert.equal(access.status, 200); auth = {cookie: access.cookie, 'x-gand-csrf': access.body.csrfToken}; },
    async close() { child.kill('SIGTERM'); const result = await bounded(exit, 20000, 'RC11_SHUTDOWN_TIMEOUT'); assert.equal(result.code, 0, output); },
  };
}
async function controls(server, admissionOpen, dispatchOpen) {
  const prior = await server.request('/api/threaded/release', undefined, 'GET'); assert.equal(prior.status, 200);
  const next = await server.request('/api/threaded/release/controls', {expectedVersion: prior.body.control.version, requestId: randomUUID(), admissionOpen, dispatchOpen, reason: 'RC11 isolated mode rehearsal'});
  assert.equal(next.status, 200, JSON.stringify(next.body));
}
async function until(server, predicate, label) { const deadline = Date.now() + 15000; while (Date.now() < deadline) { const facts = await server.call('facts'); if (predicate(facts)) return facts; await delay(25); } throw new Error(label); }
async function submit(server, threadId, body, clientRequestId = randomUUID()) {
  const request = {clientRequestId, body, targets: [member.agentId]};
  const result = await server.request(`/api/threaded/threads/${threadId}/messages`, request);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const message = (result.body.receipt ?? result.body).message;
  await server.call('budget', {messageId: message.id});
  return {message, request, receipt: result.body};
}
function check(id, description) { checks.push({id, passed: true, description}); }
try {
  const preparation = await start('execute', false); await preparation.login();
  await controls(preparation, true, false);
  const created = await preparation.request('/api/threaded/threads', {title: 'RC11 mode rehearsal', clientRequestId: 'rc11-thread'});
  assert.equal(created.status, 200); const threadId = (created.body.thread ?? created.body).id;
  const timer = await submit(preparation, threadId, 'RC11_TIMER'); await controls(preparation, true, true);
  const timerFacts = await until(preparation, f => f.invocations.some(i => i.causal_root_id === timer.message.id && i.status === 'completed'), 'RC11_TIMER_NOT_COMPLETED');
  assert.equal(timerFacts.waits.length, 1); assert.equal(timerFacts.waits[0].state, 'awaiting');
  await controls(preparation, true, false);
  const unknown = await submit(preparation, threadId, 'RC11_UNKNOWN'); await controls(preparation, true, true);
  const unknownFacts = await until(preparation, f => f.invocations.some(i => i.causal_root_id === unknown.message.id && i.status === 'unknown'), 'RC11_UNKNOWN_NOT_RETAINED');
  assert.ok(unknownFacts.budget.some(row => row.execution_state === 'unknown'));
  await controls(preparation, true, false);
  const queued = await submit(preparation, threadId, 'RC11_QUEUED');
  await controls(preparation, false, false);
  const prepared = await preparation.call('facts'); evidence.push({phase: 'execute-preparation', facts: prepared});
  assert.equal(prepared.deniedEgress, 0); assert.equal(prepared.effects.length, 3); assert.equal(prepared.waits[0].state, 'awaiting');
  assert.equal(prepared.resources.unknownClaims.length, 1); assert.equal(prepared.resources.unknownClaims[0].state, 'unknown');
  await preparation.close();
  check('RC11-M01', 'Actual index with synthetic credentials prepares a grounded timer, an injected unknown request with retained budget and an admitted queued root through authenticated production HTTP; both release controls close before normal shutdown.');

  const observed = await start('observe'); await observed.login();
  const before = await observed.call('facts');
  assert.deepEqual(before.snapshot, prepared.snapshot, 'observe startup must not repair or mutate threaded tables');
  assert.deepEqual(before.resources, prepared.resources, 'observe startup must retain the unknown resource fence and session/ticket facts');
  assert.equal(before.effects.length, 0); assert.equal(before.decryptions, 0);
  for (const route of ['/api/threaded/admission', '/api/threaded/release', '/api/threaded/threads', `/api/threaded/threads/${threadId}`, `/api/threaded/threads/${threadId}/messages`, `/api/threaded/threads/${threadId}/waits?agentId=${member.agentId}`, `/api/threaded/threads/${threadId}/view`]) {
    const read = await observed.request(route, undefined, 'GET'); assert.equal(read.status, 200, route + ': ' + JSON.stringify(read.body));
  }
  const preview = await observed.request(`/api/threaded/threads/${threadId}/routing-preview`, {body: 'Read-only routing preview'}); assert.equal(preview.status, 200);
  check('RC11-M02', 'Observe actual-index restart preserves all threaded table hashes at startup and exposes authenticated history, waits, release snapshots, timeline and pure routing preview without decryption or model transport.');
  const rejected = [];
  for (const [url, payload, method = 'POST'] of [
    ['/api/threaded/threads', {title: 'Forbidden', clientRequestId: 'observe-new'}],
    [`/api/threaded/threads/${threadId}/messages`, {clientRequestId: 'observe-root', body: 'Forbidden'}],
    [`/api/threaded/threads/${threadId}/routing-policy`, {expectedVersion: 1, policy: {preferred: [], defaultAgent: member.agentId}}, 'PUT'],
    [`/api/threaded/threads/${threadId}/controls`, {action: 'stop', requestId: 'observe-stop'}],
    [`/api/threaded/threads/${threadId}/members/${member.agentId}/controls`, {action: 'pause', requestId: 'observe-pause'}],
    [`/api/threaded/threads/${threadId}/invocations/${before.invocations[0].id}/controls`, {action: 'stop', requestId: 'observe-invocation'}],
    [`/api/threaded/threads/${threadId}/approvals/forged/decision`, {decision: 'approve', requestId: 'observe-approval'}],
    [`/api/threaded/threads/${threadId}/decisions/forged/responses`, {expectedVersion: 1, clientRequestId: 'observe-decision', body: 'Forbidden'}],
    ['/api/threaded/release/controls', {expectedVersion: 0, requestId: 'observe-release', admissionOpen: true, dispatchOpen: true, reason: 'Forbidden'}],
  ]) {
    const response = await observed.request(url, payload, method);
    assert.equal(response.status, 403, JSON.stringify(response.body)); assert.equal(response.body.code, 'THREADED_RELEASE_OBSERVE_ONLY');
    rejected.push({method, route: url, status: response.status, code: response.body.code});
  }
  check('RC11-M03', 'All nine authenticated observe mutation categories reject before business changes, including release, message, routing, lifecycle, approval and Decision controls.');
  const remaining = Math.max(0, before.waits[0].deadline - Date.now() + 1200); await delay(remaining);
  assert.ok(Date.now() > before.waits[0].deadline);
  assert.equal((await observed.call('hints')).observed, true); await delay(1250);
  const after = await observed.call('facts');
  assert.deepEqual(after.snapshot, before.snapshot); assert.deepEqual(after.budget, before.budget); assert.deepEqual(after.callbacks, before.callbacks);
  assert.deepEqual(after.resources, before.resources);
  assert.equal(after.waits[0].state, 'awaiting'); assert.equal(after.effects.length, 0); assert.equal(after.deniedEgress, 0); assert.equal(after.decryptions, 0); assert.deepEqual(after.foreignKeys, []);
  const release = await observed.request('/api/threaded/release', undefined, 'GET');
  assert.equal(release.body.drain.ready, false); assert.equal(release.body.drain.scope, 'threaded_only'); assert.equal(release.body.wholeDatabaseRollbackReady, false);
  evidence.push({phase: 'observe', before, after, rejected, release: release.body, actualTimerDeadlinePassed: true}); await observed.close();
  check('RC11-M04', 'A naturally elapsed five-second timer, explicit notification/wakeup/recovery/startDispatch hints and background intervals leave all threaded tables, shared resource tables except availability hints, unknown claim/usage and callbacks unchanged; no credentials decrypt and no transport occurs. Pending work prevents drain-ready.');

  const closed = await start('closed'); await closed.login();
  const closedBefore = await closed.call('facts'); assert.equal(closedBefore.effects.length, 0); assert.equal(closedBefore.decryptions, 0);
  const closedAdmission = await closed.request('/api/threaded/admission', undefined, 'GET'); assert.equal(closedAdmission.body.canCreate, false); assert.equal(closedAdmission.body.configured, true);
  const deniedThread = await closed.request('/api/threaded/threads', {title: 'Closed cannot create', clientRequestId: 'closed-new'});
  assert.equal(deniedThread.status, 403); assert.equal(deniedThread.body.code, 'THREADED_RELEASE_ADMISSION_CLOSED');
  const deniedRoot = await closed.request(`/api/threaded/threads/${threadId}/messages`, {clientRequestId: 'closed-new-root', body: 'Closed cannot admit', targets: [member.agentId]}); assert.equal(deniedRoot.status, 403);
  const replay = await closed.request(`/api/threaded/threads/${threadId}/messages`, queued.request); assert.equal(replay.status, 200); assert.deepEqual(replay.body, queued.receipt);
  check('RC11-M05', 'Closed actual index with retained pack refuses new threaded rooms and roots, while an exact prior admitted-message retry returns its original receipt; dispatch remains explicitly paused and never decrypts credentials.');
  const legacyResults = [];
  for (const mode of ['pipeline', 'supervisor', 'collaboration']) {
    const id = `rc11-legacy-${mode}`, runId = `${id}-run`, roomId = `${id}-room`;
    const room = await closed.request(`/api/conversations/${roomId}`, undefined, 'GET'); assert.equal(room.status, 200); assert.equal(room.body.conversation.mode, mode);
    const renamed = await closed.request(`/api/conversations/${roomId}`, {title: `${mode} RC11 updated`}, 'PATCH'); assert.equal(renamed.status, 200);
    const run = await closed.request(`/api/runs/${runId}`, {title: `${mode} RC11 historical run`}, 'PATCH'); assert.equal(run.status, 200);
    const message = await closed.request('/api/messages', {runId, from: 'user', to: 'all', kind: 'user', body: `${mode} RC11 durable legacy note`}); assert.equal(message.status, 200);
    const messages = await closed.request(`/api/messages?runId=${runId}`, undefined, 'GET'); assert.equal(messages.status, 200); assert.ok(messages.body.some(m => m.id === message.body.id));
    const task = await closed.request('/api/tasks', {title: `${mode} RC11 pending manual task`, runId}); assert.equal(task.status, 200);
    const taskRead = await closed.request(`/api/tasks/${task.body.id}`, undefined, 'GET'); assert.equal(taskRead.status, 200);
    legacyResults.push({mode, roomId, runId, messageId: message.body.id, taskId: task.body.id, readsAndWrites: true});
  }
  const empty = await closed.request('/api/conversations/empty', {title: 'RC11 new legacy empty room', agentIds: [member.agentId]}); assert.equal(empty.status, 201, JSON.stringify(empty.body));
  const hidden = await closed.request(`/api/conversations/${created.body.conversationId ?? created.body.thread?.conversationId}`, undefined, 'GET'); assert.equal(hidden.status, 404);
  await delay(1100); const closedAfter = await closed.call('facts');
  assert.equal(closedAfter.effects.length, 0); assert.equal(closedAfter.deniedEgress, 0); assert.equal(closedAfter.decryptions, 0); assert.deepEqual(closedAfter.foreignKeys, []);
  assert.equal(closedAfter.invocations.find(i => i.causal_root_id === unknown.message.id).status, 'unknown');
  assert.deepEqual(closedAfter.budget.filter(b => b.execution_state === 'unknown'), prepared.budget.filter(b => b.execution_state === 'unknown'));
  evidence.push({phase: 'closed', before: closedBefore, after: closedAfter, admission: closedAdmission.body, legacyResults, deniedThread: deniedThread.body, deniedRoot: deniedRoot.body}); await closed.close();
  check('RC11-M06', 'Closed retains HTTP history reads and durable room/run/message/manual-task writes for pipeline, supervisor and collaboration, plus new empty legacy rooms; threaded conversations remain hidden from legacy routes and unknown budgets remain reserved. This is not legacy model-execution acceptance.');
} catch (error) { failures.push({reason: error.message, stack: error.stack}); }
finally {
  for (const child of children) if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await bounded(new Promise(resolve => child.once('exit', resolve)), 10000, 'RC11_CLEANUP_TIMEOUT').catch(() => {}); }
  const result = {ok: failures.length === 0, stage: 'RC11', date: new Date().toISOString(), groups: checks.length, checks, failures,
    actualMainIndex: true, entry: 'apps/server/src/index.ts', actualPids: processes, realSupplierRequests: 0,
    syntheticCredentialsOnly: true, isolatedExecutionBypass: false, productionCodeChanged: false, dailyDatabaseAccess: false,
    evidence, limitations: [
      'Synthetic isolated database and injected API transport; no daily deployment, database, credential, workspace or supplier accessed.',
      'Observe invariance covers every threaded table; the complete index still performs its normal schema/host/legacy startup work and is not an SQLite read-only process.',
      'Closed legacy acceptance covers historical HTTP reads and durable non-executing writes across three old modes, not real-provider execution or a complete legacy/threaded workload mix.',
      'No RC10 release blocker is waived and no canary or daily enablement is authorized by these isolated checks.',
    ]};
  await mkdir(path.dirname(report), {recursive: true}); await writeFile(report, JSON.stringify(result, null, 2) + '\n');
  if (!failures.length) await rm(root, {recursive: true, force: true});
  console.log(JSON.stringify({ok: result.ok, groups: result.groups, failures: failures.map(f => f.reason), report, ...(failures.length ? {retainedRoot: root} : {})}));
  if (!result.ok) process.exitCode = 1;
}

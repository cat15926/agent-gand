import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, mkdir, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBackendRuntimeFixture } from './fixtures/threadedBackendRuntimeFixture.mjs';

// Real SDK/CLI and owned POSIX guardian processes, synthetic HTTP responses.
// No configured account, credential, business DB or remote supplier is read.
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-rc06-native-')));
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DB_PATH: path.join(root, 'unused-singleton.sqlite'), AGENTS_DIR: path.join(root, 'agents') });
const originalFetch = globalThis.fetch;
let deniedNetwork = 0;
globalThis.fetch = async () => { deniedNetwork++; throw new Error('RC06_REAL_NETWORK_FORBIDDEN'); };
const { nativeSessionResourceKey } = await import('../apps/server/src/execution/resources/sessions.ts');
const { createExecutionResourceCoordinator } = await import('../apps/server/src/execution/resources/coordinator.ts');
const fixtures = [], children = [], checks = [], evidence = [], failures = [], cleanup = [];
const reportArg = process.argv.find(value => value.startsWith('--report='));
const report = path.resolve(reportArg?.slice('--report='.length) ?? 'docs/reports/evidence/threaded-rc06/native.json');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, code, timeout = 60000) {
  const end = Date.now() + timeout;
  do { const value = predicate(); if (value) return value; await delay(30); } while (Date.now() < end);
  throw new Error(code);
}
const groupAlive = pid => execFileSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8', timeout: 1000 })
  .split('\n').some(line => { const [group, status] = line.trim().split(/\s+/); return Number(group) === pid && status && !status.startsWith('Z'); });
function response(body, sequence) {
  const model = body.model, text = 'RC06_NATIVE_ACK';
  if (!body.stream) return new Response(JSON.stringify({ id: `rc06-${sequence}`, type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 4 } }),
  { headers: { 'content-type': 'application/json' } });
  const frames = [
    { type: 'message_start', message: { id: `rc06-${sequence}`, type: 'message', role: 'assistant', model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ];
  return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}
async function make(name, options = {}) {
  const f = await openBackendRuntimeFixture(root, name, options); fixtures.push(f); return f;
}
function revise(f, receipt) {
  const b = f.runtime.budget.ensureRootForMessage(receipt.message.id);
  f.runtime.reviseRoot({ ownerId: b.ownerId, rootId: b.id, expectedVersion: b.version, requestId: randomUUID(),
    reason: 'Isolated RC06 actual native process acceptance', patch: { activityAllowanceMs: 10000 } });
}
function claim(f, receipt) {
  revise(f, receipt); f.runtime.queue.enqueueWake(receipt.wakes[0].id);
  const value = f.runtime.queue.claimNext('rc06-native'); assert.ok(value); return value;
}
function nativeFacts(f) {
  return { processes: f.db.prepare('SELECT token,binding_id,host,pid,state FROM threaded_backend_processes ORDER BY rowid').all(),
    requests: f.db.prepare('SELECT id,binding_id,state,backend,delivered FROM threaded_backend_requests ORDER BY rowid').all(),
    claims: f.db.prepare('SELECT id,generation,state FROM execution_resource_claims ORDER BY rowid').all(),
    sessions: f.db.prepare('SELECT id,version,native_id,resource_key,state FROM execution_resource_sessions ORDER BY rowid').all(),
    terminals: f.db.prepare('SELECT invocation_id,status FROM threaded_invocation_terminals ORDER BY rowid').all(),
    anchors: f.db.prepare('SELECT binding_id,record FROM threaded_session_anchors ORDER BY rowid').all(),
    invocations: f.db.prepare('SELECT id,agent_id,status FROM threaded_invocations ORDER BY rowid').all(),
    outputs: f.db.prepare('SELECT invocation_id,content FROM threaded_outputs ORDER BY rowid').all() };
}
async function worker(databasePath) {
  const child = fork(fileURLToPath(new URL('./fixtures/threadedResourceWorker.mjs', import.meta.url)),
    [databasePath, `rc06:${randomUUID()}`], { execArgv: ['--import', fileURLToPath(new URL('../apps/server/node_modules/tsx/dist/loader.mjs', import.meta.url))],
      env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', PATH: process.env.PATH, AGENT_GAND_ISOLATED_WORKER: '1',
        DB_PATH: path.join(root, 'unused-resource-worker.sqlite'), AGENTS_DIR: path.join(root, 'agents') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.push(child); let sequence = 0, ready; const pending = new Map();
  const started = new Promise(resolve => { ready = resolve; });
  child.on('message', message => {
    if (message.ready) return ready(); const p = pending.get(message.id); if (!p) return;
    pending.delete(message.id); if (message.error) p.reject(new Error(message.error.code ?? message.error.message)); else p.resolve(message.result);
  });
  child.on('error', error => { for (const p of pending.values()) p.reject(error); });
  await Promise.race([started, delay(15000).then(() => { throw new Error('RC06_RESOURCE_WORKER_START_TIMEOUT'); })]);
  return { pid: child.pid, call(operation, ...args) { return new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); child.send({ id, operation, args });
  }); }, async close() { const exited = new Promise(resolve => child.once('exit', resolve)); await this.call('close'); await exited; } };
}
try {
  {
    let f, sequence = 0, releaseB, resumeRelease = false;
    const held = new Map(), calls = [];
    f = await make('cancel-a-continue-b', { agentIds: ['sdk-member', 'sdk-other'], model: 'claude-sonnet-4-5-20250929',
      quote: { maxOutputTokens: 256, estimatedCostMicrousd: 1000, pricingReference: 'fixture-only' },
      connection: { baseUrl: 'https://rc06-native.invalid', headers: {}, timeoutMs: 120000 },
      fetch: async (url, init) => {
        assert.equal(new URL(url).origin, 'https://rc06-native.invalid'); assert.equal(init.method, 'POST');
        const body = JSON.parse(init.body); const n = ++sequence;
        if (new URL(url).pathname.endsWith('/count_tokens')) return new Response('{"input_tokens":20}', { headers: { 'content-type': 'application/json' } });
        const row = f.db.prepare("SELECT r.binding_id,i.agent_id FROM threaded_backend_requests r JOIN threaded_execution_bindings b ON b.id=r.binding_id JOIN threaded_invocations i ON i.id=b.invocation_id WHERE r.state='sending' ORDER BY r.rowid DESC LIMIT 1").get();
        assert.ok(row); calls.push({ sequence: n, ...row, stream: body.stream === true, aborted: false }); const call = calls.at(-1);
        if (!resumeRelease) await new Promise((resolve, reject) => {
          held.set(row.agent_id, true); if (row.agent_id === 'sdk-other') releaseB = resolve;
          const abort = () => { call.aborted = true; reject(new Error('RC06_SYNTHETIC_REQUEST_CANCELLED')); };
          if (init.signal.aborted) abort(); else init.signal.addEventListener('abort', abort, { once: true });
        });
        return response(body, n);
      } });
    const other = f.configurations.get('sdk-other'); Object.assign(other, { kind: 'claude-sdk', backendVersion: '0.3.288' });
    const a = claim(f, f.user('RC06_A: reply exactly RC06_NATIVE_ACK.', ['sdk-member']));
    const b = claim(f, f.user('RC06_B: reply exactly RC06_NATIVE_ACK.', ['sdk-other']));
    const runA = f.runtime.executeClaim(a), runB = f.runtime.executeClaim(b);
    await until(() => held.has('sdk-member') && held.has('sdk-other'), 'RC06_NATIVE_BOTH_REQUESTS_NOT_OBSERVED');
    const active = nativeFacts(f), pa = active.processes.find(p => p.binding_id === a.binding.id), pb = active.processes.find(p => p.binding_id === b.binding.id);
    assert.ok(pa && pb); assert.notEqual(pa.pid, pb.pid); assert.equal(pa.host, hostname()); assert.equal(pb.host, hostname());
    assert.equal(groupAlive(pa.pid), true); assert.equal(groupAlive(pb.pid), true);
    f.runtime.lifecycle.requestControl({ ownerId: f.thread.ownerId, scope: { kind: 'invocation', threadId: f.thread.id, invocationId: a.binding.invocationId },
      action: 'stop', requestId: 'rc06-stop-only-a' });
    const resultA = await runA;
    await until(() => !groupAlive(pa.pid), 'RC06_NATIVE_A_GROUP_STILL_ALIVE', 10000);
    assert.equal(groupAlive(pb.pid), true, 'Stopping A cannot stop B guardian or native child group');
    assert.equal(calls.find(c => c.agent_id === 'sdk-other').aborted, false);
    assert.equal(f.db.prepare('SELECT status FROM threaded_invocations WHERE id=?').get(b.binding.invocationId).status, 'running');
    const afterA = nativeFacts(f); assert.ok(!afterA.outputs.some(o => o.invocation_id === a.binding.invocationId));
    assert.equal(f.resources.getClaim(b.binding.claimId).state, 'started');
    checks.push('Actual SDK guardians run concurrently; stopping A reaps only A POSIX group, B request/scope/resources remain active and A publishes no output');
    evidence.push({ id: 'cancel-a-b-still-active', active, afterA, resultA, calls: structuredClone(calls), aGroupStopped: true, bGroupAlive: true });
    assert.equal(resultA.status, 'unknown'); assert.equal(f.resources.getClaim(a.binding.claimId).state, 'unknown');
    assert.equal(afterA.requests.find(value => value.binding_id === a.binding.id)?.state, 'unknown');
    assert.equal(afterA.processes.find(value => value.binding_id === a.binding.id)?.state, 'verified_stopped');
    assert.ok(!afterA.terminals.some(value => value.invocation_id === a.binding.invocationId));
    assert.equal(calls.find(value => value.agent_id === 'sdk-member').aborted, true);
    checks.push('A process exit is verified but its aborted possible-send request, resource claim and Invocation remain unknown without a fabricated terminal or usage settlement');
    releaseB(); const resultB = await runB;
    assert.equal(resultB.status, 'completed', JSON.stringify(resultB)); assert.equal(f.resources.getClaim(b.binding.claimId).state, 'released');
    await until(() => !groupAlive(pb.pid), 'RC06_NATIVE_B_GROUP_STILL_ALIVE', 10000);
    const first = nativeFacts(f), anchor = first.anchors.find(value => value.binding_id === b.binding.id); assert.ok(anchor, 'Actual SDK checkpoint must create a server-verified resume anchor');
    const native = JSON.parse(anchor.record).session.nativeId;
    assert.ok(first.outputs.some(value => value.invocation_id === b.binding.invocationId && value.content === 'RC06_NATIVE_ACK'));
    checks.push('B completes after A cancellation with exactly its own output and a verified actual SDK checkpoint; B resources release only after quiescence/terminal commit');
    resumeRelease = true;
    const resumed = claim(f, f.user('RC06_B_RESUME: reply exactly RC06_NATIVE_ACK.', ['sdk-other']));
    const preparation = JSON.parse(f.db.prepare('SELECT preparation FROM threaded_wake_queue WHERE invocation_id=?').get(resumed.binding.invocationId).preparation);
    assert.equal(preparation.threadedContext.decision.mode, 'resume');
    const done = await f.runtime.executeClaim(resumed); assert.equal(done.status, 'completed', JSON.stringify(done));
    const after = nativeFacts(f), resumeAnchor = after.anchors.find(value => value.binding_id === resumed.binding.id); assert.ok(resumeAnchor);
    assert.equal(JSON.parse(resumeAnchor.record).session.nativeId, native);
    const manifest = f.db.prepare('SELECT record FROM threaded_context_manifests WHERE binding_id=?').get(resumed.binding.id); assert.ok(manifest);
    assert.equal(after.outputs.filter(o => o.invocation_id === resumed.binding.invocationId).length, 1);
    checks.push('B independently resumes its confirmed native identity after the sibling cancellation; its second terminal/output/anchor occur once');
    evidence.push({ id: 'b-completed-and-resumed', resultB, resumeResult: done, after, calls: structuredClone(calls) });
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  }
  {
    const f = await make('same-native-different-policy', { agentIds: ['sdk-member', 'sdk-other'] });
    const resolvedResources = createExecutionResourceCoordinator(f.db, { ownerNonce: `rc06-resolved:${randomUUID()}`,
      validateRequest() {} });
    const nativeId = randomUUID(), resourceKey = nativeSessionResourceKey({ backend: 'claude-sdk', accountIdentity: `instance:${f.thread.ownerId}`, host: hostname(), nativeId });
    const makeTicket = agentId => {
      const inv = f.runtime.lifecycle.createInvocation({ ownerId: f.thread.ownerId, threadId: f.thread.id, agentId, causalRootId: `rc06-native-lock:${agentId}`, goal: 'Synthetic same native lock contention' });
      const session = { id: `different-policy-${agentId}`, version: 1, nativeId, resourceKey };
      f.db.prepare("INSERT INTO execution_resource_sessions(id,owner_id,binding_key,version,native_id,resource_key,state,record,updated_at) VALUES(?,?,?,?,?,?,'ready',?,?)")
        .run(session.id, f.thread.ownerId, session.id, 1, nativeId, resourceKey, JSON.stringify({ policyMarker: agentId }), Date.now());
      return resolvedResources.enqueue({ requestKey: randomUUID(), operationId: randomUUID(), mode: 'threaded', ownerId: f.thread.ownerId,
        threadId: f.thread.id, agentId, invocationId: inv.id, runId: inv.runId, attemptId: randomUUID(), session,
        capacity: true, workspaces: [{ path: root, access: 'read' }] });
    };
    const ta = makeTicket('sdk-member'), tb = makeTicket('sdk-other');
    const wa = await worker(f.file), wb = await worker(f.file);
    const raced = await Promise.all([wa.call('tryAcquire', ta.id), wb.call('tryAcquire', tb.id)]);
    assert.equal(raced.filter(Boolean).length, 1, 'Different policy rows may not double resume the actual native identity');
    const first = raced.find(Boolean), blockedTicket = first.agentId === ta.request.agentId ? tb : ta;
    assert.equal(await wb.call('tryAcquire', blockedTicket.id), null);
    const proof = await wa.call('recordQuiescence', first, { reason: 'not_started', sideEffects: 'none' }); await wa.call('release', first, proof);
    const next = await wb.call('tryAcquire', blockedTicket.id); assert.ok(next); assert.notEqual(next.claimId, first.claimId);
    const before = await wb.call('getClaim', next.claimId); await wa.call('release', first, proof); const after = await wb.call('getClaim', next.claimId);
    assert.deepEqual(after, before); assert.equal(after.state, 'reserved');
    checks.push('Two independent SQLite worker PIDs race distinct policy rows sharing a canonical native key: only one claim exists and the successor starts after release');
    checks.push('A late old-claim release/finally from a separate process is idempotent and cannot release or alter the new native slot generation');
    evidence.push({ id: 'different-policy-shared-native', workerPids: [wa.pid, wb.pid], nativeId, resourceKey, raced, oldClaim: first,
      oldProof: proof, successorBefore: before, successorAfterLateRelease: after,
      scope: 'Low-level coordinator identity resolver boundary. Deliberately seeded policy records; does not claim production allows duplicate Session preparation.' });
    const nextProof = await wb.call('recordQuiescence', next, { reason: 'not_started', sideEffects: 'none' }); await wb.call('release', next, nextProof);
    await wa.close(); await wb.close();
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  }
  assert.equal(deniedNetwork, 0);
} catch (error) {
  failures.push({ code: /^(?:RC06|THREADED|RESOURCE)_[A-Z0-9_]+$/.test(error.message) ? error.message : 'RC06_NATIVE_ACCEPTANCE_FAILED',
    message: error.message.slice(0, 2000), stack: String(error.stack).split('\n').slice(0, 5) }); process.exitCode = 1;
} finally {
  for (const f of fixtures) {
    try {
      await f.runtime.shutdown(5000);
      for (const p of f.db.prepare('SELECT token,host,pid FROM threaded_backend_processes').all()) {
        if (groupAlive(p.pid)) {
          assert.equal(p.host, hostname()); const command = execFileSync('ps', ['-p', String(p.pid), '-o', 'command='], { encoding: 'utf8' });
          assert.ok(command.includes('/execution/guardian.mjs') && command.includes(p.token), 'RC06_PROCESS_OWNERSHIP_UNCONFIRMED');
          try { process.kill(-p.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
          await delay(600); if (groupAlive(p.pid)) process.kill(-p.pid, 'SIGKILL');
        }
        await until(() => !groupAlive(p.pid), 'RC06_NATIVE_CLEANUP_FAILED', 5000); cleanup.push({ pid: p.pid, stopped: true });
      }
    } catch (error) { failures.push({ code: 'RC06_NATIVE_CLEANUP_FAILED', message: error.message }); process.exitCode = 1; }
    f.close();
  }
  for (const child of children) if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
  const result = { ok: failures.length === 0, stage: 'RC06', date: new Date().toISOString(), groups: checks.length, checks, failures, evidence, cleanup,
    actualSdkVersion: '0.3.288', actualGuardianAndSdkCli: true, transport: 'injected synthetic responses', realSupplierCalls: 0, realModelTokens: 0,
    dailyDatabaseRead: false, dailyConfigurationChanged: false, credentialsRead: false, actualIndexEntry: false, isolatedWorkerBypass: true,
    targetActivityAllowanceMs: 10000, productionDefaultActivityAllowanceMs: 1000, deniedRealNetwork: deniedNetwork,
    limitations: ['Factory composition uses the explicit isolated execution bypass, not index.ts or a daily deployment.',
      'Native processes/SDK checkpoints/cancellation are actual; supplier HTTP and review bodies are synthetic.',
      'An aborted possible-send request remains unknown if no remote receipt exists. Process exit alone never clears unknown usage or execution fences.',
      'The duplicate native identity fixture is a deliberate low-level resolved Session test, not ordinary preparation output.'] };
  await mkdir(path.dirname(report), { recursive: true }); await writeFile(report, JSON.stringify(result, null, 2) + '\n');
  globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: result.ok, groups: checks.length, failures, actualGuardianAndSdkCli: true, realSupplierCalls: 0, report }));
}

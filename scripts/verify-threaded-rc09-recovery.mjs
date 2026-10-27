import assert from 'node:assert/strict';
import { fork, spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openBackendRuntimeFixture } from './fixtures/threadedBackendRuntimeFixture.mjs';

const reportAt = process.argv.indexOf('--report');
const reportFile = path.resolve(reportAt < 0 ? 'docs/reports/evidence/threaded-rc09/recovery.json' : process.argv[reportAt + 1]);
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-rc09-recovery-')));
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DB_PATH: path.join(root, 'unused.sqlite'), AGENTS_DIR: path.join(root, 'agents') });
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('RC09_RECOVERY_NETWORK_FORBIDDEN'); };
const { recoverThreadedBackendFacts } = await import('../apps/server/src/threaded/backendRecovery.ts');
const { verifyThreadedBackendUsage } = await import('../apps/server/src/threaded/backends/evidence.ts');
const { threadedProcessGroupStopped } = await import('../apps/server/src/threaded/backends/sdkProcess.ts');
const fixtures = [], checks = [], workers = [], children = [];
const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const state = f => ({ requests: rows(f.db, 'threaded_budget_requests'), activity: rows(f.db, 'threaded_budget_activity'),
  reconciliations: rows(f.db, 'threaded_budget_reconciliations') });
const immutable = f => sha(Object.fromEntries(['threaded_backend_requests', 'threaded_budget_outcomes', 'threaded_attempts',
  'threaded_outputs', 'threaded_messages', 'execution_resource_claims'].map(t => [t, rows(f.db, t)])));
const check = (id, description, evidence = {}) => checks.push({ id, description, ...evidence });
async function fixture(name, usage, options = {}) {
  const f = await openBackendRuntimeFixture(root, name, { fetch: globalThis.fetch, ...options }); fixtures.push(f);
  const source = f.user(`RC09 isolated ${name}`); f.runtime.queue.enqueueWake(source.wakes[0].id);
  const claim = f.runtime.queue.claimNext('rc09-recovery'); assert.ok(claim);
  f.runtime.lifecycle.startAttempt(claim.binding);
  const authorization = f.runtime.queue.authorizationForBinding(claim.binding);
  f.db.transaction(() => f.runtime.budget.markStartedWithinTransaction(claim.binding, authorization.id)).immediate();
  const receipt = f.runtime.backendEvidence.begin(claim.binding, { kind: 'api', contextManifestId: randomUUID(),
    serializedContext: 'isolated frozen context', model: 'fixture-model', session: { nativeId: null, version: 1, backendVersion: 'fixture' } },
  authorization.id, 'original-request', JSON.stringify({ prompt: 'isolated frozen context' }), true);
  if (usage !== undefined) f.runtime.backendEvidence.complete(receipt.id, { delivered: true, ...usage });
  f.runtime.lifecycle.recoverAll(); f.runtime.budget.recover();
  return Object.assign(f, { source, claim, authorization, receipt });
}
async function worker(f) {
  const child = fork(new URL('./fixtures/threadedRc09RecoveryWorker.mjs', import.meta.url), [], {
    env: { PATH: process.env.PATH, RC09_RECOVERY_ROOT: root },
    execArgv: ['--import', new URL('../apps/server/node_modules/tsx/dist/loader.mjs', import.meta.url).pathname],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let result, stderr = ''; child.stderr.on('data', value => { stderr += value; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  try {
    await new Promise((resolve, reject) => {
      child.on('message', value => { result = value; }); child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 && result ? resolve() : reject(new Error(`RECOVERY_WORKER ${code}/${signal}: ${stderr}`)));
      child.send({ file: f.file });
    });
  } finally { clearTimeout(timer); }
  assert.equal(result.error, undefined); assert.equal(result.networkCalls, 0); assert.deepEqual(result.foreignKeys, []);
  workers.push({ pid: result.pid, exitCode: 0, result: result.result }); return result.result;
}
async function ownedGroup() {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n");setInterval(()=>{},1000)'],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }); children.push(child);
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  return child;
}
async function stopGroup(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise(resolve => child.once('exit', resolve)); process.kill(-child.pid, 'SIGKILL'); await done;
}
let failure;
try {
  {
    const f = await fixture('complete-receipt-race', { inputTokens: 11, outputTokens: 7, costMicrousd: 18 });
    const baselineRef = '52d3cc3', sourcePath = 'apps/server/src/threaded/backendRecovery.ts';
    const baselineSource = execFileSync('git', ['show', `${baselineRef}:${sourcePath}`], { encoding: 'utf8' });
    const baselineFile = path.join(root, 'baseline-backendRecovery.ts');
    const rewritten = baselineSource.replace(/from '(\.\/[^']+)'/g, (_all, relative) =>
      `from '${path.resolve(path.dirname(sourcePath), relative)}'`);
    await writeFile(baselineFile, rewritten);
    const oldRecovery = (await import(pathToFileURL(baselineFile).href)).recoverThreadedBackendFacts;
    const beforeBaseline = sha(state(f)), baselineResult = oldRecovery(f.db, f.runtime.authority);
    assert.equal(sha(state(f)), beforeBaseline); assert.equal(state(f).requests[0].known_output, null);
    const baseline = { ref: baselineRef, sourcePath, sourceSha256: createHash('sha256').update(baselineSource).digest('hex'),
      importedSourceSha256: createHash('sha256').update(rewritten).digest('hex'),
      transformation: 'Only relative static import specifiers rewritten to absolute repository paths; original implementation otherwise unchanged.',
      result: baselineResult, unrepairedBudget: state(f).requests[0], beforeAfterBudgetHash: beforeBaseline };
    const before = immutable(f), settled = await Promise.allSettled([worker(f), worker(f)]);
    for (const item of settled) if (item.status === 'rejected') throw item.reason;
    const results = settled.map(item => item.value);
    assert.equal(results.reduce((n, value) => n + value.requestUsageRepaired, 0), 1);
    assert.equal(immutable(f), before); assert.equal(state(f).reconciliations.length, 1);
    const saved = state(f).requests[0]; assert.equal(saved.execution_state, 'quiescent'); assert.equal(saved.usage_state, 'settled');
    assert.equal(saved.known_output, 7); assert.equal(saved.known_cost, 18);
    assert.equal(f.resources.getClaim(f.claim.binding.claimId).state, 'unknown');
    assert.equal(rows(f.db, 'threaded_attempts')[0].execution_stage, 'unknown');
    assert.equal((await worker(f)).requestUsageRepaired, 0); assert.equal(immutable(f), before);
    check('RC09-REC-01', 'Two new PIDs race to repair the original complete receipt once; repeated recovery retains original outcome, request, binding, resource fence and all message/output facts.',
      { baseline, workerResults: results, budget: saved, beforeAfterImmutableHash: before });
  }
  {
    const results = [];
    for (const [name, value, output, cost] of [['token-only', { outputTokens: 7 }, 7, null],
      ['cost-only', { costMicrousd: 18 }, null, 18], ['neither-known', {}, null, null]]) {
      const f = await fixture(name, value), before = immutable(f), result = await worker(f);
      const saved = state(f).requests[0]; assert.equal(result.requestUsageRepaired, 1);
      assert.equal(saved.known_output, output); assert.equal(saved.known_cost, cost); assert.equal(saved.usage_state, 'unknown');
      assert.equal(saved.execution_state, 'quiescent'); assert.equal(immutable(f), before);
      const usage = f.runtime.budget.getUsage(f.source.message.id);
      assert.equal(usage.outputTokens, output ?? f.authorization.maxOutputTokens);
      assert.equal(usage.costMicrousd, cost ?? f.authorization.reservedCostMicrousd);
      results.push({ name, budget: saved, usage });
    }
    check('RC09-REC-02', 'Output and cost reconcile independently; missing dimensions keep their original reservation, including complete transport receipts with neither dimension known.', { cases: results });
  }
  {
    const f = await fixture('receipt-settlement-rollback', { outputTokens: 8, costMicrousd: 19 });
    f.db.exec("CREATE TRIGGER rc09_reconciliation_failure BEFORE INSERT ON threaded_budget_reconciliations BEGIN SELECT RAISE(ABORT,'rc09_reconciliation_failure'); END");
    const before = sha(state(f)), receiptBefore = immutable(f), failed = await worker(f);
    assert.match(failed.message, /rc09_reconciliation_failure/); assert.equal(sha(state(f)), before); assert.equal(immutable(f), receiptBefore);
    f.db.exec('DROP TRIGGER rc09_reconciliation_failure');
    const repaired = await worker(f); assert.equal(repaired.requestUsageRepaired, 1);
    assert.equal((await worker(f)).requestUsageRepaired, 0); assert.equal(state(f).reconciliations.length, 1);
    check('RC09-REC-03', 'A reconciliation INSERT fault rolls back usage, activity-span closure and receipt key together; removing the fault permits one exact repair from a new PID.',
      { injectedFailure: failed, rollbackHash: before, repaired });
  }
  {
    const f = await fixture('binding-and-conflict', { outputTokens: 7, costMicrousd: 18 });
    const usage = { outputTokens: 7, costMicrousd: 18, evidenceReference: f.receipt.reference }, binding = f.claim.binding;
    const before = sha(state(f));
    for (const patch of [{ id: randomUUID() }, { generation: binding.generation + 1 }, { fencingToken: randomUUID() },
      { ownerId: randomUUID() }, { attemptId: randomUUID() }, { invocationId: randomUUID() }]) {
      assert.equal(verifyThreadedBackendUsage(f.db, { ...binding, ...patch }, f.authorization, usage), false);
      assert.throws(() => f.runtime.budget.settleRequest({ ...binding, ...patch }, f.authorization.id, usage), /BINDING_MISMATCH|AUTHORIZATION_REQUIRED/);
    }
    assert.throws(() => f.runtime.budget.settleRequest(binding, f.authorization.id, { ...usage, outputTokens: 0 }), /USAGE_EVIDENCE_REQUIRED/);
    assert.equal(sha(state(f)), before);
    f.db.prepare('UPDATE threaded_budget_requests SET known_output=9 WHERE id=?').run(f.authorization.id);
    const conflictBefore = sha(state(f)), conflict = await worker(f);
    assert.match(conflict.message, /SETTLEMENT_CONFLICT/); assert.equal(sha(state(f)), conflictBefore);
    check('RC09-REC-04', 'Another binding/generation/fence/owner/Attempt/Invocation and changed usage are rejected; an existing contradictory known amount is retained as a conflict with no partial write.',
      { rejectedBindingVariants: 6, conflict });
  }
  {
    const f = await fixture('unknown-receipt', undefined), before = sha(state(f));
    const first = await worker(f); assert.equal(first.requestUsageRepaired, 0);
    assert.equal(rows(f.db, 'threaded_backend_requests')[0].state, 'unknown');
    assert.equal(sha(state(f)), before); assert.equal((await worker(f)).requestUsageRepaired, 0);
    assert.equal(f.resources.getClaim(f.claim.binding.claimId).state, 'unknown');
    assert.throws(() => f.runtime.backendEvidence.quiescence(f.claim.binding), /QUIESCENCE_UNCONFIRMED/);
    check('RC09-REC-05', 'Interrupted sending becomes unknown without inventing a receipt; repeated recovery keeps token/cost/activity reservations and the resource fence, with no transport replay.');
  }
  {
    const f = await fixture('closed-process-fact', undefined), child = await ownedGroup(), token = randomUUID();
    f.runtime.backendEvidence.registerProcess(f.claim.binding, { token, pid: child.pid });
    await stopGroup(child); f.runtime.backendEvidence.processClosed(token);
    const before = sha(state(f)), result = await worker(f);
    assert.equal(result.processStopsRepaired, 1); assert.equal(rows(f.db, 'threaded_backend_processes')[0].state, 'verified_stopped');
    assert.equal(sha(state(f)), before); assert.equal(f.resources.getClaim(f.claim.binding.claimId).state, 'unknown');
    assert.throws(() => f.runtime.backendEvidence.quiescence(f.claim.binding), /QUIESCENCE_UNCONFIRMED/);
    assert.equal((await worker(f)).processStopsRepaired, 0);
    check('RC09-REC-06', 'A real detached local process group is killed and its trusted close fact is persisted; a different PID verifies only local stopped state, preserving unknown request, budget and claim.',
      { localProcessPid: child.pid, process: rows(f.db, 'threaded_backend_processes')[0], result, sdkGuardian: false });
  }
  {
    const f = await fixture('process-negative-boundaries', undefined), live = await ownedGroup(), dead = await ownedGroup();
    await stopGroup(dead);
    const cases = [ ['live', live.pid, hostname(), true], ['foreign', dead.pid, 'rc09-other-host.invalid', true],
      ['registered', dead.pid, hostname(), false], ['inspection-failure', dead.pid, hostname(), true] ];
    const tokens = {};
    for (const [name, pid, host, closed] of cases) {
      const token = tokens[name] = randomUUID(); f.runtime.backendEvidence.registerProcess(f.claim.binding, { token, pid });
      if (host !== hostname()) f.db.prepare('UPDATE threaded_backend_processes SET host=? WHERE token=?').run(host, token);
      if (closed) f.runtime.backendEvidence.processClosed(token);
    }
    const calls = [], result = recoverThreadedBackendFacts(f.db, f.runtime.authority, { processGroupStopped(pid) {
      calls.push(pid); if (pid === dead.pid) throw new Error('injected ps failure'); return threadedProcessGroupStopped(pid);
    } });
    assert.equal(result.processStopsRepaired, 0); assert.deepEqual(calls.sort(), [live.pid, dead.pid].sort());
    const saved = rows(f.db, 'threaded_backend_processes');
    assert.equal(saved.find(r => r.token === tokens.registered).state, 'registered');
    assert.ok(saved.filter(r => r.token !== tokens.registered).every(r => r.state === 'closed'));
    await stopGroup(live);
    check('RC09-REC-07', 'A live local group, foreign host, missing original close fact and inspection failure all retain their prior process states; foreign/registered records never invoke the local probe.',
      { cases: saved, inspectedPids: calls, sdkGuardian: false });
  }
  {
    const f = await fixture('process-stop-rollback', undefined), child = await ownedGroup(), token = randomUUID();
    f.runtime.backendEvidence.registerProcess(f.claim.binding, { token, pid: child.pid });
    await stopGroup(child); f.runtime.backendEvidence.processClosed(token);
    f.db.exec("CREATE TRIGGER rc09_stop_write_failure BEFORE UPDATE ON threaded_backend_processes WHEN NEW.state='verified_stopped' BEGIN SELECT RAISE(ABORT,'rc09_stop_write_failure'); END");
    const before = sha(rows(f.db, 'threaded_backend_processes')), failed = await worker(f);
    assert.match(failed.message, /rc09_stop_write_failure/); assert.equal(sha(rows(f.db, 'threaded_backend_processes')), before);
    f.db.exec('DROP TRIGGER rc09_stop_write_failure'); assert.equal((await worker(f)).processStopsRepaired, 1);
    let probes = 0;
    assert.throws(() => f.db.transaction(() => recoverThreadedBackendFacts(f.db, f.runtime.authority,
      { processGroupStopped() { probes++; return true; } }))(), /RECOVERY_REQUIRES_OUTERMOST_TRANSACTION/);
    assert.equal(probes, 0);
    check('RC09-REC-08', 'A process-stop write fault does not claim persistence; a new PID retries after repair, and recovery called within a transaction refuses before any process inspection.', { injectedFailure: failed });
  }
  {
    let operatorHookCalls = 0;
    const f = await fixture('runtime-wiring-no-external-ledger', { outputTokens: 3 }, { onRequestSettled() { operatorHookCalls++; throw new Error('must remain independent'); } });
    const result = f.runtime.recover(); assert.equal(result.requestUsageRepaired, 1); assert.equal(operatorHookCalls, 0);
    assert.equal(f.runtime.recover().requestUsageRepaired, 0);
    assert.equal(state(f).requests[0].known_output, 3); assert.equal(state(f).requests[0].known_cost, null);
    check('RC09-REC-09', 'Backend runtime recovery exposes the repair count and does not invoke the separate operator-ledger hook; absent prices remain unknown and the cumulative external ledger requires independent reconciliation.', { result, operatorHookCalls });
  }
  for (const f of fixtures) assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  assert.equal(networkCalls, 0);
} catch (error) { failure = { name: error.name, message: error.message, stack: error.stack }; }
finally {
  for (const child of children) await stopGroup(child);
  for (const f of fixtures) if (f.db.open) f.close();
  globalThis.fetch = originalFetch;
  const report = { status: failure ? 'failed' : 'passed', groups: checks.length, checks, workers,
    workerCount: workers.length, actualLocalProcessGroups: children.map(child => child.pid),
    realProviderRequests: 0, injectedHttpRequests: 0, networkCalls,
    scope: 'Isolated SQLite, manually persisted transport evidence through the production writer, independent recovery PIDs, and actual local process groups. No SDK process/actual index/supplier execution is claimed in this layer.',
    historicalLedgerTouched: false, dailyDatabaseTouched: false, schemaVersion: 35, ...(failure ? { failure } : {}) };
  await mkdir(path.dirname(reportFile), { recursive: true }); await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, groups: checks.length, workerCount: workers.length, report: reportFile, ...(failure ? { failure } : {}) }, null, 2));
  await rm(root, { recursive: true, force: true });
}
if (failure) process.exitCode = 1;

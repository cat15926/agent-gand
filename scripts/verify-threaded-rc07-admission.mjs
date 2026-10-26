import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openBackendRuntimeFixture } from './fixtures/threadedBackendRuntimeFixture.mjs';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-rc07-admission-')));
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DB_PATH: path.join(root, 'unused-singleton.sqlite'), AGENTS_DIR: path.join(root, 'agents') });
const originalFetch = globalThis.fetch;
let unexpectedNetworkCalls = 0;
globalThis.fetch = async () => { unexpectedNetworkCalls++; throw new Error('RC07_ADMISSION_NETWORK_FORBIDDEN'); };
const { THREADED_APPLICATION_TOOL_NAMES } = await import('../apps/server/src/threaded/tools.ts');
const originalBug = process.argv.includes('--expect-original-bug');
const fixtures = [], checks = [];
const count = (db, table) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const response = () => new Response(JSON.stringify({ id: 'injected-response', type: 'message', role: 'assistant',
  content: [{ type: 'text', text: 'admitted response' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 7 } }),
  { status: 200, headers: { 'content-type': 'application/json' } });
const snapshot = f => ({ manifests: f.db.prepare('SELECT record FROM threaded_context_manifests ORDER BY rowid').all()
  .map(value => JSON.parse(value.record)), sendIntents: f.db.prepare('SELECT * FROM threaded_context_send_intents ORDER BY rowid').all(),
  inputIntents: f.db.prepare('SELECT * FROM threaded_session_input_intents ORDER BY seq').all(),
  requests: f.db.prepare('SELECT * FROM threaded_backend_requests ORDER BY rowid').all(),
  cursorFacts: f.db.prepare('SELECT * FROM threaded_context_cursor_facts ORDER BY rowid').all(),
  claims: f.db.prepare('SELECT id,state FROM execution_resource_claims ORDER BY rowid').all() });
async function fixture(name, options = {}) {
  const f = await openBackendRuntimeFixture(root, name, options); fixtures.push(f); return f;
}
async function execute(f, body, targets = ['api-member']) {
  const source = f.user(body, targets); f.runtime.queue.enqueueWake(source.wakes[0].id);
  const claim = f.runtime.queue.claimNext('rc07-admission'); assert.ok(claim);
  const result = await f.runtime.executeClaim(claim); return { source, claim, result };
}
function unexposed(f, execution) {
  assert.equal(execution.result.status, 'failed');
  assert.equal(f.resources.getClaim(execution.claim.binding.claimId).state, 'released');
  for (const table of ['threaded_context_send_intents', 'threaded_session_input_intents', 'threaded_backend_requests',
    'threaded_context_cursor_facts']) assert.equal(count(f.db, table), 0, `${table} must remain absent before any API transport`);
  assert.equal(f.runtime.budget.getUsage(execution.source.message.id).actualRequests, 0);
}
try {
  {
    let calls = 0;
    const f = await fixture('api-envelope-overflow', { applicationTools: THREADED_APPLICATION_TOOL_NAMES,
      fetch: async () => { calls++; return response(); } });
    const cfg = f.configurations.get('api-member'); cfg.contextBudget = { maxInputTokens: 8192, reservedSystemTokens: 4096 };
    const first = await execute(f, 'small source');
    const before = snapshot(f); assert.equal(before.manifests[0].state, 'ready'); assert.equal(calls, 0);
    const repaired = f.runtime.recover();
    if (originalBug) {
      assert.equal(first.result.status, 'failed'); assert.equal(before.sendIntents[0].status, 'sending');
      assert.equal(before.inputIntents.length, 1); assert.equal(repaired.contextRepaired, 0);
      assert.equal(before.requests.length, 0); assert.equal(before.cursorFacts.length, 0);
    } else { unexposed(f, first); assert.equal(repaired.contextRepaired, 0); }
    const firstSession = before.manifests[0].session;
    // Recreate both runtime and SQLite connection, retaining the operator-selected
    // configuration map. Only the request ceiling changes; Session policy does not.
    cfg.contextBudget.maxInputTokens = 100_000; f.reopen();
    const second = await execute(f, 'a later authorized source after increasing the input ceiling');
    const after = snapshot(f);
    if (originalBug) { assert.equal(second.result.status, 'unknown'); assert.equal(calls, 0); }
    else {
      assert.equal(second.result.status, 'completed'); assert.equal(calls, 1);
      assert.equal(after.sendIntents.length, 1); assert.equal(after.sendIntents[0].status, 'delivered');
      assert.equal(after.sendIntents[0].binding_id, second.claim.binding.id);
      assert.deepEqual(after.manifests.at(-1).session, firstSession);
    }
    checks.push({ id: 'ADM-RC07-01', description: originalBug
      ? 'Reproduced: rejected API envelope leaves sending/possible exposure; a later larger-budget request becomes unknown without fetch.'
      : 'A ready manifest whose real API envelope exceeds the ceiling emits no bytes or exposure; a new SQLite/runtime instance accepts the later source under a larger ceiling and the same Session.',
    injectedFetchCalls: calls, first: first.result, second: second.result, before, after, repaired });
  }
  if (!originalBug) {
    {
      let calls = 0, rejectReservation = true;
      const f = await fixture('operator-cap-reject', { fetch: async () => { calls++; return response(); },
        onRequestReserved() { if (rejectReservation) throw new Error('RC07_OPERATOR_CAP_REJECTED'); } });
      const first = await execute(f, 'operator cap denies before transport'); unexposed(f, first); assert.equal(calls, 0);
      const before = snapshot(f); rejectReservation = false;
      const second = await execute(f, 'operator cap now admits a new request');
      assert.equal(second.result.status, 'completed'); assert.equal(calls, 1);
      checks.push({ id: 'ADM-RC07-02', description: 'Operator admission refusal rolls back all API possible exposure; a later allowed request succeeds without an unresolved context barrier.',
        injectedFetchCalls: calls, first: first.result, second: second.result, before, after: snapshot(f) });
    }
    {
      let calls = 0;
      const f = await fixture('receipt-transaction-rollback', { fetch: async () => { calls++; return response(); } });
      f.db.exec("CREATE TRIGGER rc07_backend_receipt_failure BEFORE INSERT ON threaded_backend_requests BEGIN SELECT RAISE(ABORT,'rc07_backend_receipt_failure'); END");
      const first = await execute(f, 'receipt insert fails after API request begin'); unexposed(f, first); assert.equal(calls, 0);
      const before = snapshot(f); f.db.exec('DROP TRIGGER rc07_backend_receipt_failure');
      const second = await execute(f, 'the next admitted request has a real durable intent');
      assert.equal(second.result.status, 'completed'); assert.equal(calls, 1);
      const after = snapshot(f); assert.equal(after.sendIntents.length, 1);
      assert.equal(after.requests[0].binding_id, after.sendIntents[0].binding_id);
      assert.equal(after.sendIntents[0].status, 'delivered'); assert.ok(after.cursorFacts.length > 0);
      checks.push({ id: 'ADM-RC07-03', description: 'An outer backend-receipt insertion failure rolls back the inner API input/send records and request-start budget; the successor uses only committed intent identity.',
        injectedFetchCalls: calls, first: first.result, second: second.result, before, after });
    }
    {
      let calls = 0;
      const f = await fixture('sent-unknown-retained', { fetch: async () => { calls++; throw new Error('RC07_TRANSPORT_OUTCOME_UNKNOWN'); } });
      const execution = await execute(f, 'request crossed the injected transport boundary');
      assert.equal(execution.result.status, 'unknown'); assert.equal(calls, 1);
      const before = snapshot(f); assert.equal(before.sendIntents[0].status, 'unknown');
      assert.equal(before.requests[0].state, 'unknown'); assert.equal(before.inputIntents.length, 1);
      assert.equal(before.cursorFacts.length, 0); assert.equal(f.resources.getClaim(execution.claim.binding.claimId).state, 'unknown');
      const repaired = f.runtime.recover(); const after = snapshot(f);
      assert.deepEqual(after.sendIntents, before.sendIntents); assert.deepEqual(after.requests, before.requests);
      const later = f.user('unknown does not authorize another request'); f.runtime.queue.enqueueWake(later.wakes[0].id);
      assert.equal(f.runtime.queue.claimNext('must-not-repeat-unknown'), null); assert.equal(calls, 1);
      checks.push({ id: 'ADM-RC07-04', description: 'A request that reaches the injected transport then loses confirmation retains unknown request/input/claim across recovery and blocks a successor; no uncertainty is cleared by the API admission fix.',
        injectedFetchCalls: calls, result: execution.result, before, after, repaired });
    }
    {
      let calls = 0, nativeStarts = 0; const localSnapshots = [];
      const f = await fixture('sdk-local-exposure-before-http', { fetch: async () => { calls++; return response(); },
        sdkProcess: async input => {
          nativeStarts++;
          const saved = snapshot(f); localSnapshots.push(saved);
          assert.equal(saved.inputIntents.length, nativeStarts);
          assert.equal(saved.sendIntents.length, nativeStarts);
          assert.equal(saved.requests.length, 0); assert.ok(input.prompt.includes('local SDK prompt'));
          throw new Error('RC07_INJECTED_NATIVE_PORT_AFTER_PROMPT');
        } });
      const first = await execute(f, 'local SDK prompt received before any HTTP', ['sdk-member']);
      assert.equal(first.result.status, 'failed'); assert.equal(nativeStarts, 1); assert.equal(calls, 0);
      const firstSession = localSnapshots[0].manifests.at(-1).session;
      const second = await execute(f, 'new local SDK prompt needs a fresh identity', ['sdk-member']);
      assert.equal(second.result.status, 'failed'); assert.equal(nativeStarts, 2); assert.equal(calls, 0);
      assert.notEqual(localSnapshots[1].manifests.at(-1).session.nativeId, firstSession.nativeId);
      assert.equal(localSnapshots[0].sendIntents[0].status, 'sending');
      checks.push({ id: 'ADM-RC07-05', description: 'The injected SDK port sees persisted possible exposure before accepting its local prompt, even with zero HTTP; lack of a terminal anchor forces the next native identity cold.',
        injectedFetchCalls: calls, injectedNativeStarts: nativeStarts, localSnapshots,
        limitation: 'An injected SDK process port is used; this does not claim a real native process or supplier.' });
    }
  }
  for (const f of fixtures) assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  assert.equal(unexpectedNetworkCalls, 0);
  const source = await readFile(new URL('../apps/server/src/threaded/backendRuntime.ts', import.meta.url));
  const report = { status: originalBug ? 'reproduced_before_fix' : 'passed', groups: checks.length,
    sourceSha256: createHash('sha256').update(source).digest('hex'), scope: 'Production BackendRuntime factory and SQLite with injected HTTP/native process port',
    supplierCalls: 0, nativeProcesses: 0, tokens: 0, dailyDatabaseReads: 0, unexpectedNetworkCalls, checks };
  const output = process.env.THREADED_RC07_ADMISSION_OUTPUT;
  if (output) { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`); }
  console.log(JSON.stringify({ ...report, checks: checks.map(({ id, description }) => ({ id, description })) }, null, 2));
} finally {
  for (const f of fixtures) if (f.db.open) f.close();
  globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true });
}

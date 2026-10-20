import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openBackendRuntimeFixture } from './fixtures/threadedBackendRuntimeFixture.mjs';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-threaded-t07-runtime-')));
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DB_PATH: path.join(root, 'unused-singleton.sqlite'), AGENTS_DIR: path.join(root, 'agents') });
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Unexpected real network call'); };
const fixtures = [], checks = [];
const count = (db, table) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const response = text => new Response(JSON.stringify({ id: 'fixture-response', type: 'message', role: 'assistant',
  content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 7 } }),
  { status: 200, headers: { 'content-type': 'application/json' } });
async function fixture(name, fetch, options = {}) {
  const f = await openBackendRuntimeFixture(root, name, { fetch, ...options }); fixtures.push(f); return f;
}
async function execute(f, receipt) {
  f.runtime.queue.enqueueWake(receipt.wakes[0].id);
  const claim = f.runtime.queue.claimNext('t07-composition'); assert.ok(claim);
  return { claim, result: await f.runtime.executeClaim(claim) };
}
try {
  {
    const sent = [];
    const f = await fixture('api-manifest', async (_url, init) => { sent.push(JSON.parse(init.body)); return response('known final'); });
    const own = f.user('private authorized token', ['api-member'], { visibility: 'private', audience: ['api-member'] });
    f.user('not for api', ['other-member'], { visibility: 'private', audience: ['other-member'] });
    const { claim, result } = await execute(f, own);
    assert.equal(result.status, 'completed'); assert.equal(sent.length, 1);
    const wire = JSON.stringify(sent[0]); assert.ok(wire.includes('private authorized token')); assert.ok(!wire.includes('not for api'));
    assert.equal(count(f.db, 'threaded_backend_requests'), 1);
    assert.equal(count(f.db, 'threaded_context_manifests'), 1);
    assert.equal(f.resources.getClaim(claim.binding.claimId).state, 'released');
    const usage = f.runtime.budget.getUsage(own.message.id);
    assert.equal(usage.actualRequests, 1); assert.equal(usage.outputTokens, 7);
    assert.equal(usage.activityReservedMs, 0); assert.equal(usage.unknownRequests, 0);
    const cursor = f.db.prepare("SELECT kind,max_seq FROM threaded_context_cursors ORDER BY kind").all();
    assert.deepEqual(cursor, [{ kind: 'delivery', max_seq: own.message.seq }]);
    assert.equal(count(f.db, 'threaded_session_input_intents'), 1);
    checks.push('One actual API request uses the canonical ACL-filtered frozen manifest, real receipt verifiers, request budget and delivery cursor; seen/mention remain absent and capacity releases only after terminal commit');
  }
  {
    let calls = 0;
    const f = await fixture('input-blocked', async () => { calls++; return response('must not run'); });
    const receipt = f.user('source too large for this manifest');
    const cfg = f.configurations.get('api-member'); cfg.contextBudget = { maxInputTokens: 64, reservedSystemTokens: 40 };
    const { claim, result } = await execute(f, receipt);
    assert.equal(result.status, 'waiting'); assert.ok(result.contextBlocked);
    assert.equal(calls, 0); assert.equal(count(f.db, 'threaded_backend_requests'), 0);
    assert.equal(f.resources.getClaim(claim.binding.claimId).state, 'released');
    assert.equal(f.runtime.budget.getUsage(receipt.message.id).actualRequests, 0);
    assert.equal(f.runtime.queue.claimNext('blocked-does-not-spin'), null);
    checks.push('A blocked input manifest parks the original Invocation, proves no send, refunds unused request quota and releases capacity without spinning through Attempts');
  }
  {
    let calls = 0;
    const f = await fixture('failed-transport', async () => { calls++; throw new Error('connection outcome unknown'); });
    const { claim, result } = await execute(f, f.user('uncertain request'));
    assert.equal(result.status, 'unknown'); assert.equal(calls, 1);
    assert.equal(f.resources.getClaim(claim.binding.claimId).state, 'unknown');
    assert.equal(f.runtime.queue.claimNext('never-repeat'), null);
    assert.equal(count(f.db, 'threaded_context_deliveries'), 0);
    assert.equal(f.runtime.budget.getUsage(claim.queue.causalRootId).unknownRequests, 1);
    checks.push('A rejected actual transport preserves unknown process/request/context evidence and cannot release or replay its source');
  }
  {
    let calls = 0;
    const f = await fixture('delivery-repair', async () => { calls++; return response('durable response'); });
    f.db.exec(`CREATE TRIGGER fixture_cursor_fault BEFORE INSERT ON threaded_context_cursors
      BEGIN SELECT RAISE(ABORT,'fixture_cursor_fault'); END;`);
    const { result } = await execute(f, f.user('persist delivery evidence before a cursor fault'));
    assert.equal(calls, 1); assert.equal(result.status, 'failed');
    assert.equal(count(f.db, 'threaded_context_deliveries'), 0);
    assert.equal(f.db.prepare("SELECT state FROM threaded_backend_requests").get().state, 'complete');
    f.db.exec('DROP TRIGGER fixture_cursor_fault');
    f.runtime.recover();
    assert.equal(count(f.db, 'threaded_context_deliveries'), 1);
    assert.equal(f.runtime.context.listPendingSends().length, 0);
    const before = count(f.db, 'threaded_context_send_receipts'); f.runtime.recover();
    assert.equal(count(f.db, 'threaded_context_send_receipts'), before); assert.equal(calls, 1);
    checks.push('A cursor-write failure is repaired from the exact durable backend receipt after terminal commit; repeated recovery adds no delivery and performs no second model call');
  }
  {
    let release;
    const f = await fixture('global-token-cap', async () => response('first only'));
    const receipt = f.user('do not exceed operator acceptance budget');
    f.runtime.close();
    const { createThreadedBackendRuntime } = await import('../apps/server/src/threaded/backendRuntime.ts');
    const runtime = createThreadedBackendRuntime(f.db, { resources: f.resources,
      resolveAgent: scope => f.configurations.get(scope.agentId), fetch: async () => { release = true; return response('must not send'); },
      onRequestReserved() { throw new Error('operator_token_cap'); }, dispatchEnabled: false, autoStart: false, repairIntervalMs: 0 });
    runtime.queue.enqueueWake(receipt.wakes[0].id); const claim = runtime.queue.claimNext('token-gate');
    const result = await runtime.executeClaim(claim);
    assert.equal(release, undefined); assert.equal(result.status, 'failed');
    assert.equal(runtime.budget.getUsage(receipt.message.id).actualRequests, 0);
    assert.equal(count(f.db, 'threaded_backend_requests'), 0); runtime.close();
    checks.push('The operator acceptance token cap runs inside request admission before transport or actual-request start, so quota refusal cannot emit provider bytes');
  }
  {
    const stamp = new Date().toISOString();
    const account = { id: 'fixture-anthropic-account', rows: { accounts: [{ id: 'fixture-anthropic-account',
      display_name: 'Fixture', provider: 'anthropic', auth_type: 'api_key', source: 'managed',
      enabled: 1, archived: 0, version: 1, config_version: 1, credential_version: 1,
      created_at: stamp, updated_at: stamp }] } };
    const f = await fixture('provider-api-capacity', async () => response('one provider slot'), { account });
    f.resources.configurePolicy(f.thread.ownerId, { globalLimit: 6, threadLimit: 6, accountLimit: 6,
      providerLimits: { anthropic: 1 } }, 1);
    const a = f.user('first provider slot', ['api-member']), b = f.user('second provider slot', ['other-member']);
    f.runtime.queue.enqueueWake(a.wakes[0].id); f.runtime.queue.enqueueWake(b.wakes[0].id);
    const first = f.runtime.queue.claimNext('provider-a'); assert.ok(first);
    assert.equal(f.resources.getClaim(first.binding.claimId).request.providerKey, 'anthropic');
    assert.equal(f.runtime.queue.claimNext('provider-b-blocked'), null);
    assert.equal((await f.runtime.executeClaim(first)).status, 'completed');
    const second = f.runtime.queue.claimNext('provider-b-released'); assert.ok(second);
    assert.equal((await f.runtime.executeClaim(second)).status, 'completed');

    const mixed = await fixture('provider-mixed-capacity', async () => response('after legacy'), { account });
    mixed.resources.configurePolicy(mixed.thread.ownerId, { globalLimit: 6, threadLimit: 6, accountLimit: 6,
      providerLimits: { anthropic: 1 } }, 1);
    mixed.db.prepare("INSERT INTO runs(id,goal,mode,status,agent_ids,created_at) VALUES('legacy-provider-run','fixture','collaboration','running',?,?)")
      .run(JSON.stringify(['other-member']), stamp);
    const ticket = mixed.resources.enqueue({ requestKey: 'legacy-api-provider', operationId: 'legacy-api-provider',
      mode: 'legacy', ownerId: mixed.thread.ownerId, agentId: 'other-member', runId: 'legacy-provider-run',
      attemptId: 'legacy-provider-attempt', accountId: account.id, providerKey: 'anthropic' });
    const legacy = mixed.resources.tryAcquire(ticket.id); assert.ok(legacy);
    mixed.runtime.queue.enqueueWake(mixed.user('wait for the existing legacy provider slot').wakes[0].id);
    assert.equal(mixed.runtime.queue.claimNext('mixed-provider-blocked'), null);
    mixed.resources.release(legacy, mixed.resources.recordQuiescence(legacy, { reason: 'not_started', sideEffects: 'none' }));
    const admitted = mixed.runtime.queue.claimNext('mixed-provider-released'); assert.ok(admitted);
    assert.equal((await mixed.runtime.executeClaim(admitted)).status, 'completed');
    checks.push('The trusted account provider cap limits two API members and mixed legacy/new calls even when global, Thread and account capacities allow more');
  }
  {
    let turns = 0;
    const f = await fixture('sdk-compaction-continuity', async () => response('SDK fixture HTTP'), {
      sdkProcess: async input => {
        turns++;
        input.onRecord({ type: 'system', subtype: 'init', session_id: input.nativeId, tools: [] });
        if (turns === 1) input.onRecord({ type: 'system', subtype: 'compact_boundary', session_id: input.nativeId,
          uuid: 'verified-fixture-compaction' });
        const result = await originalFetch(`${input.environment.ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': input.environment.ANTHROPIC_API_KEY },
          body: JSON.stringify({ model: input.model, max_tokens: input.maxOutputTokens,
            messages: [{ role: 'user', content: input.prompt }] }) });
        assert.equal(result.status, 200); await result.text();
        input.onRecord({ type: 'threaded_checkpoint', sessionId: input.nativeId,
          anchorUuid: randomUUID(), inputUserUuid: randomUUID() });
        input.onRecord({ type: 'result', subtype: 'success', session_id: input.nativeId, uuid: randomUUID(), result: 'fixture final' });
      },
    });
    const first = await execute(f, f.user('compact first', ['sdk-member']));
    assert.equal(first.result.status, 'completed');
    const firstAnchor = JSON.parse(f.db.prepare('SELECT record FROM threaded_session_anchors ORDER BY rowid DESC LIMIT 1').get().record);
    assert.equal(firstAnchor.evidence.compactionBoundary, 'verified-fixture-compaction');
    const second = await execute(f, f.user('resume without another compact', ['sdk-member']));
    assert.equal(second.result.status, 'completed');
    const secondAnchor = JSON.parse(f.db.prepare('SELECT record FROM threaded_session_anchors ORDER BY rowid DESC LIMIT 1').get().record);
    assert.equal(secondAnchor.session.nativeId, firstAnchor.session.nativeId);
    assert.equal(secondAnchor.evidence.compactionBoundary, firstAnchor.evidence.compactionBoundary);
    f.db.exec(`CREATE TRIGGER fixture_anchor_fault BEFORE INSERT ON threaded_session_anchors
      BEGIN SELECT RAISE(ABORT,'fixture_anchor_fault'); END;`);
    const failed = await execute(f, f.user('verified quiet but anchor write fails', ['sdk-member']));
    assert.equal(failed.result.status, 'failed');
    assert.equal(f.resources.getClaim(failed.claim.binding.claimId).state, 'released');
    assert.equal(f.runtime.budget.getUsage(failed.claim.queue.causalRootId).unknownRequests, 0);
    f.db.exec('DROP TRIGGER fixture_anchor_fault');
    const fourth = await execute(f, f.user('cold after missing recovery anchor', ['sdk-member']));
    assert.equal(fourth.result.status, 'completed');
    const lastAnchor = JSON.parse(f.db.prepare('SELECT record FROM threaded_session_anchors ORDER BY rowid DESC LIMIT 1').get().record);
    assert.notEqual(lastAnchor.session.nativeId, firstAnchor.session.nativeId);
    assert.equal(lastAnchor.evidence.compactionBoundary, undefined);
    checks.push('A verified compaction boundary survives a resumed Invocation with no new compact; anchor persistence failure preserves known quiescence and forces the next native identity cold');
  }
  for (const f of fixtures) assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  console.log(JSON.stringify({ ok: true, groups: checks.length, checks, realModelCalls: 0, externalCalls: 0,
    scope: 'Isolated SQLite and injected HTTP; SDK continuity uses real loopback with an injected process port, no native process proof claim' }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  for (const f of fixtures) if (f.db.open) f.close();
  await rm(root, { recursive: true, force: true });
}

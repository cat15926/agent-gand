import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { openBackendRuntimeFixture } from './fixtures/threadedBackendRuntimeFixture.mjs';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-t12-activity-')));
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DB_PATH: path.join(root, 'unused.sqlite'), AGENTS_DIR: path.join(root, 'agents') });
const nativeFetch = globalThis.fetch; let forbiddenNetwork = 0;
globalThis.fetch = async () => { forbiddenNetwork++; throw new Error('External network forbidden'); };
const fixtures = [], checks = [];
const encoder = new TextEncoder();
function finalFrames() {
  return [{ type: 'message_start', message: { id: randomUUID(), usage: { input_tokens: 20 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'heartbeat-completed' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
    { type: 'message_stop' }].map(value => `data: ${JSON.stringify(value)}\n\n`).join('');
}
async function fixture(name, options = {}) {
  let clock = Date.now() + 60_000, f, chunks = 0, validationArmed = false, validationCostInjected = false;
  f = await openBackendRuntimeFixture(root, name, { now: () => clock,
    fetch: async () => {
      validationArmed = true;
      if (options.expiredGap) clock += 1001;
      let sent = false;
      return new Response(new ReadableStream({ pull(controller) {
        if (chunks++ < 18) { clock += 200;
          if (options.revoke && chunks === 4) f.db.prepare("UPDATE threaded_members SET permission_version=permission_version+1,version=version+1 WHERE thread_id=? AND agent_id='api-member'").run(f.thread.id);
          controller.enqueue(encoder.encode(': verified transport progress\n\n'));
        } else if (!sent) { sent = true; controller.enqueue(encoder.encode(finalFrames())); }
        else controller.close();
      } }), { headers: { 'content-type': 'text/event-stream' } });
    }, sdkProcess: async input => {
      input.onRecord({ type: 'system', subtype: 'init', session_id: input.nativeId, tools: [] });
      const response = await nativeFetch(`${input.environment.ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': input.environment.ANTHROPIC_API_KEY },
        body: JSON.stringify({ model: input.model, max_tokens: input.maxOutputTokens,
          messages: [{ role: 'user', content: input.prompt }] }) });
      assert.equal(response.status, 200); await response.text();
      input.onRecord({ type: 'threaded_checkpoint', sessionId: input.nativeId, anchorUuid: randomUUID(), inputUserUuid: randomUUID() });
      input.onRecord({ type: 'result', subtype: 'success', session_id: input.nativeId, uuid: randomUUID(), result: 'heartbeat-completed' });
    } });
  const getConfiguration = f.configurations.get.bind(f.configurations);
  f.configurations.get = key => {
    if (options.slowAuthorization && validationArmed && !validationCostInjected) { clock += 600; validationCostInjected = true; }
    return getConfiguration(key);
  };
  fixtures.push(f); const member = options.sdk ? 'sdk-member' : 'api-member';
  const receipt = f.user(name, [member]), budget = f.runtime.budget.ensureRootForMessage(receipt.message.id);
  if (options.hardCap) f.runtime.reviseRoot({ ownerId: f.thread.ownerId, rootId: budget.id, expectedVersion: budget.version,
    requestId: randomUUID(), reason: 'Synthetic hard activity bound', patch: { maxActivityMs: 1400 } });
  const claim = f.runtime.queue.claimNext('activity-regression'); assert.ok(claim);
  const startedClock = clock, result = await f.runtime.executeClaim(claim);
  return { f, receipt, claim, result, elapsed: clock - startedClock, validationCostInjected,
    policy: f.runtime.budget.getRoot(receipt.message.id).policy,
    usage: f.runtime.budget.getUsage(receipt.message.id) };
}
try {
  for (const sdk of [false, true]) {
    const value = await fixture(sdk ? 'sdk-buffered-progress' : 'api-buffered-progress', { sdk });
    assert.equal(value.result.status, 'completed', JSON.stringify({ result: value.result, elapsed: value.elapsed,
      attempt: value.f.db.prepare('SELECT execution_reason FROM threaded_attempts').get() }));
    assert.ok(value.elapsed > 3000); assert.equal(value.policy.activityAllowanceMs, 1000);
    assert.equal(value.policy.maxActivityMs, 30 * 60_000); assert.equal(value.usage.actualRequests, 1);
    assert.equal(value.usage.activityReservedMs, 0); assert.equal(value.usage.unknownRequests, 0);
    assert.ok(value.usage.activityMs >= 3600); assert.equal(value.f.resources.getClaim(value.claim.binding.claimId).state, 'released');
    checks.push(`${sdk ? 'SDK relay' : 'API'}: buffered SSE microtasks span multiple unchanged 1000ms allowances; trusted progress renews the same Attempt/request and charges all elapsed activity.`);
  }
  {
    const value = await fixture('slow-authorization-before-effect', { slowAuthorization: true });
    assert.equal(value.result.status, 'completed'); assert.equal(value.validationCostInjected, true);
    assert.equal(value.policy.activityAllowanceMs, 1000); assert.ok(value.elapsed >= 4200);
    assert.equal(value.usage.actualRequests, 1); assert.equal(value.usage.activityReservedMs, 0);
    checks.push('A trusted full configuration/context validation taking 600ms does not consume the preceding allowance before atomic renewal; full effect authorization still runs.');
  }
  for (const [name, options] of [['expired-gap', { expiredGap: true }], ['hard-cap', { hardCap: true }], ['revoked-permission', { revoke: true }]]) {
    const value = await fixture(name, options);
    assert.equal(value.result.status, 'unknown', JSON.stringify(value.result)); assert.equal(value.policy.activityAllowanceMs, 1000);
    assert.equal(value.f.db.prepare("SELECT COUNT(*) n FROM threaded_messages WHERE origin='agent_response'").get().n, 0);
    assert.equal(value.f.resources.getClaim(value.claim.binding.claimId).state, 'unknown');
    assert.equal(value.usage.actualRequests, 1); assert.equal(value.usage.unknownRequests, 1);
    const requests = value.f.db.prepare('SELECT COUNT(*) n FROM threaded_backend_requests').get().n;
    value.f.runtime.recover(); value.f.runtime.recover(); assert.equal(value.f.runtime.queue.claimNext('no-replay'), null);
    assert.equal(value.f.db.prepare('SELECT COUNT(*) n FROM threaded_backend_requests').get().n, requests);
    if (options.hardCap) assert.equal(value.policy.maxActivityMs, 1400);
    checks.push(`${name}: transport progress cannot revive expired activity, exceed the hard root budget, or retain revoked authority; unknown stays fenced without replay.`);
  }
  assert.equal(forbiddenNetwork, 0);
  const result = { ok: true, groups: checks.length, checks, realModelCalls: 0, externalNetworkCalls: 0,
    localSdkRelayOnly: true, defaultAllowanceUnchanged: 1000, sharedTokenLedgerAccess: false };
  const output = path.resolve('docs/reports/evidence/threaded-t12-activity-heartbeat/result.json');
  await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ...result, output }, null, 2));
} finally { for (const f of fixtures) f.close(); globalThis.fetch = nativeFetch; await rm(root, { recursive: true, force: true }); }

import assert from 'node:assert/strict';
import { createT12TransportDiagnostics } from './fixtures/threadedT12TransportDiagnostics.mjs';

const secret = 'SYNTHETIC_T12_DIAGNOSTIC_SECRET', body = 'SYNTHETIC_RESPONSE_BODY_MUST_NOT_BE_RECORDED';
const redact = value => value.replaceAll(secret, '[redacted]');
const checks = [];
{
  const diagnostics = createT12TransportDiagnostics({ redact, fetch: async () => new Response(body,
    { headers: { 'content-type': 'application/json', authorization: secret } }) });
  const response = await diagnostics.fetch('https://fixture.invalid/v1/messages', { method: 'POST',
    headers: { authorization: secret }, body: 'SYNTHETIC_REQUEST_BODY_MUST_NOT_BE_RECORDED' });
  assert.equal(await response.text(), body); assert.equal(response.headers.get('authorization'), secret);
  const [fact] = diagnostics.snapshot(); assert.equal(fact.state, 'body_complete'); assert.equal(fact.status, 200);
  assert.equal(fact.bodyBytes, Buffer.byteLength(body)); assert.match(fact.bodySha256, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(fact).includes(body)); assert.ok(!JSON.stringify(fact).includes('SYNTHETIC_REQUEST_BODY'));
  assert.ok(!JSON.stringify(fact).includes(secret)); assert.ok(!Object.hasOwn(fact, 'headers'));
  checks.push('Successful transport preserves response bytes/headers while diagnostics retain metadata/hash only.');
}
{
  const controller = new AbortController(); controller.abort(new Error(`timeout ${secret}`));
  const error = Object.assign(new Error(`network ${secret}`), { name: 'TimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT',
    cause: Object.assign(new Error(`connection ${secret}`), { code: 'ETIMEDOUT' }) });
  const diagnostics = createT12TransportDiagnostics({ redact, fetch: async () => { throw error; } });
  await assert.rejects(() => diagnostics.fetch('https://fixture.invalid/v1/messages', { signal: controller.signal }), value => value === error);
  const [fact] = diagnostics.snapshot(); assert.equal(fact.state, 'fetch_error'); assert.equal(fact.error.name, 'TimeoutError');
  assert.equal(fact.error.code, 'UND_ERR_CONNECT_TIMEOUT'); assert.equal(fact.error.cause.code, 'ETIMEDOUT');
  assert.equal(fact.signalAborted, true); assert.ok(!JSON.stringify(fact).includes(secret));
  checks.push('Headers/connection failures preserve error category/cause/abort facts with secrets redacted.');
}
{
  let pulls = 0;
  const diagnostics = createT12TransportDiagnostics({ redact, fetch: async () => new Response(new ReadableStream({
    pull(controller) { if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('partial'));
      else controller.error(Object.assign(new Error(`stream ${secret}`), { code: 'ECONNRESET' })); },
  })) });
  const response = await diagnostics.fetch('https://fixture.invalid/v1/messages', {});
  await assert.rejects(() => response.text(), /stream/);
  const [fact] = diagnostics.snapshot(); assert.equal(fact.state, 'body_error'); assert.equal(fact.status, 200);
  assert.equal(fact.error.code, 'ECONNRESET'); assert.ok(fact.bodyBytes > 0); assert.ok(!JSON.stringify(fact).includes(secret));
  checks.push('A response-body failure after HTTP 200 remains distinguishable from a connection failure.');
}
{
  const diagnostics = createT12TransportDiagnostics({ redact, fetch: async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new TextEncoder().encode('waiting')); },
  })) });
  const response = await diagnostics.fetch('https://fixture.invalid/v1/messages', {});
  await response.body.cancel(new Error(`cancel ${secret}`));
  const [fact] = diagnostics.snapshot(); assert.equal(fact.state, 'body_cancelled'); assert.ok(!JSON.stringify(fact).includes(secret));
  checks.push('Consumer cancellation is recorded without presenting it as confirmed response completion.');
}
console.log(JSON.stringify({ ok: true, groups: checks.length, checks, networkCalls: 0, credentialReads: 0, tokenLedgerAccess: false }, null, 2));

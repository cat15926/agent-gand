import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { effectiveExternalTimeout, externalTimeoutError } from '../apps/server/src/execution/timeout.ts';
import { withRpcProcess } from '../apps/server/src/execution/rpc.ts';

const root = await mkdtemp(path.join(tmpdir(), 'gand-diagnostics-'));
try {
  const now = Date.parse('2026-10-08T00:00:00Z');
  const account = effectiveExternalTimeout({ configuredMs: 300_000, managed: true, now });
  assert.deepEqual(account, { configuredMs: 300_000, effectiveMs: 300_000, source: 'account', deadlineAt: '2026-10-08T00:05:00.000Z' });
  const lease = effectiveExternalTimeout({ configuredMs: 300_000, managed: true, now, leaseExpiresAt: '2026-10-08T00:02:00Z' });
  assert.equal(lease.effectiveMs, 120_000); assert.equal(lease.source, 'coordination_lease');
  const deadline = effectiveExternalTimeout({ configuredMs: 300_000, managed: true, now, leaseExpiresAt: '2026-10-08T00:02:00Z', runDeadlineAt: '2026-10-08T00:01:00Z' });
  assert.equal(deadline.effectiveMs, 60_000); assert.equal(deadline.source, 'run_deadline');
  assert.equal(externalTimeoutError(account).details.phase, 'initialization');
  assert.equal(externalTimeoutError(account, { nativeInvokedAt: 'x' }).details.phase, 'before_session');
  assert.equal(externalTimeoutError(account, { nativeInvokedAt: 'x', sessionBoundAt: 'x' }).details.phase, 'before_first_activity');
  assert.equal(externalTimeoutError(account, { nativeInvokedAt: 'x', firstToolAt: 'x' }).details.phase, 'after_activity');
  assert.equal(externalTimeoutError(deadline, { nativeInvokedAt: 'x' }).details.phase, 'deadline');
  const fixture = `process.stderr.write('provider validation failed: api_key=sk-fixture-secret-never-used\\n');
    process.stdout.write(JSON.stringify({method:'ready',params:{}})+'\\n');
    setInterval(()=>{},1000);`;
  const controller = new AbortController();
  let stopped = false;
  await assert.rejects(withRpcProcess({ command: process.execPath, args: ['-e', fixture], cwd: root, signal: controller.signal, timeoutMs: 3000,
    onProcessStopped: () => { stopped = true; } }, async peer => {
      peer.onMessage(() => { setTimeout(() => controller.abort(externalTimeoutError(account, { nativeInvokedAt: 'x', sessionBoundAt: 'x' })), 50); });
      await new Promise(() => {});
    }), error => {
      assert.equal(error.code, 'timeout'); assert.equal(error.details.phase, 'before_first_activity');
      assert.match(error.details.stderr, /provider validation failed/); assert.doesNotMatch(error.details.stderr, /sk-fixture-secret/);
      return true;
    });
  assert.equal(stopped, true, 'failure must reap owned native process before returning');
  console.log('Execution diagnostics verified: account policy, lease/deadline clamps, no-first-response vs later timeout, redacted stderr and native process cleanup.');
} finally { await rm(root, { recursive: true, force: true }); }

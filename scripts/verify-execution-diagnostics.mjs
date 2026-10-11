import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { effectiveExternalTimeout, externalTimeoutError } from '../apps/server/src/execution/timeout.ts';
import { withRpcProcess } from '../apps/server/src/execution/rpc.ts';
import { mock } from 'node:test';
import { ActivityTimeout, withActivityTimeout } from '../apps/server/src/execution/activityTimeout.ts';

const root = await mkdtemp(path.join(tmpdir(), 'gand-diagnostics-'));
try {
  mock.timers.enable({ apis: ['setTimeout'] });
  const failures = [];
  const activity = new ActivityTimeout({ firstResponseTimeoutMs: 1000, idleTimeoutMs: 200 }, error => failures.push(error));
  activity.start(); mock.timers.tick(999); assert.equal(failures.length, 0);
  mock.timers.tick(1); assert.equal(failures.pop().details.timeoutKind, 'first_response');
  activity.start(); activity.activity(); activity.pause('tool:a'); activity.pause('approval:b');
  mock.timers.tick(3000); assert.equal(failures.length, 0, 'tools/approval wait must pause idle');
  activity.resume('tool:a'); mock.timers.tick(3000); assert.equal(failures.length, 0, 'another pending operation still pauses idle');
  activity.resume('approval:b'); mock.timers.tick(199); activity.activity(); mock.timers.tick(199);
  assert.equal(failures.length, 0); mock.timers.tick(1); assert.equal(failures.pop().details.timeoutKind, 'idle');
  activity.start(); activity.activity(); activity.stop(); mock.timers.tick(3000); assert.equal(failures.length, 0);
  activity.start(); mock.timers.tick(1000); assert.equal(failures.pop().details.timeoutKind, 'first_response', 'new invocation gets a new first response clock');
  const disabled = new ActivityTimeout({}, error => failures.push(error)); disabled.start(); mock.timers.tick(100000); disabled.stop(); assert.equal(failures.length, 0);
  const idleOnly = new ActivityTimeout({ idleTimeoutMs: 200 }, error => failures.push(error)); idleOnly.start(); mock.timers.tick(3000);
  assert.equal(failures.length, 0, 'idle alone does not impose a first response limit'); idleOnly.activity(); mock.timers.tick(200); assert.equal(failures.pop().details.timeoutKind, 'idle');
  mock.timers.reset();
  let lateSignal;
  await assert.rejects(withActivityTimeout({ firstResponseTimeoutMs: 20 }, async signal => { lateSignal = signal; return new Promise(() => {}); }), error => error.details.timeoutKind === 'first_response');
  assert.equal(lateSignal.aborted, true, 'provider ignoring abort must still return a timely failure');
  const preaborted = new AbortController(); preaborted.abort(new Error('original cancellation'));
  await assert.rejects(withActivityTimeout({ signal: preaborted.signal }, async () => { throw new Error('must not call provider'); }), /original cancellation/);
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
  console.log('Execution diagnostics verified: independent first/idle clocks, nested tool/approval pauses, disabled defaults, ignored abort, account policy, lease/deadline clamps, redacted stderr and native process cleanup.');
} finally { await rm(root, { recursive: true, force: true }); }

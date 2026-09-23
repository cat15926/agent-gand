import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-tool-ledger-'));
process.env.DB_PATH = path.join(root, 'test.sqlite');
const db = await import('../apps/server/src/db/database.ts');
const { executeToolOnce, listToolExecutions, reconcileInterruptedToolExecutions } = await import('../apps/server/src/tools/executions.ts');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function request(key, policy, attemptId, spanId, execute) {
  return { runId: 'r1', agentId: 'a', attemptId, toolName: 'external.write', input: '{}',
    idempotencyKey: key, replayPolicy: policy, spanId, execute };
}

try {
  let executions = 0;
  const hold = deferred();
  const first = executeToolOnce(request('completed', 'manual', 'a1', 's1', async () => {
    executions++;
    return hold.promise;
  }));
  await assert.rejects(executeToolOnce(request('completed', 'manual', 'a1', 's2', async () => 'duplicate')), /不能并发重放/);
  hold.resolve('done');
  assert.deepEqual(await first, { output: 'done', replayed: false });
  assert.deepEqual(await executeToolOnce(request('completed', 'manual', 'a2', 's3', async () => 'duplicate')), { output: 'done', replayed: true });
  assert.equal(executions, 1);

  const uncertain = deferred();
  const manual = executeToolOnce(request('manual-crash', 'manual', 'm1', 'm-span', async () => uncertain.promise));
  assert.equal(reconcileInterruptedToolExecutions('m1').needsAttention, true);
  await assert.rejects(executeToolOnce(request('manual-crash', 'manual', 'm2', 'm-new', async () => 'unsafe')), /需要人工处理/);
  uncertain.resolve('late manual output');
  await assert.rejects(manual, /迟到结果已丢弃/);
  assert.equal(listToolExecutions('r1').find((item) => item.idempotencyKey === 'manual-crash').status, 'needs_attention');

  const retryable = deferred();
  const old = executeToolOnce(request('idempotent-crash', 'idempotent', 'i1', 'i-span', async () => retryable.promise));
  assert.deepEqual(reconcileInterruptedToolExecutions('i1'), { needsAttention: false, found: true, reasons: [] });
  assert.deepEqual(await executeToolOnce(request('idempotent-crash', 'idempotent', 'i2', 'i-new', async () => 'new output')),
    { output: 'new output', replayed: false });
  retryable.resolve('stale output');
  await assert.rejects(old, /迟到结果已丢弃/);
  const record = listToolExecutions('r1').find((item) => item.idempotencyKey === 'idempotent-crash');
  assert.equal(record.status, 'completed');
  assert.equal(record.output, 'new output');
  assert.equal(record.attemptId, 'i2');
  await assert.rejects(executeToolOnce({ ...request('completed', 'manual', 'a3', 's4', async () => 'wrong'), runId: 'r2' }), /幂等键冲突/);
  console.log('独立 ToolExecution 账本验证通过');
} finally {
  db.closeDatabase();
  await rm(root, { recursive: true, force: true });
}

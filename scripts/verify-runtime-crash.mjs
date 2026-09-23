import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-runtime-crash-'));
process.env.DB_PATH = path.join(root, 'test.sqlite');
process.env.COLLAB_RUNTIME_ATOMIC = 'true';
const db = await import('../apps/server/src/db/database.ts');
const store = await import('../apps/server/src/collaboration/store.ts');
const { auditShadowRun } = await import('../apps/server/src/runtime/shadow.ts');
const worker = fileURLToPath(new URL('./helpers/runtime-fault-child.mjs', import.meta.url));
const loader = path.resolve('apps/server/node_modules/tsx/dist/loader.mjs');
const args = ['--import', loader, worker];

function fixture(name) {
  const now = new Date().toISOString();
  const runId = `run-${name}`; const conversationId = `conversation-${name}`;
  db.run('INSERT INTO conversations (id,title,mode,agent_ids,created_at,updated_at) VALUES (?,?,?,?,?,?)', conversationId, name, 'collaboration', '["a","b"]', now, now);
  db.run('INSERT INTO runs (id,goal,mode,conversation_id,turn_no,status,agent_ids,created_at) VALUES (?,?,?,?,?,?,?,?)', runId, name, 'collaboration', conversationId, 1, 'running', '["a","b"]', now);
  return { runId, conversationId };
}

function crash(mode, fields) {
  const result = spawnSync(process.execPath, [...args, mode], {
    cwd: process.cwd(), env: { ...process.env, TEST_RUN_ID: fields.runId, TEST_CONVERSATION_ID: fields.conversationId,
      TEST_DISPATCH_ID: fields.dispatchId ?? '', TEST_ATTEMPT_ID: fields.attemptId ?? '' }, timeout: 10_000, encoding: 'utf8',
  });
  assert.equal(result.signal, 'SIGKILL', `${mode}: ${result.stderr || result.error}`);
}

function race(mode, fields) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...args, mode], { cwd: process.cwd(),
      env: { ...process.env, TEST_RUN_ID: fields.runId, TEST_CONVERSATION_ID: fields.conversationId,
        TEST_LEASE_OWNER: fields.leaseOwner ?? '', TEST_DISPATCH_ID: fields.dispatchId ?? '',
        TEST_ATTEMPT_ID: fields.attemptId ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(`${mode}: ${err}`)));
  });
}

try {
  const flow = fixture('flow');
  crash('admission_before', flow);
  assert.equal(db.get('SELECT COUNT(*) n FROM collaboration_dispatches WHERE run_id=?', flow.runId).n, 0);
  assert.equal(db.get('SELECT COUNT(*) n FROM runtime_subjects WHERE run_id=?', flow.runId).n, 0);
  crash('admission_after', flow);
  const rootDispatch = store.listDispatches(flow.runId)[0];
  assert.ok(rootDispatch);
  assert.equal(db.get('SELECT COUNT(*) n FROM runtime_subjects WHERE run_id=?', flow.runId).n, 1);
  crash('claim_before', flow);
  assert.equal(store.getDispatch(rootDispatch.id)?.status, 'queued');
  assert.equal(store.listAttempts(flow.runId).length, 0);
  crash('claim_after', flow);
  const first = store.listAttempts(flow.runId)[0];
  assert.equal(first?.status, 'running');
  assert.equal(store.getDispatch(rootDispatch.id)?.status, 'running');
  db.run("UPDATE collaboration_attempts SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", first.id);
  assert.deepEqual(store.interruptExpiredAttempts({ onlyExpired: true }), [flow.conversationId]);
  const retry = store.claimNextDispatch(flow.conversationId, 'parent-retry');
  assert.equal(retry?.dispatch.id, rootDispatch.id);
  crash('handoff_before', { ...flow, dispatchId: rootDispatch.id, attemptId: retry.attempt.id });
  assert.equal(store.listDispatches(flow.runId).length, 1);
  assert.equal(store.listAttempts(flow.runId).at(-1).status, 'running');
  assert.equal(db.get('SELECT state FROM runtime_custody WHERE subject_id=(SELECT subject_id FROM runtime_dispatch_subjects WHERE dispatch_id=?)', rootDispatch.id).state, 'owned');
  crash('handoff_after', { ...flow, dispatchId: rootDispatch.id, attemptId: retry.attempt.id });
  const handoff = store.listDispatches(flow.runId).find((item) => item.kind === 'handoff');
  assert.equal(handoff?.status, 'queued');
  assert.equal(store.listAttempts(flow.runId).at(-1).status, 'completed');
  assert.equal(db.get('SELECT state FROM runtime_custody WHERE subject_id=(SELECT subject_id FROM runtime_dispatch_subjects WHERE dispatch_id=?)', rootDispatch.id).state, 'transferring');
  const acquired = store.claimNextDispatch(flow.conversationId, 'parent');
  assert.equal(acquired?.dispatch.id, handoff.id);
  assert.equal(db.get('SELECT holder_agent_id FROM runtime_custody WHERE subject_id=(SELECT subject_id FROM runtime_dispatch_subjects WHERE dispatch_id=?)', handoff.id).holder_agent_id, 'b');
  assert.equal(await race('assemble_context', { ...flow, dispatchId: handoff.id, attemptId: acquired.attempt.id }), 'capsule');
  assert.equal(db.get('SELECT COUNT(*) n FROM runtime_context_assemblies WHERE attempt_id=?', acquired.attempt.id).n, 1);
  crash('tool_crash', { ...flow, attemptId: acquired.attempt.id });
  assert.equal(db.get('SELECT status FROM tool_executions WHERE attempt_id=?', acquired.attempt.id).status, 'running');
  db.run("UPDATE collaboration_attempts SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", acquired.attempt.id);
  store.interruptExpiredAttempts({ onlyExpired: true });
  assert.equal(db.get('SELECT status FROM tool_executions WHERE attempt_id=?', acquired.attempt.id).status, 'needs_attention');
  assert.equal(store.getDispatch(handoff.id)?.status, 'failed', '未知工具副作用不能自动重试');
  assert.deepEqual(auditShadowRun(flow.runId), []);

  const concurrent = fixture('concurrent');
  crash('admission_after', concurrent);
  const [left, right] = await Promise.all([race('race_claim', concurrent), race('race_claim', concurrent)]);
  assert.equal([left, right].filter((value) => value !== 'none').length, 1, '跨进程只能接球一次');
  assert.equal(store.listAttempts(concurrent.runId).filter((item) => item.status === 'running').length, 1);
  const active = store.listAttempts(concurrent.runId).find((item) => item.status === 'running');
  db.run("UPDATE collaboration_attempts SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", active.id);
  await Promise.all([race('renew', { ...concurrent, leaseOwner: active.leaseOwner }), race('expire', concurrent)]);
  const afterRace = store.listAttempts(concurrent.runId);
  assert.ok(['running', 'interrupted'].includes(afterRace[0].status));
  if (afterRace[0].status === 'running') {
    assert.equal(store.getDispatch(afterRace[0].dispatchId)?.status, 'running');
    assert.ok(new Date(afterRace[0].leaseExpiresAt).getTime() > Date.now());
  } else {
    assert.equal(store.getDispatch(afterRace[0].dispatchId)?.status, 'queued');
    const reclaimed = store.claimNextDispatch(concurrent.conversationId, 'new-owner');
    assert.ok(reclaimed);
    store.finishAttempt({ attemptId: active.id, dispatchId: active.dispatchId, status: 'completed' });
    assert.equal(store.getDispatch(active.dispatchId)?.status, 'running', '过期旧 Attempt 不能覆盖新 claim');
  }
  assert.ok(store.listAttempts(concurrent.runId).filter((item) => item.status === 'running').length <= 1);
  assert.deepEqual(auditShadowRun(concurrent.runId), []);
  console.log('Runtime 进程崩溃与租约并发验证通过');
} finally {
  db.closeDatabase();
  await rm(root, { recursive: true, force: true });
}

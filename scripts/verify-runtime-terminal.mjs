import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-runtime-terminal-'));
process.env.DB_PATH = path.join(root, 'test.sqlite');
const db = await import('../apps/server/src/db/database.ts');
const { subscribe } = await import('../apps/server/src/messaging/bus.ts');
const { post } = await import('../apps/server/src/messaging/inbox.ts');
const { commitRunTerminal, getRunTerminal } = await import('../apps/server/src/runtime/terminal.ts');
const { getRun } = await import('../apps/server/src/runs/trace.ts');
const worker = fileURLToPath(new URL('./helpers/runtime-fault-child.mjs', import.meta.url));
const loader = path.resolve('apps/server/node_modules/tsx/dist/loader.mjs');
const childArgs = ['--import', loader, worker];

function fixture(name, withRuntimeWork = false) {
  const now = new Date().toISOString();
  const runId = `run-${name}`;
  const conversationId = `conversation-${name}`;
  db.run('INSERT INTO conversations (id,title,mode,agent_ids,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    conversationId, name, 'collaboration', '["a"]', now, now);
  db.run('INSERT INTO runs (id,goal,mode,conversation_id,turn_no,status,agent_ids,created_at) VALUES (?,?,?,?,?,?,?,?)',
    runId, name, 'collaboration', conversationId, 1, 'running', '["a"]', now);
  post({ runId, from: 'user', to: 'all', kind: 'user', body: name,
    deliveryStatus: 'processing', clientMessageId: `user:${runId}` });
  if (withRuntimeWork) {
    const subjectId = `subject-${name}`;
    db.run(`INSERT INTO runtime_subjects (id,run_id,subject_key,kind,status,objective,created_at,updated_at)
      VALUES (?,?,?,'root','active',?,?,?)`, subjectId, runId, `root:${name}`, name, now, now);
    db.run(`INSERT INTO runtime_holds
      (id,run_id,subject_id,holder_agent_id,generation,version,condition,recovery_policy,status,idempotency_key,created_at,updated_at)
      VALUES (?,?,?,?,1,1,?,?,'open',?,?,?)`, `hold-${name}`, runId, subjectId, 'a',
    JSON.stringify({ kind: 'event', eventKey: `event:${name}` }), JSON.stringify({ kind: 'wake_run' }),
    `hold:${name}`, now, now);
    db.run(`INSERT INTO runtime_successor_obligations
      (id,run_id,parent_subject_id,kind,source_action_id,stable_key,status,required,generation,payload,created_at)
      VALUES (?,?,?,'external_wait',?,?,'open',1,1,'{}',?)`,
    `obligation-${name}`, runId, subjectId, `source-${name}`, `wait:${name}`, now);
  }
  return { runId, conversationId };
}

function acceptedCompletion(runId) {
  return {
    input: {
      contract: { version: 1, runId, objective: '原子终局验收', participantIds: [], requiredSubjectKeys: [],
        completionPolicy: 'all_required', partialFailurePolicy: 'needs_attention' },
      subjects: [], dispatches: [], pendingDecisions: 0, batchStatuses: [], hasAnyOutput: true,
      dependenciesSatisfied: true, requiredArtifactsSatisfied: true, reviewAccepted: true,
      protocolTerminal: true, successorObligationsSatisfied: true,
    },
    evaluation: { status: 'accepted', reasons: [], disposition: 'normal' },
  };
}

function completedCommand(runId) {
  return {
    runId, status: 'completed', disposition: 'accepted', source: 'terminal_verification',
    userMessageStatus: 'responded', prepare: () => ({
      completion: acceptedCompletion(runId),
      report: { from: 'a', to: 'user', kind: 'agent', messageType: 'collaboration_result',
        body: `final:${runId}`, clientMessageId: `runtime:completion:${runId}` },
    }),
  };
}

function crash(mode, fields) {
  const result = spawnSync(process.execPath, [...childArgs, mode], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, TEST_RUN_ID: fields.runId, TEST_CONVERSATION_ID: fields.conversationId } });
  assert.equal(result.signal, 'SIGKILL', `${mode}: ${result.stderr || result.error}`);
}

function race(status, fields) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...childArgs, 'terminal_race'], { cwd: process.cwd(),
      env: { ...process.env, TEST_RUN_ID: fields.runId, TEST_CONVERSATION_ID: fields.conversationId,
        TEST_TERMINAL_STATUS: status }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`${status}: ${err}`)));
  });
}

try {
  const atomic = fixture('atomic', true);
  const events = [];
  const unsubscribe = subscribe((event) => {
    const eventRunId = event.type === 'run.updated' ? event.run.id
      : event.type === 'message' ? event.message.runId : null;
    if (eventRunId === atomic.runId) events.push(event.type);
  });
  const committed = commitRunTerminal(completedCommand(atomic.runId));
  unsubscribe();
  assert.equal(committed.committed, true);
  assert.equal(committed.terminal.status, 'completed');
  assert.equal(committed.terminal.disposition, 'accepted');
  assert.equal(getRun(atomic.runId)?.terminalDisposition, 'accepted');
  assert.ok(committed.terminal.completionEvaluationSeq);
  assert.ok(committed.terminal.reportMessageId);
  assert.equal(db.get('SELECT COUNT(*) n FROM messages WHERE run_id=? AND client_message_id=?',
    atomic.runId, `runtime:completion:${atomic.runId}`).n, 1);
  assert.equal(db.get("SELECT delivery_status FROM messages WHERE run_id=? AND kind='user'", atomic.runId).delivery_status, 'responded');
  assert.equal(db.get('SELECT status FROM runtime_holds WHERE run_id=?', atomic.runId).status, 'cancelled');
  assert.equal(db.get('SELECT status FROM runtime_successor_obligations WHERE run_id=?', atomic.runId).status, 'cancelled');
  assert.ok(events.includes('message'));
  assert.ok(events.includes('run.updated'));
  const duplicate = commitRunTerminal({ runId: atomic.runId, status: 'failed', disposition: 'failed', source: 'late_failure' });
  assert.equal(duplicate.committed, false);
  assert.equal(duplicate.terminal.status, 'completed', '迟到竞争者只能读取既有赢家');
  assert.equal(db.get('SELECT COUNT(*) n FROM runtime_run_terminals WHERE run_id=?', atomic.runId).n, 1);

  const rollback = fixture('rollback');
  const rolledBackEvents = [];
  const unsubscribeRollback = subscribe((event) => {
    const eventRunId = event.type === 'run.updated' ? event.run.id
      : event.type === 'message' ? event.message.runId : null;
    if (eventRunId === rollback.runId) rolledBackEvents.push(event.type);
  });
  assert.throws(() => db.tx(() => {
    commitRunTerminal(completedCommand(rollback.runId));
    throw new Error('forced rollback');
  }), /forced rollback/);
  unsubscribeRollback();
  assert.equal(getRun(rollback.runId)?.status, 'running');
  assert.equal(getRunTerminal(rollback.runId), null);
  assert.equal(db.get('SELECT COUNT(*) n FROM messages WHERE run_id=? AND client_message_id=?',
    rollback.runId, `runtime:completion:${rollback.runId}`).n, 0);
  assert.deepEqual(rolledBackEvents, [], '回滚不得发送 message/run.updated 通知');

  const invalid = fixture('invalid');
  assert.throws(() => commitRunTerminal({ runId: invalid.runId, status: 'completed', disposition: 'accepted',
    source: 'invalid_without_completion' }), /accepted Completion Evaluation/);
  assert.equal(getRun(invalid.runId)?.status, 'running', 'Completion 校验失败必须回滚 CAS');

  const before = fixture('crash-before');
  crash('terminal_before', before);
  assert.equal(getRun(before.runId)?.status, 'running');
  assert.equal(getRunTerminal(before.runId), null);
  assert.equal(db.get('SELECT COUNT(*) n FROM messages WHERE run_id=? AND client_message_id=?',
    before.runId, `runtime:completion:${before.runId}`).n, 0);

  const after = fixture('crash-after');
  crash('terminal_after', after);
  assert.equal(getRun(after.runId)?.status, 'completed');
  assert.equal(getRunTerminal(after.runId)?.status, 'completed');
  assert.equal(db.get('SELECT COUNT(*) n FROM messages WHERE run_id=? AND client_message_id=?',
    after.runId, `runtime:completion:${after.runId}`).n, 1);

  const concurrent = fixture('concurrent');
  const raceResults = await Promise.all([
    race('completed', concurrent), race('failed', concurrent), race('cancelled', concurrent), race('completed', concurrent),
  ]);
  assert.equal(raceResults.filter((item) => item.committed).length, 1, '并发终局只能有一个 CAS 赢家');
  const terminal = getRunTerminal(concurrent.runId);
  assert.ok(terminal);
  assert.equal(getRun(concurrent.runId)?.status, terminal.status);
  assert.equal(db.get('SELECT COUNT(*) n FROM runtime_run_terminals WHERE run_id=?', concurrent.runId).n, 1);
  assert.equal(db.get('SELECT COUNT(*) n FROM messages WHERE run_id=? AND client_message_id=?',
    concurrent.runId, `runtime:completion:${concurrent.runId}`).n, 1, '赢家报告必须且只能落库一次');
  assert.equal(db.get("SELECT COUNT(*) n FROM messages WHERE run_id=? AND kind='user' AND delivery_status IN ('responded','failed')",
    concurrent.runId).n, 1);

  console.log('Runtime 原子终局、并发 CAS、进程崩溃与回滚通知验证通过');
} finally {
  db.closeDatabase();
  await rm(root, { recursive: true, force: true });
}

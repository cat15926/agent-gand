import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-runtime-actions-'));
process.env.DB_PATH = path.join(root, 'test.sqlite');
const db = await import('../apps/server/src/db/database.ts');
const store = await import('../apps/server/src/collaboration/store.ts');
const { post } = await import('../apps/server/src/messaging/inbox.ts');
const { subscribe } = await import('../apps/server/src/messaging/bus.ts');
const commands = await import('../apps/server/src/runtime/actionCommands.ts');
const worker = fileURLToPath(new URL('./helpers/runtime-fault-child.mjs', import.meta.url));
const loader = path.resolve('apps/server/node_modules/tsx/dist/loader.mjs');
const childArgs = ['--import', loader, worker];

function fixture(name) {
  const now = new Date().toISOString();
  const runId = `run-${name}`; const conversationId = `conversation-${name}`;
  db.run('INSERT INTO conversations (id,title,mode,agent_ids,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    conversationId, name, 'collaboration', '["a","b","c"]', now, now);
  db.run('INSERT INTO runs (id,goal,mode,conversation_id,turn_no,status,agent_ids,created_at) VALUES (?,?,?,?,?,?,?,?)',
    runId, name, 'collaboration', conversationId, 1, 'running', '["a","b","c"]', now);
  const source = post({ runId, from: 'user', to: 'a', kind: 'user', body: name,
    clientMessageId: `user:${runId}` });
  const parent = store.createDispatch({ runId, conversationId, sourceMessageId: source.id, kind: 'initial',
    from: 'user', targetAgentId: 'a', depth: 0, idempotencyKey: `initial:${runId}` });
  return { runId, conversationId, dispatchId: parent.id };
}

function childEnv(fields) {
  return { ...process.env, TEST_RUN_ID: fields.runId, TEST_CONVERSATION_ID: fields.conversationId,
    TEST_DISPATCH_ID: fields.dispatchId ?? '' };
}

function crash(mode, fields) {
  const result = spawnSync(process.execPath, [...childArgs, mode], { cwd: process.cwd(), env: childEnv(fields),
    encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.signal, 'SIGKILL', `${mode}: ${result.stderr || result.error}`);
}

function race(fields) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...childArgs, 'action_handoff_race'], { cwd: process.cwd(),
      env: childEnv(fields), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
  });
}

try {
  const complete = fixture('complete');
  let executions = 0;
  const committedEvents = [];
  const unsubscribe = subscribe((event) => {
    if (event.type === 'runtime.action_command.committed' && event.command.runId === complete.runId) {
      committedEvents.push(event.command.id);
    }
  });
  const commitComplete = () => commands.commitCompleteActionCommand({ runId: complete.runId,
    dispatchId: complete.dispatchId, commandKey: `complete:${complete.runId}`, execute: () => {
      executions++;
      const message = post({ runId: complete.runId, from: 'a', to: 'user', kind: 'agent',
        messageType: 'collaboration_result', body: '完成结果', clientMessageId: `complete:${complete.runId}:message` });
      return { messageId: message.id };
    } });
  assert.equal(commitComplete().committed, true);
  assert.equal(commitComplete().committed, false);
  unsubscribe();
  assert.equal(executions, 1, '重复 complete 命令不得再次执行领域写入');
  assert.equal(committedEvents.length, 1, '动作命令事件只能在首次事务提交后发送一次');

  const hold = fixture('hold');
  commands.commitHoldActionCommand({ runId: hold.runId, dispatchId: hold.dispatchId,
    commandKey: `hold:${hold.runId}`, execute: () => {
      const prompt = post({ runId: hold.runId, from: 'a', to: 'user', kind: 'agent',
        messageType: 'collaboration_wait_user', body: '请确认', clientMessageId: `hold:${hold.runId}:message` });
      const decision = store.createDecision({ runId: hold.runId, conversationId: hold.conversationId,
        dispatchId: hold.dispatchId, idempotencyKey: `hold:${hold.runId}:decision`, kind: 'agent_question',
        promptMessageId: prompt.id, payload: { question: '请确认' } });
      return { decisionId: decision.id, promptMessageId: prompt.id };
    } });
  assert.equal(store.listDecisions(hold.runId).length, 1);

  const consult = fixture('consult');
  commands.commitConsultAllActionCommand({ runId: consult.runId, dispatchId: consult.dispatchId,
    commandKey: `consult:${consult.runId}`, execute: () => {
      const question = post({ runId: consult.runId, from: 'a', to: 'b,c', kind: 'agent',
        messageType: 'collaboration_question', body: '分别分析', clientMessageId: `consult:${consult.runId}:message` });
      const batch = store.createBatch({ runId: consult.runId, conversationId: consult.conversationId,
        initiatorAgentId: 'a', sourceDispatchId: consult.dispatchId, question: '分别分析', targetAgentIds: ['b', 'c'] });
      const children = ['b', 'c'].map((target) => store.createDispatchDetailed({ runId: consult.runId,
        conversationId: consult.conversationId, sourceMessageId: question.id, parentDispatchId: consult.dispatchId,
        batchId: batch.id, kind: 'fanout', from: 'a', targetAgentId: target, depth: 1,
        idempotencyKey: `consult:${consult.runId}:${target}`, dedupeText: '分别分析' }).dispatch.id);
      return { batchId: batch.id, children };
    } });
  assert.equal(store.listBatches(consult.runId).length, 1);
  assert.equal(store.listDispatches(consult.runId).filter((item) => item.kind === 'fanout').length, 2);

  const consultAny = fixture('consult-any');
  commands.commitConsultAnyActionCommand({ runId: consultAny.runId, dispatchId: consultAny.dispatchId,
    commandKey: `consult-any:${consultAny.runId}`, execute: () => {
      const question = post({ runId: consultAny.runId, from: 'a', to: 'b,c', kind: 'agent',
        messageType: 'collaboration_question', body: '首个成功即可', clientMessageId: `consult-any:${consultAny.runId}:message` });
      const batch = store.createBatch({ runId: consultAny.runId, conversationId: consultAny.conversationId,
        initiatorAgentId: 'a', sourceDispatchId: consultAny.dispatchId, question: '首个成功即可',
        targetAgentIds: ['b', 'c'], joinPolicy: 'any' });
      const children = ['b', 'c'].map((target) => store.createDispatchDetailed({ runId: consultAny.runId,
        conversationId: consultAny.conversationId, sourceMessageId: question.id, parentDispatchId: consultAny.dispatchId,
        batchId: batch.id, kind: 'fanout', from: 'a', targetAgentId: target, depth: 1,
        idempotencyKey: `consult-any:${consultAny.runId}:${target}`, dedupeText: '首个成功即可' }).dispatch.id);
      return { batchId: batch.id, children };
    } });
  assert.equal(store.listBatches(consultAny.runId)[0]?.joinPolicy, 'any');

  const wake = fixture('wake');
  commands.commitWakeActionCommand({ runId: wake.runId, dispatchId: wake.dispatchId,
    commandKey: `wake:${wake.runId}`, execute: () => {
      const message = post({ runId: wake.runId, from: 'user', to: 'a', kind: 'user', body: '继续',
        clientMessageId: `wake:${wake.runId}:message` });
      const resumed = store.createDispatch({ runId: wake.runId, conversationId: wake.conversationId,
        sourceMessageId: message.id, parentDispatchId: wake.dispatchId, kind: 'resume', from: 'system',
        targetAgentId: 'a', depth: 1, idempotencyKey: `wake:${wake.runId}:dispatch` });
      return { resumedDispatchId: resumed.id };
    } });
  assert.equal(store.listDispatches(wake.runId).filter((item) => item.kind === 'resume').length, 1);

  const before = fixture('before');
  crash('action_handoff_before', before);
  assert.equal(commands.listRuntimeActionCommands(before.runId).length, 0);
  assert.equal(store.listDispatches(before.runId).filter((item) => item.kind === 'handoff').length, 0);
  assert.equal(db.get('SELECT COUNT(*) n FROM messages WHERE run_id=? AND client_message_id=?',
    before.runId, `action-handoff:${before.runId}:message`).n, 0);

  const after = fixture('after');
  crash('action_handoff_after', after);
  assert.equal(commands.listRuntimeActionCommands(after.runId).length, 1);
  assert.equal(store.listDispatches(after.runId).filter((item) => item.kind === 'handoff').length, 1);
  assert.equal(db.get('SELECT COUNT(*) n FROM messages WHERE run_id=? AND client_message_id=?',
    after.runId, `action-handoff:${after.runId}:message`).n, 1);

  const consultAnyBefore = fixture('consult-any-before');
  crash('action_consult_any_before', consultAnyBefore);
  assert.equal(commands.listRuntimeActionCommands(consultAnyBefore.runId).length, 0);
  assert.equal(store.listBatches(consultAnyBefore.runId).length, 0);
  assert.equal(store.listDispatches(consultAnyBefore.runId).filter((item) => item.kind === 'fanout').length, 0);

  const consultAnyAfter = fixture('consult-any-after');
  crash('action_consult_any_after', consultAnyAfter);
  assert.equal(commands.listRuntimeActionCommands(consultAnyAfter.runId)[0]?.kind, 'consult_any');
  assert.equal(store.listBatches(consultAnyAfter.runId)[0]?.joinPolicy, 'any');
  assert.equal(store.listDispatches(consultAnyAfter.runId).filter((item) => item.kind === 'fanout').length, 2);

  const concurrent = fixture('concurrent');
  const results = await Promise.all([race(concurrent), race(concurrent), race(concurrent)]);
  assert.equal(results.filter((item) => item.committed).length, 1, '同一 handoff 命令跨进程只能提交一次');
  assert.equal(commands.listRuntimeActionCommands(concurrent.runId).length, 1);
  assert.equal(store.listDispatches(concurrent.runId).filter((item) => item.kind === 'handoff').length, 1);
  assert.equal(db.get('SELECT COUNT(*) n FROM messages WHERE run_id=? AND client_message_id=?',
    concurrent.runId, `action-handoff:${concurrent.runId}:message`).n, 1);

  const kinds = [complete, hold, consult, consultAny, wake]
    .flatMap((item) => commands.listRuntimeActionCommands(item.runId).map((entry) => entry.kind));
  assert.deepEqual(kinds.sort(), ['complete', 'consult_all', 'consult_any', 'hold', 'wake']);
  console.log('Runtime 公共动作命令、幂等账本、跨进程竞态与 SIGKILL 验证通过');
} finally {
  db.closeDatabase();
  await rm(root, { recursive: true, force: true });
}

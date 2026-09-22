import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-collab-reliability-'));
process.env.DB_PATH = path.join(root, 'test.sqlite');
process.env.COLLAB_MAX_ATTEMPTS = '2';

const database = await import('../apps/server/src/db/database.ts');
const store = await import('../apps/server/src/collaboration/store.ts');
const trace = await import('../apps/server/src/runs/trace.ts');
const bus = await import('../apps/server/src/messaging/bus.ts');
const inbox = await import('../apps/server/src/messaging/inbox.ts');

const now = new Date().toISOString();
const runId = 'run-reliability';
const conversationId = 'conversation-reliability';
database.run('INSERT INTO conversations (id,title,mode,agent_ids,created_at,updated_at) VALUES (?,?,?,?,?,?)', conversationId, '可靠性', 'collaboration', '["a","b"]', now, now);
database.run('INSERT INTO runs (id,goal,mode,conversation_id,turn_no,status,agent_ids,created_at) VALUES (?,?,?,?,?,?,?,?)', runId, '验证可靠性', 'collaboration', conversationId, 1, 'running', '["a","b"]', now);

const events = [];
const unsubscribe = bus.subscribe((event) => events.push(event));

try {
  const contributionInput = { runId, from: 'a', to: 'b', kind: 'agent', messageType: 'collaboration_contribution', body: '可见的并行发言', clientMessageId: 'collaboration:fanout:fixture:contribution' };
  const contribution = inbox.post(contributionInput);
  assert.equal(inbox.post(contributionInput).id, contribution.id, '同一 fanout dispatch 重试不得复制发言');
  assert.equal(inbox.listByConversation(conversationId).filter((message) => message.messageType === 'collaboration_contribution').length, 1);
  assert.throws(() => database.tx(() => {
    store.createDispatchDetailed({ runId, conversationId, sourceMessageId: 'source-rollback', kind: 'initial', from: 'user', targetAgentId: 'a', depth: 0, idempotencyKey: 'rollback', dedupeText: 'rollback' });
    throw new Error('force rollback');
  }), /force rollback/);
  assert.equal(database.get('SELECT COUNT(*) n FROM collaboration_dispatches WHERE idempotency_key=?', 'rollback').n, 0);
  assert.equal(events.filter((event) => event.type === 'collaboration.dispatch.updated').length, 0, 'rollback 后不得广播 dispatch');

  const first = database.tx(() => store.createDispatchDetailed({ runId, conversationId, sourceMessageId: 'source-1', parentDispatchId: 'parent-1', kind: 'handoff', from: 'user', targetAgentId: 'a', depth: 1, idempotencyKey: 'first', dedupeText: '  SAME\nMessage  ' }));
  const duplicate = database.tx(() => store.createDispatchDetailed({ runId, conversationId, sourceMessageId: 'source-2', parentDispatchId: 'parent-1', kind: 'handoff', from: 'user', targetAgentId: 'a', depth: 1, idempotencyKey: 'second', dedupeText: 'same message' }));
  assert.equal(duplicate.dispatch.id, first.dispatch.id);
  assert.equal(duplicate.deduplicatedTo, first.dispatch.id);
  assert.equal(database.get('SELECT COUNT(*) n FROM collaboration_dispatches').n, 1);
  assert.equal(events.filter((event) => event.type === 'collaboration.dispatch.updated').length, 1, '提交后只广播真实创建项');

  const secondA = store.createDispatch({ runId, conversationId, sourceMessageId: 'source-3', parentDispatchId: 'parent-2', kind: 'handoff', from: 'user', targetAgentId: 'a', depth: 1, idempotencyKey: 'third', dedupeText: 'different' });
  const firstB = store.createDispatch({ runId, conversationId, sourceMessageId: 'source-4', parentDispatchId: 'parent-3', kind: 'handoff', from: 'user', targetAgentId: 'b', depth: 1, idempotencyKey: 'fourth', dedupeText: 'parallel' });
  const claimedA = store.claimNextDispatch(conversationId, 'test-owner');
  assert.equal(claimedA?.dispatch.id, first.dispatch.id);
  const claimedB = store.claimNextDispatch(conversationId, 'test-owner');
  assert.equal(claimedB?.dispatch.id, firstB.id, '同 Agent 被占用时应领取另一 Agent');
  assert.equal(store.claimNextDispatch(conversationId, 'test-owner'), null, '同一 Agent 不得并发领取第二项');

  const recovered = store.interruptExpiredAttempts();
  assert.deepEqual(recovered, [conversationId]);
  assert.equal(store.getDispatch(claimedA.dispatch.id)?.status, 'queued');
  assert.equal(store.getDispatch(claimedB.dispatch.id)?.status, 'queued');

  const retryA = store.claimNextDispatch(conversationId, 'test-owner');
  assert.equal(retryA?.dispatch.id, first.dispatch.id);
  const agentSpan = trace.startSpan(runId, { spanKind: 'agent', name: 'agent:a', input: JSON.stringify({ dispatchId: first.dispatch.id }) });
  const toolSpan = trace.startSpan(runId, { parentId: agentSpan.id, spanKind: 'tool', name: 'tool:fs.write' });
  trace.endSpan(toolSpan, { status: 'ok', output: 'written' });
  store.interruptExpiredAttempts();
  assert.equal(store.getDispatch(first.dispatch.id)?.status, 'failed', '存在写工具副作用时不得自动重放');
  assert.equal(store.listAttempts(runId).filter((attempt) => attempt.dispatchId === first.dispatch.id).length, 2);
  assert.equal(store.getDispatch(secondA.id)?.status, 'queued');

  console.log('collaboration reliability verification passed: atomic rollback, dedupe, agent slot, safe recovery, side-effect stop');
} finally {
  unsubscribe();
  database.db.close();
  await rm(root, { recursive: true, force: true });
}

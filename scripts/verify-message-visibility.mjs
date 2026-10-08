import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'gand-visibility-'));
process.env.DB_PATH = path.join(root, 'test.sqlite');
process.env.NODE_ENV = 'test';
process.env.AGENTS_DIR = path.join(root, 'agents');
process.env.SANDBOX_DIR = path.join(root, 'sandbox');
// Start from tables without ACL columns, as an existing installation does.
const { default: Database } = await import('../apps/server/node_modules/better-sqlite3/lib/index.js');
const legacy = new Database(process.env.DB_PATH);
legacy.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY,run_id TEXT NOT NULL,conversation_id TEXT,seq INTEGER,from_agent TEXT NOT NULL,to_agent TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,meta TEXT,task_id TEXT,reply_to TEXT,message_type TEXT NOT NULL DEFAULT 'informational',payload TEXT,delivery_status TEXT,client_message_id TEXT,created_at TEXT NOT NULL);
CREATE TABLE runtime_context_assemblies (id TEXT PRIMARY KEY,run_id TEXT NOT NULL,dispatch_id TEXT NOT NULL,attempt_id TEXT NOT NULL UNIQUE,segments TEXT NOT NULL,char_count INTEGER NOT NULL,token_estimate INTEGER NOT NULL,context_sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
INSERT INTO messages(id,run_id,conversation_id,seq,from_agent,to_agent,kind,body,created_at) VALUES('historical','historical','historical',1,'user','all','user','historical message','2026-01-01');`);
legacy.close();
const db = await import('../apps/server/src/db/database.ts');
assert.deepEqual(db.get('SELECT visibility,audience FROM messages WHERE id=?', 'historical'), { visibility: 'public', audience: '[]' });
const inbox = await import('../apps/server/src/messaging/inbox.ts');
const store = await import('../apps/server/src/collaboration/store.ts');
const { assembleCollaborationContext, persistRuntimeContextAssembly } = await import('../apps/server/src/runtime/context.ts');
const { planCollaborationAdmission } = await import('../apps/server/src/runtime/subjectContract.ts');
const { observeAdmission, observeAction } = await import('../apps/server/src/runtime/shadow.ts');
const { freezeRuntimeContract } = await import('../apps/server/src/runtime/controlAction.ts');
const { resolveEvidence } = await import('../apps/server/src/runtime/evidence.ts');
const { attemptAccess } = await import('../apps/server/src/messaging/access.ts');
const { parseControlCall, collaborationControlTools } = await import('../apps/server/src/collaboration/controlTools.ts');
const { getRun, startSpan, endSpan } = await import('../apps/server/src/runs/trace.ts');
const { replyMessageAccess } = await import('../apps/server/src/orchestration/service.ts');
const { conversationHistory } = await import('../apps/server/src/conversations/service.ts');
const { prepareNativeSession } = await import('../apps/server/src/execution/sessions.ts');
const { createExecution, updateExecution } = await import('../apps/server/src/execution/store.ts');
const { reserveMember } = await import('../apps/server/src/execution/memberAdmission.ts');
const { runAgentTurn } = await import('../apps/server/src/orchestration/agentStep.ts');
const { sdkOptions } = await import('../apps/server/src/execution/sdkOptions.ts');
const { config } = await import('../apps/server/src/config.ts');
const { reconcileCollaborationBatches } = await import('../apps/server/src/collaboration/scheduler.ts');
const { saveHandoffCapsule, latestHandoffCapsule, minimalHandoffCapsule } = await import('../apps/server/src/runtime/capsule.ts');
const { intersectMessageAccess } = await import('../packages/shared/src/message.ts');
const roomId = randomUUID(), runId = randomUUID(), oldId = randomUUID();
const now = new Date().toISOString();
try {
  db.run('INSERT INTO conversations(id,title,mode,agent_ids,created_at,updated_at) VALUES(?,?,?,?,?,?)', roomId, 'visibility', 'collaboration', '["host","alice","bob"]', now, now);
  for (const id of [oldId, runId]) {
    db.run('INSERT INTO runs(id,goal,mode,conversation_id,status,agent_ids,created_at) VALUES(?,?,?,?,?,?,?)', id, 'independent tasks', 'collaboration', roomId, 'running', '["host","alice","bob"]', now);
  }
  freezeRuntimeContract(planCollaborationAdmission({ runId, objective: 'ROOT_PRIVATE_SECRET', participantIds: ['host','alice','bob'], targetAgentIds: ['host'],
    completionEngine: true, controlActionVersion: 2, contextContributorVersion: 1, messageVisibilityVersion: 1,
    exitGuard: { version: 1, maxCorrections: 1, correctionMaxTokens: 512 }, completionCandidateVersion: 1,
    successorObligationVersion: 1, evidenceBundleVersion: 1, durableHoldVersion: 2 }).contract);
  inbox.post({ runId: oldId, from: 'alice', to: 'all', kind: 'agent', body: 'UNRELATED_OLD_PUBLIC' });
  inbox.post({ runId, from: 'user', to: 'host', kind: 'user', body: 'ROOT_PRIVATE_SECRET', visibility: 'private' });
  const publicMessage = inbox.post({ runId, from: 'host', to: 'alice', kind: 'agent', body: 'PUBLIC_COMMON' });
  const secret = inbox.post({ clientMessageId: 'secret-alice-id', runId, from: 'host', to: 'alice', kind: 'agent', body: 'SECRET_ALICE', visibility: 'private' });
  inbox.post({ runId, from: 'system', to: 'host', kind: 'system', body: 'AGGREGATE_SECRET_ALICE', visibility: 'private', audience: ['host'] });
  const own = inbox.post({ runId, from: 'host', to: 'bob', kind: 'agent', body: 'SECRET_BOB', visibility: 'private' });
  assert.equal(inbox.listByConversation(roomId, 'bob').some(m => m.id === secret.id), false);
  assert.equal(inbox.listByConversation(roomId, 'bob').some(m => m.id === publicMessage.id), true);
  assert.equal(inbox.listByConversation(roomId).some(m => m.id === secret.id), true, 'owner retains audit access');
  assert.equal(inbox.listMessages({ runId, viewerId: 'bob' }).some(m => m.id === secret.id), false);
  assert.throws(() => inbox.post({ runId, from: 'host', to: 'alice', kind: 'agent', body: 'bad', visibility: 'private', audience: ['outsider'] }), /audience/);
  assert.throws(() => inbox.post({ runId, from: 'host', to: 'all', kind: 'agent', body: 'bad', visibility: 'private' }), /audience/);
  const dispatch = store.createDispatch({ runId, conversationId: roomId, sourceMessageId: own.id, kind: 'initial', from: 'host', targetAgentId: 'bob', reason: 'private task', depth: 0, idempotencyKey: 'bob:private' });
  const agent = { id: 'bob', name: 'Bob', description: 'executor', capabilities: ['execute'] };
  const claim = store.claimNextDispatch(roomId, 'visibility-test');
  const context = assembleCollaborationContext({ run: getRun(runId), dispatch, agent, attemptId: claim.attempt.id });
  assert.match(context, /SECRET_BOB/);
  assert.match(context, /PUBLIC_COMMON/);
  assert.doesNotMatch(context, /SECRET_ALICE|UNRELATED_OLD_PUBLIC|ROOT_PRIVATE_SECRET/);
  assert.deepEqual(attemptAccess(claim.attempt.id).audience.sort(), ['bob','host','user']);
  assert.equal(resolveEvidence(runId, { kind: 'message', id: secret.id }, 'bob').trusted, false);
  assert.equal(resolveEvidence(runId, { kind: 'message', id: secret.id }, 'alice').trusted, true);
  assert.throws(() => assembleCollaborationContext({ run: getRun(runId), dispatch: { ...dispatch, sourceMessageId: secret.id }, agent, attemptId: 'denied' }), /可见范围/);
  assert.throws(() => assembleCollaborationContext({ run: getRun(runId), dispatch: { ...dispatch, sourceMessageId: 'missing-source' }, agent, attemptId: 'missing' }), /可见范围/);
  const span = startSpan(runId, { spanKind: 'llm', name: 'private-span', attributes: { 'collaboration.dispatch.id': dispatch.id } });
  endSpan(span, { output: 'PRIVATE_OUTPUT', status: 'ok' });
  assert.equal(resolveEvidence(runId, { kind: 'run_event', id: span.id }, 'alice').trusted, false);
  assert.equal(resolveEvidence(runId, { kind: 'run_event', id: span.id }, 'bob').trusted, true);
  const publicContext = assembleCollaborationContext({ run: getRun(runId), dispatch: { ...dispatch, sourceMessageId: publicMessage.id }, agent, attemptId: 'public-context' });
  assert.doesNotMatch(publicContext, /SECRET_BOB|SECRET_ALICE|ROOT_PRIVATE_SECRET/);
  assert.equal(attemptAccess('public-context').visibility, 'public');
  const action = parseControlCall({ name: 'agent.consult', input: JSON.stringify({ targets: ['alice'], objective: 'secret', reason: 'private', visibility: 'private' }) }, ['host','alice','bob'], 'host', 2, { messageVisibilityVersion: 1 });
  assert.equal(action.visibility, 'private');
  assert.throws(() => parseControlCall({ name: 'agent.consult', input: JSON.stringify({ targets: ['alice'], objective: 'secret', reason: 'private', visibility: 'private' }) }, ['host','alice'], 'host', 2), /尚未启用/);
  assert.ok(collaborationControlTools(2, { messageVisibilityVersion: 1 }).find(t => t.name === 'agent.consult').parameters.properties.visibility);
  const intersection = intersectMessageAccess([secret, own]);
  assert.deepEqual(intersection.audience.sort(), ['host','user']);
  const restrictedAuthor = inbox.post({ runId, from: 'alice', to: 'user', kind: 'agent', body: 'owner only report', visibility: 'private', audience: ['user'] });
  assert.deepEqual(restrictedAuthor.audience, ['user'], 'explicit derived ACL must not auto-add the author');
  const result = inbox.post({ runId, from: 'system', to: 'host', kind: 'system', body: 'PRIVATE_AGGREGATE', ...intersection });
  assert.equal(inbox.listByConversation(roomId, 'alice').some(m => m.id === result.id), false);
  assert.equal(inbox.listByConversation(roomId, 'bob').some(m => m.id === result.id), false);
  assert.throws(() => inbox.post({ runId, from: 'host', to: 'alice', kind: 'agent', body: 'SECRET_ALICE', clientMessageId: 'secret-alice-id' }), /幂等键的可见范围/);
  const saved = db.get('SELECT segments FROM runtime_context_assemblies WHERE attempt_id=?', claim.attempt.id);
  assert.throws(() => persistRuntimeContextAssembly({ runId, workItemId: dispatch.id, attemptId: claim.attempt.id, segments: JSON.parse(saved.segments), context }), /可见范围发生漂移/);
  assert.doesNotMatch(conversationHistory(roomId, 99), /SECRET_ALICE|SECRET_BOB/);
  const request = { conversationId: roomId, replyTo: secret.id, agentIds: ['host','alice','bob'] };
  assert.equal(replyMessageAccess(request, 'collaboration', ['alice']).visibility, 'private');
  assert.throws(() => replyMessageAccess(request, 'collaboration', ['bob']), /可见范围/);
  assert.throws(() => replyMessageAccess(request, 'pipeline', ['alice']), /共享上下文/);
  const consult = { id: 'private-routing', name: 'agent.consult', input: JSON.stringify({ targets: ['bob'], objective: 'SECRET_ALICE', reason: 'invalid redistribution', visibility: 'private' }) };
  assert.throws(() => parseControlCall(consult, ['host','alice','bob'], 'host', 2,
    { messageVisibilityVersion: 1, messageAccess: { visibility: 'private', audience: ['user','host','alice'] } }), /不能扩大授权/);
  assert.equal(parseControlCall(consult, ['host','alice','bob'], 'host', 2,
    { messageVisibilityVersion: 1, messageAccess: { visibility: 'public', audience: [] } }).visibility, 'private');
  const unknownEvent = startSpan(runId, { spanKind: 'orchestration', name: 'unbound-audit' });
  endSpan(unknownEvent, { output: 'UNBOUND_SECRET', status: 'ok' });
  assert.equal(resolveEvidence(runId, { kind: 'run_event', id: unknownEvent.id }, 'alice').trusted, false);
  assert.equal(resolveEvidence(runId, { kind: 'run_event', id: unknownEvent.id }).trusted, true);
  store.finishAttempt({ attemptId: claim.attempt.id, dispatchId: dispatch.id, status: 'completed', output: 'PRIVATE_BOB_OUTPUT' });
  const handoff = inbox.post({ runId, from: 'bob', to: 'host', kind: 'agent', body: '继续私密任务', ...attemptAccess(claim.attempt.id) });
  const child = store.createDispatch({ runId, conversationId: roomId, sourceMessageId: handoff.id, parentDispatchId: dispatch.id, kind: 'handoff', from: 'bob', targetAgentId: 'host', depth: 1, idempotencyKey: 'private-handoff' });
  const capsule = minimalHandoffCapsule({ runId, dispatchId: child.id, sourceDispatchId: dispatch.id, sourceAttemptId: claim.attempt.id, objective: 'private', message: handoff.body, reason: 'test', sourceMessageId: handoff.id, completedWork: 'PRIVATE_BOB_OUTPUT' });
  saveHandoffCapsule(capsule);
  assert.equal(latestHandoffCapsule(child.id, runId, 'host').summary, handoff.body);
  assert.throws(() => latestHandoffCapsule(child.id, runId, 'alice'), /可见范围/);
  const publicHandoff = inbox.post({ runId, from: 'bob', to: 'host', kind: 'agent', body: 'PUBLIC_HANDOFF' });
  const publicChild = store.createDispatch({ runId, conversationId: roomId, sourceMessageId: publicHandoff.id,
    parentDispatchId: dispatch.id, kind: 'handoff', from: 'bob', targetAgentId: 'host', depth: 1, idempotencyKey: 'public-capsule-negative' });
  assert.throws(() => saveHandoffCapsule({ ...capsule, dispatchId: publicChild.id }), /可见范围/);
  store.cancelCollaborationRun(runId);
  // Exercise production aggregate propagation, without a model or network listener.
  const parentMessage = inbox.post({ runId: oldId, from: 'user', to: 'host', kind: 'user', body: 'two private cards' });
  const plan = planCollaborationAdmission({ runId: oldId, objective: parentMessage.body, participantIds: ['host','alice','bob'], targetAgentIds: ['host'],
    completionEngine: true, controlActionVersion: 2, contextContributorVersion: 1, messageVisibilityVersion: 1,
    exitGuard: { version: 1, maxCorrections: 1, correctionMaxTokens: 512 }, completionCandidateVersion: 1,
    successorObligationVersion: 1, evidenceBundleVersion: 1, durableHoldVersion: 2 });
  const parent = store.createDispatch({ runId: oldId, conversationId: roomId, sourceMessageId: parentMessage.id, kind: 'initial', from: 'user', targetAgentId: 'host', depth: 0, idempotencyKey: 'batch-parent' });
  observeAdmission(plan.contract, plan.subjects, [parent.id]);
  const parentClaim = store.claimNextDispatch(roomId, 'batch-parent-owner'); assert.ok(parentClaim);
  const batch = store.createBatch({ runId: oldId, conversationId: roomId, initiatorAgentId: 'host', sourceDispatchId: parent.id, question: parentMessage.body, targetAgentIds: ['alice','bob'], joinPolicy: 'all' });
  const children = ['alice','bob'].map(id => {
    const question = inbox.post({ runId: oldId, from: 'host', to: id, kind: 'agent', body: 'CARD_' + id, visibility: 'private' });
    return store.createDispatch({ runId: oldId, conversationId: roomId, sourceMessageId: question.id, parentDispatchId: parent.id, batchId: batch.id, kind: 'fanout', from: 'host', targetAgentId: id, depth: 1, idempotencyKey: 'batch:' + id });
  });
  const consultAction = { version: 2, type: 'consult', targetAgentIds: ['alice','bob'], objective: parentMessage.body, reason: 'test', join: 'all', visibility: 'private' };
  observeAction({ dispatchId: parent.id, attemptId: parentClaim.attempt.id, agentId: 'host', action: consultAction, childDispatchIds: children.map(c => c.id), batchId: batch.id });
  store.finishAttempt({ attemptId: parentClaim.attempt.id, dispatchId: parent.id, status: 'completed', output: 'waiting', action: consultAction });
  for (const sub of children) {
    const id = sub.targetAgentId;
    const subClaim = store.claimNextDispatch(roomId, 'batch-owner');
    assert.equal(subClaim.dispatch.id, sub.id);
    store.finishAttempt({ attemptId: subClaim.attempt.id, dispatchId: sub.id, status: 'completed', output: 'CONFIRMED_' + id });
  }
  reconcileCollaborationBatches(oldId);
  const aggregate = inbox.listByRun(oldId).find(m => m.body.startsWith('并行征询结果已汇总：'));
  assert.equal(aggregate.visibility, 'private'); assert.deepEqual(aggregate.audience.sort(), ['host','user']);
  assert.ok(inbox.listByConversation(roomId, 'alice').every(m => m.id !== aggregate.id));
  store.cancelCollaborationRun(oldId);
  // Sessions with the same role/account/room must reset when the information boundary changes.
  const sessionOpts = { run: getRun(runId), agent: { ...agent, version: 1, model: 'default', systemPrompt: 'test', execution: { kind: 'external', driver: 'codex-app-server', sessionPolicy: 'conversation' } }, messages: [{ role: 'user', content: 'test' }], attemptId: claim.attempt.id };
  const connection = { managed: true, cacheKey: 'fixture-account', runtimeHome: path.join(root, 'native-home') };
  const sessionExecution = createExecution({ runId, agentId: 'bob', scopeId: 'private-session', driver: 'codex-app-server', agentVersion: 1, cwd: root });
  const session = await prepareNativeSession(sessionOpts, sessionExecution, new AbortController().signal, false, connection);
  session.bind(randomUUID()); session.finish(true); session.release();
  persistRuntimeContextAssembly({ runId, workItemId: 'public-boundary', attemptId: 'public-boundary', segments: [], context: 'public' });
  const reset = await prepareNativeSession({ ...sessionOpts, attemptId: 'public-boundary' }, sessionExecution, new AbortController().signal, false, connection);
  assert.equal(reset.resume, false); assert.notEqual(reset.record.bindingKey, session.record.bindingKey); reset.finish(false); reset.release();
  updateExecution(sessionExecution.id, { status: 'cancelled' });
  const privateOptions = sdkOptions({ cwd: root, model: 'default', instructions: 'test', prompt: 'private', permissionMode: 'readonly', nativeTools: [], privateContext: true }, async () => false);
  assert.deepEqual(privateOptions.tools, []); assert.equal(privateOptions.maxTurns, undefined, 'privacy isolation must not apply correction limits');
  const known = createExecution({ runId, agentId: 'bob', scopeId: 'known-usage', driver: 'codex-app-server', agentVersion: 1, cwd: root });
  updateExecution(known.id, { status: 'completed', tokensIn: 2, tokensOut: 3, costUsd: null, progress: { nativeInvokedAt: now } });
  const knownSpan = startSpan(runId, { spanKind: 'llm', name: 'known-usage', attributes: { 'execution.id': known.id } });
  endSpan(knownSpan, { status: 'ok', tokensIn: 2, tokensOut: 3 });
  const budget = store.budgetSnapshot(runId);
  assert.equal(budget.tokens.used, 5); assert.equal(budget.usageCoverage.unknownTokenCalls, 1); assert.equal(budget.usageCoverage.unknownCostCalls, 2);
  // Queue timeout must keep its primary cause and must not start a model request.
  const previousTimeout = config.externalAgents.timeoutMs; config.externalAgents.timeoutMs = 25;
  reserveMember(oldId, 'bob', 'earlier-reservation');
  try {
    await assert.rejects(runAgentTurn({ run: getRun(oldId), agent, parentSpanId: span.id, executionScopeId: 'queue-test', messages: [] }), error => error.code === 'timeout' && error.details.phase === 'queue');
  } finally { config.externalAgents.timeoutMs = previousTimeout; }
  console.log('Message visibility verified: public routing, private context/evidence, aggregate boundaries, owner audit and historical isolation.');
} finally { db.closeDatabase(); await rm(root, { recursive: true, force: true }); }

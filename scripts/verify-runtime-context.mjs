import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-runtime-context-'));
process.env.DB_PATH = path.join(root, 'test.sqlite');
const db = await import('../apps/server/src/db/database.ts');
const store = await import('../apps/server/src/collaboration/store.ts');
const inbox = await import('../apps/server/src/messaging/inbox.ts');
const { getRun, startSpan, endSpan } = await import('../apps/server/src/runs/trace.ts');
const { executeToolOnce, listToolExecutions } = await import('../apps/server/src/tools/executions.ts');
const { workspaceRootDir } = await import('../apps/server/src/tools/builtin/index.ts');
const { createWorkspaceFileEvidence, resolveEvidence } = await import('../apps/server/src/runtime/evidence.ts');
const { minimalHandoffCapsule, saveHandoffCapsule, latestHandoffCapsule } = await import('../apps/server/src/runtime/capsule.ts');
const { assembleCollaborationContext } = await import('../apps/server/src/runtime/context.ts');

const runId = `context-${randomUUID()}`;
const otherRunId = `other-${randomUUID()}`;
const runRoot = workspaceRootDir({ runId });
function fixture(id, conversationId) {
  const now = new Date().toISOString();
  db.run('INSERT INTO conversations (id,title,mode,agent_ids,created_at,updated_at) VALUES (?,?,?,?,?,?)', conversationId, id, 'collaboration', '["a","b"]', now, now);
  db.run('INSERT INTO runs (id,goal,mode,conversation_id,turn_no,status,agent_ids,created_at) VALUES (?,?,?,?,?,?,?,?)', id, '修复登录', 'collaboration', conversationId, 1, 'running', '["a","b"]', now);
}

try {
  fixture(runId, `room-${runId}`);
  fixture(otherRunId, `room-${otherRunId}`);
  const otherMessage = inbox.post({ runId: otherRunId, from: 'user', to: 'a', kind: 'user', body: '跨 Run 私密内容' });
  const userMessage = inbox.post({ runId, from: 'user', to: 'a', kind: 'user', body: '请修复登录；api_key=abcdefgh1234567890' });
  const source = store.createDispatch({ runId, conversationId: `room-${runId}`, sourceMessageId: userMessage.id,
    kind: 'initial', from: 'user', targetAgentId: 'a', depth: 0, idempotencyKey: 'initial' });
  const claimed = store.claimNextDispatch(`room-${runId}`, 'owner');
  assert.equal(claimed?.dispatch.id, source.id);
  store.finishAttempt({ attemptId: claimed.attempt.id, dispatchId: source.id, status: 'completed', output: '已定位登录失效原因' });
  const handoffMessage = inbox.post({ runId, from: 'a', to: 'b', kind: 'agent', messageType: 'collaboration_handoff', body: '请完成登录修复' });
  const child = store.createDispatch({ runId, conversationId: `room-${runId}`, sourceMessageId: handoffMessage.id,
    parentDispatchId: source.id, kind: 'handoff', from: 'a', targetAgentId: 'b', depth: 1, idempotencyKey: 'handoff' });
  const minimal = minimalHandoffCapsule({ runId, dispatchId: child.id, sourceDispatchId: source.id,
    sourceAttemptId: claimed.attempt.id, objective: '修复登录', message: handoffMessage.body,
    reason: '需要编码', sourceMessageId: handoffMessage.id, completedWork: '已定位登录失效原因' });
  assert.equal(saveHandoffCapsule(minimal).version, 1);
  assert.equal(saveHandoffCapsule(minimal).version, 1);
  assert.throws(() => saveHandoffCapsule({ ...minimal, summary: '冲突' }), /同版本内容冲突/);
  assert.throws(() => saveHandoffCapsule({ ...minimal, version: 2, evidenceRefs: [{ kind: 'message', id: otherMessage.id }] }), /跨 Run/);
  assert.equal(resolveEvidence(runId, { kind: 'message', id: otherMessage.id }).trusted, false);
  assert.match(resolveEvidence(runId, { kind: 'message', id: userMessage.id }).excerpt, /REDACTED SECRET/);
  assert.equal(resolveEvidence(runId, { kind: 'attempt_output', id: claimed.attempt.id }).trusted, true);
  await executeToolOnce({ runId, agentId: 'a', attemptId: claimed.attempt.id, toolName: 'fs.read', input: '{}',
    idempotencyKey: `evidence:${runId}`, replayPolicy: 'safe', spanId: 'evidence-tool-span', execute: async () => '工具核验结果' });
  const toolRef = { kind: 'tool_execution', id: listToolExecutions(runId)[0].id };
  assert.equal(resolveEvidence(runId, toolRef).trusted, true);
  assert.equal(resolveEvidence(otherRunId, toolRef).trusted, false);
  const event = startSpan(runId, { spanKind: 'orchestration', name: 'evidence-check' });
  endSpan(event, { output: '运行证据', status: 'ok' });
  assert.equal(resolveEvidence(runId, { kind: 'run_event', id: event.id }).trusted, true);

  await mkdir(runRoot, { recursive: true });
  await writeFile(path.join(runRoot, 'proof.txt'), '已核验的文件内容');
  const fileRef = createWorkspaceFileEvidence(runId, 'proof.txt');
  assert.equal(resolveEvidence(runId, fileRef).trusted, true);
  assert.equal(resolveEvidence(otherRunId, fileRef).trusted, false);
  const outside = path.join(root, 'outside.txt');
  await writeFile(outside, '不能读到');
  await symlink(outside, path.join(runRoot, 'escape.txt'));
  assert.throws(() => createWorkspaceFileEvidence(runId, 'escape.txt'), /越出 Run 工作区/);
  const revised = { ...minimal, version: 2, evidenceRefs: [...minimal.evidenceRefs, fileRef] };
  saveHandoffCapsule(revised);
  assert.equal(latestHandoffCapsule(child.id, runId)?.version, 2);

  for (let index = 0; index < 40; index++) {
    inbox.post({ runId, from: 'a', to: 'b', kind: 'agent', body: `历史消息 ${index} ${'长内容'.repeat(500)}` });
  }
  const agent = { id: 'b', name: 'B', description: '实现者', capabilities: ['execute'] };
  const context = assembleCollaborationContext({ run: getRun(runId), dispatch: child, agent, attemptId: 'context-attempt-1' });
  assert.ok(context.length <= 24_000);
  assert.match(context, /交接 Capsule/);
  assert.match(context, /已核验的文件内容/);
  assert.doesNotMatch(context, /跨 Run 私密内容/);
  assert.doesNotMatch(context, /abcdefgh1234567890/);
  assert.equal(assembleCollaborationContext({ run: getRun(runId), dispatch: child, agent, attemptId: 'context-attempt-1' }), context);
  const record = db.get('SELECT * FROM runtime_context_assemblies WHERE attempt_id=?', 'context-attempt-1');
  assert.equal(record.char_count, context.length);
  assert.ok(JSON.parse(record.segments).some((segment) => segment.source === 'capsule'));
  await writeFile(path.join(runRoot, 'proof.txt'), '已经被篡改');
  assert.equal(resolveEvidence(runId, fileRef).trusted, false);
  const changedContext = assembleCollaborationContext({ run: getRun(runId), dispatch: child, agent, attemptId: 'context-attempt-2' });
  assert.match(changedContext, /证据不可用：文件内容已变化/);
  assert.doesNotMatch(changedContext, /已经被篡改/);
  console.log('Capsule、Evidence 与 Context 验证通过');
} finally {
  db.closeDatabase();
  await rm(runRoot, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}

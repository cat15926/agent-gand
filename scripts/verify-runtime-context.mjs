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
const { assembleCollaborationContext, assembleRuntimeContext } = await import('../apps/server/src/runtime/context.ts');
const { planCollaborationAdmission } = await import('../apps/server/src/runtime/subjectContract.ts');
const { executionPolicyForProfile } = await import('../apps/server/src/runtime/runPolicy.ts');
const { observeAction, observeAdmission } = await import('../apps/server/src/runtime/shadow.ts');

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
  const admission = planCollaborationAdmission({ runId, objective: '修复登录', participantIds: ['a', 'b'], targetAgentIds: ['a'],
    executionPolicy: executionPolicyForProfile('execute'), controlActionVersion: 2,
    exitGuard: { version: 1, maxCorrections: 1, correctionMaxTokens: 512 },
    completionCandidateVersion: 1, successorObligationVersion: 1, evidenceBundleVersion: 1,
    evidenceLoopGuardVersion: 1, contextContributorVersion: 1, durableHoldVersion: 2 });
  const source = db.tx(() => {
    const dispatch = store.createDispatch({ runId, conversationId: `room-${runId}`, sourceMessageId: userMessage.id,
      kind: 'initial', from: 'user', targetAgentId: 'a', depth: 0, idempotencyKey: 'initial' });
    observeAdmission(admission.contract, admission.subjects, [dispatch.id]);
    return dispatch;
  });
  const claimed = store.claimNextDispatch(`room-${runId}`, 'owner');
  assert.equal(claimed?.dispatch.id, source.id);
  const handoffMessage = inbox.post({ runId, from: 'a', to: 'b', kind: 'agent', messageType: 'collaboration_handoff', body: '请完成登录修复' });
  const child = store.createDispatch({ runId, conversationId: `room-${runId}`, sourceMessageId: handoffMessage.id,
    parentDispatchId: source.id, kind: 'handoff', from: 'a', targetAgentId: 'b', depth: 1, idempotencyKey: 'handoff' });
  const action = { version: 2, type: 'handoff', targetAgentId: 'b', objective: '修复登录', reason: '需要编码' };
  const [handoffObligation] = observeAction({ dispatchId: source.id, attemptId: claimed.attempt.id, agentId: 'a',
    action, childDispatchIds: [child.id], batchId: null });
  assert.ok(handoffObligation, 'Runtime 必须为 handoff 创建接球义务');
  store.finishAttempt({ attemptId: claimed.attempt.id, dispatchId: source.id, status: 'completed',
    output: '已定位登录失效原因', action });
  const minimal = minimalHandoffCapsule({ runId, dispatchId: child.id, sourceDispatchId: source.id,
    sourceAttemptId: claimed.attempt.id, objective: '修复登录', message: handoffMessage.body,
    reason: '需要编码', sourceMessageId: handoffMessage.id, completedWork: '已定位登录失效原因',
    successorObligationRefs: [{ obligationId: handoffObligation.id, generation: handoffObligation.generation }] });
  assert.equal(minimal.schemaVersion, 2);
  assert.deepEqual(minimal.successorObligationRefs,
    [{ obligationId: handoffObligation.id, generation: handoffObligation.generation }]);
  assert.equal(saveHandoffCapsule(minimal).version, 1);
  assert.equal(saveHandoffCapsule(minimal).version, 1);
  assert.throws(() => saveHandoffCapsule({ ...minimal,
    successorObligationRefs: [{ obligationId: handoffObligation.id, generation: handoffObligation.generation + 1 }] }),
  /伪造、跨 Run、过期或不匹配/);
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
  const subject = db.get(`SELECT s.id,s.subject_key,c.generation FROM runtime_dispatch_subjects m
    JOIN runtime_subjects s ON s.id=m.subject_id JOIN runtime_custody c ON c.subject_id=s.id WHERE m.dispatch_id=?`, child.id);
  const rejectedAt = new Date().toISOString();
  db.run(`INSERT INTO runtime_completion_candidates
    (id,run_id,subject_id,subject_key,attempt_id,generation,agent_id,action,summary,evidence_refs,
     exit_guard_status,exit_guard_reasons,status,reasons,retryable,feedback,idempotency_key,created_at,decided_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  `rejected-${runId}`, runId, subject.id, subject.subject_key, claimed.attempt.id, subject.generation, 'a',
  JSON.stringify({ version: 2, type: 'complete' }), '不完整结果', '[]', 'allow_candidate', '[]', 'rejected',
  JSON.stringify(['OPEN_REQUIRED_OBLIGATION']), 1, '请先完成接球义务后重试。', `rejected:${runId}`, rejectedAt, rejectedAt);

  for (let index = 0; index < 40; index++) {
    inbox.post({ runId, from: 'a', to: 'b', kind: 'agent', body: `历史消息 ${index} ${'长内容'.repeat(500)}` });
  }
  const agent = { id: 'b', name: 'B', description: '实现者', capabilities: ['execute'] };
  const context = assembleCollaborationContext({ run: getRun(runId), dispatch: child, agent, attemptId: 'context-attempt-1' });
  assert.ok(context.length <= 24_000);
  assert.match(context, /交接 Capsule/);
  assert.match(context, /schema 2/);
  assert.match(context, /Capsule 后继义务引用/);
  assert.match(context, new RegExp(handoffObligation.id));
  assert.match(context, /agent\.handoff、agent\.consult、agent\.hold、agent\.complete/);
  assert.match(context, /generation=/);
  assert.match(context, /请先完成接球义务后重试/);
  assert.match(context, /已核验的文件内容/);
  assert.doesNotMatch(context, /跨 Run 私密内容/);
  assert.doesNotMatch(context, /abcdefgh1234567890/);
  assert.equal(assembleCollaborationContext({ run: getRun(runId), dispatch: child, agent, attemptId: 'context-attempt-1' }), context);
  const record = db.get('SELECT * FROM runtime_context_assemblies WHERE attempt_id=?', 'context-attempt-1');
  assert.equal(record.char_count, context.length);
  const segments = JSON.parse(record.segments);
  assert.ok(segments.some((segment) => segment.source === 'capsule'));
  for (const sourceName of ['current_objective', 'allowed_actions', 'custody', 'responsibility_blockers',
    'obligation', 'completion_feedback', 'capsule_obligation_refs']) {
    const segment = segments.find((item) => item.source === sourceName);
    assert.ok(segment, `关键 Context 段 ${sourceName} 必须存在`);
    assert.equal(segment.protected, true);
    assert.equal(segment.truncated, false, `关键 Context 段 ${sourceName} 不得静默截断`);
  }
  assert.ok(segments.every((segment) => Number.isInteger(segment.priority) && segment.maxChars > 0
    && segment.sensitivePolicy === 'redact' && Array.isArray(segment.provenance) && typeof segment.protected === 'boolean'),
  'Context Contributor 必须保存优先级、分段预算、敏感信息策略和 provenance');
  assert.throws(() => assembleRuntimeContext({ runId, workItemId: child.id, attemptId: 'context-protected-overflow', maxChars: 32,
    contributors: [{ source: 'critical', text: 'x'.repeat(40), priority: 100, maxChars: 30,
      sensitivePolicy: 'redact', provenance: ['test'], protected: true }] }), /受保护 Context 段/,
  '受保护段不能被静默截断');
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

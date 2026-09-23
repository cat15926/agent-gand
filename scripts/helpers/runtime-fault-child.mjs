const mode = process.argv[2];
const runId = process.env.TEST_RUN_ID;
const conversationId = process.env.TEST_CONVERSATION_ID;
const dispatchId = process.env.TEST_DISPATCH_ID;
const attemptId = process.env.TEST_ATTEMPT_ID;
const { tx } = await import('../../apps/server/src/db/database.ts');
const store = await import('../../apps/server/src/collaboration/store.ts');
const { planCollaborationAdmission } = await import('../../apps/server/src/runtime/subjectContract.ts');
const { observeAction, observeAdmission } = await import('../../apps/server/src/runtime/shadow.ts');
const { minimalHandoffCapsule, saveHandoffCapsule } = await import('../../apps/server/src/runtime/capsule.ts');
const { post } = await import('../../apps/server/src/messaging/inbox.ts');

function crash() { process.kill(process.pid, 'SIGKILL'); }

if (mode === 'admission_before' || mode === 'admission_after') {
  tx(() => {
    const dispatch = store.createDispatch({ runId, conversationId, sourceMessageId: `source:${runId}`,
      kind: 'initial', from: 'user', targetAgentId: 'a', depth: 0, idempotencyKey: `initial:${runId}` });
    const plan = planCollaborationAdmission({ runId, objective: '崩溃注入', participantIds: ['a', 'b'], targetAgentIds: ['a'] });
    observeAdmission(plan.contract, plan.subjects, [dispatch.id]);
    if (mode === 'admission_before') crash();
  });
  crash();
} else if (mode === 'claim_before' || mode === 'claim_after') {
  if (mode === 'claim_before') tx(() => {
    store.claimNextDispatch(conversationId, `child:${process.pid}`);
    crash();
  });
  else {
    store.claimNextDispatch(conversationId, `child:${process.pid}`);
    crash();
  }
} else if (mode === 'handoff_before' || mode === 'handoff_after') {
  tx(() => {
    const message = post({ runId, from: 'a', to: 'b', kind: 'agent', messageType: 'collaboration_handoff', body: '继续处理交接事项' });
    const child = store.createDispatch({ runId, conversationId, sourceMessageId: message.id,
      parentDispatchId: dispatchId, kind: 'handoff', from: 'a', targetAgentId: 'b', depth: 1,
      idempotencyKey: `handoff:${runId}` });
    observeAction({ dispatchId, attemptId, agentId: 'a', action: {
      type: 'handoff', targetAgentId: 'b', message: '继续', reason: '崩溃测试',
    }, childDispatchIds: [child.id], batchId: null });
    store.finishAttempt({ attemptId, dispatchId, status: 'completed' });
    saveHandoffCapsule(minimalHandoffCapsule({ runId, dispatchId: child.id, sourceDispatchId: dispatchId,
      sourceAttemptId: attemptId, objective: '崩溃注入', message: message.body, reason: '继续',
      sourceMessageId: message.id, completedWork: '' }));
    if (mode === 'handoff_before') crash();
  });
  crash();
} else if (mode === 'renew') {
  store.renewCollaborationLeases(process.env.TEST_LEASE_OWNER);
} else if (mode === 'expire') {
  store.interruptExpiredAttempts({ onlyExpired: true });
} else if (mode === 'race_claim') {
  const claimed = store.claimNextDispatch(conversationId, `racer:${process.pid}`);
  process.stdout.write(claimed?.attempt.id ?? 'none');
} else if (mode === 'tool_crash') {
  const { executeToolOnce } = await import('../../apps/server/src/tools/executions.ts');
  await executeToolOnce({ runId, agentId: 'b', attemptId, toolName: 'external.write', input: '{}',
    idempotencyKey: `tool:${runId}`, replayPolicy: 'manual', spanId: `span:${attemptId}`,
    execute: async () => crash() });
} else if (mode === 'assemble_context') {
  const { getRun } = await import('../../apps/server/src/runs/trace.ts');
  const { assembleCollaborationContext } = await import('../../apps/server/src/runtime/context.ts');
  const context = assembleCollaborationContext({ run: getRun(runId), dispatch: store.getDispatch(dispatchId),
    agent: { id: 'b', name: 'B', description: '接球者', capabilities: ['execute'] }, attemptId });
  process.stdout.write(context.includes('交接 Capsule') ? 'capsule' : 'missing');
} else {
  throw new Error(`未知故障注入模式：${mode}`);
}

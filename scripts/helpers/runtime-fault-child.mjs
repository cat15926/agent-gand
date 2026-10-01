const mode = process.argv[2];
const runId = process.env.TEST_RUN_ID;
const conversationId = process.env.TEST_CONVERSATION_ID;
const dispatchId = process.env.TEST_DISPATCH_ID;
const attemptId = process.env.TEST_ATTEMPT_ID;
const { tx } = await import('../../apps/server/src/db/database.ts');
const store = await import('../../apps/server/src/collaboration/store.ts');
const { planCollaborationAdmission } = await import('../../apps/server/src/runtime/subjectContract.ts');
const { executionPolicyForProfile } = await import('../../apps/server/src/runtime/runPolicy.ts');
const { observeAction, observeAdmission } = await import('../../apps/server/src/runtime/shadow.ts');
const { minimalHandoffCapsule, saveHandoffCapsule } = await import('../../apps/server/src/runtime/capsule.ts');
const { post } = await import('../../apps/server/src/messaging/inbox.ts');

function crash() { process.kill(process.pid, 'SIGKILL'); }

function terminalCommand(status = 'completed') {
  const { commitRunTerminal } = globalThis.__runtimeTerminalModule;
  const completed = status === 'completed';
  return commitRunTerminal({
    runId,
    status,
    disposition: completed ? 'accepted' : status,
    source: `fault_child:${mode}`,
    userMessageStatus: completed ? 'responded' : 'failed',
    prepare: () => ({
      ...(completed ? { completion: {
        input: {
          contract: { version: 1, runId, objective: '终局崩溃注入', participantIds: [],
            requiredSubjectKeys: [], completionPolicy: 'all_required', partialFailurePolicy: 'needs_attention' },
          subjects: [], dispatches: [], pendingDecisions: 0, batchStatuses: [], hasAnyOutput: true,
          dependenciesSatisfied: true, requiredArtifactsSatisfied: true, reviewAccepted: true,
          protocolTerminal: true, successorObligationsSatisfied: true,
        },
        evaluation: { status: 'accepted', reasons: [], disposition: 'normal' },
      } } : {}),
      reasonCodes: completed ? [] : [`${status.toUpperCase()}_BY_RACE`],
      report: { from: 'system', to: 'user', kind: 'system', messageType: completed ? 'collaboration_result' : 'informational',
        body: `terminal:${status}`, clientMessageId: `runtime:completion:${runId}` },
    }),
  });
}

if (mode === 'admission_before' || mode === 'admission_after') {
  tx(() => {
    const dispatch = store.createDispatch({ runId, conversationId, sourceMessageId: `source:${runId}`,
      kind: 'initial', from: 'user', targetAgentId: 'a', depth: 0, idempotencyKey: `initial:${runId}` });
    const plan = planCollaborationAdmission({ runId, objective: '崩溃注入', participantIds: ['a', 'b'], targetAgentIds: ['a'],
      executionPolicy: executionPolicyForProfile('atomic_compat'), controlActionVersion: 2,
      completionCandidateVersion: 1, successorObligationVersion: 1, evidenceBundleVersion: 1,
      evidenceLoopGuardVersion: 1, contextContributorVersion: 1, durableHoldVersion: 1 });
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
} else if (mode === 'hold_claim') {
  const { claimReadyDurableHolds } = await import('../../apps/server/src/runtime/holds.ts');
  const claimed = claimReadyDurableHolds({ claimOwner: `hold-racer:${process.pid}`, runId });
  process.stdout.write(claimed[0]?.id ?? 'none');
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
} else if (mode === 'terminal_before' || mode === 'terminal_after' || mode === 'terminal_race') {
  globalThis.__runtimeTerminalModule = await import('../../apps/server/src/runtime/terminal.ts');
  if (mode === 'terminal_before') {
    tx(() => {
      terminalCommand('completed');
      crash();
    });
  } else if (mode === 'terminal_after') {
    terminalCommand('completed');
    crash();
  } else {
    const result = terminalCommand(process.env.TEST_TERMINAL_STATUS || 'completed');
    process.stdout.write(JSON.stringify({ committed: result.committed, status: result.terminal.status }));
  }
} else if (mode === 'action_handoff_before' || mode === 'action_handoff_after' || mode === 'action_handoff_race') {
  const { commitHandoffActionCommand } = await import('../../apps/server/src/runtime/actionCommands.ts');
  const execute = () => {
    const message = post({ runId, from: 'a', to: 'b', kind: 'agent', messageType: 'collaboration_handoff',
      body: '跨进程原子交接', clientMessageId: `action-handoff:${runId}:message` });
    const child = store.createDispatchDetailed({ runId, conversationId, sourceMessageId: message.id,
      parentDispatchId: dispatchId || null, kind: 'handoff', from: 'a', targetAgentId: 'b', reason: '原子命令验收',
      depth: 1, idempotencyKey: `action-handoff:${runId}:dispatch`, dedupeText: '跨进程原子交接' });
    if (mode === 'action_handoff_before') crash();
    return { messageId: message.id, dispatchId: child.dispatch.id };
  };
  const result = commitHandoffActionCommand({ runId, dispatchId: dispatchId || null,
    commandKey: `action-handoff:${runId}`, execute });
  if (mode === 'action_handoff_after') crash();
  process.stdout.write(JSON.stringify({ committed: result.committed, ...result.result }));
} else {
  throw new Error(`未知故障注入模式：${mode}`);
}

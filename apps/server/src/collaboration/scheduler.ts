import { randomUUID } from 'node:crypto';
import { intersectMessageAccess } from '@agent-gand/shared';
import { assertMessageAccess, attemptAccess, messageAccess } from '../messaging/access.ts';
import type {
  AgentDefinition,
  CollaborationDispatch,
  Conversation,
  Run,
  RuntimeControlAction,
  RuntimeDurableHoldCondition,
  RuntimeRouteGuardEvent,
  RuntimeSuccessorObligation,
} from '@agent-gand/shared';
import { config } from '../config.ts';
import { settleRequestedPause } from '../runtime/runControls.ts';
import { afterCommit, all, get, tx } from '../db/database.ts';
import { listByConversation, listByRun, post, postSystem, updateRunUserMessageStatus } from '../messaging/inbox.ts';
import { endSpan, getRun, listEvents, listRunAgentSnapshots, setRunStatus, startSpan } from '../runs/trace.ts';
import { runAgentTurn, SESSION_BOUNDARY_DIRECTIVE, type AgentTurnResult } from '../orchestration/agentStep.ts';
import { collaborationControlTools, parseControlCall } from './controlTools.ts';
import { classifyCollaborationTurnExit } from './turnExit.ts';
import { planCollaborationAdmission } from '../runtime/subjectContract.ts';
import { observeAction, observeAdmission, observeAggregateLink, observeTechnicalBlock, observeTerminalInterruption } from '../runtime/shadow.ts';
import { minimalHandoffCapsule, saveHandoffCapsule } from '../runtime/capsule.ts';
import { assembleCollaborationContext } from '../runtime/context.ts';
import { describeCompletionReason, evaluateCompletion } from '../runtime/completion.ts';
import { isCompletionEngineRun, loadCompletionSnapshot, recordCompletionEvaluation } from '../runtime/completionStore.ts';
import {
  answerCandidateControlAction,
  freezeRuntimeContract,
  normalizeRuntimeControlAction,
  runtimeConsultAnyVersion,
  runtimeControlActionVersion,
} from '../runtime/controlAction.ts';
import {
  evaluateExitGuard,
  runtimeExitGuardPolicy,
  type RuntimeExitGuardEvaluation,
  type RuntimeExitGuardInput,
  type RuntimeExitGuardPolicy,
  type RuntimeExitStopReason,
} from '../runtime/exitGuard.ts';
import {
  runtimeCompletionCandidateVersion,
  submitCompletionCandidate,
} from '../runtime/subjectCompletion.ts';
import {
  activeConversationState,
  budgetExceeded,
  budgetSnapshot,
  claimNextDispatch,
  createBatch,
  createDecision,
  createDispatch,
  createDispatchDetailed,
  finishAttempt,
  getBatch,
  getCompletedDispatchOutput,
  expireBatch,
  getDispatch,
  hasPendingDecision,
  isActiveAttempt,
  listConversationDispatches,
  listDispatches,
  listAttempts,
  setAttemptInputContext,
  updateBatch,
  listRecoverableConversationIds,
  listRunningCollaborationRunIds,
  listOpenBatches,
  listUnaggregatedBatches,
  interruptExpiredAttempts,
  renewCollaborationLeases,
  selectAnyBatchWinner,
} from './store.ts';
import { emit, subscribe } from '../messaging/bus.ts';
import { onMemberAvailable } from '../execution/memberAdmission.ts';
import { listToolExecutions } from '../tools/executions.ts';
import { persistRouteGuardEvent, recordEvidenceAwareRoute, runtimeEvidenceLoopGuardVersion } from '../runtime/loopGuard.ts';
import {
  createDurableHold,
  resolveRunDependencySubjectIds,
  runtimeDurableHoldVersion,
  runtimeExternalWaitVersion,
} from '../runtime/holds.ts';
import { loadResponsibilitySnapshot } from '../runtime/responsibilitySnapshot.ts';
import { commitRunTerminal } from '../runtime/terminal.ts';
import { continuationRouteBlock } from '../runtime/recovery.ts';
import {
  commitCompleteActionCommand,
  commitConsultAnyActionCommand,
  commitConsultAllActionCommand,
  commitHandoffActionCommand,
  commitHoldActionCommand,
  type RuntimeActionCommandInput,
} from '../runtime/actionCommands.ts';
import { settleConsultAnyJoin } from '../runtime/obligations.ts';
import {
  executionPolicyForProfile,
  resolveRunPolicy,
  runtimeOwnsCompletion,
  runtimeStateEnabled,
  assertExecutableCollaborationPolicy,
  loadRuntimeContract,
} from '../runtime/runPolicy.ts';

const leaseOwner = `server:${process.pid}:${randomUUID()}`;
const activeConversations = new Set<string>();
const dirtyConversations = new Set<string>();
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

class CollaborationGuardError extends Error {
  constructor(message: string, readonly code: 'depth' | 'targets' | 'ping_pong' | 'action',
    readonly preservedOutput: string | null = null,
    readonly routeGuard: RuntimeRouteGuardEvent | null = null) { super(message); }
}

class StaleAttemptError extends Error {}

function collaborationSpan(runId: string) {
  return listEvents(runId).find((event) => event.spanKind === 'orchestration' && event.name === `collaboration:${runId}`);
}

function ensureCollaborationSpan(run: Run) {
  return collaborationSpan(run.id) ?? startSpan(run.id, {
    spanKind: 'orchestration', name: `collaboration:${run.id}`, input: run.goal,
    attributes: { 'orchestration.phase': 'collaboration.run' },
  });
}

export function closeCollaborationTrace(runId: string, outcome: 'completed' | 'failed' | 'cancelled'): void {
  const root = collaborationSpan(runId);
  if (root?.status === 'running') endSpan(root, { output: outcome, status: outcome === 'completed' ? 'ok' : 'error' });
}

export interface CollaborationAdmissionInput {
  recipientIds?: string[];
  replyTo?: string | null;
  taskId?: string | null;
  clientMessageId?: string;
}

function emitScheduler(conversationId: string): void {
  const state = activeConversationState(conversationId);
  emit({ type: 'collaboration.scheduler.updated', conversationId, ...state });
}

function initialTargets(run: Run, conversation: Conversation, input: CollaborationAdmissionInput, sourceMessageId: string): string[] {
  if (input.recipientIds?.length) return [...new Set(input.recipientIds)].slice(0, config.collaboration.maxTargets);
  if (input.replyTo) {
    const replied = listByConversation(conversation.id).find((message) => message.id === input.replyTo);
    if (replied?.kind === 'agent' && run.agentIds.includes(replied.from)) return [replied.from];
  }
  const recent = [...listByConversation(conversation.id)].reverse().find((message) =>
    message.id !== sourceMessageId && message.kind === 'agent' && message.messageType !== 'collaboration_contribution' && run.agentIds.includes(message.from));
  return recent ? [recent.from] : run.agentIds.slice(0, 1);
}

export function admitCollaborationRun(run: Run, conversation: Conversation, input: CollaborationAdmissionInput = {}): void {
  let userMessage = listByRun(run.id).find((message) => message.kind === 'user');
  if (!userMessage) {
    userMessage = post({ runId: run.id, from: 'user', to: input.recipientIds?.join(',') || 'all', kind: 'user', body: run.goal,
      replyTo: input.replyTo ?? null, taskId: input.taskId ?? null, clientMessageId: input.clientMessageId, deliveryStatus: 'processing' });
  }
  const executionPolicy = executionPolicyForProfile('execute');
  const targets = initialTargets(run, conversation, input, userMessage.id);
  for (const target of targets) assertMessageAccess(messageAccess(userMessage.id), target, '初始任务');
  if (targets.length === 0) {
    commitRunTerminal({ runId: run.id, status: 'failed', disposition: 'failed',
      source: 'collaboration_admission', userMessageStatus: 'failed', prepare: () => ({
        reasonCodes: ['NO_AVAILABLE_AGENT'], report: { from: 'system', to: 'user', kind: 'system',
          messageType: 'informational', body: '当前聊天室没有可用 Agent',
          clientMessageId: `runtime:no-available-agent:${run.id}` },
      }) });
    return;
  }
  const createAdmission = () => {
    setRunStatus(run.id, 'running');
    ensureCollaborationSpan(run);
    const planned = planCollaborationAdmission({ runId: run.id, objective: run.goal, participantIds: run.agentIds,
      targetAgentIds: targets, completionEngine: true, executionPolicy, controlActionVersion: 2,
      exitGuard: { version: 1, maxCorrections: config.collaboration.exitGuardMaxCorrections,
        correctionMaxTokens: config.collaboration.exitGuardCorrectionMaxTokens },
      completionCandidateVersion: 1, successorObligationVersion: 1,
      evidenceBundleVersion: 1, evidenceLoopGuardVersion: 1, contextContributorVersion: 1,
      durableHoldVersion: 2, externalWaitVersion: 1, consultAnyVersion: 1, progressDigestVersion: 1, messageVisibilityVersion: 1 });
    freezeRuntimeContract(planned.contract);
    const initialDispatches = targets.map((target) => createDispatch({
      runId: run.id, conversationId: conversation.id, sourceMessageId: userMessage.id,
      kind: 'initial', from: 'user', targetAgentId: target, reason: '用户发起协作', depth: 0,
      idempotencyKey: `initial:${userMessage.id}:${target}`, dedupeText: userMessage.body,
    }));
    observeAdmission(planned.contract, planned.subjects, initialDispatches.map((item) => item.id));
  };
  // Run 状态、冻结 Contract、初始 Dispatch 与 Subject 同属一个 admission 提交单元。
  tx(createAdmission);
  updateRunUserMessageStatus(run.id, 'processing');
  kickCollaboration(conversation.id);
}

export function kickCollaboration(conversationId: string): void {
  if (activeConversations.has(conversationId)) { dirtyConversations.add(conversationId); return; }
  activeConversations.add(conversationId);
  queueMicrotask(() => void drain(conversationId));
}

async function drain(conversationId: string): Promise<void> {
  try {
    do {
      dirtyConversations.delete(conversationId);
      await pauseExceededRuns(conversationId);
      for (;;) {
        const claimed = claimNextDispatch(conversationId, leaseOwner);
        if (!claimed) break;
        void executeDispatch(claimed.dispatch, claimed.attempt.id).finally(() => kickCollaboration(conversationId));
      }
      for (const runId of new Set(listConversationDispatches(conversationId).filter((item) => item.status === 'blocked').map((item) => item.runId))) {
        finalizeRun(runId);
      }
      emitScheduler(conversationId);
    } while (dirtyConversations.has(conversationId));
  } finally {
    activeConversations.delete(conversationId);
    if (dirtyConversations.delete(conversationId)) kickCollaboration(conversationId);
  }
}

async function pauseExceededRuns(conversationId: string): Promise<void> {
  const runIds = [...new Set(listConversationDispatches(conversationId).filter((d) => d.status === 'queued').map((d) => d.runId))];
  for (const runId of runIds) {
    const item = getRun(runId);
    if (!item || item.status !== 'running' || hasPendingDecision(runId)) continue;
    const dimension = budgetExceeded(runId);
    if (!dimension) continue;
    const snapshot = budgetSnapshot(runId);
    const message = post({ runId, from: 'system', to: 'user', kind: 'system', messageType: 'collaboration_wait_user',
      body: `协作预算已达到上限（${dimension}）。请选择按当前结果终止，或按比例增加预算后继续。`,
      payload: { decisionKind: 'budget_exhausted', dimension, budget: snapshot } });
    createDecision({ runId, conversationId, idempotencyKey: `budget:${runId}:${snapshot.revisions.length}`,
      kind: 'budget_exhausted', promptMessageId: message.id, payload: { dimension, budget: snapshot } });
    setRunStatus(runId, 'waiting_for_user');
  }
}

function terminalRunStatus(status: Run['status']): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

function internalFanoutOutput(dispatch: CollaborationDispatch, content: string, action: RuntimeControlAction): string | null {
  if (dispatch.kind !== 'fanout') return null;
  if (action.type === 'complete' || action.type === 'answer_candidate') return content.trim() || '已完成并行征询子任务。';
  if (action.type !== 'handoff' || !dispatch.batchId) return null;
  const batch = getBatch(dispatch.batchId);
  if (batch?.initiatorAgentId !== action.targetAgentId) return null;
  return action.objective.trim();
}

function effectiveTurnOutput(turn: AgentTurnResult, action: RuntimeControlAction | null): string {
  if (action?.type === 'complete' && action.summary?.trim()) return action.summary.trim();
  const body = turn.content.trim();
  if (body.length > 0) return body;
  return '';
}

function exitGuardInput(input: {
  run: Run;
  dispatch: CollaborationDispatch;
  attemptId: string;
  agentId: string;
  turn: AgentTurnResult;
  action: RuntimeControlAction | null;
  stopReason: RuntimeExitStopReason;
  correctionAttempt: number;
  policy: RuntimeExitGuardPolicy;
}): RuntimeExitGuardInput {
  const runtimePolicy = resolveRunPolicy(input.run.id);
  const allowImplicitAnswer = runtimePolicy.implicitAnswerPolicy === 'initial_and_consultation'
    && (input.dispatch.kind === 'initial' || input.dispatch.kind === 'fanout');
  const responsibility = loadResponsibilitySnapshot({ runId: input.run.id,
    dispatchId: input.dispatch.id, attemptId: input.attemptId });
  return {
    stopReason: input.stopReason,
    action: input.action,
    output: effectiveTurnOutput(input.turn, input.action),
    hasActiveCustody: isActiveAttempt(input.attemptId, input.dispatch.id),
    holderMatches: input.dispatch.targetAgentId === input.agentId,
    completionBlockers: !runtimeStateEnabled(runtimePolicy) ? [] : responsibility?.completionBlockers ?? [{
      code: 'ATTEMPT_MISSING', category: 'stale_responsibility', refType: 'attempt', refId: input.attemptId,
      message: '无法加载当前 Attempt 的责任快照',
    }],
    allowImplicitAnswer,
    protocolRequiresExplicit: !allowImplicitAnswer,
    evidenceCount: listToolExecutions(input.run.id)
      .filter((item) => item.attemptId === input.attemptId && item.status === 'completed').length,
    correctionAttempt: input.correctionAttempt,
    correctionBudgetAvailable: budgetExceeded(input.run.id) === null,
    policy: input.policy,
  };
}

function traceExitGuard(runId: string, parentSpanId: string, dispatch: CollaborationDispatch, agentId: string,
  input: RuntimeExitGuardInput, evaluation: RuntimeExitGuardEvaluation): void {
  const span = startSpan(runId, {
    parentId: parentSpanId,
    spanKind: 'orchestration',
    name: `exit_guard:${evaluation.status}`,
    input: JSON.stringify(input),
    attributes: {
      'agent.id': agentId,
      'collaboration.dispatch.id': dispatch.id,
      'orchestration.phase': 'collaboration.exit_guard',
      'runtime.exit_guard.status': evaluation.status,
      'runtime.exit_guard.reasons': evaluation.reasons.join(','),
      'runtime.exit_guard.correction_attempt': input.correctionAttempt,
    },
  });
  endSpan(span, { output: JSON.stringify(evaluation),
    status: evaluation.status === 'fail_attempt' || evaluation.status === 'needs_attention' ? 'error' : 'ok' });
}

interface ActionApplicationResult {
  outputMessageId: string | null;
  childDispatchIds: string[];
  batchId: string | null;
  decisionId: string | null;
  deduplicatedTo: string | null;
}

const emptyActionResult = (): ActionApplicationResult => ({
  outputMessageId: null, childDispatchIds: [], batchId: null, decisionId: null, deduplicatedTo: null,
});

function commitCollaborationAction<T>(action: RuntimeControlAction, observedAction: RuntimeControlAction,
  input: RuntimeActionCommandInput<T>) {
  if (observedAction.type === 'complete' || observedAction.type === 'answer_candidate') {
    return commitCompleteActionCommand(input);
  }
  if (action.type === 'handoff') return commitHandoffActionCommand(input);
  if (action.type === 'consult' && action.join === 'all') return commitConsultAllActionCommand(input);
  if (action.type === 'consult' && action.join === 'any') return commitConsultAnyActionCommand(input);
  if (action.type === 'hold') return commitHoldActionCommand(input);
  throw new CollaborationGuardError(`动作 ${action.type} 没有 Runtime 命令边界`, 'action');
}

async function executeDispatch(dispatch: CollaborationDispatch, attemptId: string): Promise<void> {
  const run = getRun(dispatch.runId);
  const agent = listRunAgentSnapshots(dispatch.runId).find((item) => item.id === dispatch.targetAgentId);
  if (!run || !agent) {
    finishAttempt({ attemptId, dispatchId: dispatch.id, status: 'failed', error: 'Run 或 Agent 快照不存在' });
    if (run) finalizeRun(run.id);
    return;
  }
  if (terminalRunStatus(run.status)) {
    finishAttempt({ attemptId, dispatchId: dispatch.id, status: 'cancelled', error: `Run 已进入终态：${run.status}` });
    return;
  }
  const runtimePolicy = assertExecutableCollaborationPolicy(run.id);
  let inputContext: string;
  try {
    inputContext = assembleCollaborationContext({ run, dispatch, agent, attemptId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishAttempt({ attemptId, dispatchId: dispatch.id, status: 'failed', dispatchStatus: 'blocked', error: `CONTEXT_ASSEMBLY_FAILED: ${message}` });
    postSystem(run.id, 'user', `协作上下文组装失败：${message}`);
    finalizeRun(run.id);
    return;
  }
  setAttemptInputContext(attemptId, inputContext);
  const rootSpan = ensureCollaborationSpan(run);
  const dispatchSpan = startSpan(run.id, { parentId: rootSpan.id, spanKind: 'orchestration', name: `dispatch:${dispatch.id}`,
    input: JSON.stringify({ dispatchId: dispatch.id, sourceMessageId: dispatch.sourceMessageId, parentDispatchId: dispatch.parentDispatchId, targetAgentId: agent.id, depth: dispatch.depth, budget: budgetSnapshot(run.id) }),
    attributes: { 'agent.id': agent.id, 'collaboration.dispatch.id': dispatch.id, 'collaboration.attempt.id': attemptId, ...(dispatch.batchId ? { 'collaboration.batch.id': dispatch.batchId } : {}), 'orchestration.phase': 'collaboration.dispatch' } });
  const agentSpan = startSpan(run.id, { parentId: dispatchSpan.id, spanKind: 'agent', name: `agent:${agent.id}`, input: JSON.stringify({ dispatchId: dispatch.id, sourceMessageId: dispatch.sourceMessageId, depth: dispatch.depth, budget: budgetSnapshot(run.id) }),
    attributes: { 'agent.id': agent.id, 'agent.role': 'collaborator', 'collaboration.dispatch.id': dispatch.id, 'collaboration.attempt.id': attemptId,
      ...(dispatch.batchId ? { 'collaboration.batch.id': dispatch.batchId } : {}), 'orchestration.phase': 'collaboration.dispatch' } });
  let controlSpan: ReturnType<typeof startSpan> | null = null;
  try {
    const actionVersion = runtimeControlActionVersion(run.id);
    const guardPolicy = runtimeExitGuardPolicy(run.id);
    const externalWaitVersion = runtimeExternalWaitVersion(run.id);
    const consultAnyVersion = runtimeConsultAnyVersion(run.id);
    const messageVisibilityVersion = loadRuntimeContract(run.id)?.features?.messageVisibilityVersion ?? null;
    const controlTools = collaborationControlTools(runtimePolicy.toolApiVersion, { externalWaitVersion, consultAnyVersion, messageVisibilityVersion });
    const privateContext = attemptAccess(attemptId).visibility === 'private';
    const turn = await runAgentTurn({ run, agent, parentSpanId: agentSpan.id, agentId: agent.id, attemptId,
      privateContext, disableTools: privateContext,
      executionScopeId: `collaboration:${dispatch.id}`,
      messages: [{ role: 'system', content: agent.systemPrompt }, { role: 'system', content: SESSION_BOUNDARY_DIRECTIVE }, { role: 'user', content: inputContext }],
      controlTools,
      handleControlCalls: (calls) => parseControlCall(calls[0]!, run.agentIds, agent.id, actionVersion,
        { externalWaitVersion, consultAnyVersion, messageVisibilityVersion, messageAccess: attemptAccess(attemptId) }),
      ...(guardPolicy ? {
        exitCorrectionMaxTokens: guardPolicy.correctionMaxTokens,
        reviewExit: (candidate: AgentTurnResult, correctionAttempt: number) => {
          const candidateExit = classifyCollaborationTurnExit(candidate);
          if (candidateExit.kind === 'truncated' || candidateExit.kind === 'approval_wait' || candidateExit.kind === 'empty') {
            return { status: 'allow' as const };
          }
          const candidateNormalized = candidateExit.kind === 'control_action'
            ? normalizeRuntimeControlAction(candidate.controlAction, { expectedVersion: actionVersion })
            : answerCandidateControlAction(actionVersion);
          const candidateAction = candidateNormalized.ok ? candidateNormalized.action : null;
          const input = exitGuardInput({ run, dispatch, attemptId, agentId: agent.id, turn: candidate,
            action: candidateAction, stopReason: 'normal', correctionAttempt, policy: guardPolicy });
          const evaluation = evaluateExitGuard(input);
          if (evaluation.status === 'continue_same_turn') {
            traceExitGuard(run.id, agentSpan.id, dispatch, agent.id, input, evaluation);
            return { status: 'continue_same_turn' as const, feedback: evaluation.feedback };
          }
          return { status: 'allow' as const };
        },
      } : {}),
    });
    if (getDispatch(dispatch.id)?.status === 'cancelled') {
      endSpan(agentSpan, { output: '用户已停止该 Agent，本次结果已丢弃', status: 'error' });
      endSpan(dispatchSpan, { output: 'cancelled', status: 'error' });
      finalizeRun(run.id);
      return;
    }
    const currentRun = getRun(run.id);
    if (!currentRun || terminalRunStatus(currentRun.status)) {
      finishAttempt({ attemptId, dispatchId: dispatch.id, status: 'cancelled', error: `Run 已进入终态：${currentRun?.status ?? 'missing'}` });
      endSpan(agentSpan, { output: 'Run 已结束，本次迟到结果已丢弃', status: 'error' });
      endSpan(dispatchSpan, { output: 'late_result_cancelled', status: 'error' });
      return;
    }
    const exit = classifyCollaborationTurnExit(turn);
    if (exit.kind === 'truncated' || exit.kind === 'approval_wait' || exit.kind === 'empty') {
      if (guardPolicy) {
        const stopReason: RuntimeExitStopReason = exit.kind === 'truncated' ? 'truncated'
          : exit.kind === 'approval_wait' ? 'approval_wait' : 'empty';
        const input = exitGuardInput({ run, dispatch, attemptId, agentId: agent.id, turn, action: null,
          stopReason, correctionAttempt: turn.exitCorrectionAttempts ?? 0, policy: guardPolicy });
        traceExitGuard(run.id, agentSpan.id, dispatch, agent.id, input, evaluateExitGuard(input));
      }
      const reason = `${exit.code}: ${exit.detail}`;
      tx(() => {
        if (!isActiveAttempt(attemptId, dispatch.id)) throw new StaleAttemptError('迟到的 Attempt 已失去提交权');
        finishAttempt({ attemptId, dispatchId: dispatch.id, status: 'failed', dispatchStatus: 'blocked', error: reason });
        postSystem(run.id, 'user', `协作执行未完成：${exit.detail}`);
        if (dispatch.batchId) maybeCompleteBatch(dispatch.batchId);
        finalizeRun(run.id);
        observeTechnicalBlock(dispatch.id, attemptId, agent.id);
      });
      endSpan(agentSpan, { output: reason, status: 'error', attributes: { 'collaboration.exit.kind': exit.kind } });
      endSpan(dispatchSpan, { output: reason, status: 'error', attributes: { 'collaboration.exit.kind': exit.kind } });
      return;
    }
    // 无控制动作只是答案候选；统一进入规范动作。
    const normalized = exit.kind === 'control_action'
      ? normalizeRuntimeControlAction(turn.controlAction, { expectedVersion: actionVersion })
      : answerCandidateControlAction(actionVersion);
    if (!normalized.ok) throw new CollaborationGuardError(`${normalized.code}: ${normalized.reason}`, 'action');
    const action = normalized.action;
    let finalExitGuard: RuntimeExitGuardEvaluation = { status: 'allow_candidate', reasons: ['HISTORICAL_EXIT_SEMANTICS'] };
    if (guardPolicy) {
      const input = exitGuardInput({ run, dispatch, attemptId, agentId: agent.id, turn, action,
        stopReason: 'normal', correctionAttempt: turn.exitCorrectionAttempts ?? 0, policy: guardPolicy });
      const evaluation = evaluateExitGuard(input);
      finalExitGuard = evaluation;
      traceExitGuard(run.id, agentSpan.id, dispatch, agent.id, input, evaluation);
      if (evaluation.status === 'continue_same_turn' || evaluation.status === 'fail_attempt' || evaluation.status === 'needs_attention') {
        throw new CollaborationGuardError(`EXIT_GUARD_${evaluation.status.toUpperCase()}: ${evaluation.reasons.join(', ')}`, 'action');
      }
      if (evaluation.status === 'wait' && action.type !== 'hold') {
        throw new CollaborationGuardError(`EXIT_GUARD_INVALID_WAIT: ${evaluation.reasons.join(', ')}`, 'action');
      }
    }
    controlSpan = startSpan(run.id, { parentId: agentSpan.id, spanKind: 'orchestration', name: `control:${action.type}`,
      input: JSON.stringify(action), attributes: { 'agent.id': agent.id, 'collaboration.dispatch.id': dispatch.id,
        'orchestration.phase': 'collaboration.control', 'collaboration.exit.kind': exit.kind,
        'collaboration.control.version': action.version, 'collaboration.control.source': normalized.source } });
    const effectiveOutput = effectiveTurnOutput(turn, action);
    const fanoutOutput = internalFanoutOutput(dispatch, effectiveOutput, action);
    let applied = emptyActionResult();
    const output = fanoutOutput ?? effectiveOutput;
    const observedAction: RuntimeControlAction = fanoutOutput !== null ? { version: 2, type: 'answer_candidate' } : action;
    const candidateVersion = runtimeCompletionCandidateVersion(run.id);
    let observedObligations: RuntimeSuccessorObligation[] = [];
    const commandResult = commitCollaborationAction(action, observedAction, {
      runId: run.id, attemptId, dispatchId: dispatch.id, commandKey: `collaboration-action:${attemptId}`,
      execute: (): {
        candidateDecision: ReturnType<typeof submitCompletionCandidate> | null;
        applied: ActionApplicationResult;
      } => {
      let localCandidateDecision: ReturnType<typeof submitCompletionCandidate> | null = null;
      let localApplied = emptyActionResult();
      if (!isActiveAttempt(attemptId, dispatch.id)) throw new StaleAttemptError('迟到的 Attempt 已失去提交权');
      const attempt = listAttempts(run.id).find((item) => item.id === attemptId);
      const retryAllowed = Boolean(attempt && attempt.attemptNo < config.collaboration.maxAttempts);
      if (candidateVersion === 1
        && (observedAction.type === 'complete' || observedAction.type === 'answer_candidate')) {
        localCandidateDecision = submitCompletionCandidate({
          runId: run.id, dispatchId: dispatch.id, attemptId, agentId: agent.id, action: observedAction,
          summary: output, evidenceRefs: [{ kind: 'attempt_output', id: attemptId }],
          exitGuard: { status: finalExitGuard.status, reasons: finalExitGuard.reasons }, retryAllowed,
        });
        if (localCandidateDecision.evaluation.status !== 'accepted') {
          const willRetry = localCandidateDecision.evaluation.status === 'rejected'
            && localCandidateDecision.evaluation.retryable && retryAllowed;
          const reason = `SUBJECT_COMPLETION_${localCandidateDecision.evaluation.status.toUpperCase()}: ${localCandidateDecision.evaluation.reasons.join(', ')}`;
          finishAttempt({ attemptId, dispatchId: dispatch.id, status: 'failed', dispatchStatus: willRetry ? 'queued' : 'blocked',
            output, action: normalized.storedAction, error: reason });
          post({ runId: run.id, from: 'system', to: agent.id, kind: 'system', body: localCandidateDecision.evaluation.feedback, ...attemptAccess(attemptId) });
          if (dispatch.batchId) maybeCompleteBatch(dispatch.batchId);
          finalizeRun(run.id);
          return { candidateDecision: localCandidateDecision, applied: localApplied };
        }
        if (dispatch.batchId && dispatch.kind === 'fanout') {
          const batch = getBatch(dispatch.batchId);
          if (batch?.joinPolicy === 'any') {
            if (consultAnyVersion !== 1) throw new Error('consult(any) Batch 缺少冻结能力版本');
            const winner = selectAnyBatchWinner({ batchId: batch.id, dispatchId: dispatch.id,
              expectedGeneration: batch.generation, candidateId: localCandidateDecision.candidate.id });
            if (!winner.selected || winner.batch.winnerDispatchId !== dispatch.id) {
              throw new StaleAttemptError(`consult(any) winner 已由 ${winner.batch.winnerDispatchId ?? '其他候选'} 占用`);
            }
          }
        }
      }
      if (fanoutOutput !== null) {
        // 辩手原文作为可恢复的发言保留在聊天室，但不是面向用户的最终报告。
        // 稳定 clientMessageId 使重试或重连不会复制同一 dispatch 的发言。
        const contribution = post({
          runId: run.id, from: agent.id, to: dispatch.from, kind: 'agent', messageType: 'collaboration_contribution',
          body: output, replyTo: dispatch.sourceMessageId,
          ...attemptAccess(attemptId),
          meta: { dispatchId: dispatch.id, batchId: dispatch.batchId, attemptId },
          clientMessageId: `collaboration:fanout:${dispatch.id}:contribution`,
        });
        localApplied.outputMessageId = contribution.id;
      } else localApplied = applyAction(run, dispatch, attemptId, agent, effectiveOutput, action);
      const actionWasDeferred = (action.type === 'handoff'
        && localApplied.childDispatchIds.length === 0 && localApplied.outputMessageId === null)
        || (action.type === 'consult' && localApplied.batchId === null);
      const observe = () => {
        if (actionWasDeferred) return;
        observedObligations = observeAction({ dispatchId: dispatch.id, attemptId, agentId: agent.id, action: observedAction,
          childDispatchIds: localApplied.childDispatchIds, batchId: localApplied.batchId });
        if (observedAction.type === 'hold' && localApplied.outputMessageId
          && runtimeDurableHoldVersion(run.id) !== null) {
          let condition: RuntimeDurableHoldCondition;
          let timeoutAt: string | undefined;
          let timeoutReason: string | undefined;
          let idempotencyKey: string;
          let resumeReason: string;
          if (observedAction.wake.kind === 'user_decision') {
            if (!localApplied.decisionId) throw new Error('用户决策 Hold 缺少 Decision');
            condition = { kind: 'user_decision' as const, decisionId: localApplied.decisionId };
            timeoutAt = runtimeDurableHoldVersion(run.id) === 2
              ? new Date(Date.now() + config.collaboration.runTimeoutMs).toISOString() : undefined;
            timeoutReason = '用户决策未在本轮运行时限内到达';
            idempotencyKey = `decision-hold:${localApplied.decisionId}`;
            resumeReason = '持久化用户决策已到达';
          } else if (observedAction.wake.kind === 'timer') {
            if (externalWaitVersion !== 1) throw new Error('当前 Run 未启用 timer Hold');
            condition = { kind: 'timer' as const, wakeAt: observedAction.wake.wakeAt };
            idempotencyKey = `timer-hold:${attemptId}`;
            resumeReason = '计划等待时间已到';
          } else {
            if (externalWaitVersion !== 1) throw new Error('当前 Run 未启用 dependency Hold');
            const requesterSubjectId = get<{ subject_id: string }>(
              'SELECT subject_id FROM runtime_dispatch_subjects WHERE dispatch_id=?', dispatch.id)?.subject_id;
            if (!requesterSubjectId) throw new Error('Dependency Hold 缺少当前 Subject');
            condition = { kind: 'dependency' as const,
              subjectIds: resolveRunDependencySubjectIds({ runId: run.id, requesterSubjectId,
                targetAgentIds: observedAction.wake.targetAgentIds }),
              policy: observedAction.wake.policy };
            timeoutAt = observedAction.wake.timeoutAt;
            timeoutReason = '同 Run 依赖未在期限内完成';
            idempotencyKey = `dependency-hold:${attemptId}`;
            resumeReason = '同 Run 依赖已满足';
          }
          createDurableHold({ runId: run.id, sourceDispatchId: dispatch.id, sourceAttemptId: attemptId,
            holderAgentId: agent.id, condition,
            ...(timeoutAt ? { timeoutAt, onTimeout: { kind: 'fail' as const, reason: timeoutReason } } : {}),
            recoveryPolicy: { kind: 'resume_dispatch', targetAgentId: agent.id,
              sourceMessageId: localApplied.outputMessageId, parentDispatchId: dispatch.id,
              depth: dispatch.depth, reason: resumeReason }, idempotencyKey });
        }
      };
      if (localCandidateDecision === null) observe();
      finishAttempt({ attemptId, dispatchId: dispatch.id, status: 'completed', output, action: normalized.storedAction,
        deduplicatedTo: localApplied.deduplicatedTo, outputMessageId: localApplied.outputMessageId });
      if (action.type === 'handoff' && localApplied.childDispatchIds.length === 1 && localApplied.outputMessageId && !localApplied.deduplicatedTo) {
        const successorObligationRefs = observedObligations
          .filter((item) => item.kind === 'handoff_acquire'
            && item.payload.dispatchId === localApplied.childDispatchIds[0])
          .map((item) => ({ obligationId: item.id, generation: item.generation }));
        if (successorObligationRefs.length !== 1) {
          throw new Error('权威 Runtime handoff 未能在命令事务内创建唯一接球义务');
        }
        saveHandoffCapsule(minimalHandoffCapsule({
          runId: run.id, dispatchId: localApplied.childDispatchIds[0]!, sourceDispatchId: dispatch.id,
          sourceAttemptId: attemptId, objective: run.goal, message: action.objective, reason: action.reason,
          sourceMessageId: localApplied.outputMessageId, completedWork: effectiveOutput,
          ...(successorObligationRefs.length > 0 ? { successorObligationRefs } : {}),
        }));
      }
      if (dispatch.batchId) maybeCompleteBatch(dispatch.batchId);
      finalizeRun(run.id);
      return { candidateDecision: localCandidateDecision, applied: localApplied };
    } });
    applied = commandResult.result.applied;
    const candidateDecision = commandResult.result.candidateDecision;
    if (candidateDecision) {
      const candidateSpan = startSpan(run.id, { parentId: agentSpan.id, spanKind: 'orchestration',
        name: `completion_candidate:${candidateDecision.evaluation.status}`, input: JSON.stringify(candidateDecision.candidate),
        attributes: { 'agent.id': agent.id, 'collaboration.dispatch.id': dispatch.id,
          'runtime.completion_candidate.id': candidateDecision.candidate.id,
          'runtime.completion_candidate.status': candidateDecision.evaluation.status,
          'orchestration.phase': 'collaboration.completion_candidate' } });
      endSpan(candidateSpan, { output: JSON.stringify(candidateDecision.evaluation),
        status: candidateDecision.evaluation.status === 'accepted' ? 'ok' : 'error' });
      if (candidateDecision.evaluation.status !== 'accepted') {
        const result = JSON.stringify({ candidateId: candidateDecision.candidate.id,
          status: candidateDecision.evaluation.status, reasons: candidateDecision.evaluation.reasons });
        endSpan(controlSpan, { output: result, status: 'error' });
        endSpan(agentSpan, { output: result, status: 'error' });
        endSpan(dispatchSpan, { output: result, status: 'error' });
        return;
      }
    }
    endSpan(controlSpan, { output: JSON.stringify(applied), status: 'ok', attributes: {
      ...(applied.deduplicatedTo ? { 'collaboration.deduplicated_to': applied.deduplicatedTo } : {}),
    } });
    endSpan(agentSpan, { output: JSON.stringify({ dispatchId: dispatch.id, outputMessageId: applied.outputMessageId,
      controlAction: action, controlActionSource: normalized.source }), status: 'ok' });
    endSpan(dispatchSpan, { output: JSON.stringify(applied), status: 'ok' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof StaleAttemptError || !isActiveAttempt(attemptId, dispatch.id)) {
      if (controlSpan) endSpan(controlSpan, { output: message, status: 'error' });
      endSpan(agentSpan, { output: 'stale_attempt_discarded', status: 'error' });
      endSpan(dispatchSpan, { output: 'stale_attempt_discarded', status: 'error' });
      return;
    }
    const blocked = err instanceof CollaborationGuardError;
    tx(() => {
      if (blocked && err.routeGuard) persistRouteGuardEvent(err.routeGuard);
      finishAttempt({ attemptId, dispatchId: dispatch.id, status: 'failed', dispatchStatus: blocked ? 'blocked' : 'failed', error: message });
      if (blocked && err.preservedOutput?.trim()) {
        post({ runId: run.id, from: agent.id, to: 'all', kind: 'agent', messageType: 'informational',
          ...attemptAccess(attemptId),
          body: err.preservedOutput.trim(), clientMessageId: `collaboration:guard:${attemptId}:preserved-output`,
          meta: { dispatchId: dispatch.id, attemptId, guard: err.code,
            ...(err.routeGuard ? { routeGuardEventId: err.routeGuard.id,
              evidenceFingerprint: err.routeGuard.evidenceFingerprint, repeatedCount: err.routeGuard.repeatedCount } : {}) } });
      }
      post({ runId: run.id, from: 'system', to: agent.id, kind: 'system', body: `${blocked ? '协作路由已阻断' : '协作执行失败'}：${message}`, ...attemptAccess(attemptId) });
      if (dispatch.batchId) maybeCompleteBatch(dispatch.batchId);
      finalizeRun(run.id);
      observeTerminalInterruption(dispatch.id, attemptId, agent.id);
    });
    const guardAttributes = blocked ? { 'collaboration.guard': err.code,
      ...(err.routeGuard ? { 'runtime.route_guard.id': err.routeGuard.id,
        'runtime.route_guard.repeated_count': err.routeGuard.repeatedCount,
        'runtime.evidence.fingerprint': err.routeGuard.evidenceFingerprint,
        ...(err.routeGuard.progressDigest ? {
          'runtime.progress.digest': err.routeGuard.progressDigest.digest,
          'runtime.progress.entries': err.routeGuard.progressDigest.entries.length,
        } : {}) } : {}) } : {};
    if (controlSpan) endSpan(controlSpan, { output: message, status: 'error', attributes: guardAttributes });
    endSpan(agentSpan, { output: message, status: 'error', attributes: guardAttributes });
    endSpan(dispatchSpan, { output: message, status: 'error', attributes: guardAttributes });
  }
}

function requestedDebateRounds(run: Run, routeText = ''): number | null {
  const currentRunText = listByRun(run.id).map((message) => message.body).join('\n');
  const text = `${run.goal}\n${routeText}\n${currentRunText}`;
  if (!text.includes('辩论')) return null;
  const rounds = [...text.matchAll(/(\d{1,2})\s*轮/gu)]
    .map((match) => Number.parseInt(match[1] ?? '', 10))
    .find((value) => Number.isInteger(value) && value >= 2 && value <= 20);
  return rounds ?? null;
}

function guardRoute(run: Run, dispatch: CollaborationDispatch, targets: string[], routeText = ''): boolean {
  const debateRounds = requestedDebateRounds(run, routeText);
  const depthLimit = debateRounds === null ? config.collaboration.maxDepth : Math.max(config.collaboration.maxDepth, debateRounds * 2 + 4);
  if (dispatch.depth + 1 > depthLimit) throw new CollaborationGuardError(`已达到最大路由深度 ${depthLimit}`, 'depth');
  if (targets.length === 0 || targets.length > config.collaboration.maxTargets) throw new CollaborationGuardError(`一次最多路由给 ${config.collaboration.maxTargets} 位 Agent`, 'targets');
  const budget = budgetSnapshot(run.id);
  if (budget.dispatches.used + targets.length > budget.dispatches.currentLimit) {
    const message = post({ runId: run.id, from: 'system', to: 'user', kind: 'system', messageType: 'collaboration_wait_user',
      body: '创建后续路由会超过 Dispatch 预算。请选择按当前结果终止，或增加预算后继续。',
      payload: { decisionKind: 'budget_exhausted', dimension: 'dispatches', budget } });
    createDecision({ runId: run.id, conversationId: run.conversationId, dispatchId: dispatch.id,
      idempotencyKey: `budget-route:${dispatch.id}`, kind: 'budget_exhausted', promptMessageId: message.id,
      payload: { dimension: 'dispatches', budget, agentId: dispatch.targetAgentId, resumeSourceMessageId: dispatch.sourceMessageId, parentDispatchId: dispatch.id, depth: dispatch.depth } });
    setRunStatus(run.id, 'waiting_for_user');
    return false;
  }
  return true;
}

function pingPongCount(runId: string, from: string, to: string): number {
  const handoffs = listDispatches(runId).filter((item) => item.kind === 'handoff' && item.status !== 'cancelled').slice(-config.collaboration.pingPongBlock);
  let count = 0; let expectedFrom = from; let expectedTo = to;
  for (const item of handoffs.reverse()) {
    if (item.from !== expectedTo || item.targetAgentId !== expectedFrom) break;
    count += 1; [expectedFrom, expectedTo] = [expectedTo, expectedFrom];
  }
  return count + 1;
}

function applyAction(run: Run, dispatch: CollaborationDispatch, attemptId: string,
  agent: AgentDefinition, content: string, action: RuntimeControlAction): ActionApplicationResult {
  if (action.type === 'complete' || action.type === 'answer_candidate') {
    return emptyActionResult();
  }
  if (action.type === 'handoff') {
    const continuationBlock = continuationRouteBlock(run.id, [action.targetAgentId], action.objective);
    if (continuationBlock) throw new CollaborationGuardError(continuationBlock, 'action');
    const inheritedAccess = attemptAccess(attemptId);
    if (action.visibility === 'public' && inheritedAccess.visibility === 'private') {
      throw new CollaborationGuardError('私密上下文不能直接扩大为公开交接；请由房间所有者创建公开任务', 'action');
    }
    assertMessageAccess(inheritedAccess, action.targetAgentId, '交接来源');
    if (!guardRoute(run, dispatch, [action.targetAgentId], action.objective)) return emptyActionResult();
    const debateRounds = requestedDebateRounds(run, action.objective);
    const pingPongBlock = debateRounds === null ? config.collaboration.pingPongBlock : Math.max(config.collaboration.pingPongBlock, debateRounds * 2 + 3);
    const pingPongWarn = debateRounds === null ? config.collaboration.pingPongWarn : Math.max(config.collaboration.pingPongWarn, debateRounds * 2 + 1);
    const preservedOutput = content.trim() || action.objective;
    if (runtimeEvidenceLoopGuardVersion(run.id) === 1) {
      const subject = get<{ subject_id: string; objective: string }>(`SELECT m.subject_id,s.objective
        FROM runtime_dispatch_subjects m JOIN runtime_subjects s ON s.id=m.subject_id WHERE m.dispatch_id=?`, dispatch.id);
      if (!subject) throw new CollaborationGuardError('证据防循环缺少 Subject 映射', 'action', preservedOutput);
      const guard = recordEvidenceAwareRoute({ runId: run.id, subjectId: subject.subject_id,
        sourceDispatchId: dispatch.id, fromAgentId: agent.id, targetAgentId: action.targetAgentId,
        objective: subject.objective, warnAt: pingPongWarn, blockAt: pingPongBlock });
      if (guard.outcome === 'blocked') throw new CollaborationGuardError(guard.reason ?? '无新证据循环已阻断', 'ping_pong', preservedOutput, guard);
      if (guard.outcome === 'warned') postSystem(run.id, action.targetAgentId,
        `提示：当前 Subject 在无新证据时已往返 ${guard.repeatedCount} 次，请补充可验证证据或完成当前事项。`);
    } else {
      const streak = pingPongCount(run.id, agent.id, action.targetAgentId);
      if (streak >= pingPongBlock) throw new CollaborationGuardError(`检测到 ${agent.id} 与 ${action.targetAgentId} 连续往返，已阻止继续交接`, 'ping_pong', preservedOutput);
      if (streak >= pingPongWarn) postSystem(run.id, action.targetAgentId, '提示：检测到多次连续交接，请确认是否已有足够信息完成当前事项。');
    }
    const message = post({ runId: run.id, from: agent.id, to: action.targetAgentId, kind: 'agent', messageType: 'collaboration_handoff',
      ...(inheritedAccess.visibility === 'private' ? inheritedAccess : { visibility: action.visibility ?? 'public' }),
      body: action.objective, meta: { dispatchId: dispatch.id, routeFrom: agent.id, routeTo: [action.targetAgentId], reason: action.reason } });
    const created = createDispatchDetailed({ runId: run.id, conversationId: run.conversationId, sourceMessageId: message.id, parentDispatchId: dispatch.id,
      kind: 'handoff', from: agent.id, targetAgentId: action.targetAgentId, reason: action.reason, depth: dispatch.depth + 1,
      idempotencyKey: `handoff:${dispatch.id}:${action.targetAgentId}:${hashText(action.objective)}`, dedupeText: action.objective });
    return { ...emptyActionResult(), outputMessageId: message.id, childDispatchIds: [created.dispatch.id], deduplicatedTo: created.deduplicatedTo };
  }
  if (action.type === 'consult') {
    const continuationBlock = continuationRouteBlock(run.id, action.targetAgentIds, action.objective);
    if (continuationBlock) throw new CollaborationGuardError(continuationBlock, 'action');
    const inheritedAccess = attemptAccess(attemptId);
    if (action.visibility === 'public' && inheritedAccess.visibility === 'private') {
      throw new CollaborationGuardError('私密上下文不能直接扩大为公开投递；请由房间所有者发布公开摘要或启动无私密来源的任务', 'action');
    }
    for (const target of action.targetAgentIds) assertMessageAccess(inheritedAccess, target, '咨询来源');
    const consultationAccess = inheritedAccess.visibility === 'private'
      ? intersectMessageAccess([inheritedAccess, { visibility: 'private', audience: ['user', agent.id, ...action.targetAgentIds] }])
      : { visibility: action.visibility ?? 'public' as const };
    if (action.join === 'any' && runtimeConsultAnyVersion(run.id) !== 1) {
      throw new CollaborationGuardError('当前 Run 尚未启用 consult join=any', 'action');
    }
    if (!guardRoute(run, dispatch, action.targetAgentIds, action.objective)) return emptyActionResult();
    const message = post({ runId: run.id, from: agent.id, to: action.targetAgentIds.join(','), kind: 'agent', messageType: 'collaboration_question',
      ...consultationAccess,
      body: action.objective, meta: { dispatchId: dispatch.id, routeFrom: agent.id, routeTo: action.targetAgentIds, reason: action.reason } });
    const batch = createBatch({ runId: run.id, conversationId: run.conversationId, initiatorAgentId: agent.id,
      sourceDispatchId: dispatch.id, question: action.objective, targetAgentIds: action.targetAgentIds,
      joinPolicy: action.join });
    afterCommit(() => scheduleBatchTimeout(batch.id, batch.timeoutAt));
    const children = action.targetAgentIds.map((target) => createDispatchDetailed({ runId: run.id, conversationId: run.conversationId,
      sourceMessageId: message.id, parentDispatchId: dispatch.id, batchId: batch.id, kind: 'fanout', from: agent.id,
      targetAgentId: target, reason: action.reason, depth: dispatch.depth + 1, idempotencyKey: `fanout:${batch.id}:${target}`, dedupeText: action.objective }));
    return { ...emptyActionResult(), outputMessageId: message.id, childDispatchIds: children.map((item) => item.dispatch.id),
      batchId: batch.id, deduplicatedTo: children.find((item) => item.deduplicatedTo)?.deduplicatedTo ?? null };
  }
  if (action.type === 'hold' && action.wake.kind === 'timer') {
    const message = post({ runId: run.id, from: agent.id, to: 'all', kind: 'agent', messageType: 'informational',
      ...attemptAccess(attemptId),
      body: `当前责任已暂停，将在 ${action.wake.wakeAt} 自动恢复。`,
      meta: { dispatchId: dispatch.id, reason: action.reason, holdKind: 'timer', wakeAt: action.wake.wakeAt } });
    return { ...emptyActionResult(), outputMessageId: message.id };
  }
  if (action.type === 'hold' && action.wake.kind === 'dependency') {
    const message = post({ runId: run.id, from: agent.id, to: 'all', kind: 'agent', messageType: 'informational',
      ...attemptAccess(attemptId),
      body: `当前责任已暂停，等待 ${action.wake.targetAgentIds.join('、')} 的同 Run 责任按 ${action.wake.policy} 策略完成；最晚等待至 ${action.wake.timeoutAt}。`,
      meta: { dispatchId: dispatch.id, reason: action.reason, holdKind: 'dependency',
        targets: action.wake.targetAgentIds, policy: action.wake.policy, timeoutAt: action.wake.timeoutAt } });
    return { ...emptyActionResult(), outputMessageId: message.id };
  }
  if (action.type === 'hold' && action.wake.kind === 'user_decision'
    && action.wake.decisionKind === 'agent_question') {
    const message = post({ runId: run.id, from: agent.id, to: 'user', kind: 'agent', messageType: 'collaboration_wait_user',
      ...attemptAccess(attemptId),
      body: action.wake.prompt, meta: { dispatchId: dispatch.id, reason: action.reason }, payload: { decisionKind: 'agent_question' } });
    const decision = createDecision({ runId: run.id, conversationId: run.conversationId, dispatchId: dispatch.id,
      idempotencyKey: `question:${dispatch.id}`, kind: 'agent_question', promptMessageId: message.id,
      payload: { question: action.wake.prompt, reason: action.reason, agentId: agent.id } });
    setRunStatus(run.id, 'waiting_for_user');
    return { ...emptyActionResult(), outputMessageId: message.id, decisionId: decision.id };
  }
  if (action.type === 'cancel') throw new CollaborationGuardError(`Agent 无权直接取消 Run：${action.reason}`, 'action');
  if (action.type !== 'hold' || action.wake.kind !== 'user_decision'
    || action.wake.decisionKind !== 'supervisor_task_proposal') {
    throw new CollaborationGuardError(`未实现的规范控制动作：${action.type}`, 'action');
  }
  const proposal = action.wake.proposal;
  const message = post({ runId: run.id, from: agent.id, to: 'user', kind: 'agent', messageType: 'collaboration_task_proposal',
    ...attemptAccess(attemptId),
    body: `${proposal.title}\n\n${proposal.goal}`, meta: { dispatchId: dispatch.id, reason: action.reason },
    payload: { decisionKind: 'supervisor_task_proposal', proposal } });
  const decision = createDecision({ runId: run.id, conversationId: run.conversationId, dispatchId: dispatch.id,
    idempotencyKey: `proposal:${dispatch.id}`, kind: 'supervisor_task_proposal', promptMessageId: message.id, payload: { proposal, agentId: agent.id } });
  setRunStatus(run.id, 'waiting_for_user');
  return { ...emptyActionResult(), outputMessageId: message.id, decisionId: decision.id };
}

function maybeCompleteBatch(batchId: string): void {
  tx(() => {
    const batch = getBatch(batchId);
    if (!batch || batch.resultDispatchId || batch.status === 'cancelled') return;
    const children = listDispatches(batch.runId).filter((item) => item.batchId === batch.id && item.kind === 'fanout');
    if (children.length === 0) return;
    const winner = batch.winnerDispatchId
      ? children.find((item) => item.id === batch.winnerDispatchId) : undefined;
    if (batch.joinPolicy === 'any') {
      if (batch.winnerDispatchId && (!winner || winner.status !== 'completed')) return;
      if (!batch.winnerDispatchId && children.some((item) => item.status === 'queued' || item.status === 'running')) return;
    } else if (children.some((item) => item.status === 'queued' || item.status === 'running')) return;
    const currentRun = getRun(batch.runId); if (!currentRun) return;
    const resultChildren = batch.joinPolicy === 'any' && winner ? [winner] : children;
    const results = resultChildren.map((item) => {
      const output = getCompletedDispatchOutput(item.id)
        ?? (item.outputMessageId ? listByRun(currentRun.id).find((message) => message.id === item.outputMessageId)?.body : null);
      return `${item.targetAgentId}（${item.status}）：${output ?? item.error ?? '无结果'}`;
    }).join('\n\n');
    if (batch.joinPolicy === 'any' && !winner) {
      settleConsultAnyJoin({ runId: batch.runId, batchId: batch.id, status: 'failed',
        resolutionSourceId: `consult-any-exhausted:${batch.id}:g${batch.generation}`,
        resolution: { reason: batch.status === 'timeout' ? 'timeout' : 'all_candidates_failed', generation: batch.generation } });
    }
    const aggregateAccess = intersectMessageAccess(resultChildren.flatMap(child => [
      messageAccess(child.sourceMessageId), ...(child.outputMessageId ? [messageAccess(child.outputMessageId)] : []),
      ...all<{ id: string }>('SELECT id FROM collaboration_attempts WHERE dispatch_id=? ORDER BY attempt_no DESC LIMIT 1', child.id).map(attempt => attemptAccess(attempt.id)),
    ]));
    if (aggregateAccess.visibility === 'private') aggregateAccess.audience = aggregateAccess.audience.filter(id => id === 'user' || id === batch.initiatorAgentId);
    const aggregateRecipient = aggregateAccess.visibility === 'private' && !aggregateAccess.audience.includes(batch.initiatorAgentId)
      ? 'user' : batch.initiatorAgentId;
    const source = post({ runId: currentRun.id, from: 'system', to: aggregateRecipient, kind: 'system',
      ...aggregateAccess,
      messageType: 'collaboration_routing', body: `并行征询结果已汇总：\n\n${results}`,
      meta: { batchId: batch.id, joinPolicy: batch.joinPolicy, winnerDispatchId: batch.winnerDispatchId },
      clientMessageId: `collaboration:batch:${batch.id}:aggregate-source` });
    const result = createDispatchDetailed({ runId: currentRun.id, conversationId: currentRun.conversationId, sourceMessageId: source.id,
      parentDispatchId: batch.sourceDispatchId, batchId: batch.id, kind: 'aggregate', from: 'system', targetAgentId: batch.initiatorAgentId,
      reason: batch.joinPolicy === 'any' ? '首个成功咨询结果回流' : '并行征询结果回流',
      depth: Math.max(0, ...children.map((item) => item.depth)), idempotencyKey: `aggregate:${batch.id}`, dedupeText: results });
    const batchStatus = batch.status === 'timeout' ? 'timeout'
      : batch.joinPolicy === 'any' ? (winner ? 'completed' : 'failed')
        : children.every((item) => item.status === 'failed' || item.status === 'blocked' || item.status === 'cancelled') ? 'failed'
          : children.every((item) => item.status === 'completed') ? 'completed' : 'partial';
    updateBatch(batch.id, batchStatus, result.dispatch.id);
    observeAggregateLink(batch.sourceDispatchId, result.dispatch.id);
  });
}

function scheduleBatchTimeout(batchId: string, timeoutAt: string): void {
  const timer = setTimeout(() => {
    const batch = expireBatch(batchId);
    if (!batch) return;
    maybeCompleteBatch(batchId);
    kickCollaboration(batch.conversationId);
  }, Math.max(0, new Date(timeoutAt).getTime() - Date.now()));
  timer.unref();
}

/** 启动恢复和人工取消后共用；重复调用只能得到同一个 aggregate。 */
export function reconcileCollaborationBatches(runId?: string): void {
  for (const batch of listUnaggregatedBatches(runId)) maybeCompleteBatch(batch.id);
}

export function finalizeCollaborationRun(runId: string, options: {
  disposition?: 'normal' | 'partial_user_accepted' | 'delegated'; publishResult?: boolean;
} = {}): void {
  if (settleRequestedPause(runId)) return;
  const run = getRun(runId); if (!run || run.status === 'awaiting_approval' || terminalRunStatus(run.status)) return;
  const runtimePolicy = resolveRunPolicy(runId);
  // 历史 profile 仅保留只读解释；退役后不再走 legacy finalization。
  if (!runtimeOwnsCompletion(runtimePolicy) || !isCompletionEngineRun(runId)) return;
  tx(() => {
      const snapshot = loadCompletionSnapshot(runId);
      if (!snapshot) return;
      snapshot.input.disposition = options.disposition ?? 'normal';
      const evaluation = evaluateCompletion(snapshot.input);
      if (evaluation.status === 'waiting') {
        recordCompletionEvaluation(runId, evaluation, snapshot.input);
        return;
      }
      if (evaluation.status !== 'accepted') {
        const result = commitRunTerminal({ runId, status: 'failed', disposition: 'failed',
          source: 'collaboration_completion', userMessageStatus: 'failed', prepare: () => ({
            completion: { input: snapshot.input, evaluation }, reasonCodes: evaluation.reasons,
            report: { from: 'system', to: 'user', kind: 'system', messageType: 'informational',
              body: `Completion Engine 拒绝完成：${evaluation.reasons.map(describeCompletionReason).join('；')}`,
              clientMessageId: `runtime:completion-rejected:${runId}` },
          }) });
        if (result.committed) afterCommit(() => closeCollaborationTrace(runId, 'failed'));
        return;
      }
      const parts = evaluation.disposition === 'partial_user_accepted'
        ? (snapshot.reportParts.length > 0 ? snapshot.reportParts : snapshot.partialReportParts)
        : snapshot.reportParts;
      const body = parts.length === 1 ? parts[0]!.output
        : parts.map((part) => `${part.agentId}：\n${part.output}`).join('\n\n');
      const disposition = evaluation.disposition === 'partial_user_accepted' ? 'authorized_partial'
        : evaluation.disposition === 'delegated' ? 'delegated' : 'accepted';
      const result = commitRunTerminal({ runId, status: 'completed', disposition,
        source: 'collaboration_completion', userMessageStatus: 'responded', prepare: () => ({
          completion: { input: snapshot.input, evaluation },
          ...((options.publishResult ?? true) && evaluation.disposition !== 'delegated' ? { report: {
            from: parts.length === 1 ? parts[0]!.agentId : 'system', to: 'user', kind: 'agent' as const,
            messageType: 'collaboration_result' as const, body: body || '已完成当前协作事项。',
            ...intersectMessageAccess(listByRun(runId)),
            meta: { completionKind: 'runtime_accepted', disposition: evaluation.disposition },
            clientMessageId: `runtime:completion:${runId}`,
          } } : {}),
        }) });
      if (result.committed) afterCommit(() => closeCollaborationTrace(runId, 'completed'));
  });
}

function finalizeRun(runId: string): void { finalizeCollaborationRun(runId); }

function hashText(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}

export function recoverCollaborationRuns(): void {
  for (const runId of listRunningCollaborationRunIds()) {
    const run = getRun(runId); if (run) ensureCollaborationSpan(run);
    if (hasPendingDecision(runId)) setRunStatus(runId, 'waiting_for_user');
    else finalizeRun(runId);
  }
  reconcileCollaborationBatches();
  for (const conversationId of listRecoverableConversationIds()) kickCollaboration(conversationId);
  for (const batch of listOpenBatches()) scheduleBatchTimeout(batch.id, batch.timeoutAt);
}

/** 活进程先续自己的租约，再只回收真正过期的其他进程 Attempt。 */
export function sweepCollaborationLeases(): void {
  renewCollaborationLeases(leaseOwner);
  for (const conversationId of interruptExpiredAttempts({ onlyExpired: true })) {
    for (const runId of new Set(listConversationDispatches(conversationId).map((item) => item.runId))) finalizeRun(runId);
    kickCollaboration(conversationId);
  }
  for (const conversationId of listRecoverableConversationIds()) kickCollaboration(conversationId);
}

function wakeMemberQueue(agentId: string): void {
  for (const row of all<{ conversation_id: string }>(`SELECT DISTINCT d.conversation_id FROM collaboration_dispatches d
    JOIN runs r ON r.id=d.run_id WHERE d.target_agent_id=? AND d.status='queued' AND r.status='running'`, agentId)) kickCollaboration(row.conversation_id);
}
onMemberAvailable(wakeMemberQueue);
subscribe(event => {
  if (event.type === 'collaboration.attempt.updated' && event.attempt.status !== 'running') wakeMemberQueue(event.attempt.agentId);
});

export function resumeCollaborationConversation(conversationId: string): void { kickCollaboration(conversationId); }
export function settleCollaborationRun(runId: string): void {
  const item = getRun(runId); if (!item) return;
  reconcileCollaborationBatches(runId);
  finalizeRun(runId); kickCollaboration(item.conversationId);
}

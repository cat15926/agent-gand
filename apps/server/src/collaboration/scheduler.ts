import { randomUUID } from 'node:crypto';
import type {
  AgentDefinition,
  CollaborationDispatch,
  Conversation,
  Run,
  RuntimeCompletionCandidate,
  RuntimeControlAction,
  RuntimeSubjectCompletionEvaluation,
} from '@agent-gand/shared';
import { config } from '../config.ts';
import { afterCommit, tx } from '../db/database.ts';
import { listByConversation, listByRun, post, postSystem, updateRunUserMessageStatus } from '../messaging/inbox.ts';
import { endSpan, finishRun, getRun, listEvents, listRunAgentSnapshots, setRunStatus, startSpan } from '../runs/trace.ts';
import { runAgentTurn, SESSION_BOUNDARY_DIRECTIVE, type AgentTurnResult } from '../orchestration/agentStep.ts';
import { COLLABORATION_CONTROL_TOOLS, parseControlCall } from './controlTools.ts';
import { classifyCollaborationTurnExit, isTechnicalInterruption } from './turnExit.ts';
import { planCollaborationAdmission } from '../runtime/subjectContract.ts';
import { observeAction, observeAdmission, observeAggregateLink, observeTechnicalBlock, observeTerminalInterruption, safelyObserve } from '../runtime/shadow.ts';
import { minimalHandoffCapsule, saveHandoffCapsule } from '../runtime/capsule.ts';
import { assembleCollaborationContext } from '../runtime/context.ts';
import { describeCompletionReason, evaluateCompletion } from '../runtime/completion.ts';
import { isCompletionEngineRun, loadCompletionSnapshot, recordCompletionEvaluation } from '../runtime/completionStore.ts';
import {
  answerCandidateControlAction,
  freezeRuntimeContract,
  normalizeRuntimeControlAction,
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
  hasOpenDispatches,
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
  interruptExpiredAttempts,
  renewCollaborationLeases,
} from './store.ts';
import { emit } from '../messaging/bus.ts';

const leaseOwner = `server:${process.pid}:${randomUUID()}`;
const activeConversations = new Set<string>();
const dirtyConversations = new Set<string>();
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

class CollaborationGuardError extends Error {
  constructor(message: string, readonly code: 'depth' | 'targets' | 'ping_pong' | 'action') { super(message); }
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
  const targets = initialTargets(run, conversation, input, userMessage.id);
  if (targets.length === 0) {
    postSystem(run.id, 'user', '当前聊天室没有可用 Agent');
    finishRun(run.id, 'failed');
    updateRunUserMessageStatus(run.id, 'failed');
    return;
  }
  const createAdmission = () => {
    setRunStatus(run.id, 'running');
    ensureCollaborationSpan(run);
    const runtimeStateEnabled = config.collaboration.runtimeAtomic || config.collaboration.runtimeShadow;
    const planned = planCollaborationAdmission({ runId: run.id, objective: run.goal, participantIds: run.agentIds,
      targetAgentIds: targets, completionEngine: runtimeStateEnabled && config.collaboration.completionEngine, controlActionVersion: 2,
      exitGuard: { version: 1, maxCorrections: config.collaboration.exitGuardMaxCorrections,
        correctionMaxTokens: config.collaboration.exitGuardCorrectionMaxTokens },
      ...(runtimeStateEnabled ? { completionCandidateVersion: 1 as const } : {}) });
    freezeRuntimeContract(planned.contract);
    const initialDispatches = targets.map((target) => createDispatch({
      runId: run.id, conversationId: conversation.id, sourceMessageId: userMessage.id,
      kind: 'initial', from: 'user', targetAgentId: target, reason: '用户发起协作', depth: 0,
      idempotencyKey: `initial:${userMessage.id}:${target}`, dedupeText: userMessage.body,
    }));
    if (runtimeStateEnabled) {
      const observe = () => {
        observeAdmission(planned.contract, planned.subjects, initialDispatches.map((item) => item.id));
      };
      if (config.collaboration.runtimeAtomic) observe();
      else afterCommit(() => safelyObserve('admission', observe));
    }
  };
  if (config.collaboration.runtimeAtomic) tx(createAdmission);
  else createAdmission();
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

function openSuccessorObligations(runId: string, dispatchId: string): number {
  return listDispatches(runId).filter((item) => item.parentDispatchId === dispatchId
    && item.status !== 'completed' && item.status !== 'failed' && item.status !== 'cancelled').length;
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
  const allowImplicitAnswer = input.dispatch.kind === 'initial' || input.dispatch.kind === 'fanout';
  return {
    stopReason: input.stopReason,
    action: input.action,
    output: effectiveTurnOutput(input.turn, input.action),
    hasActiveCustody: isActiveAttempt(input.attemptId, input.dispatch.id),
    holderMatches: input.dispatch.targetAgentId === input.agentId,
    openSuccessorObligations: openSuccessorObligations(input.run.id, input.dispatch.id),
    allowImplicitAnswer,
    protocolRequiresExplicit: !allowImplicitAnswer,
    // 阶段 2 不把“调用过工具”冒充可信证据；阶段 5 接入 EvidenceBundle 后再传真实计数。
    evidenceCount: 0,
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
    attributes: { 'agent.id': agent.id, 'collaboration.dispatch.id': dispatch.id, ...(dispatch.batchId ? { 'collaboration.batch.id': dispatch.batchId } : {}), 'orchestration.phase': 'collaboration.dispatch' } });
  const agentSpan = startSpan(run.id, { parentId: dispatchSpan.id, spanKind: 'agent', name: `agent:${agent.id}`, input: JSON.stringify({ dispatchId: dispatch.id, sourceMessageId: dispatch.sourceMessageId, depth: dispatch.depth, budget: budgetSnapshot(run.id) }),
    attributes: { 'agent.id': agent.id, 'agent.role': 'collaborator', 'collaboration.dispatch.id': dispatch.id,
      ...(dispatch.batchId ? { 'collaboration.batch.id': dispatch.batchId } : {}), 'orchestration.phase': 'collaboration.dispatch' } });
  let controlSpan: ReturnType<typeof startSpan> | null = null;
  try {
    const actionVersion = runtimeControlActionVersion(run.id);
    const guardPolicy = runtimeExitGuardPolicy(run.id);
    const controlTools = actionVersion === 1
      ? COLLABORATION_CONTROL_TOOLS.filter((tool) => tool.name !== 'agent.complete')
      : COLLABORATION_CONTROL_TOOLS;
    const turn = await runAgentTurn({ run, agent, parentSpanId: agentSpan.id, agentId: agent.id, attemptId,
      executionScopeId: `collaboration:${dispatch.id}`,
      messages: [{ role: 'system', content: agent.systemPrompt }, { role: 'system', content: SESSION_BOUNDARY_DIRECTIVE }, { role: 'user', content: inputContext }],
      controlTools,
      handleControlCalls: (calls) => parseControlCall(calls[0]!, run.agentIds, agent.id, actionVersion),
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
        if (config.collaboration.runtimeAtomic) observeTechnicalBlock(dispatch.id, attemptId, agent.id);
        else if (config.collaboration.runtimeShadow) afterCommit(() => safelyObserve('technical_block', () => observeTechnicalBlock(dispatch.id, attemptId, agent.id)));
      });
      endSpan(agentSpan, { output: reason, status: 'error', attributes: { 'collaboration.exit.kind': exit.kind } });
      endSpan(dispatchSpan, { output: reason, status: 'error', attributes: { 'collaboration.exit.kind': exit.kind } });
      return;
    }
    // 无控制动作只是答案候选；统一进入规范动作，但历史 Run 仍按冻结版本持久化 v1 结构。
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
    const transactionResult = tx((): {
      candidateDecision: { candidate: RuntimeCompletionCandidate; evaluation: RuntimeSubjectCompletionEvaluation } | null;
    } => {
      let localCandidateDecision: { candidate: RuntimeCompletionCandidate; evaluation: RuntimeSubjectCompletionEvaluation } | null = null;
      if (!isActiveAttempt(attemptId, dispatch.id)) throw new StaleAttemptError('迟到的 Attempt 已失去提交权');
      const attempt = listAttempts(run.id).find((item) => item.id === attemptId);
      const retryAllowed = Boolean(attempt && attempt.attemptNo < config.collaboration.maxAttempts);
      if (config.collaboration.runtimeAtomic && candidateVersion === 1
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
          postSystem(run.id, agent.id, localCandidateDecision.evaluation.feedback);
          if (dispatch.batchId) maybeCompleteBatch(dispatch.batchId);
          finalizeRun(run.id);
          return { candidateDecision: localCandidateDecision };
        }
      }
      if (fanoutOutput !== null) {
        // 辩手原文作为可恢复的发言保留在聊天室，但不是面向用户的最终报告。
        // 稳定 clientMessageId 使重试或重连不会复制同一 dispatch 的发言。
        const contribution = post({
          runId: run.id, from: agent.id, to: dispatch.from, kind: 'agent', messageType: 'collaboration_contribution',
          body: output, replyTo: dispatch.sourceMessageId,
          meta: { dispatchId: dispatch.id, batchId: dispatch.batchId, attemptId },
          clientMessageId: `collaboration:fanout:${dispatch.id}:contribution`,
        });
        applied.outputMessageId = contribution.id;
      } else applied = applyAction(run, dispatch, agent, effectiveOutput, action);
      const actionWasDeferred = action.type === 'handoff' && applied.childDispatchIds.length === 0 && applied.outputMessageId === null;
      const observe = () => {
        if (actionWasDeferred) return;
        if (candidateVersion === 1 && (observedAction.type === 'complete' || observedAction.type === 'answer_candidate')) {
          submitCompletionCandidate({ runId: run.id, dispatchId: dispatch.id, attemptId, agentId: agent.id,
            action: observedAction, summary: output, evidenceRefs: [{ kind: 'attempt_output', id: attemptId }],
            exitGuard: { status: finalExitGuard.status, reasons: finalExitGuard.reasons }, retryAllowed });
          return;
        }
        observeAction({ dispatchId: dispatch.id, attemptId, agentId: agent.id, action: observedAction,
          childDispatchIds: applied.childDispatchIds, batchId: applied.batchId });
      };
      if (config.collaboration.runtimeAtomic && localCandidateDecision === null) observe();
      finishAttempt({ attemptId, dispatchId: dispatch.id, status: 'completed', output, action: normalized.storedAction,
        deduplicatedTo: applied.deduplicatedTo, outputMessageId: applied.outputMessageId });
      if (action.type === 'handoff' && applied.childDispatchIds.length === 1 && applied.outputMessageId && !applied.deduplicatedTo) {
        saveHandoffCapsule(minimalHandoffCapsule({
          runId: run.id, dispatchId: applied.childDispatchIds[0]!, sourceDispatchId: dispatch.id,
          sourceAttemptId: attemptId, objective: run.goal, message: action.objective, reason: action.reason,
          sourceMessageId: applied.outputMessageId, completedWork: effectiveOutput,
        }));
      }
      if (dispatch.batchId) maybeCompleteBatch(dispatch.batchId);
      finalizeRun(run.id);
      if (!config.collaboration.runtimeAtomic && config.collaboration.runtimeShadow) afterCommit(() => safelyObserve('action', observe));
      return { candidateDecision: localCandidateDecision };
    });
    const candidateDecision = transactionResult.candidateDecision;
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
      finishAttempt({ attemptId, dispatchId: dispatch.id, status: 'failed', dispatchStatus: blocked ? 'blocked' : 'failed', error: message });
      postSystem(run.id, agent.id, `${blocked ? '协作路由已阻断' : '协作执行失败'}：${message}`);
      if (dispatch.batchId) maybeCompleteBatch(dispatch.batchId);
      finalizeRun(run.id);
      if (config.collaboration.runtimeAtomic) observeTerminalInterruption(dispatch.id, attemptId, agent.id);
      else if (config.collaboration.runtimeShadow) afterCommit(() => safelyObserve('terminal_failure', () => observeTerminalInterruption(dispatch.id, attemptId, agent.id)));
    });
    if (controlSpan) endSpan(controlSpan, { output: message, status: 'error', attributes: blocked ? { 'collaboration.guard': err.code } : {} });
    endSpan(agentSpan, { output: message, status: 'error' });
    endSpan(dispatchSpan, { output: message, status: 'error', attributes: blocked ? { 'collaboration.guard': err.code } : {} });
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

function applyAction(run: Run, dispatch: CollaborationDispatch, agent: AgentDefinition, content: string, action: RuntimeControlAction): ActionApplicationResult {
  if (action.type === 'complete' || action.type === 'answer_candidate') {
    if (config.collaboration.completionEngine && isCompletionEngineRun(run.id)) return emptyActionResult();
    const message = post({ runId: run.id, from: agent.id, to: 'user', kind: 'agent', messageType: 'collaboration_result',
      body: content.trim() || '已完成当前协作事项。', meta: { dispatchId: dispatch.id, routeFrom: dispatch.from,
        completionKind: action.type === 'answer_candidate' ? 'answer_candidate' : 'explicit' } });
    return { ...emptyActionResult(), outputMessageId: message.id };
  }
  if (action.type === 'handoff') {
    if (!guardRoute(run, dispatch, [action.targetAgentId], action.objective)) return emptyActionResult();
    const streak = pingPongCount(run.id, agent.id, action.targetAgentId);
    const debateRounds = requestedDebateRounds(run, action.objective);
    const pingPongBlock = debateRounds === null ? config.collaboration.pingPongBlock : Math.max(config.collaboration.pingPongBlock, debateRounds * 2 + 3);
    const pingPongWarn = debateRounds === null ? config.collaboration.pingPongWarn : Math.max(config.collaboration.pingPongWarn, debateRounds * 2 + 1);
    if (streak >= pingPongBlock) throw new CollaborationGuardError(`检测到 ${agent.id} 与 ${action.targetAgentId} 连续往返，已阻止继续交接`, 'ping_pong');
    if (streak >= pingPongWarn) postSystem(run.id, action.targetAgentId, '提示：检测到多次连续交接，请确认是否已有足够信息完成当前事项。');
    const message = post({ runId: run.id, from: agent.id, to: action.targetAgentId, kind: 'agent', messageType: 'collaboration_handoff',
      body: action.objective, meta: { dispatchId: dispatch.id, routeFrom: agent.id, routeTo: [action.targetAgentId], reason: action.reason } });
    const created = createDispatchDetailed({ runId: run.id, conversationId: run.conversationId, sourceMessageId: message.id, parentDispatchId: dispatch.id,
      kind: 'handoff', from: agent.id, targetAgentId: action.targetAgentId, reason: action.reason, depth: dispatch.depth + 1,
      idempotencyKey: `handoff:${dispatch.id}:${action.targetAgentId}:${hashText(action.objective)}`, dedupeText: action.objective });
    return { ...emptyActionResult(), outputMessageId: message.id, childDispatchIds: [created.dispatch.id], deduplicatedTo: created.deduplicatedTo };
  }
  if (action.type === 'consult') {
    if (action.join !== 'all') throw new CollaborationGuardError('当前 Scheduler 尚未启用 consult join=any', 'action');
    if (!guardRoute(run, dispatch, action.targetAgentIds, action.objective)) return emptyActionResult();
    const message = post({ runId: run.id, from: agent.id, to: action.targetAgentIds.join(','), kind: 'agent', messageType: 'collaboration_question',
      body: action.objective, meta: { dispatchId: dispatch.id, routeFrom: agent.id, routeTo: action.targetAgentIds, reason: action.reason } });
    const batch = createBatch({ runId: run.id, conversationId: run.conversationId, initiatorAgentId: agent.id,
      sourceDispatchId: dispatch.id, question: action.objective, targetAgentIds: action.targetAgentIds });
    afterCommit(() => scheduleBatchTimeout(batch.id, batch.timeoutAt));
    const children = action.targetAgentIds.map((target) => createDispatchDetailed({ runId: run.id, conversationId: run.conversationId,
      sourceMessageId: message.id, parentDispatchId: dispatch.id, batchId: batch.id, kind: 'fanout', from: agent.id,
      targetAgentId: target, reason: action.reason, depth: dispatch.depth + 1, idempotencyKey: `fanout:${batch.id}:${target}`, dedupeText: action.objective }));
    return { ...emptyActionResult(), outputMessageId: message.id, childDispatchIds: children.map((item) => item.dispatch.id),
      batchId: batch.id, deduplicatedTo: children.find((item) => item.deduplicatedTo)?.deduplicatedTo ?? null };
  }
  if (action.type === 'hold' && action.wake.decisionKind === 'agent_question') {
    const message = post({ runId: run.id, from: agent.id, to: 'user', kind: 'agent', messageType: 'collaboration_wait_user',
      body: action.wake.prompt, meta: { dispatchId: dispatch.id, reason: action.reason }, payload: { decisionKind: 'agent_question' } });
    const decision = createDecision({ runId: run.id, conversationId: run.conversationId, dispatchId: dispatch.id,
      idempotencyKey: `question:${dispatch.id}`, kind: 'agent_question', promptMessageId: message.id,
      payload: { question: action.wake.prompt, reason: action.reason, agentId: agent.id } });
    setRunStatus(run.id, 'waiting_for_user');
    return { ...emptyActionResult(), outputMessageId: message.id, decisionId: decision.id };
  }
  if (action.type === 'cancel') throw new CollaborationGuardError(`Agent 无权直接取消 Run：${action.reason}`, 'action');
  if (action.type !== 'hold' || action.wake.decisionKind !== 'supervisor_task_proposal') {
    throw new CollaborationGuardError(`未实现的规范控制动作：${action.type}`, 'action');
  }
  const proposal = action.wake.proposal;
  const message = post({ runId: run.id, from: agent.id, to: 'user', kind: 'agent', messageType: 'collaboration_task_proposal',
    body: `${proposal.title}\n\n${proposal.goal}`, meta: { dispatchId: dispatch.id, reason: action.reason },
    payload: { decisionKind: 'supervisor_task_proposal', proposal } });
  const decision = createDecision({ runId: run.id, conversationId: run.conversationId, dispatchId: dispatch.id,
    idempotencyKey: `proposal:${dispatch.id}`, kind: 'supervisor_task_proposal', promptMessageId: message.id, payload: { proposal, agentId: agent.id } });
  setRunStatus(run.id, 'waiting_for_user');
  return { ...emptyActionResult(), outputMessageId: message.id, decisionId: decision.id };
}

function maybeCompleteBatch(batchId: string): void {
  const batch = getBatch(batchId);
  if (!batch || batch.resultDispatchId) return;
  const children = listDispatches(batch.runId).filter((item) => item.batchId === batch.id && item.kind === 'fanout');
  if (children.length === 0 || children.some((item) => item.status === 'queued' || item.status === 'running')) return;
  const run = getRun(batch.runId); if (!run) return;
  const results = children.map((item) => {
    const output = getCompletedDispatchOutput(item.id)
      ?? (item.outputMessageId ? listByRun(run.id).find((message) => message.id === item.outputMessageId)?.body : null);
    return `${item.targetAgentId}（${item.status}）：${output ?? item.error ?? '无结果'}`;
  }).join('\n\n');
  const source = post({ runId: run.id, from: 'system', to: batch.initiatorAgentId, kind: 'system', messageType: 'collaboration_routing',
    body: `并行征询结果已汇总：\n\n${results}`, meta: { batchId: batch.id } });
  const result = createDispatchDetailed({ runId: run.id, conversationId: run.conversationId, sourceMessageId: source.id,
    parentDispatchId: batch.sourceDispatchId, batchId: batch.id, kind: 'aggregate', from: 'system', targetAgentId: batch.initiatorAgentId,
    reason: '并行征询结果回流', depth: Math.max(0, ...children.map((item) => item.depth)), idempotencyKey: `aggregate:${batch.id}`, dedupeText: results });
  const batchStatus = batch.status === 'timeout' ? 'timeout'
    : children.every((item) => item.status === 'failed' || item.status === 'blocked' || item.status === 'cancelled') ? 'failed'
      : children.every((item) => item.status === 'completed') ? 'completed' : 'partial';
  updateBatch(batch.id, batchStatus, result.dispatch.id);
  if (config.collaboration.runtimeAtomic) observeAggregateLink(batch.sourceDispatchId, result.dispatch.id);
  else if (config.collaboration.runtimeShadow) afterCommit(() => safelyObserve('aggregate_link', () => observeAggregateLink(batch.sourceDispatchId, result.dispatch.id)));
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

export function finalizeCollaborationRun(runId: string, options: {
  disposition?: 'normal' | 'partial_user_accepted' | 'delegated'; publishResult?: boolean;
} = {}): void {
  const run = getRun(runId); if (!run || run.status === 'awaiting_approval' || terminalRunStatus(run.status)) return;
  const completionOwned = config.collaboration.completionEngine && isCompletionEngineRun(runId);
  if (run.status === 'waiting_for_user' && !completionOwned && !options.disposition) return;
  if (completionOwned) {
    const snapshot = loadCompletionSnapshot(runId);
    if (!snapshot) {
      // Contract marker and snapshot share the same row; this only protects against a concurrent/corrupt read.
      return;
    }
    snapshot.input.disposition = options.disposition ?? 'normal';
    const evaluation = evaluateCompletion(snapshot.input);
    recordCompletionEvaluation(runId, evaluation, snapshot.input);
    if (evaluation.status === 'waiting') return;
    if (evaluation.status !== 'accepted') {
      finishRun(runId, 'failed');
      closeCollaborationTrace(runId, 'failed');
      post({ runId, from: 'system', to: 'user', kind: 'system', messageType: 'informational',
        body: `Completion Engine 拒绝完成：${evaluation.reasons.map(describeCompletionReason).join('；')}`,
        clientMessageId: `runtime:completion-rejected:${runId}` });
      try { updateRunUserMessageStatus(runId, 'failed'); } catch { /* legacy */ }
      return;
    }
    if ((options.publishResult ?? true) && evaluation.disposition !== 'delegated') {
      const parts = evaluation.disposition === 'partial_user_accepted'
        ? (snapshot.reportParts.length > 0 ? snapshot.reportParts : snapshot.partialReportParts)
        : snapshot.reportParts;
      const body = parts.length === 1 ? parts[0]!.output
        : parts.map((part) => `${part.agentId}：\n${part.output}`).join('\n\n');
      post({ runId, from: parts.length === 1 ? parts[0]!.agentId : 'system', to: 'user', kind: 'agent',
        messageType: 'collaboration_result', body: body || '已完成当前协作事项。',
        meta: { completionKind: 'runtime_accepted', disposition: evaluation.disposition },
        clientMessageId: `runtime:completion:${runId}` });
    }
    finishRun(runId, 'completed');
    closeCollaborationTrace(runId, 'completed');
    try { updateRunUserMessageStatus(runId, 'responded'); } catch { /* legacy */ }
    return;
  }
  if (hasOpenDispatches(runId) || hasPendingDecision(runId)) return;
  const dispatches = listDispatches(runId);
  const succeeded = !dispatches.some((item) => isTechnicalInterruption(item.error))
    && dispatches.some((item) => item.status === 'completed');
  finishRun(runId, succeeded ? 'completed' : 'failed');
  closeCollaborationTrace(runId, succeeded ? 'completed' : 'failed');
  try { updateRunUserMessageStatus(runId, succeeded ? 'responded' : 'failed'); } catch { /* legacy */ }
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
}

export function resumeCollaborationConversation(conversationId: string): void { kickCollaboration(conversationId); }
export function settleCollaborationRun(runId: string): void {
  const item = getRun(runId); if (!item) return;
  finalizeRun(runId); kickCollaboration(item.conversationId);
}

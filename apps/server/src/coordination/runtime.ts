import type { AgentDefinition, CoordinationPlan, CoordinationPlanStep, CoordinationStepState, Run } from '@agent-gand/shared';
import { config } from '../config.ts';
import { updateRunUserMessageStatus, post } from '../messaging/inbox.ts';
import { runAgentTurn, SESSION_BOUNDARY_DIRECTIVE } from '../orchestration/agentStep.ts';
import { latestCheckpoint, saveCheckpoint } from '../runs/checkpoints.ts';
import { endSpan, finishRun, getRun, listRunAgentSnapshots, setRunStatus, startSpan } from '../runs/trace.ts';
import {
  claimCoordinationStep,
  completeCoordinationStep,
  failCoordinationStep,
  getRunCoordinationPlan,
  listCoordinationStepStates,
  prepareCoordinationReadySteps,
  recordCoordinationEvent,
  scheduleCoordinationRevision,
  setCoordinationAttemptSpan,
  setCoordinationPlanStatus,
} from './store.ts';

interface RuntimeMessageInput {
  recipientIds?: string[];
  replyTo?: string | null;
  taskId?: string | null;
  clientMessageId?: string;
}

const activeRuns = new Set<string>();

function ancestorIds(plan: CoordinationPlan, step: CoordinationPlanStep): string[] {
  const byId = new Map(plan.steps.map((item) => [item.id, item]));
  const found = new Set<string>();
  const visit = (id: string): void => {
    if (found.has(id)) return;
    found.add(id);
    byId.get(id)?.dependsOn.forEach(visit);
  };
  step.dependsOn.forEach(visit);
  return plan.steps.filter((item) => found.has(item.id)).map((item) => item.id);
}

function dependencyTranscript(plan: CoordinationPlan, step: CoordinationPlanStep, states: CoordinationStepState[]): string {
  const relevant = new Set(ancestorIds(plan, step));
  const outputs = plan.steps.flatMap((item) => {
    if (!relevant.has(item.id)) return [];
    const output = states.find((state) => state.stepId === item.id)?.output;
    return output ? [`[${item.actorRole} · ${item.id}]\n${output}`] : [];
  });
  return outputs.length > 0 ? outputs.join('\n\n') : '（无前序产物）';
}

function stepPrompt(run: Run, plan: CoordinationPlan, step: CoordinationPlanStep, states: CoordinationStepState[], contextGoal: string): string {
  const current = states.find((state) => state.stepId === step.id);
  const base = [
    `用户目标：${contextGoal}`,
    `Coordination Plan：${plan.id} revision ${plan.revision}`,
    `当前步骤：${step.id}`,
    `你的固定角色：${step.actorRole}`,
    `本步骤完成条件：${step.completion}`,
    `前序冻结产物：\n${dependencyTranscript(plan, step, states)}`,
  ];
  if (current?.error) base.push(`上一次反馈（必须处理）：\n${current.error}`);
  if (step.protocol === 'debate') {
    const position = step.metadata.position;
    if (position === 'pro') base.push('你是正方，立场在整个辩论期间固定。独立完成本轮论证，并回应已冻结的前序观点。');
    else if (position === 'con') base.push('你是反方，立场在整个辩论期间固定。独立完成本轮论证，并回应已冻结的前序观点。');
    else base.push('你是独立裁判。只能在全部辩论发言冻结后裁决，评价论证质量并给出明确结论。');
  } else if (step.type === 'fanout') {
    base.push('这是独立分支。不要假设其他并行成员的未完成结果，直接提交完整、可汇总的产物。');
  } else if (step.type === 'aggregate') {
    base.push('汇总所有前序分支，保留关键差异并形成一个统一交付物。');
  } else if (step.protocol === 'review_revision' && step.type === 'review') {
    const implementationAttempt = Math.max(1, ...step.dependsOn.map((id) => states.find((state) => state.stepId === id)?.attemptNo ?? 1));
    base.push('__AGENT_GAND_REVIEW_JSON__');
    base.push(`当前实现轮次：${implementationAttempt}`);
    base.push('你是独立 Reviewer。严格只输出 JSON：{"verdict":"PASS|FAIL","summary":"...","issues":[{"problem":"...","suggestion":"..."}]}');
  } else if (step.protocol === 'review_revision') {
    base.push('根据目标完成实现；如存在上一轮 Reviewer 反馈，逐项修正后重新提交完整结果。');
  }
  base.push('直接输出本步骤产物，不要声称执行了未实际完成的后续步骤。');
  return base.join('\n\n');
}

function parseReview(output: string): { verdict: 'PASS' | 'FAIL'; summary: string } | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(output.trim());
  const candidate = (fenced?.[1] ?? output).trim();
  try {
    const value = JSON.parse(candidate) as { verdict?: unknown; summary?: unknown };
    if (value.verdict !== 'PASS' && value.verdict !== 'FAIL') return null;
    return { verdict: value.verdict, summary: typeof value.summary === 'string' ? value.summary : output };
  } catch {
    return null;
  }
}

function messageType(step: CoordinationPlanStep): 'result' | 'review_result' | 'collaboration_result' {
  if (step.type === 'review') return 'review_result';
  if (step.type === 'aggregate') return 'collaboration_result';
  return 'result';
}

async function executeStep(run: Run, plan: CoordinationPlan, step: CoordinationPlanStep, agents: Map<string, AgentDefinition>, rootSpanId: string, contextGoal: string): Promise<void> {
  const before = listCoordinationStepStates(plan.id);
  const input = step.type === 'completion_gate' ? '检查全部依赖是否完成' : stepPrompt(run, plan, step, before, contextGoal);
  const claimed = claimCoordinationStep(plan, step, input);
  if (!claimed) return;
  const span = startSpan(run.id, {
    parentId: rootSpanId,
    spanKind: step.type === 'completion_gate' ? 'orchestration' : 'agent',
    name: `coordination:${step.id}`,
    input,
    attributes: {
      'coordination.plan.id': plan.id,
      'coordination.step.id': step.id,
      'coordination.attempt.id': claimed.attempt.id,
      'coordination.attempt.no': claimed.attempt.attemptNo,
      'orchestration.phase': `coordination.${step.type}`,
      ...(step.agentId ? { 'agent.id': step.agentId, 'agent.role': step.type === 'review' ? 'reviewer' : 'worker' } : {}),
    },
  });
  setCoordinationAttemptSpan(claimed.attempt.id, span.id);
  try {
    if (step.type === 'completion_gate') {
      completeCoordinationStep(plan, step.id, claimed.attempt.id, 'completion gate passed');
      endSpan(span, { output: 'completion gate passed', status: 'ok' });
      return;
    }
    const agent = step.agentId ? agents.get(step.agentId) : undefined;
    if (!agent) throw new Error(`步骤 ${step.id} 的 Agent 不存在于 Run 快照`);
    const turn = await runAgentTurn({
      run,
      agent,
      parentSpanId: span.id,
      messages: [
        { role: 'system', content: agent.systemPrompt },
        { role: 'system', content: SESSION_BOUNDARY_DIRECTIVE },
        { role: 'user', content: input },
      ],
      agentId: agent.id,
      attemptId: claimed.attempt.id,
      displayKind: step.type === 'review' ? 'review_protocol' : 'message',
      executionScopeId: claimed.attempt.idempotencyKey,
    });
    const output = turn.content.trim();
    if (!output) throw new Error(`步骤 ${step.id} 返回空结果`);
    await post({
      runId: run.id, from: agent.id, to: step.type === 'review' ? 'all' : 'all', kind: 'agent', body: output,
      messageType: messageType(step), payload: { coordinationPlanId: plan.id, coordinationStepId: step.id, attemptNo: claimed.attempt.attemptNo },
      clientMessageId: claimed.attempt.idempotencyKey,
    });
    if (step.protocol === 'review_revision' && step.type === 'review') {
      const review = parseReview(output);
      if (!review) throw new Error('Reviewer 未返回合法的 PASS/FAIL JSON');
      if (review.verdict === 'FAIL') {
        if (claimed.attempt.attemptNo >= step.maxAttempts) {
          failCoordinationStep(plan, step, claimed.attempt.id, `Reviewer 达到最大返工次数：${review.summary}`, false);
          endSpan(span, { output, status: 'error' });
          return;
        }
        const targets = Array.isArray(step.metadata.reviewTargetStepIds) ? step.metadata.reviewTargetStepIds : step.dependsOn;
        scheduleCoordinationRevision(plan, step, claimed.attempt.id, targets, output);
        endSpan(span, { output, status: 'ok' });
        return;
      }
    }
    completeCoordinationStep(plan, step.id, claimed.attempt.id, output);
    endSpan(span, { output, status: 'ok' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retry = claimed.attempt.attemptNo < step.maxAttempts;
    failCoordinationStep(plan, step, claimed.attempt.id, message, retry);
    endSpan(span, { output: message, status: 'error' });
  }
}

async function mapWithLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = cursor; cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function execute(run: Run, plan: CoordinationPlan, contextGoal: string, displayGoal: string, userMessage?: RuntimeMessageInput): Promise<void> {
  if (activeRuns.has(run.id)) return;
  activeRuns.add(run.id);
  const root = startSpan(run.id, {
    spanKind: 'orchestration', name: `coordination:plan:${plan.id}`, input: contextGoal,
    attributes: { 'coordination.plan.id': plan.id, 'orchestration.phase': 'coordination.runtime' },
  });
  try {
    setRunStatus(run.id, 'running');
    if (plan.status === 'validated') setCoordinationPlanStatus(plan.id, 'active');
    await post({
      runId: run.id, from: 'user', to: userMessage?.recipientIds?.join(',') || 'all', kind: 'user', body: displayGoal,
      replyTo: userMessage?.replyTo, taskId: userMessage?.taskId,
      clientMessageId: userMessage?.clientMessageId ?? `coordination:${plan.id}:user`, deliveryStatus: 'processing',
    });
    const snapshots = listRunAgentSnapshots(run.id);
    const agents = new Map(snapshots.map((agent) => [agent.id, agent]));
    saveCheckpoint({ runId: run.id, kind: 'coordination', phase: 'running', state: { planId: plan.id, revision: plan.revision, contextGoal } });
    for (;;) {
      const currentPlan = getRunCoordinationPlan(run.id) ?? plan;
      const states = listCoordinationStepStates(currentPlan.id);
      if (states.some((state) => state.status === 'failed')) throw new Error(`Coordination Step 失败：${states.find((state) => state.status === 'failed')?.stepId}`);
      if (states.length === currentPlan.steps.length && states.every((state) => state.status === 'completed')) {
        setCoordinationPlanStatus(currentPlan.id, 'completed');
        recordCoordinationEvent({ kind: 'plan_completed', draftId: currentPlan.draftId, planId: currentPlan.id, runId: run.id, payload: { revision: currentPlan.revision } });
        saveCheckpoint({ runId: run.id, kind: 'coordination', phase: 'completed', status: 'completed', state: { planId: currentPlan.id, revision: currentPlan.revision } });
        finishRun(run.id, 'completed');
        updateRunUserMessageStatus(run.id, 'responded');
        endSpan(root, { output: 'Coordination Plan completed', status: 'ok' });
        return;
      }
      const readyStates = prepareCoordinationReadySteps(currentPlan);
      const ready = readyStates.map((state) => currentPlan.steps.find((step) => step.id === state.stepId)).filter((step): step is CoordinationPlanStep => Boolean(step));
      if (ready.length === 0) {
        const latest = listCoordinationStepStates(currentPlan.id);
        if (latest.some((state) => state.status === 'running')) return;
        throw new Error('Coordination Runtime 无可运行步骤：依赖死锁或状态损坏');
      }
      await mapWithLimit(ready, config.orchestratorConcurrency, (step) => executeStep(run, currentPlan, step, agents, root.id, contextGoal));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setCoordinationPlanStatus(plan.id, 'failed');
    recordCoordinationEvent({ kind: 'plan_failed', draftId: plan.draftId, planId: plan.id, runId: run.id, payload: { error: message } });
    saveCheckpoint({ runId: run.id, kind: 'coordination', phase: 'failed', status: 'completed', state: { planId: plan.id, error: message } });
    finishRun(run.id, 'failed');
    try { updateRunUserMessageStatus(run.id, 'failed'); } catch { /* user message may not exist */ }
    endSpan(root, { output: message, status: 'error' });
    throw error;
  } finally {
    activeRuns.delete(run.id);
  }
}

export async function runCoordinationPlan(run: Run, contextGoal: string, displayGoal = run.goal, userMessage?: RuntimeMessageInput): Promise<void> {
  const plan = getRunCoordinationPlan(run.id);
  if (!plan) throw new Error(`Run ${run.id} 没有关联 Coordination Plan`);
  await execute(run, plan, contextGoal, displayGoal, userMessage);
}

export async function resumeCoordinationRun(runId: string): Promise<void> {
  const run = getRun(runId);
  const plan = getRunCoordinationPlan(runId);
  if (!run || !plan || plan.status === 'completed' || plan.status === 'failed') return;
  const checkpoint = latestCheckpoint(runId, 'coordination');
  const contextGoal = typeof checkpoint?.state.contextGoal === 'string' ? checkpoint.state.contextGoal : run.goal;
  await execute(run, plan, contextGoal, run.goal);
}

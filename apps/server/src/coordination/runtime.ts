import type { AgentDefinition, CoordinationPlan, CoordinationPlanStep, CoordinationStepState, Run } from '@agent-gand/shared';
import { config } from '../config.ts';
import { expirePendingApprovalsForRun } from '../hitl/approvals.ts';
import { post, postSystem, updateRunUserMessageStatus } from '../messaging/inbox.ts';
import { runAgentTurn, SESSION_BOUNDARY_DIRECTIVE } from '../orchestration/agentStep.ts';
import { latestCheckpoint, saveCheckpoint } from '../runs/checkpoints.ts';
import { endSpan, finishRun, getRun, listRunAgentSnapshots, setRunStatus, startSpan } from '../runs/trace.ts';
import { artifactStat } from '../tools/builtin/index.ts';
import {
  claimCoordinationStep,
  completeCoordinationStep,
  failCoordinationStep,
  getRunCoordinationPlan,
  listCoordinationStepStates,
  prepareCoordinationReadySteps,
  recordCoordinationEvent,
  releaseCoordinationStep,
  scheduleCoordinationRevision,
  setCoordinationAttemptInput,
  setCoordinationAttemptSpan,
  setCoordinationPlanStatus,
} from './store.ts';
import {
  assembleCoordinationKernelContext,
  assertCoordinationKernelCompletion,
  closeCoordinationKernelPlan,
  evaluateCoordinationKernel,
} from '../runtime/coordinationAdapter.ts';
import { hasRuntimeContextAssembly } from '../runtime/context.ts';

interface RuntimeMessageInput {
  recipientIds?: string[];
  replyTo?: string | null;
  taskId?: string | null;
  clientMessageId?: string;
}

const activeRuns = new Set<string>();

/** AG-COORD-01：产物最小字节数——存在但只有几十字节的"承诺式 stub"同样视为未冻结（真机 35 字符 stub 实证） */
const MIN_ARTIFACT_BYTES = 64;

function workspaceCtxOf(run: Run, plan: CoordinationPlan): { runId: string; workspace?: string | null; workspaceScope?: string | null } {
  // 与工具执行共用同一映射：ext 工作区下无前缀路径先落 <extRoot>/<planId8>/，再拼产物相对路径
  return { runId: run.id, workspace: run.workspace ?? null, workspaceScope: plan.id.slice(0, 8) };
}

/** 校验一组声明产物已落盘且非 stub；返回缺失/过短清单（空数组 = 通过） */
function missingArtifacts(run: Run, plan: CoordinationPlan, paths: string[]): string[] {
  const ctx = workspaceCtxOf(run, plan);
  return paths.filter((artifactPath) => {
    const stat = artifactStat(artifactPath, ctx);
    return !stat.exists || stat.size < MIN_ARTIFACT_BYTES;
  });
}

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
  // AG-COORD-01：产物路径由计划结构化声明，prompt 明确指令，不再依赖模型自选文件名
  if (step.expectedArtifacts && step.expectedArtifacts.length > 0) {
    base.push(`本步骤产物必须使用 fs.write 完整冻结到 ${step.expectedArtifacts.map((artifactPath) => `\`${artifactPath}\``).join('、')}；完成后在回复中确认已写入，未写入即视为未完成。`);
  }
  // AG-COORD-05：前序产物已全文注入，抑制重复 fs.read（真机每步重读全部历史文件，双倍上下文+聊天刷屏）
  if (ancestorIds(plan, step).length > 0) {
    base.push('前序冻结产物已完整注入上文，不要再用 fs.read 重读已冻结文件；引用时直接引用上文内容。');
  }
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

async function executeStep(run: Run, plan: CoordinationPlan, step: CoordinationPlanStep, agents: Map<string, AgentDefinition>, rootSpanId: string, contextGoal: string): Promise<'paused' | void> {
  const before = listCoordinationStepStates(plan.id);
  const baseInput = step.type === 'completion_gate' ? '检查全部依赖是否完成' : stepPrompt(run, plan, step, before, contextGoal);
  const claimed = claimCoordinationStep(plan, step, baseInput);
  if (!claimed) return;
  const input = step.type === 'completion_gate' ? baseInput
    : hasRuntimeContextAssembly(claimed.attempt.id) && claimed.attempt.input
      ? claimed.attempt.input
      : assembleCoordinationKernelContext({ run, plan, step, attemptId: claimed.attempt.id, baseInput });
  if (input !== claimed.attempt.input) setCoordinationAttemptInput(claimed.attempt.id, input);
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
    // AG-COORD-01 终局屏障：review/aggregate 启动前校验全部祖先声明产物已真实落盘——
    // 即使上游步骤状态被误标 completed，缺产物也在此阻断，不允许裁判在证据缺失时出具裁决
    if (step.type === 'review' || step.type === 'aggregate') {
      const ancestors = ancestorIds(plan, step);
      const required = plan.steps
        .filter((item) => ancestors.includes(item.id))
        .flatMap((item) => item.expectedArtifacts ?? []);
      const missing = missingArtifacts(run, plan, required);
      if (missing.length > 0) {
        throw new Error(`终局屏障阻止：前序产物缺失或过短（${missing.join('、')}），不能进入 ${step.id}`);
      }
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
      // AG-COORD-03：外部工作区按 plan 隔离；内部/命名工作区忽略 scope（本就按 run/房间隔离）
      workspaceScope: plan.id.slice(0, 8),
    });
    // AG-COORD-04：审批连续超时 → 释放步骤（不烧 attempt 失败）并上抛暂停信号，由 execute() 暂停 run
    if (turn.approvalStarved) {
      releaseCoordinationStep(plan, step, claimed.attempt.id, '审批连续超时，等待用户处理后恢复');
      endSpan(span, { output: '审批连续超时，步骤已暂停', status: 'ok' });
      return 'paused';
    }
    // AG-COORD-02：升预算重发后仍截断 → 判定 attempt 失败（走既有重试），不得把截断正文当产物
    if (turn.truncated) {
      throw new Error('LLM 响应被 max_tokens 截断（升预算重发后仍不完整）；可调大 LLM_MAX_TOKENS');
    }
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
    // AG-COORD-01 完成校验：声明产物的步骤必须真实落盘且非 stub 才允许标记 completed
    if (step.expectedArtifacts && step.expectedArtifacts.length > 0) {
      const missing = missingArtifacts(run, plan, step.expectedArtifacts);
      if (missing.length > 0) {
        throw new Error(`产物未冻结或过短（${missing.join('、')}）：必须先用 fs.write 写入完整内容`);
      }
    }
    completeCoordinationStep(plan, step.id, claimed.attempt.id, output);
    endSpan(span, { output, status: 'ok' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedStates = listCoordinationStepStates(plan.id);
    closeCoordinationKernelPlan(plan, failedStates, false);
    evaluateCoordinationKernel(plan, failedStates);
    const retry = claimed.attempt.attemptNo < step.maxAttempts;
    failCoordinationStep(plan, step, claimed.attempt.id, message, retry);
    endSpan(span, { output: message, status: 'error' });
  }
}

async function mapWithLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<'paused' | void>): Promise<Array<'paused' | void>> {
  let cursor = 0;
  const results: Array<'paused' | void> = [];
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = cursor; cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      results.push(await fn(item));
    }
  });
  await Promise.all(workers);
  return results;
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
    if (plan.status === 'validated' || plan.status === 'paused') setCoordinationPlanStatus(plan.id, 'active');
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
      evaluateCoordinationKernel(currentPlan, states);
      if (states.some((state) => state.status === 'failed')) throw new Error(`Coordination Step 失败：${states.find((state) => state.status === 'failed')?.stepId}`);
      if (states.length === currentPlan.steps.length && states.every((state) => state.status === 'completed')) {
        assertCoordinationKernelCompletion(currentPlan, states);
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
      const results = await mapWithLimit(ready, config.orchestratorConcurrency, (step) => executeStep(run, currentPlan, step, agents, root.id, contextGoal));
      // AG-COORD-04：批次内出现暂停信号 → run 置 waiting_for_user（plan 置 paused），由用户显式恢复/取消。
      // 不 finishRun、不清 activeRuns 之外的执行态：步骤已释放回 ready，恢复时复用原 attempt 继续。
      const pauseRequested = getRunCoordinationPlan(run.id)?.status === 'pause_requested';
      if (results.includes('paused') || pauseRequested) {
        const reason = pauseRequested ? 'user_requested' : 'approval_starved';
        setRunStatus(run.id, 'waiting_for_user');
        setCoordinationPlanStatus(currentPlan.id, 'paused');
        saveCheckpoint({ runId: run.id, kind: 'coordination', phase: 'waiting_for_user', status: 'waiting', state: { planId: currentPlan.id, revision: currentPlan.revision, contextGoal, reason } });
        recordCoordinationEvent({ kind: 'plan_paused', draftId: currentPlan.draftId, planId: currentPlan.id, runId: run.id, payload: { reason, ...(pauseRequested ? {} : { approvalMaxExpiries: config.approvalMaxExpiries }) } });
        expirePendingApprovalsForRun(run.id);
        await postSystem(run.id, 'system', pauseRequested
          ? 'Coordination Plan 已在安全步骤边界暂停，可以调整后续计划或直接恢复。'
          : `审批连续超时（上限 ${config.approvalMaxExpiries} 次），运行已暂停；处理完审批卡后可恢复运行，或直接取消。`);
        endSpan(root, { output: pauseRequested ? '用户请求暂停' : '审批连续超时，等待用户恢复', status: 'ok' });
        return;
      }
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

export async function resumeCoordinationRun(runId: string): Promise<Run | null> {
  const run = getRun(runId);
  const plan = getRunCoordinationPlan(runId);
  if (!run || !plan || plan.status === 'completed' || plan.status === 'failed' || plan.status === 'cancelled') return run ?? null;
  const checkpoint = latestCheckpoint(runId, 'coordination');
  const contextGoal = typeof checkpoint?.state.contextGoal === 'string' ? checkpoint.state.contextGoal : run.goal;
  if (plan.status === 'paused') {
    recordCoordinationEvent({ kind: 'plan_resumed', draftId: plan.draftId, planId: plan.id, runId, payload: { by: 'user' } });
  }
  await execute(run, plan, contextGoal, run.goal);
  return run;
}

export function requestCoordinationPause(runId: string): Run | null {
  const run = getRun(runId);
  const plan = getRunCoordinationPlan(runId);
  if (!run || !plan) return run ?? null;
  if (plan.status === 'paused') return run;
  if (!['validated', 'active'].includes(plan.status) || !['pending', 'running', 'awaiting_approval'].includes(run.status)) return run;
  setCoordinationPlanStatus(plan.id, 'pause_requested');
  recordCoordinationEvent({ kind: 'plan_pause_requested', draftId: plan.draftId, planId: plan.id, runId, payload: { revision: plan.revision } });
  return getRun(runId) ?? run;
}

/** AG-COORD-04：用户显式取消暂停中的 Coordination run（终态，不可恢复）。 */
export function cancelCoordinationRun(runId: string): Run | null {
  const run = getRun(runId);
  const plan = getRunCoordinationPlan(runId);
  if (!run || !plan) return run ?? null;
  if (plan.status === 'completed' || plan.status === 'failed' || plan.status === 'cancelled') return run;
  const cancelledStates = listCoordinationStepStates(plan.id);
  closeCoordinationKernelPlan(plan, cancelledStates, true);
  evaluateCoordinationKernel(plan, cancelledStates);
  setCoordinationPlanStatus(plan.id, 'cancelled');
  recordCoordinationEvent({ kind: 'plan_cancelled', draftId: plan.draftId, planId: plan.id, runId, payload: { by: 'user' } });
  expirePendingApprovalsForRun(runId, 'system:cancelled');
  finishRun(runId, 'cancelled');
  try { updateRunUserMessageStatus(runId, 'failed'); } catch { /* user message may not exist */ }
  return getRun(runId) ?? run;
}

import type { AgentDefinition, Run, Task } from '@agent-gand/shared';
import { config } from '../config.ts';
import { emit } from '../messaging/bus.ts';
import { postSystem, sendAgentMessage } from '../messaging/inbox.ts';
import {
  claimRevision,
  claimTask,
  completeTask,
  failTask,
  getTask,
  listTasks,
  transitionTask,
} from '../messaging/tasks.ts';
import { endSpan, startSpan } from '../runs/trace.ts';
import { completeAttempt, createAttempt, failAttempt } from '../tasks/attempts.ts';
import { createReview } from '../tasks/reviews.ts';
import { runAgentTurn, SESSION_BOUNDARY_DIRECTIVE } from './agentStep.ts';
import { buildWorkContext } from './contextBuilder.ts';
import { reviewTask } from './reviewStep.ts';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

async function mapWithLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function reviewPayload(review: ReturnType<typeof createReview>): Record<string, unknown> {
  return { verdict: review.verdict, summary: review.summary, issues: review.issues };
}

async function executeTask(
  run: Run,
  initial: Task,
  agents: Map<string, AgentDefinition>,
  parentSpanId: string,
): Promise<void> {
  const fresh = getTask(initial.id);
  if (!fresh || (fresh.status !== 'pending' && fresh.status !== 'needs_revision')) return;
  initial = fresh;
  const assigneeId = initial.assignee;
  if (!assigneeId) {
    failTask(initial.id, '任务没有 assignee');
    return;
  }
  const agent = agents.get(assigneeId);
  if (!agent) {
    failTask(initial.id, `任务 assignee 不在当前团队: ${assigneeId}`);
    return;
  }

  const claimed = initial.status === 'needs_revision'
    ? claimRevision(initial.id, assigneeId)
    : claimTask(initial.id, assigneeId);
  const context = buildWorkContext(run, claimed);
  let attempt = createAttempt({
    taskId: claimed.id,
    runId: run.id,
    agentId: agent.id,
    kind: 'work',
    attemptNo: claimed.attempt,
    inputContext: context,
    leaseMs: config.taskLeaseMs,
  });
  const agentSpan = startSpan(run.id, {
    parentId: parentSpanId,
    spanKind: 'agent',
    name: `agent:${agent.id}（task:${claimed.id.slice(0, 8)} attempt:${claimed.attempt}）`,
    input: context,
  });
  await sendAgentMessage({
    runId: run.id,
    taskId: claimed.id,
    from: run.supervisorId ?? 'supervisor',
    to: agent.id,
    kind: 'agent',
    messageType: claimed.attempt === 1 ? 'assignment' : 'revision_request',
    body: claimed.attempt === 1
      ? `任务指派：${claimed.title}`
      : `返工指派：${claimed.title}（第 ${claimed.attempt}/${claimed.maxAttempts} 次）`,
    payload: { attemptId: attempt.id, attemptNo: claimed.attempt },
  });

  let output: string;
  try {
    const turn = await runAgentTurn({
      run,
      agent,
      parentSpanId: agentSpan.id,
      messages: [
        { role: 'system', content: agent.systemPrompt },
        { role: 'system', content: SESSION_BOUNDARY_DIRECTIVE },
        { role: 'user', content: context },
      ],
    });
    output = turn.content.trim();
    if (turn.emptyResponse || output === '') throw new Error('Agent 未返回可用结果');
    attempt = completeAttempt(attempt.id, output);
    endSpan(agentSpan, { output, status: 'ok' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try { failAttempt(attempt.id, message); } catch { /* attempt 可能已经结束 */ }
    endSpan(agentSpan, { output: message, status: 'error' });
    const current = getTask(claimed.id);
    if (current && current.status === 'in_progress') {
      if (current.attempt < current.maxAttempts) {
        transitionTask(current.id, { from: 'in_progress', to: 'needs_revision', error: message });
      } else {
        failTask(current.id, message);
      }
    }
    await postSystem(run.id, agent.id, `任务「${claimed.title}」执行失败：${message}`);
    return;
  }

  await sendAgentMessage({
    runId: run.id,
    taskId: claimed.id,
    from: agent.id,
    to: claimed.reviewerId ?? run.supervisorId ?? 'supervisor',
    kind: 'agent',
    messageType: claimed.reviewerId ? 'review_request' : 'result',
    body: output,
    payload: { attemptId: attempt.id, attemptNo: claimed.attempt },
  });

  if (!claimed.reviewerId) {
    completeTask(claimed.id, agent.id, output);
    return;
  }
  const reviewer = agents.get(claimed.reviewerId);
  if (!reviewer) {
    failTask(claimed.id, `Reviewer 不在当前团队: ${claimed.reviewerId}`);
    return;
  }
  const awaiting = transitionTask(claimed.id, { from: 'in_progress', to: 'awaiting_review' });
  const reviewContext = `审查任务「${awaiting.title}」的第 ${awaiting.attempt} 次实现`;
  const reviewAttempt = createAttempt({
    taskId: awaiting.id,
    runId: run.id,
    agentId: reviewer.id,
    kind: 'review',
    attemptNo: awaiting.attempt,
    inputContext: reviewContext,
    leaseMs: config.taskLeaseMs,
  });
  const reviewSpan = startSpan(run.id, {
    parentId: parentSpanId,
    spanKind: 'agent',
    name: `agent:${reviewer.id}（review:${awaiting.id.slice(0, 8)} attempt:${awaiting.attempt}）`,
    input: reviewContext,
  });
  try {
    const parsed = await reviewTask({ run, task: awaiting, workAttempt: attempt, reviewer, parentSpanId: reviewSpan.id });
    const review = createReview({
      taskId: awaiting.id,
      attemptId: attempt.id,
      reviewerId: reviewer.id,
      ...parsed,
    });
    completeAttempt(reviewAttempt.id, JSON.stringify(parsed));
    endSpan(reviewSpan, { output: JSON.stringify(parsed), status: 'ok' });
    await sendAgentMessage({
      runId: run.id,
      taskId: awaiting.id,
      from: reviewer.id,
      to: parsed.verdict === 'PASS' ? run.supervisorId ?? 'supervisor' : agent.id,
      kind: 'agent',
      messageType: parsed.verdict === 'PASS' ? 'review_result' : 'revision_request',
      body: `${parsed.verdict}：${parsed.summary}`,
      payload: reviewPayload(review),
    });
    if (parsed.verdict === 'PASS') {
      transitionTask(awaiting.id, { from: 'awaiting_review', to: 'completed', result: output });
    } else if (awaiting.attempt < awaiting.maxAttempts) {
      transitionTask(awaiting.id, { from: 'awaiting_review', to: 'needs_revision', error: parsed.summary });
    } else {
      failTask(awaiting.id, `达到最大执行次数；最终审查失败：${parsed.summary}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try { failAttempt(reviewAttempt.id, message); } catch { /* attempt 可能已经结束 */ }
    endSpan(reviewSpan, { output: message, status: 'error' });
    failTask(awaiting.id, `审查失败：${message}`);
    await postSystem(run.id, reviewer.id, `任务「${awaiting.title}」审查失败：${message}`);
  }
}

export interface ScheduleResult {
  tasks: Task[];
  failed: boolean;
}

/** 按 DAG ready wave 调度；每一 wave 内受 concurrency 限制并行。 */
export async function runTaskSchedule(input: {
  run: Run;
  agents: AgentDefinition[];
  parentSpanId: string;
}): Promise<ScheduleResult> {
  const agentMap = new Map(input.agents.map((agent) => [agent.id, agent]));
  for (;;) {
    let tasks = listTasks(input.run.id);

    // 依赖失败后，该任务不再可能 ready，明确失败并保留原因。
    for (const task of tasks) {
      if (task.status !== 'pending' && task.status !== 'needs_revision') continue;
      const failedBlocker = task.blockedBy
        .map((id) => getTask(id))
        .find((blocker) => blocker?.status === 'failed' || blocker?.status === 'cancelled');
      if (failedBlocker) failTask(task.id, `前置任务未完成：${failedBlocker.title}`);
    }
    tasks = listTasks(input.run.id);
    if (tasks.every((task) => TERMINAL.has(task.status))) {
      return { tasks, failed: tasks.some((task) => task.status !== 'completed') };
    }

    const byId = new Map(tasks.map((task) => [task.id, task]));
    const ready = tasks.filter(
      (task) =>
        (task.status === 'pending' || task.status === 'needs_revision') &&
        task.blockedBy.every((id) => byId.get(id)?.status === 'completed'),
    );
    if (ready.length === 0) {
      const stuck = tasks.filter((task) => !TERMINAL.has(task.status));
      for (const task of stuck) failTask(task.id, '调度器无可运行任务：依赖死锁或遗留执行状态');
      return { tasks: listTasks(input.run.id), failed: true };
    }

    emit({
      type: 'scheduler.updated',
      runId: input.run.id,
      active: Math.min(config.orchestratorConcurrency, ready.length),
      queued: Math.max(0, ready.length - config.orchestratorConcurrency),
    });
    await mapWithLimit(ready, config.orchestratorConcurrency, (task) =>
      executeTask(input.run, task, agentMap, input.parentSpanId),
    );
  }
}

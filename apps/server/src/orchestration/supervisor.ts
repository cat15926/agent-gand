/**
 * 主管委派：一次结构化规划 → DAG 调度 → Coder/Reviewer 返工闭环 → 基于真实结果汇总。
 */
import type { AgentDefinition, Run } from '@agent-gand/shared';
import { post, postSystem } from '../messaging/inbox.ts';
import { createTask } from '../messaging/tasks.ts';
import { endSpan, finishRun, getRun, listRunAgentSnapshots, setRunStatus, startSpan } from '../runs/trace.ts';
import { saveCheckpoint } from '../runs/checkpoints.ts';
import { chatOnce } from './agentStep.ts';
import { buildSupervisorSummaryContext } from './contextBuilder.ts';
import { runTaskSchedule } from './scheduler.ts';
import type { Orchestrator } from './types.ts';
import { tx } from '../db/database.ts';

interface DecomposedTask {
  title: string;
  body: string | null;
  acceptanceCriteria: string[];
  assignee: string;
  reviewer: string | null;
  blockedByTitles: string[];
}

const MAX_TASKS = 5;

function extractJsonText(content: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content.trim());
  const candidate = (fenced?.[1] ?? content).trim();
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  return first >= 0 && last > first ? candidate.slice(first, last + 1) : candidate;
}

/** 严格校验任务数量、角色、验收标准和 DAG，返回拓扑序。 */
export function parseDecomposition(
  content: string,
  workers: AgentDefinition[],
  allAgents: AgentDefinition[],
  defaultReviewerId?: string | null,
): DecomposedTask[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(content));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rawTasks = (parsed as { tasks?: unknown }).tasks;
  if (!Array.isArray(rawTasks) || rawTasks.length === 0 || rawTasks.length > MAX_TASKS) return null;

  const workerIds = new Set(workers.map((agent) => agent.id));
  const reviewerIds = new Set(allAgents.filter((agent) => agent.capabilities.includes('review')).map((agent) => agent.id));
  const tasks: DecomposedTask[] = [];
  const titles = new Set<string>();
  for (const raw of rawTasks) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.title !== 'string' || item.title.trim() === '' || titles.has(item.title.trim())) return null;
    if (typeof item.assignee !== 'string' || !workerIds.has(item.assignee)) return null;
    const inferredReviewer = (defaultReviewerId && reviewerIds.has(defaultReviewerId) && defaultReviewerId !== item.assignee
      ? defaultReviewerId : allAgents.find((agent) => agent.capabilities.includes('review') && agent.id !== item.assignee)?.id) ?? null;
    const reviewer = typeof item.reviewer === 'string' ? item.reviewer : inferredReviewer;
    const reviewRequired = item.reviewRequired === true || (item.reviewRequired !== false && reviewer !== null);
    if (reviewRequired && (reviewer === null || !reviewerIds.has(reviewer))) return null;
    if (reviewer === item.assignee && allAgents.length > 1) return null;
    const rawCriteria = Array.isArray(item.acceptanceCriteria)
      ? item.acceptanceCriteria
      : [typeof item.body === 'string' ? item.body : `完成任务：${item.title}`];
    const acceptanceCriteria = rawCriteria.filter(
      (criterion): criterion is string => typeof criterion === 'string' && criterion.trim() !== '',
    );
    if (acceptanceCriteria.length === 0 || acceptanceCriteria.length !== rawCriteria.length) return null;
    const blockedByTitles = Array.isArray(item.blockedBy)
      ? item.blockedBy.filter((value): value is string => typeof value === 'string')
      : [];
    if (Array.isArray(item.blockedBy) && blockedByTitles.length !== item.blockedBy.length) return null;
    const title = item.title.trim();
    titles.add(title);
    tasks.push({
      title,
      body: typeof item.body === 'string' ? item.body : null,
      acceptanceCriteria,
      assignee: item.assignee,
      reviewer: reviewRequired ? reviewer : null,
      blockedByTitles,
    });
  }

  const byTitle = new Map(tasks.map((task) => [task.title, task]));
  const done = new Set<string>();
  const ordered: DecomposedTask[] = [];
  while (ordered.length < tasks.length) {
    const ready = tasks.filter(
      (task) =>
        !done.has(task.title) &&
        task.blockedByTitles.every((title) => title !== task.title && byTitle.has(title) && done.has(title)),
    );
    if (ready.length === 0) return null;
    for (const task of ready) {
      done.add(task.title);
      ordered.push(task);
    }
  }
  return ordered;
}

function decomposePrompt(goal: string, workers: AgentDefinition[], allAgents: AgentDefinition[]): string {
  const workerList = workers.map((agent) => `- ${agent.id}：${agent.description ?? '（无描述）'}`).join('\n');
  const reviewerList = allAgents.filter((agent) => agent.capabilities.includes('review')).map((agent) => `* ${agent.id}：${agent.description ?? '（无描述）'}`).join('\n');
  return [
    `目标：${goal}`,
    '',
    '可执行任务的成员（assignee 从中选择）：',
    workerList,
    '',
    '可用审查成员（reviewer 从中选择，且不能和 assignee 相同）：',
    reviewerList,
    '',
    '严格只输出 JSON，任务数 1～5：',
    '{"tasks":[{"title":"任务标题","body":"任务说明","acceptanceCriteria":["验收标准"],"assignee":"成员id","reviewer":"审查成员id","blockedBy":["依赖任务标题"]}]}',
    '无需审查时设置 reviewRequired:false 并省略 reviewer。blockedBy 可省略。',
  ].join('\n');
}

function fallbackTasks(goal: string, workers: AgentDefinition[], allAgents: AgentDefinition[], defaultReviewerId?: string | null): DecomposedTask[] {
  const reviewer = allAgents.find((agent) => agent.id === defaultReviewerId && agent.capabilities.includes('review'))
    ?? allAgents.find((agent) => agent.capabilities.includes('review'));
  const executorPool = reviewer ? workers.filter((agent) => agent.id !== reviewer.id) : workers;
  const executor = executorPool[0] ?? workers[0] ?? allAgents[0];
  if (!executor) throw new Error('主管委派至少需要一个可执行 Agent');
  const excerpt = goal.trim().slice(0, 30);
  const blueprints = /调研|研究|分析/.test(goal)
    ? [
        ['收集资料', '围绕目标收集相关材料与背景信息'],
        ['整理要点', '归纳已有信息并提炼关键结论'],
        ['输出结论', '汇总为可交付的结论报告'],
      ]
    : [
        ['拆解目标', '明确目标、约束和实施步骤'],
        ['完成实现', '按步骤完成主体工作'],
        ['复核交付', '检查产出并给出最终结果'],
      ];
  return blueprints.map(([prefix, body], index) => ({
    title: `${prefix}：${excerpt}`,
    body: body ?? goal,
    acceptanceCriteria: [body ?? '完成任务', '给出可验证的结果或产物说明'],
    assignee: executor.id,
    reviewer: reviewer && reviewer.id !== executor.id ? reviewer.id : null,
    blockedByTitles: index === 0 ? [] : [`${blueprints[index - 1]?.[0]}：${excerpt}`],
  }));
}

const activeSchedules = new Set<string>();

async function scheduleAndSummarize(
  run: Run,
  agents: AgentDefinition[],
  supervisor: AgentDefinition,
  parentSpanId: string,
): Promise<void> {
  saveCheckpoint({ runId: run.id, kind: 'supervisor', phase: 'scheduling', state: {} });
  const scheduled = await runTaskSchedule({ run, agents, parentSpanId });
  saveCheckpoint({ runId: run.id, kind: 'supervisor', phase: 'summarizing', state: { failed: scheduled.failed } });
  const summaryPrompt = buildSupervisorSummaryContext(run, scheduled.tasks);
  const summary = await chatOnce(supervisor, run.id, parentSpanId, summaryPrompt);
  if (summary.trim() !== '') {
    await post({
      runId: run.id,
      from: supervisor.id,
      to: 'user',
      kind: 'agent',
      messageType: 'result',
      body: summary,
      payload: { failed: scheduled.failed },
      clientMessageId: `durable:${run.id}:supervisor:summary`,
    });
  }
  finishRun(run.id, scheduled.failed ? 'failed' : 'completed');
  saveCheckpoint({ runId: run.id, kind: 'supervisor', phase: 'completed', status: 'completed', state: { failed: scheduled.failed } });
}

/** 人工重试与启动恢复入口：复用已落库任务，不重复规划。 */
export async function resumeSupervisorRun(runId: string): Promise<void> {
  if (activeSchedules.has(runId)) return;
  const run = getRun(runId);
  if (!run || run.mode !== 'supervisor') return;
  const supervisorId = run.supervisorId ?? run.agentIds[0];
  if (!supervisorId) return;
  const snapshots = listRunAgentSnapshots(run.id);
  const agents = run.agentIds.map((id) => snapshots.find((agent) => agent.id === id))
    .filter((agent): agent is AgentDefinition => agent !== undefined);
  const supervisor = agents.find((agent) => agent.id === supervisorId);
  if (!supervisor) return;
  const ordered = [supervisor, ...agents.filter((agent) => agent.id !== supervisor.id)];
  activeSchedules.add(runId);
  setRunStatus(runId, 'running');
  const span = startSpan(runId, { spanKind: 'orchestration', name: `resume:${supervisor.id}`, input: '恢复已落库任务',
    attributes: { 'agent.id': supervisor.id, 'agent.role': 'supervisor', 'orchestration.phase': 'supervisor.resume' } });
  try {
    await scheduleAndSummarize(run, ordered, supervisor, span.id);
    endSpan(span, { output: '恢复调度完成', status: 'ok' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    endSpan(span, { output: message, status: 'error' });
    finishRun(runId, 'failed');
    throw err;
  } finally {
    activeSchedules.delete(runId);
  }
}

export const supervisorOrchestrator: Orchestrator = {
  async start(run: Run, agents: AgentDefinition[], goal: string, displayGoal = goal, userMessage): Promise<void> {
    try {
      setRunStatus(run.id, 'running');
      await post({ runId: run.id, from: 'user', to: userMessage?.recipientIds?.join(',') || 'all', kind: 'user', body: displayGoal,
        replyTo: userMessage?.replyTo, taskId: userMessage?.taskId, clientMessageId: userMessage?.clientMessageId, deliveryStatus: 'processing' });
      const supervisor = agents[0];
      if (!supervisor) throw new Error('supervisor 模式至少需要 1 个 agent');
      if (!supervisor.capabilities.includes('coordinate')) throw new Error(`主管 ${supervisor.id} 不具备协调能力`);
      const workers = agents.filter((agent) => agent.id !== supervisor.id && agent.capabilities.includes('execute'));
      if (workers.length === 0 && supervisor.capabilities.includes('execute')) workers.push(supervisor);
      if (workers.length === 0) throw new Error('主管委派至少需要一个具备执行能力的 Agent');
      const supervisorSpan = startSpan(run.id, {
        spanKind: 'orchestration',
        name: `supervisor:${supervisor.id}`,
        input: goal,
        attributes: { 'agent.id': supervisor.id, 'agent.role': 'supervisor', 'orchestration.phase': 'supervisor.schedule' },
      });
      saveCheckpoint({ runId: run.id, kind: 'supervisor', phase: 'planning', state: { supervisorId: supervisor.id } });

      let specs: DecomposedTask[] | null = null;
      if (!supervisor.model.startsWith('mock:')) {
        try {
          const raw = await chatOnce(supervisor, run.id, supervisorSpan.id, decomposePrompt(goal, workers, agents), 'review_protocol');
          specs = parseDecomposition(raw, workers, agents, run.defaultReviewerId);
        } catch {
          specs = null;
        }
      }
      if (!specs) {
        specs = fallbackTasks(goal, workers, agents, run.defaultReviewerId);
        if (!supervisor.model.startsWith('mock:')) {
          await postSystem(run.id, supervisor.id, '结构化拆解失败已降级为安全 fallback 计划');
        }
      }

      const titleToId = new Map<string, string>();
      // 规划任务必须原子落库：进程在循环中崩溃时 SQLite 回滚，恢复器不会调度半张 DAG。
      tx(() => {
        for (const spec of specs) {
          const task = createTask({
            runId: run.id,
            title: spec.title,
            body: spec.body,
            createdBy: supervisor.id,
            assignee: spec.assignee,
            reviewerId: spec.reviewer,
            acceptanceCriteria: spec.acceptanceCriteria,
            blockedBy: spec.blockedByTitles
              .map((title) => titleToId.get(title))
              .filter((id): id is string => id !== undefined),
          });
          titleToId.set(spec.title, task.id);
        }
      });
      saveCheckpoint({ runId: run.id, kind: 'supervisor', phase: 'tasks_created', state: { taskCount: specs.length } });

      activeSchedules.add(run.id);
      try {
        await scheduleAndSummarize(run, agents, supervisor, supervisorSpan.id);
        const finished = getRun(run.id);
        endSpan(supervisorSpan, {
          output: '主管调度与汇总完成',
          status: finished?.status === 'completed' ? 'ok' : 'error',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        endSpan(supervisorSpan, { output: message, status: 'error' });
        throw err;
      } finally {
        activeSchedules.delete(run.id);
      }
    } catch (err) {
      finishRun(run.id, 'failed');
      throw err;
    }
  },
};

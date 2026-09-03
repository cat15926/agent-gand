/**
 * 主管委派编排（规格 §4.2 + §7.2）
 * supervisor（第一个 agent）拆解目标为 tasks：真实 LLM 用结构化 JSON 拆解
 * （assignee 校验、标题去重、blockedBy 无环），非法输出 fallback 到 mock 拆解；
 * worker 逐个 claim → 执行（LLM + 工具调用循环，含权限门控/审批）→ complete，
 * 最后 supervisor 汇总一条 message。mock 模型的 supervisor 直接走 mock 拆解（零回归）。
 * TODO: worker 并行执行与失败重试
 */
import type { AgentDefinition, Run } from '@agent-gand/shared';
import { post, postSystem } from '../messaging/inbox.ts';
import { claimTask, createTask, completeTask } from '../messaging/tasks.ts';
import { endSpan, finishRun, setRunStatus, startSpan } from '../runs/trace.ts';
import { chatOnce, runAgentTurn } from './agentStep.ts';
import type { Orchestrator } from './types.ts';

/** mock 任务拆解：按 goal 关键词确定性生成 2-3 条（零回归的 fallback 路径） */
function planTasksByGoal(goal: string): Array<{ title: string; body: string }> {
  const g = goal.trim().slice(0, 30);
  if (/调研|研究|分析/.test(goal)) {
    return [
      { title: `收集资料：${g}`, body: '围绕目标收集相关材料与背景信息' },
      { title: `整理要点：${g}`, body: '归纳收集到的信息，提炼关键结论' },
      { title: `输出结论：${g}`, body: '汇总为一份结论报告' },
    ];
  }
  if (goal.trim().length <= 8) {
    return [
      { title: `理解目标：${g}`, body: '明确目标含义与验收口径' },
      { title: `给出结果：${g}`, body: '产出最终答复' },
    ];
  }
  return [
    { title: `拆解目标：${g}`, body: '把目标拆成可执行的步骤' },
    { title: `逐步实现：${g}`, body: '按步骤完成实现工作' },
    { title: `复核汇总：${g}`, body: '检查产出并汇总结论' },
  ];
}

// ---- 结构化拆解（规格 §7.2）----

/** 校验通过后的任务规格（blockedBy 已解析为同批次 title 引用） */
interface DecomposedTask {
  title: string;
  body: string | null;
  assignee: string;
  blockedByTitles: string[];
}

const MAX_TASKS = 5;

/** 提取 JSON 文本：容忍 ```json 围栏包裹或散文夹带（取首个 { 到末个 }） */
function extractJsonText(content: string): string {
  const trimmed = content.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first >= 0 && last > first) return candidate.slice(first, last + 1);
  return candidate;
}

/**
 * 校验 LLM 输出：{"tasks":[{title,body,assignee,blockedBy?}]}。
 * assignee ∈ 团队、标题非空且去重、blockedBy 引用存在且无环、任务数 ≤5；
 * 任一不合法返回 null（调用方 fallback）。返回值为拓扑序。
 */
function parseDecomposition(content: string, roster: AgentDefinition[]): DecomposedTask[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(content));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const tasksRaw = (parsed as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasksRaw) || tasksRaw.length === 0) return null;

  const rosterIds = new Set(roster.map((a) => a.id));
  const tasks: DecomposedTask[] = [];
  const seenTitles = new Set<string>();
  for (const raw of tasksRaw.slice(0, MAX_TASKS)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const t = raw as { title?: unknown; body?: unknown; assignee?: unknown; blockedBy?: unknown };
    if (typeof t.title !== 'string' || t.title.trim().length === 0) return null;
    const title = t.title.trim();
    if (seenTitles.has(title)) return null; // 标题去重
    seenTitles.add(title);
    if (typeof t.assignee !== 'string' || !rosterIds.has(t.assignee)) return null; // assignee ∈ 团队
    const blockedBy = Array.isArray(t.blockedBy)
      ? t.blockedBy.filter((b): b is string => typeof b === 'string')
      : [];
    tasks.push({
      title,
      body: typeof t.body === 'string' ? t.body : null,
      assignee: t.assignee,
      blockedByTitles: blockedBy,
    });
  }

  // 拓扑排序 + 环检测（Kahn）
  const byTitle = new Map(tasks.map((t) => [t.title, t]));
  const deps = new Map<string, Set<string>>();
  for (const t of tasks) {
    const refs = new Set<string>();
    for (const ref of t.blockedByTitles) {
      if (ref === t.title) return null; // 自引用
      if (!byTitle.has(ref)) return null; // 引用不存在
      refs.add(ref);
    }
    deps.set(t.title, refs);
  }
  const ordered: DecomposedTask[] = [];
  const done = new Set<string>();
  for (;;) {
    const ready = tasks.filter((t) => !done.has(t.title) && [...deps.get(t.title)!].every((d) => done.has(d)));
    if (ready.length === 0) break;
    for (const t of ready) {
      done.add(t.title);
      ordered.push(t);
    }
  }
  return ordered.length === tasks.length ? ordered : null; // 不等长 → 有环
}

/** 结构化拆解 prompt（附团队成员名单，要求 assignee 从中选） */
function decomposePrompt(goal: string, roster: AgentDefinition[]): string {
  const members = roster.map((a) => `- ${a.id}：${a.description ?? '（无描述）'}`).join('\n');
  return [
    `目标：${goal}`,
    '',
    '团队成员（assignee 必须从下列 id 中选择）：',
    members,
    '',
    '请把目标拆解为不超过 5 条任务，严格只输出 JSON（不要输出 JSON 以外的任何文字），格式：',
    '{"tasks":[{"title":"任务标题","body":"任务说明","assignee":"成员id","blockedBy":["依赖任务的title"]}]}',
    '其中 blockedBy 为可选字段，表示该任务依赖的其他任务标题。',
  ].join('\n');
}

export const supervisorOrchestrator: Orchestrator = {
  async start(run: Run, agents: AgentDefinition[], goal: string): Promise<void> {
    try {
      setRunStatus(run.id, 'running');
      const supervisor = agents[0];
      if (!supervisor) throw new Error('supervisor 模式至少需要 1 个 agent');
      const agentMap = new Map(agents.map((a) => [a.id, a]));
      const roster = agents.length > 1 ? agents.slice(1) : [supervisor];

      // 1. supervisor 拆解目标（真实 LLM 结构化；mock 直接走规则拆解，零回归）
      const supSpan = startSpan(run.id, {
        spanKind: 'agent',
        name: `agent:${supervisor.id}（supervisor）`,
        input: goal,
      });
      const planContent = await chatOnce(supervisor, run.id, supSpan.id, goal);
      if (planContent.trim().length > 0) {
        await post({ runId: run.id, from: supervisor.id, to: 'all', kind: 'agent', body: planContent });
      }

      // 2. 任务规格：结构化拆解 → 校验；非法/异常 → fallback mock 拆解（并发降级说明）
      let isFallback = supervisor.model.startsWith('mock:');
      let specs: Array<{ title: string; body: string | null; assignee: string; blockedByTitles: string[] }>;
      if (isFallback) {
        specs = planTasksByGoal(goal).map((s, i) => ({
          ...s,
          assignee: roster[i % roster.length]!.id,
          blockedByTitles: [], // 创建时按顺序结链（见下）
        }));
      } else {
        let decomposed: DecomposedTask[] | null = null;
        try {
          const raw = await chatOnce(supervisor, run.id, supSpan.id, decomposePrompt(goal, roster));
          decomposed = parseDecomposition(raw, roster);
        } catch {
          decomposed = null; // Provider 网络/鉴权异常也降级
        }
        if (decomposed) {
          specs = decomposed;
        } else {
          isFallback = true;
          specs = planTasksByGoal(goal).map((s, i) => ({
            ...s,
            assignee: roster[i % roster.length]!.id,
            blockedByTitles: [],
          }));
          await postSystem(run.id, supervisor.id, '结构化拆解失败已降级为 mock 拆解（LLM 输出非法或调用失败）');
        }
      }

      // 3. 按拓扑序创建任务：结构化任务按其 blockedBy 解析（空 = 无依赖，可并行）；
      //    mock fallback 保持 P0 的顺序结链行为
      const titleToId = new Map<string, string>();
      const createdTasks: Array<{ id: string; title: string; assignee: string }> = [];
      for (const spec of specs) {
        const blockedByIds = isFallback
          ? createdTasks.length > 0
            ? [createdTasks[createdTasks.length - 1]!.id]
            : []
          : spec.blockedByTitles
              .map((t) => titleToId.get(t))
              .filter((id): id is string => id !== undefined);
        const task = createTask({
          runId: run.id,
          title: spec.title,
          body: spec.body,
          createdBy: supervisor.id,
          blockedBy: blockedByIds,
        });
        titleToId.set(spec.title, task.id);
        createdTasks.push({ id: task.id, title: task.title, assignee: spec.assignee });
      }

      // 4. 逐个 claim → 执行（LLM + 工具调用循环，含权限门控/审批）→ complete
      for (const task of createdTasks) {
        const worker = agentMap.get(task.assignee);
        if (!worker) continue; // 校验已保证存在，防御性兜底
        const claimed = claimTask(task.id, worker.id); // IMMEDIATE 事务锁，防并发
        const workerSpan = startSpan(run.id, {
          parentId: supSpan.id,
          spanKind: 'agent',
          name: `agent:${worker.id}`,
          input: JSON.stringify({ taskId: task.id, title: claimed.title }),
        });
        const turn = await runAgentTurn({
          run,
          agent: worker,
          parentSpanId: workerSpan.id,
          messages: [
            { role: 'system', content: worker.systemPrompt },
            {
              role: 'user',
              content: `任务：${claimed.title}\n说明：${claimed.body ?? '-'}\n\n总体目标：${goal}`,
            },
          ],
        });
        const content = turn.content;
        // 空正文（重试后仍空）时 agentStep 已发 system 失败说明，跳过空 agent 消息
        if (content.trim().length > 0) {
          await post({
            runId: run.id,
            from: worker.id,
            to: supervisor.id,
            kind: 'agent',
            body: content,
            meta: { taskId: task.id },
          });
        }
        endSpan(workerSpan, { output: content, status: content.trim().length > 0 ? 'ok' : 'error' });
        completeTask(task.id, worker.id);
      }

      // 5. supervisor 汇总
      const doneSummary = createdTasks.map((t) => t.title).join('、');
      const summaryContent = await chatOnce(
        supervisor,
        run.id,
        supSpan.id,
        `以下任务已全部完成：${doneSummary}。请汇总最终结果。目标：${goal}`,
      );
      if (summaryContent.trim().length > 0) {
        await post({
          runId: run.id,
          from: supervisor.id,
          to: 'user',
          kind: 'agent',
          body: summaryContent,
          meta: { summary: true },
        });
      }
      endSpan(supSpan, { output: summaryContent, status: 'ok' });
      finishRun(run.id, 'completed');
    } catch (err) {
      finishRun(run.id, 'failed');
      throw err;
    }
  },
};

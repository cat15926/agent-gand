/**
 * 主管委派编排（规格 §4.2 orchestration/supervisor.ts）
 * supervisor（第一个 agent）拆解目标为 tasks（当前为 mock 规则生成），
 * worker 逐个 claim → 执行 → complete，最后 supervisor 汇总一条 message。
 * TODO: 用 LLM 结构化输出替代 mock 任务生成；worker 并行执行与失败重试
 */
import type { AgentDefinition, Run } from '@agent-gand/shared';
import { resolveProvider } from '../llm/router.ts';
import type { LlmMessage } from '../llm/provider.ts';
import { post } from '../messaging/inbox.ts';
import { claimTask, createTask, completeTask } from '../messaging/tasks.ts';
import { endSpan, finishRun, setRunStatus, startSpan } from '../runs/trace.ts';
import type { Orchestrator } from './types.ts';

/** mock 任务拆解：按 goal 关键词确定性生成 2-3 条 */
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

async function chatOnce(agent: AgentDefinition, runId: string, parentSpanId: string, userContent: string): Promise<string> {
  const provider = resolveProvider(agent.model);
  const messages: LlmMessage[] = [
    { role: 'system', content: agent.systemPrompt },
    { role: 'user', content: userContent },
  ];
  const llmSpan = startSpan(runId, {
    parentId: parentSpanId,
    spanKind: 'llm',
    name: `llm:${agent.model}`,
    input: JSON.stringify(messages),
  });
  const res = await provider.chat({ model: agent.model, messages });
  endSpan(llmSpan, {
    output: res.content,
    status: 'ok',
    tokensIn: res.usage.tokensIn,
    tokensOut: res.usage.tokensOut,
    costUsd: res.usage.costUsd,
  });
  return res.content;
}

export const supervisorOrchestrator: Orchestrator = {
  async start(run: Run, agents: AgentDefinition[], goal: string): Promise<void> {
    try {
      setRunStatus(run.id, 'running');
      const supervisor = agents[0];
      if (!supervisor) throw new Error('supervisor 模式至少需要 1 个 agent');
      const pool = agents.length > 1 ? agents.slice(1) : [supervisor];

      // 1. supervisor 拆解目标
      const supSpan = startSpan(run.id, {
        spanKind: 'agent',
        name: `agent:${supervisor.id}（supervisor）`,
        input: goal,
      });
      const planContent = await chatOnce(supervisor, run.id, supSpan.id, goal);
      await post({ runId: run.id, from: supervisor.id, to: 'all', kind: 'agent', body: planContent });

      // 2. 生成任务（mock 规则；串行依赖链：后一条 blockedBy 前一条）
      const specs = planTasksByGoal(goal);
      const taskIds: string[] = [];
      for (const spec of specs) {
        const task = createTask({
          runId: run.id,
          title: spec.title,
          body: spec.body,
          createdBy: supervisor.id,
          blockedBy: taskIds.length > 0 ? [taskIds[taskIds.length - 1]!] : [],
        });
        taskIds.push(task.id);
      }

      // 3. 逐个 claim → 执行 → complete（worker 轮转）
      for (const [i, taskId] of taskIds.entries()) {
        const worker = pool[i % pool.length]!;
        const claimed = claimTask(taskId, worker.id); // IMMEDIATE 事务锁，防并发
        const workerSpan = startSpan(run.id, {
          parentId: supSpan.id,
          spanKind: 'agent',
          name: `agent:${worker.id}`,
          input: JSON.stringify({ taskId, title: claimed.title }),
        });
        const content = await chatOnce(
          worker,
          run.id,
          workerSpan.id,
          `任务：${claimed.title}\n说明：${claimed.body ?? '-'}\n\n总体目标：${goal}`,
        );
        await post({
          runId: run.id,
          from: worker.id,
          to: supervisor.id,
          kind: 'agent',
          body: content,
          meta: { taskId },
        });
        endSpan(workerSpan, { output: content, status: 'ok' });
        completeTask(taskId, worker.id);
      }

      // 4. supervisor 汇总
      const doneSummary = specs.map((s) => s.title).join('、');
      const summaryContent = await chatOnce(
        supervisor,
        run.id,
        supSpan.id,
        `以下任务已全部完成：${doneSummary}。请汇总最终结果。目标：${goal}`,
      );
      await post({
        runId: run.id,
        from: supervisor.id,
        to: 'user',
        kind: 'agent',
        body: summaryContent,
        meta: { summary: true },
      });
      endSpan(supSpan, { output: summaryContent, status: 'ok' });
      finishRun(run.id, 'completed');
    } catch (err) {
      finishRun(run.id, 'failed');
      throw err;
    }
  },
};

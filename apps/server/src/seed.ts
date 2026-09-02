/**
 * 种子数据（规格 §4.2 seed.ts）
 * DB 为空时：1 条 completed 演示 run（含 events+usage）、1 条 pending approval、2 条示例 task、若干 message
 */
import { createApproval } from './hitl/approvals.ts';
import { post } from './messaging/inbox.ts';
import { claimTask, createTask } from './messaging/tasks.ts';
import {
  countRuns,
  createRun,
  endSpan,
  finishRun,
  setRunStatus,
  startSpan,
} from './runs/trace.ts';

/** 演示 run 各 agent 的假 usage（确定性） */
const DEMO_USAGE: Array<{ agentId: string; tokensIn: number; tokensOut: number }> = [
  { agentId: 'planner', tokensIn: 210, tokensOut: 96 },
  { agentId: 'coder', tokensIn: 320, tokensOut: 180 },
  { agentId: 'reviewer', tokensIn: 150, tokensOut: 88 },
];

export function seed(): void {
  if (countRuns() > 0) return; // 已有数据（含此前 seed 过）则跳过

  // 1) completed 演示 run：agent span + 嵌套 llm span（含 usage）+ message 流
  const run = createRun('演示：三角色流水线巡检', 'pipeline', ['planner', 'coder', 'reviewer']);
  setRunStatus(run.id, 'running');
  post({ runId: run.id, from: 'user', to: 'all', kind: 'user', body: '请开始演示巡检' });
  for (const demo of DEMO_USAGE) {
    const agentSpan = startSpan(run.id, {
      spanKind: 'agent',
      name: `agent:${demo.agentId}`,
      input: JSON.stringify({ goal: run.goal }),
    });
    const llmSpan = startSpan(run.id, {
      parentId: agentSpan.id,
      spanKind: 'llm',
      name: `llm:mock:${demo.agentId}`,
      input: JSON.stringify({ note: 'seed 演示数据' }),
    });
    const content = `【seed 演示】${demo.agentId} 的产出（历史数据）`;
    endSpan(llmSpan, {
      output: content,
      status: 'ok',
      tokensIn: demo.tokensIn,
      tokensOut: demo.tokensOut,
      costUsd: Math.round((demo.tokensIn * 2e-6 + demo.tokensOut * 8e-6) * 1e6) / 1e6,
    });
    post({ runId: run.id, from: demo.agentId, to: 'all', kind: 'agent', body: content });
    endSpan(agentSpan, { output: content, status: 'ok' });
  }
  finishRun(run.id, 'completed');

  // 2) 2 条示例 task（1 条 pending、1 条 in_progress 已被 coder 认领）
  createTask({
    runId: null,
    title: '示例：接入真实 LLM Provider',
    body: '把 openai: / anthropic: 路由从 TODO 骨架补齐为真实调用（消费 LLM_* 环境变量）',
    createdBy: 'user',
  });
  const claimed = createTask({
    runId: run.id,
    title: '示例：为 web 补充用量图表',
    body: '在 RightPanel 的用量 tab 展示 tokens/cost 曲线',
    createdBy: 'user',
  });
  claimTask(claimed.id, 'coder');

  // 3) 1 条 pending approval（演示审批卡）
  createApproval({
    runId: run.id,
    agentId: 'coder',
    toolName: 'shell.run',
    input: JSON.stringify({ cmd: 'pwd' }),
    reason: '演示审批卡：confirm 模式下非白名单工具需人工确认',
  });
}

/**
 * 顺序流水线编排（规格 §4.2 orchestration/pipeline.ts）
 * 按 agentIds 顺序执行：每个 agent 走 runAgentTurn（LLM + 工具调用循环，
 * 见 agentStep.ts），messages 累积传递；记 agent/llm/tool span 与 usage。
 */
import type { AgentDefinition, Run } from '@agent-gand/shared';
import { post } from '../messaging/inbox.ts';
import { endSpan, finishRun, setRunStatus, startSpan } from '../runs/trace.ts';
import { runAgentTurn } from './agentStep.ts';
import type { Orchestrator } from './types.ts';

/** 累积的对话转写：后续 agent 的 user 轮包含前面所有 agent 的产出 */
function buildUserTurn(goal: string, transcript: Array<{ from: string; content: string }>): string {
  if (transcript.length === 0) return goal;
  const history = transcript.map((t) => `[${t.from}] ${t.content}`).join('\n\n');
  return `${goal}\n\n—— 前序 agent 产出 ——\n${history}`;
}

export const pipelineOrchestrator: Orchestrator = {
  async start(run: Run, agents: AgentDefinition[], goal: string): Promise<void> {
    try {
      setRunStatus(run.id, 'running');
      const transcript: Array<{ from: string; content: string }> = [];
      for (const agent of agents) {
        const agentSpan = startSpan(run.id, {
          spanKind: 'agent',
          name: `agent:${agent.id}`,
          input: JSON.stringify({ goal }),
        });
        // 工具 schema 随请求下发；工具调用走权限门控（approve/edit 后执行，reject 跳过），
        // 结果回传下一轮（agentStep.runAgentTurn）
        // TODO: [tool:X] 标记会随 transcript 累积传递，后续 agent 会重复触发同名工具
        //（当前顺带演示三档权限；接入真实 Provider 后应只解析原始 goal 或按 agent 上下文提取）
        const turn = await runAgentTurn({
          run,
          agent,
          parentSpanId: agentSpan.id,
          messages: [
            { role: 'system', content: agent.systemPrompt },
            { role: 'user', content: buildUserTurn(goal, transcript) },
          ],
        });
        // 空正文（重试后仍空）时 agentStep 已发 system 失败说明，跳过空 agent 消息
        if (turn.content.trim().length > 0) {
          await post({
            runId: run.id,
            from: agent.id,
            to: 'all',
            kind: 'agent',
            body: turn.content,
            meta: { toolRounds: turn.toolRounds },
          });
          transcript.push({ from: agent.id, content: turn.content });
        }
        endSpan(agentSpan, { output: turn.content, status: turn.emptyResponse ? 'error' : 'ok' });
      }
      finishRun(run.id, 'completed');
    } catch (err) {
      finishRun(run.id, 'failed');
      throw err;
    }
  },
};

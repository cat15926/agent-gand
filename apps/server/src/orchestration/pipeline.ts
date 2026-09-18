/**
 * 顺序流水线编排（规格 §4.2 orchestration/pipeline.ts）
 * 按 agentIds 顺序执行：每个 agent 走 runAgentTurn（LLM + 工具调用循环，
 * 见 agentStep.ts），messages 累积传递；记 agent/llm/tool span 与 usage。
 */
import type { AgentDefinition, Run } from '@agent-gand/shared';
import { post } from '../messaging/inbox.ts';
import { endSpan, finishRun, setRunStatus, startSpan } from '../runs/trace.ts';
import { getRun, listRunAgentSnapshots } from '../runs/trace.ts';
import { latestCheckpoint, saveCheckpoint } from '../runs/checkpoints.ts';
import { runAgentTurn, SESSION_BOUNDARY_DIRECTIVE } from './agentStep.ts';
import type { Orchestrator } from './types.ts';

/** 累积的对话转写：后续 agent 的 user 轮包含前面所有 agent 的产出 */
function buildUserTurn(goal: string, transcript: Array<{ from: string; content: string }>): string {
  if (transcript.length === 0) return goal;
  const history = transcript.map((t) => `[${t.from}] ${t.content}`).join('\n\n');
  return `${goal}\n\n—— 前序 agent 产出 ——\n${history}`;
}

interface PipelineState { nextAgentIndex: number; transcript: Array<{ from: string; content: string }>; userPosted: boolean; displayGoal: string }
const activePipelines = new Set<string>();

async function executePipeline(run: Run, agents: AgentDefinition[], goal: string, displayGoal = goal, userMessage?: Parameters<Orchestrator['start']>[4]): Promise<void> {
  if (activePipelines.has(run.id)) return;
  activePipelines.add(run.id);
    try {
      setRunStatus(run.id, 'running');
      const checkpoint = latestCheckpoint(run.id, 'pipeline');
      const recovered = checkpoint?.state as Partial<PipelineState> | undefined;
      const state: PipelineState = { nextAgentIndex: recovered?.nextAgentIndex ?? 0,
        transcript: Array.isArray(recovered?.transcript) ? recovered.transcript : [],
        userPosted: recovered?.userPosted === true, displayGoal: recovered?.displayGoal ?? displayGoal };
      // 用户目标先入消息流（聊天界面可见用户输入，与 agent 消息同流展示）
      if (!state.userPosted) {
        await post({ runId: run.id, from: 'user', to: userMessage?.recipientIds?.join(',') || 'all', kind: 'user', body: state.displayGoal,
          replyTo: userMessage?.replyTo, taskId: userMessage?.taskId, clientMessageId: userMessage?.clientMessageId ?? `durable:${run.id}:user`, deliveryStatus: 'processing' });
        state.userPosted = true;
        saveCheckpoint({ runId: run.id, kind: 'pipeline', phase: 'user_posted', state: { ...state } });
      }
      for (let index = state.nextAgentIndex; index < agents.length; index += 1) {
        const agent = agents[index]!;
        saveCheckpoint({ runId: run.id, kind: 'pipeline', phase: 'agent_running', state: { ...state, nextAgentIndex: index, agentId: agent.id } });
        const agentSpan = startSpan(run.id, {
          spanKind: 'agent',
          name: `agent:${agent.id}`,
          input: JSON.stringify({ goal }),
          attributes: { 'agent.id': agent.id, 'agent.role': 'pipeline', 'orchestration.phase': 'pipeline.step' },
        });
        // 工具 schema 随请求下发；工具调用走权限门控（approve/edit 后执行，reject 跳过），
        // 结果回传下一轮（agentStep.runAgentTurn）
        // TODO: [tool:X] 标记会随 transcript 累积传递，后续 agent 会重复触发同名工具
        //（当前顺带演示三档权限；接入真实 Provider 后应只解析原始 goal 或按 agent 上下文提取）
        // 首个 agent 注入会话边界声明（防跨 run 沙箱遗留污染，§9 过渡缓解）
        const messages: Array<{ role: 'system' | 'user'; content: string }> = [
          { role: 'system', content: agent.systemPrompt },
        ];
        if (state.transcript.length === 0) {
          messages.push({ role: 'system', content: SESSION_BOUNDARY_DIRECTIVE });
        }
        messages.push({ role: 'user', content: buildUserTurn(goal, state.transcript) });
        const turn = await runAgentTurn({
          run,
          agent,
          parentSpanId: agentSpan.id,
          messages,
          executionScopeId: `pipeline:${index}:${agent.id}`,
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
            clientMessageId: `durable:${run.id}:pipeline:${index}:${agent.id}`,
          });
          state.transcript.push({ from: agent.id, content: turn.content });
        }
        endSpan(agentSpan, { output: turn.content, status: turn.emptyResponse ? 'error' : 'ok' });
        state.nextAgentIndex = index + 1;
        saveCheckpoint({ runId: run.id, kind: 'pipeline', phase: 'agent_completed', state: { ...state } });
      }
      saveCheckpoint({ runId: run.id, kind: 'pipeline', phase: 'completed', status: 'completed', state: { ...state } });
      finishRun(run.id, 'completed');
    } catch (err) {
      finishRun(run.id, 'failed');
      throw err;
    } finally {
      activePipelines.delete(run.id);
    }
}

export async function resumePipelineRun(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run || run.mode !== 'pipeline' || run.status === 'completed') return;
  const snapshots = listRunAgentSnapshots(run.id);
  const agents = run.agentIds.map((id) => snapshots.find((agent) => agent.id === id)).filter((agent): agent is AgentDefinition => Boolean(agent));
  await executePipeline(run, agents, run.goal, (latestCheckpoint(run.id, 'pipeline')?.state.displayGoal as string | undefined) ?? run.goal);
}

export const pipelineOrchestrator: Orchestrator = {
  async start(run, agents, goal, displayGoal = goal, userMessage): Promise<void> {
    await executePipeline(run, agents, goal, displayGoal, userMessage);
  },
};

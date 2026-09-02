/**
 * 顺序流水线编排（规格 §4.2 orchestration/pipeline.ts）
 * 按 agentIds 顺序，每个 agent 一次 LLM 调用（messages 累积传递）；
 * 记录 agent/llm span 与 usage；工具调用由 mock 响应触发，走权限门控（P0-5）
 */
import type { AgentDefinition, Run } from '@agent-gand/shared';
import { post, postSystem } from '../messaging/inbox.ts';
import { createApproval, waitForDecision, ApprovalTimeoutError } from '../hitl/approvals.ts';
import { resolveProvider } from '../llm/router.ts';
import type { LlmMessage, LlmToolCall } from '../llm/provider.ts';
import { endSpan, finishRun, setRunStatus, startSpan } from '../runs/trace.ts';
import { getTool } from '../tools/builtin/index.ts';
import { checkPermission } from '../tools/types.ts';
import type { Orchestrator } from './types.ts';

/** 累积的对话转写：后续 agent 的 user 轮包含前面所有 agent 的产出 */
function buildUserTurn(goal: string, transcript: Array<{ from: string; content: string }>): string {
  if (transcript.length === 0) return goal;
  const history = transcript.map((t) => `[${t.from}] ${t.content}`).join('\n\n');
  return `${goal}\n\n—— 前序 agent 产出 ——\n${history}`;
}

/**
 * 工具调用执行：权限三档门控 →（confirm 且非白名单时）审批中断 → 执行 + tool span。
 * 不论成功失败都不抛出（记 span/系统消息后继续流水线）。
 */
async function executeToolCall(
  run: Run,
  agent: AgentDefinition,
  parentSpanId: string,
  toolCall: LlmToolCall,
): Promise<void> {
  const tool = getTool(toolCall.name);
  if (!tool) {
    await postSystem(run.id, agent.id, `工具 ${toolCall.name} 不存在，已跳过`);
    return;
  }
  const decision = checkPermission(agent, tool.name);
  if (decision === 'deny') {
    await postSystem(
      run.id,
      agent.id,
      `工具 ${tool.name} 被权限门控拒绝（模式 ${agent.permissionMode}${agent.disallowedTools.includes(tool.name) ? '，命中 disallowedTools' : ''}）`,
    );
    return;
  }

  let inputRaw = toolCall.input;
  if (decision === 'need_approval') {
    const approval = createApproval({
      runId: run.id,
      agentId: agent.id,
      toolName: tool.name,
      input: inputRaw,
      reason: `agent「${agent.id}」权限模式为 confirm，且 ${tool.name} 不在其工具白名单`,
    });
    setRunStatus(run.id, 'awaiting_approval');
    const approvalSpan = startSpan(run.id, {
      parentId: parentSpanId,
      spanKind: 'approval',
      name: `approval:${tool.name}`,
      input: inputRaw,
    });
    try {
      const decided = await waitForDecision(approval.id);
      if (decided.status === 'edited') inputRaw = decided.editedInput ?? inputRaw;
      endSpan(approvalSpan, { output: `decision: ${decided.status}`, status: 'ok' });
      setRunStatus(run.id, 'running');
      if (decided.status === 'rejected') {
        await postSystem(run.id, agent.id, `人工已拒绝工具 ${tool.name} 的调用`);
        return;
      }
    } catch (err) {
      const message = err instanceof ApprovalTimeoutError ? '等待审批超时，按拒绝处理' : String(err);
      endSpan(approvalSpan, { output: message, status: 'error' });
      setRunStatus(run.id, 'running');
      await postSystem(run.id, agent.id, `工具 ${tool.name} 审批流程异常：${message}`);
      return;
    }
  }

  const toolSpan = startSpan(run.id, {
    parentId: parentSpanId,
    spanKind: 'tool',
    name: `tool:${tool.name}`,
    input: inputRaw,
  });
  try {
    const parsed: unknown = JSON.parse(inputRaw);
    const output = await tool.run(parsed, { runId: run.id, agentId: agent.id });
    endSpan(toolSpan, { output, status: 'ok' });
    await post({
      runId: run.id,
      from: agent.id,
      to: 'all',
      kind: 'tool',
      body: output.slice(0, 500),
      meta: { tool: tool.name, spanId: toolSpan.id },
    });
  } catch (err) {
    endSpan(toolSpan, { output: err instanceof Error ? err.message : String(err), status: 'error' });
    await postSystem(run.id, agent.id, `工具 ${tool.name} 执行失败：${err instanceof Error ? err.message : String(err)}`);
  }
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
        const provider = resolveProvider(agent.model);
        const llmMessages: LlmMessage[] = [
          { role: 'system', content: agent.systemPrompt },
          { role: 'user', content: buildUserTurn(goal, transcript) },
        ];
        const llmSpan = startSpan(run.id, {
          parentId: agentSpan.id,
          spanKind: 'llm',
          name: `llm:${agent.model}`,
          input: JSON.stringify(llmMessages),
        });
        const res = await provider.chat({ model: agent.model, messages: llmMessages });
        endSpan(llmSpan, {
          output: res.content,
          status: 'ok',
          tokensIn: res.usage.tokensIn,
          tokensOut: res.usage.tokensOut,
          costUsd: res.usage.costUsd,
        });
        // 工具调用：mock 响应触发，走权限门控（approve/edit 后执行，reject 跳过）
        // TODO: [tool:X] 标记会随 transcript 累积传递，后续 agent 会重复触发同名工具
        //（当前顺带演示三档权限；接入真实 Provider 后应只解析原始 goal 或按 agent 上下文提取）
        if (res.toolCall) await executeToolCall(run, agent, agentSpan.id, res.toolCall);
        await post({
          runId: run.id,
          from: agent.id,
          to: 'all',
          kind: 'agent',
          body: res.content,
          meta: { spanId: llmSpan.id },
        });
        transcript.push({ from: agent.id, content: res.content });
        endSpan(agentSpan, { output: res.content, status: 'ok' });
      }
      finishRun(run.id, 'completed');
    } catch (err) {
      finishRun(run.id, 'failed');
      throw err;
    }
  },
};

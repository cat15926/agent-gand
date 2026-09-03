/**
 * 单 agent 执行步骤（pipeline 与 supervisor 共用，避免两份工具逻辑漂移）
 *
 * runAgentTurn：LLM 调用 + 工具调用循环 ——
 *   LLM（带 tools schema）→ toolCall → 权限门控 →（confirm 非白名单）审批中断
 *   → 执行（tool span + usage 记账）→ 工具结果回传下一轮 LLM → 直至无 toolCall 或达轮数上限。
 *
 * 空正文防御（thinking 模型预算耗尽会只思考不出正文）：
 *   无正文且无 toolCall → 注入 nudge 重试一次；仍空 → llm span 标 error +
 *   收件箱 system 失败说明，调用方跳过空 agent 消息（禁止静默空消息）。
 *
 * TODO: 协议原生 tool 消息（openai role:tool / anthropic tool_result block，当前用 user 消息模拟回传）
 */
import type { AgentDefinition, Run } from '@agent-gand/shared';
import { createApproval, waitForDecision, ApprovalTimeoutError } from '../hitl/approvals.ts';
import { resolveProvider } from '../llm/router.ts';
import type { LlmMessage, LlmToolCall, LlmResponse } from '../llm/provider.ts';
import { post, postSystem } from '../messaging/inbox.ts';
import { endSpan, setRunStatus, startSpan, type EndSpanInput } from '../runs/trace.ts';
import { getTool, toolsForAgent } from '../tools/builtin/index.ts';
import { checkPermission } from '../tools/types.ts';

/** llm span input 统一记录 messages + 工具名单（事后可诊断 tools 是否下发） */
export function llmSpanInput(messages: LlmMessage[], toolNames: string[]): string {
  return JSON.stringify({ messages, tools: toolNames });
}

/** nudge 文案（anthropic 协议不支持 mid-conversation system，用 user 轮实现同等效果） */
const EMPTY_NUDGE = '请直接输出结论正文，不要只思考；如需调用工具请直接发起工具调用，不要在正文中用文字描述工具调用。';

/** 工具调用指令（prompt 级缓解"把调用写成文字"） */
const TOOL_CALL_DIRECTIVE = '如需调用工具，请直接发起工具调用（tool_use/tool_calls），不要在正文中用文字描述工具调用。';

/**
 * 伪调用文本窄启发式：最终轮（无 toolCall）正文形如 "[调用工具 fs.read]" /
 * "使用工具：xxx" / "tool:xxx" 的短文本 → 视为空正文（真机 run c674d39e 实证）。
 * 只匹配整条正文即伪调用的情形，正常长正文中的提及不受影响。
 */
const PSEUDO_TOOL_CALL_RE = /^\[?(?:调用工具|使用工具|tool[:：])[^\]」』]{0,40}\]?$/;

function isPseudoToolCallText(content: string): boolean {
  return PSEUDO_TOOL_CALL_RE.test(content.trim());
}

/** llm span output：正文 + 终止原因后缀（stop_reason 可诊断空正文类问题） */
function llmSpanOutput(res: LlmResponse): string {
  const body = res.content.trim().length > 0 ? res.content : '（空正文）';
  return res.stopReason === null ? body : `${body}\n[stop_reason=${res.stopReason}]`;
}

export interface AgentTurnOptions {
  run: Run;
  agent: AgentDefinition;
  parentSpanId: string;
  /** 初始消息（含 system） */
  messages: LlmMessage[];
  /** 工具循环轮数上限，默认 6（思考型模型多轮核验常见；TODO: P1 支持 agent frontmatter 级配置） */
  maxToolRounds?: number;
}

export interface AgentTurnResult {
  /** 最终一轮的文本产出（空串 = 重试后仍为空，已发 system 失败说明） */
  content: string;
  /** 实际执行的工具轮数 */
  toolRounds: number;
  /** 是否因空正文失败 */
  emptyResponse: boolean;
}

/**
 * 单发 LLM 调用（supervisor 的拆解/汇总等，不带工具）。
 * 同样有空正文防御：nudge 重试一次，仍空发 system 失败说明并返回空串。
 */
export async function chatOnce(
  agent: AgentDefinition,
  runId: string,
  parentSpanId: string,
  userContent: string,
): Promise<string> {
  const provider = resolveProvider(agent.model);
  const messages: LlmMessage[] = [
    { role: 'system', content: agent.systemPrompt },
    { role: 'user', content: userContent },
  ];
  for (let attempt = 0; ; attempt += 1) {
    const llmSpan = startSpan(runId, {
      parentId: parentSpanId,
      spanKind: 'llm',
      name: `llm:${agent.model}`,
      input: llmSpanInput(messages, []),
    });
    const res = await provider.chat({ model: agent.model, messages });
    const usage: EndSpanInput = {
      tokensIn: res.usage.tokensIn,
      tokensOut: res.usage.tokensOut,
      costUsd: res.usage.costUsd,
    };
    if ((res.content.trim().length > 0 && !isPseudoToolCallText(res.content)) || res.toolCall !== null) {
      endSpan(llmSpan, { ...usage, output: llmSpanOutput(res), status: 'ok' });
      return res.content;
    }
    if (attempt === 0) {
      endSpan(llmSpan, { ...usage, output: `${llmSpanOutput(res)}（注入 nudge 重试）`, status: 'ok' });
      messages.push({ role: 'user', content: EMPTY_NUDGE });
      continue;
    }
    endSpan(llmSpan, { ...usage, output: `${llmSpanOutput(res)}（重试后仍为空）`, status: 'error' });
    await postSystem(runId, agent.id, `LLM 返回空正文（已重试一次；可能 thinking 耗尽 token 预算，可调大 LLM_MAX_TOKENS）`);
    return '';
  }
}

export async function runAgentTurn(opts: AgentTurnOptions): Promise<AgentTurnResult> {
  const { run, agent, parentSpanId } = opts;
  const provider = resolveProvider(agent.model);
  // 按权限三档决定下发集合（confirm 全量 / auto 白名单 / readonly 只读集），执行时仍走门控
  const tools = toolsForAgent(agent);
  const toolNames = tools.map((t) => t.name);
  const messages = [...opts.messages];
  // 工具调用指令：插入到首条 system 之后（无 system 则置顶）
  if (tools.length > 0) {
    const sysIdx = messages.findIndex((m) => m.role === 'system');
    const directive: LlmMessage = { role: 'system', content: TOOL_CALL_DIRECTIVE };
    if (sysIdx >= 0) messages.splice(sysIdx + 1, 0, directive);
    else messages.unshift(directive);
  }
  const maxRounds = opts.maxToolRounds ?? 6;
  let toolRounds = 0;
  let nudged = false; // 空正文/伪调用 nudge 只重试一次

  for (let round = 0; ; round += 1) {
    const llmSpan = startSpan(run.id, {
      parentId: parentSpanId,
      spanKind: 'llm',
      name: `llm:${agent.model}`,
      input: llmSpanInput(messages, toolNames),
    });
    const res = await provider.chat({ model: agent.model, messages, tools });
    const usage: EndSpanInput = {
      tokensIn: res.usage.tokensIn,
      tokensOut: res.usage.tokensOut,
      costUsd: res.usage.costUsd,
    };

    // 空正文/伪调用防御：无 toolCall 且（正文为空 或 整条正文是伪调用文本）
    if (res.toolCall === null && (res.content.trim().length === 0 || isPseudoToolCallText(res.content))) {
      if (!nudged) {
        nudged = true;
        endSpan(llmSpan, { ...usage, output: `${llmSpanOutput(res)}（注入 nudge 重试）`, status: 'ok' });
        messages.push({ role: 'user', content: EMPTY_NUDGE });
        continue;
      }
      endSpan(llmSpan, { ...usage, output: `${llmSpanOutput(res)}（重试后仍为空）`, status: 'error' });
      await postSystem(
        run.id,
        agent.id,
        `LLM 返回空正文（已重试一次；可能 thinking 耗尽 token 预算，可调大 LLM_MAX_TOKENS）`,
      );
      return { content: '', toolRounds, emptyResponse: true };
    }

    endSpan(llmSpan, { ...usage, output: llmSpanOutput(res), status: 'ok' });

    if (res.toolCall === null) return { content: res.content, toolRounds, emptyResponse: false };
    if (round >= maxRounds) {
      await postSystem(run.id, agent.id, `已达工具轮数上限（${maxRounds}），停止继续调用工具`);
      // 无 tools 的收尾调用：基于已获工具结果给最终结论（保证结论完整性，比调大上限省 token）
      const closing = await closingCall(run, agent, parentSpanId, messages);
      return { content: closing.trim().length > 0 ? closing : res.content, toolRounds, emptyResponse: false };
    }

    toolRounds += 1;
    const outcome = await executeToolCall(run, agent, parentSpanId, res.toolCall);
    // 工具结果回传下一轮（user 消息模拟，见文件头 TODO）。
    // 占位文案用不易被模仿的纯说明体——真机实证 GLM 会从 transcript 模仿占位句式输出伪调用文本
    messages.push({
      role: 'assistant',
      content: res.content.length > 0 ? res.content : `（assistant 已请求工具 ${res.toolCall.name}，结果见下一轮）`,
    });
    messages.push({ role: 'user', content: `【工具结果】${res.toolCall.name}：\n${outcome}` });
  }
}

/** 上限截停后的收尾调用：不带 tools，要求基于已有工具结果直接给最终结论 */
async function closingCall(
  run: Run,
  agent: AgentDefinition,
  parentSpanId: string,
  messages: LlmMessage[],
): Promise<string> {
  const provider = resolveProvider(agent.model);
  const final: LlmMessage[] = [
    ...messages,
    { role: 'user', content: '工具调用预算已用完，请基于已获得的工具结果直接给出最终结论，不要再请求工具调用。' },
  ];
  const llmSpan = startSpan(run.id, {
    parentId: parentSpanId,
    spanKind: 'llm',
    name: `llm:${agent.model}（收尾）`,
    input: llmSpanInput(final, []),
  });
  const res = await provider.chat({ model: agent.model, messages: final }); // 不传 tools
  endSpan(llmSpan, {
    output: llmSpanOutput(res),
    status: 'ok',
    tokensIn: res.usage.tokensIn,
    tokensOut: res.usage.tokensOut,
    costUsd: res.usage.costUsd,
  });
  return res.content;
}

/**
 * 执行一次工具调用：权限三档门控 →（need_approval 时）审批中断 → 执行 + tool span。
 * 返回回传给下一轮 LLM 的结果文本（被拒/失败也返回说明而非抛出，保证循环继续）。
 */
async function executeToolCall(
  run: Run,
  agent: AgentDefinition,
  parentSpanId: string,
  toolCall: LlmToolCall,
): Promise<string> {
  const tool = getTool(toolCall.name);
  if (!tool) {
    const note = `工具 ${toolCall.name} 不存在，已跳过`;
    await postSystem(run.id, agent.id, note);
    return note;
  }
  const decision = checkPermission(agent, tool.name);
  if (decision === 'deny') {
    const note = `工具 ${tool.name} 被权限门控拒绝（模式 ${agent.permissionMode}${agent.disallowedTools.includes(tool.name) ? '，命中 disallowedTools' : ''}）`;
    await postSystem(run.id, agent.id, note);
    return note;
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
        const note = `人工已拒绝工具 ${tool.name} 的调用`;
        await postSystem(run.id, agent.id, note);
        return note;
      }
      if (decided.status === 'expired') {
        // §8.2：超时按拒绝处理（decidedBy=system:timeout，置 expired 不遗留 pending）
        const note = `等待审批超时（已置 expired），工具 ${tool.name} 按拒绝处理`;
        await postSystem(run.id, agent.id, note);
        return note;
      }
    } catch (err) {
      const message = err instanceof ApprovalTimeoutError ? '等待审批超时，按拒绝处理' : String(err);
      endSpan(approvalSpan, { output: message, status: 'error' });
      setRunStatus(run.id, 'running');
      await postSystem(run.id, agent.id, `工具 ${tool.name} 审批流程异常：${message}`);
      return `审批流程异常：${message}`;
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
    return output;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    endSpan(toolSpan, { output: message, status: 'error' });
    await postSystem(run.id, agent.id, `工具 ${tool.name} 执行失败：${message}`);
    return `工具执行失败：${message}`;
  }
}

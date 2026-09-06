/**
 * 单 agent 执行步骤（pipeline 与 supervisor 共用，避免两份工具逻辑漂移）
 *
 * runAgentTurn：LLM 调用 + 工具调用循环 ——
 *   LLM（带 tools schema，流式）→ toolCalls（§8.4 一轮可多个）→ 逐个权限门控（审批并行创建、
 *   等全部决策；单个被拒/超时只跳过该工具）→ 通过的 Promise.all 并行执行（span 时间可重叠）
 *   → 工具结果统一回传下一轮 LLM → 直至无 toolCalls 或达轮数上限。
 *
 * 流式（§8.1）：llm span 运行期间文本增量经 bus 发 llm.delta（runId + spanId + text）；
 * span 结束仍记完整 output。增量丢失可容忍（断线重连由 hydrate 回补）。
 *
 * 空正文防御（thinking 模型预算耗尽会只思考不出正文）：
 *   无正文且无 toolCalls → 注入 nudge 重试一次；仍空 → llm span 标 error +
 *   收件箱 system 失败说明，调用方跳过空 agent 消息（禁止静默空消息）。
 *
 * TODO: 协议原生 tool 消息（openai role:tool / anthropic tool_result block，当前用 user 消息模拟回传）
 */
import type { AgentDefinition, Run } from '@agent-gand/shared';
import { createApproval, waitForDecision } from '../hitl/approvals.ts';
import { resolveProvider } from '../llm/router.ts';
import type { DeltaHandler, LlmMessage, LlmToolCall, LlmResponse } from '../llm/provider.ts';
import { post, postSystem } from '../messaging/inbox.ts';
import { emit } from '../messaging/bus.ts';
import { endSpan, setRunStatus, startSpan, type EndSpanInput } from '../runs/trace.ts';
import { getTool, isExternalRun, toolsForAgent } from '../tools/builtin/index.ts';
import { externalId, getExternalByIdOrThrow } from '../workspaces/external.ts';
import { checkPermission, type Tool } from '../tools/types.ts';

/** llm span input 统一记录 messages + 工具名单（事后可诊断 tools 是否下发） */
export function llmSpanInput(messages: LlmMessage[], toolNames: string[]): string {
  return JSON.stringify({ messages, tools: toolNames });
}

/** nudge 文案（anthropic 协议不支持 mid-conversation system，用 user 轮实现同等效果） */
const EMPTY_NUDGE = '请直接输出结论正文，不要只思考；如需调用工具请直接发起工具调用，不要在正文中用文字描述工具调用。';

/** 工具调用指令（prompt 级缓解"把调用写成文字"；§8.4 追加并行提示） */
const TOOL_CALL_DIRECTIVE =
  '如需调用工具，请直接发起工具调用（tool_use/tool_calls），不要在正文中用文字描述工具调用。如需多个工具，请在同一轮并行发起全部调用。';

/**
 * 会话边界声明（§9.2 措辞更新：per-run 沙箱已落地，声明从"防误读遗留"升级为三段路径语义导航）：
 * 背景 run 74ff3ce5——跨 run 共享沙箱导致新 run 被历史文件误导。
 */
export const SESSION_BOUNDARY_DIRECTIVE =
  '会话边界提示：这是一个全新任务的开始，当前任务以上方用户目标为准。你的工作目录是当前 run 独立的——无前缀路径只在本次 run 内可见，历史任务的文件不会出现在其中；历史产物在 archive/ 前缀下只读。除非用户目标或本轮对话明确要求，不要引用或恢复历史任务的内容。shared/ 前缀是团队共享区，只存放跨 run 复用的持久团队资产（模板、词典、规范等），且写入需人工审批；任务看板、过程产物等一次性内容一律写入本 run 工作区（无前缀路径），不要放入 shared/。';

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

/** llm.delta 转发器（§8.1）：span 运行期间把文本增量经 bus 广播 */
function deltaForwarder(runId: string, spanId: string): DeltaHandler {
  return (text) => emit({ type: 'llm.delta', runId, spanId, text });
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
    let res: LlmResponse;
    try {
      res = await provider.chat({ model: agent.model, messages }, deltaForwarder(runId, llmSpan.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      endSpan(llmSpan, { output: message, status: 'error' });
      throw err;
    }
    const usage: EndSpanInput = {
      tokensIn: res.usage.tokensIn,
      tokensOut: res.usage.tokensOut,
      costUsd: res.usage.costUsd,
    };
    if ((res.content.trim().length > 0 && !isPseudoToolCallText(res.content)) || res.toolCalls.length > 0) {
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
    let res: LlmResponse;
    try {
      res = await provider.chat({ model: agent.model, messages, tools }, deltaForwarder(run.id, llmSpan.id));
    } catch (err) {
      // 流式中途超时/网络异常（R5）：增量已广播不回收，span 记 error 后向上抛（run 走 failed）
      const message = err instanceof Error ? err.message : String(err);
      endSpan(llmSpan, { output: message, status: 'error' });
      throw err;
    }
    const usage: EndSpanInput = {
      tokensIn: res.usage.tokensIn,
      tokensOut: res.usage.tokensOut,
      costUsd: res.usage.costUsd,
    };

    // 空正文/伪调用防御：无 toolCalls 且（正文为空 或 整条正文是伪调用文本）
    if (res.toolCalls.length === 0 && (res.content.trim().length === 0 || isPseudoToolCallText(res.content))) {
      if (!nudged) {
        nudged = true;
        endSpan(llmSpan, { ...usage, output: `${llmSpanOutput(res)}（注入 nudge 重试）`, status: 'ok' });
        messages.push({ role: 'user', content: EMPTY_NUDGE });
        continue;
      }
      endSpan(llmSpan, { ...usage, output: `${llmSpanOutput(res)}（重试后仍空）`, status: 'error' });
      await postSystem(
        run.id,
        agent.id,
        `LLM 返回空正文（已重试一次；可能 thinking 耗尽 token 预算，可调大 LLM_MAX_TOKENS）`,
      );
      return { content: '', toolRounds, emptyResponse: true };
    }

    endSpan(llmSpan, { ...usage, output: llmSpanOutput(res), status: 'ok' });

    if (res.toolCalls.length === 0) return { content: res.content, toolRounds, emptyResponse: false };
    if (round >= maxRounds) {
      await postSystem(run.id, agent.id, `已达工具轮数上限（${maxRounds}），停止继续调用工具`);
      // 无 tools 的收尾调用：基于已获工具结果给最终结论（保证结论完整性，比调大上限省 token）
      const closing = await closingCall(run, agent, parentSpanId, messages);
      return { content: closing.trim().length > 0 ? closing : res.content, toolRounds, emptyResponse: false };
    }

    toolRounds += 1;
    // §8.4：一轮多个 toolCalls——逐个门控（审批并行创建、等全部决策）→ 通过的并行执行。
    // 单个被拒/超时只跳过该工具，不连坐整轮（部分拒绝语义，inspector R6）。
    const gated = await Promise.all(
      res.toolCalls.map((toolCall) => gateToolCall(run, agent, parentSpanId, toolCall)),
    );
    if (gated.some((g) => g.hadApproval)) setRunStatus(run.id, 'running');
    const outcomes = await Promise.all(
      gated.map((g) =>
        g.allowed && g.tool
          ? runTool(run, agent, parentSpanId, g.tool, g.input)
          : Promise.resolve(g.note ?? '已跳过'),
      ),
    );
    // 工具结果统一回传下一轮（user 消息模拟，见文件头 TODO）。
    // 占位文案用不易被模仿的纯说明体——真机实证 GLM 会从 transcript 模仿占位句式输出伪调用文本
    const names = res.toolCalls.map((t) => t.name).join('、');
    messages.push({
      role: 'assistant',
      content:
        res.content.length > 0 ? res.content : `（assistant 已请求工具 ${names}，结果见下一轮）`,
    });
    messages.push({
      role: 'user',
      content: gated.map((g, i) => `【工具结果】${g.toolCall.name}：\n${outcomes[i]}`).join('\n\n'),
    });
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
  let res: LlmResponse;
  try {
    // 不传 tools；增量同样转发（收尾结论较长时 web 仍可流式显示）
    res = await provider.chat({ model: agent.model, messages: final }, deltaForwarder(run.id, llmSpan.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    endSpan(llmSpan, { output: message, status: 'error' });
    throw err;
  }
  endSpan(llmSpan, {
    output: llmSpanOutput(res),
    status: 'ok',
    tokensIn: res.usage.tokensIn,
    tokensOut: res.usage.tokensOut,
    costUsd: res.usage.costUsd,
  });
  return res.content;
}

/** 门控结果：allowed=false 时 note 为回传给下一轮 LLM 的跳过说明 */
interface GatedToolCall {
  toolCall: LlmToolCall;
  tool: Tool | null;
  /** edit 决策可能改写入参 */
  input: string;
  allowed: boolean;
  /** 是否经过了审批等待（轮级用于统一恢复 run 状态） */
  hadApproval: boolean;
  note: string | null;
}

/**
 * 工具调用门控（§8.3 顺序 + §8.2 审批）：不存在/deny → 跳过说明；
 * need_approval → 创建审批（run 置 awaiting_approval）→ 等待决策——
 * approved/edited → 放行；rejected/expired（超时按拒绝处理，置 expired 不遗留 pending）→ 跳过说明。
 * 多个 gateToolCall 并发时审批创建即并行；run 状态由轮级统一恢复 running。
 */
async function gateToolCall(
  run: Run,
  agent: AgentDefinition,
  parentSpanId: string,
  toolCall: LlmToolCall,
): Promise<GatedToolCall> {
  const tool = getTool(toolCall.name);
  if (!tool) {
    const note = `工具 ${toolCall.name} 不存在，已跳过`;
    await postSystem(run.id, agent.id, note);
    return { toolCall, tool: null, input: toolCall.input, allowed: false, hadApproval: false, note };
  }
  const decision = checkPermission(agent, tool.name);
  if (decision === 'deny') {
    const note = `工具 ${tool.name} 被权限门控拒绝（模式 ${agent.permissionMode}${agent.disallowedTools.includes(tool.name) ? '，命中 disallowedTools' : ''}）`;
    await postSystem(run.id, agent.id, note);
    return { toolCall, tool, input: toolCall.input, allowed: false, hadApproval: false, note };
  }

  // 团队共享区写保护（2026-09-06 用户需求）：fs.write 目标为 shared/ 前缀 → 无论权限档一律人工审批
  // （auto 白名单内也不豁免——团队资产变更由用户拍板；archive/ 写入在 resolver 层已拒）
  let sharedWrite = false;
  // 外部 run 中 shared/ 前缀不经审批（resolver 直接以"自成一体"拒绝，§11.3），故仅内部 run 判定
  if (decision === 'allow' && tool.name === 'fs.write' && !isExternalRun({ workspace: run.workspace ?? null })) {
    try {
      const parsed = JSON.parse(toolCall.input) as { path?: unknown };
      sharedWrite = typeof parsed.path === 'string' && parsed.path.trim().startsWith('shared/');
    } catch {
      sharedWrite = false;
    }
  }
  // §11.3 外部工作区写保护（用户裁定：逐次审批）：run 绑定外部目录时 fs.write 一律人工审批
  // （auto/白名单内不豁免——本机目录写入由用户逐次拍板；外部内 shared/archive 前缀在 resolver 层已拒）
  let externalWrite = false;
  let externalRoot = '';
  if (decision === 'allow' && tool.name === 'fs.write' && isExternalRun({ workspace: run.workspace ?? null })) {
    externalWrite = true;
    externalRoot = getExternalByIdOrThrow(externalId(run.workspace) ?? '').absPath;
  }
  const effectiveDecision = sharedWrite || externalWrite ? 'need_approval' : decision;

  let inputRaw = toolCall.input;
  if (effectiveDecision === 'need_approval') {
    const approval = createApproval({
      runId: run.id,
      agentId: agent.id,
      toolName: tool.name,
      input: inputRaw,
      reason: sharedWrite
        ? `写入团队共享区 shared/（团队资产变更，需用户审批；shared/ 仅存放持久团队资产）`
        : externalWrite
          ? `写入外部工作区（本机目录 ${externalRoot}）需用户审批`
          : `agent「${agent.id}」权限模式为 confirm，且 ${tool.name} 不在其工具白名单（非只读类工具，§8.3）`,
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
      if (decided.status === 'rejected') {
        const note = `人工已拒绝工具 ${tool.name} 的调用`;
        await postSystem(run.id, agent.id, note);
        return { toolCall, tool, input: inputRaw, allowed: false, hadApproval: true, note };
      }
      if (decided.status === 'expired') {
        const note = `等待审批超时（已置 expired），工具 ${tool.name} 按拒绝处理`;
        await postSystem(run.id, agent.id, note);
        return { toolCall, tool, input: inputRaw, allowed: false, hadApproval: true, note };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      endSpan(approvalSpan, { output: message, status: 'error' });
      await postSystem(run.id, agent.id, `工具 ${tool.name} 审批流程异常：${message}`);
      return {
        toolCall,
        tool,
        input: inputRaw,
        allowed: false,
        hadApproval: true,
        note: `审批流程异常：${message}`,
      };
    }
    return { toolCall, tool, input: inputRaw, allowed: true, hadApproval: true, note: null };
  }
  return { toolCall, tool, input: inputRaw, allowed: true, hadApproval: false, note: null };
}

/**
 * 执行已放行的工具调用：tool span + usage 记账 + 广播 tool 消息。
 * 返回回传给下一轮 LLM 的结果文本（失败也返回说明而非抛出，保证循环继续）。
 * 同一轮多个 runTool 经 Promise.all 并行执行（span 时间可重叠，§8.4）。
 */
async function runTool(
  run: Run,
  agent: AgentDefinition,
  parentSpanId: string,
  tool: Tool,
  inputRaw: string,
): Promise<string> {
  const toolSpan = startSpan(run.id, {
    parentId: parentSpanId,
    spanKind: 'tool',
    name: `tool:${tool.name}`,
    input: inputRaw,
  });
  try {
    const parsed: unknown = JSON.parse(inputRaw);
    // workspace 透传（§10.2）：命名工作区时无前缀路径落 workspaces/<name>/
    const output = await tool.run(parsed, {
      runId: run.id,
      agentId: agent.id,
      workspace: run.workspace ?? null,
    });
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

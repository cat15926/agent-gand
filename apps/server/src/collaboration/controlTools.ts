import { isMessageVisibleTo, type MessageAccess, type CollaborationStoredControlAction, type RuntimeControlActionVersion } from '@agent-gand/shared';
import type { LlmToolCall, LlmToolSchema } from '../llm/provider.ts';
import { config } from '../config.ts';

const COMPLETE_TOOL: LlmToolSchema = {
  name: 'agent.complete',
  description: '明确提交当前事项的最终结果。仅在结果完整且没有待处理后继义务时调用。',
  parameters: { type: 'object', additionalProperties: false, required: ['summary'], properties: {
    summary: { type: 'string' },
  } },
};

const PROPOSE_TASK_TOOL: LlmToolSchema = {
  name: 'agent.propose_supervisor_task',
  description: '提议把工作转为有验收和 Reviewer 的正式 Supervisor Run，必须等待用户确认。',
  parameters: { type: 'object', additionalProperties: false,
    required: ['title', 'goal', 'acceptanceCriteria', 'suggestedAssigneeIds', 'reason'], properties: {
      title: { type: 'string' }, goal: { type: 'string' },
      acceptanceCriteria: { type: 'array', items: { type: 'string' }, minItems: 1 },
      suggestedAssigneeIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
      suggestedReviewerId: { type: 'string' }, reason: { type: 'string' },
    } },
};

/** toolApiVersion=2：模型只看到领域语义名称，不再看到旧调度实现名。 */
const HOLD_TOOL_V2_USER: LlmToolSchema = {
  name: 'agent.hold',
  description: '等待用户判断并暂停当前责任；恢复条件和内部标识由 Runtime 创建。',
  parameters: { type: 'object', additionalProperties: false, required: ['question', 'reason'], properties: {
    question: { type: 'string' }, reason: { type: 'string' },
  } },
};

const HOLD_TOOL_V2_EXTERNAL_WAIT: LlmToolSchema = {
  name: 'agent.hold',
  description: '暂停当前责任，等待用户判断、定时唤醒或同一 Run 内其他成员的责任完成。不要等待未注册的外部事件。',
  parameters: { type: 'object', additionalProperties: false, required: ['mode', 'reason'], properties: {
    mode: { type: 'string', enum: ['user', 'timer', 'dependency'] },
    question: { type: 'string', description: 'mode=user 时必填。' },
    delaySeconds: { type: 'integer', minimum: 1, maximum: 604800, description: 'mode=timer 时必填。' },
    targets: { type: 'array', items: { type: 'string' }, minItems: 1,
      maxItems: config.collaboration.maxTargets, description: 'mode=dependency 时必填，填写当前聊天室成员 ID。' },
    policy: { type: 'string', enum: ['all', 'any'], description: 'mode=dependency 时必填。' },
    timeoutSeconds: { type: 'integer', minimum: 1, maximum: 604800, description: 'mode=dependency 时必填。' },
    reason: { type: 'string' },
  } },
};

export const COLLABORATION_CONTROL_TOOLS_V2: LlmToolSchema[] = [
  COMPLETE_TOOL,
  {
    name: 'agent.handoff',
    description: '把当前 Subject 的责任移交给一位聊天室成员。调用后当前回合结束。',
    parameters: { type: 'object', additionalProperties: false, required: ['target', 'objective', 'reason'], properties: {
      target: { type: 'string' }, objective: { type: 'string' }, reason: { type: 'string' },
    } },
  },
  {
    name: 'agent.consult',
    description: '创建并行咨询子工作，当前 Subject 保留责任；全部结果将回流。调用后当前回合结束。',
    parameters: { type: 'object', additionalProperties: false, required: ['targets', 'objective', 'reason'], properties: {
      targets: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: config.collaboration.maxTargets },
      objective: { type: 'string' }, reason: { type: 'string' },
    } },
  },
  HOLD_TOOL_V2_USER,
  PROPOSE_TASK_TOOL,
];

const CONSULT_TOOL_V2_ANY: LlmToolSchema = {
  name: 'agent.consult',
  description: '创建并行咨询子工作；join=all 等待全部结果，join=any 接受首个通过验收的成功结果。调用后当前回合结束。',
  parameters: { type: 'object', additionalProperties: false, required: ['targets', 'objective', 'reason', 'join'], properties: {
    targets: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: config.collaboration.maxTargets },
    objective: { type: 'string' }, reason: { type: 'string' },
    join: { type: 'string', enum: ['all', 'any'] },
  } },
};

export function collaborationControlTools(toolApiVersion: 1 | 2,
  options: { externalWaitVersion?: 1 | null; consultAnyVersion?: 1 | null; messageVisibilityVersion?: 1 | null } = {}): LlmToolSchema[] {
  if (toolApiVersion !== 2) throw new Error('Tool API v1 的模型工具暴露已退役');
  return COLLABORATION_CONTROL_TOOLS_V2.map((tool) => {
    const selected = tool.name === 'agent.hold' && options.externalWaitVersion === 1 ? HOLD_TOOL_V2_EXTERNAL_WAIT
      : tool.name === 'agent.consult' && options.consultAnyVersion === 1 ? CONSULT_TOOL_V2_ANY : tool;
    if (!options.messageVisibilityVersion || !['agent.consult', 'agent.handoff'].includes(selected.name)) return selected;
    return { ...selected, description: selected.description + ' 默认公开；含身份、秘密或仅限收件者的信息时必须选择 visibility=private。私密内容仅参与成员与房间所有者可见。',
      parameters: { ...selected.parameters, properties: { ...(selected.parameters.properties as Record<string, unknown>),
        visibility: { type: 'string', enum: ['public', 'private'], description: 'public 为公开定向任务；private 为私密投递，回复与汇总继承可见范围。' } } } };
  });
}

function objectInput(call: LlmToolCall): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(call.input); } catch { throw new Error(`${call.name} 参数必须是 JSON`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${call.name} 参数必须是对象`);
  return parsed as Record<string, unknown>;
}
function text(value: unknown, field: string, max = 8_000): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} 必填`);
  if (value.trim().length > max) throw new Error(`${field} 过长`);
  return value.trim();
}
function member(id: unknown, members: Set<string>, field: string): string {
  const value = text(id, field, 100);
  if (!members.has(value)) throw new Error(`${field} 不是当前聊天室启用成员: ${value}`);
  return value;
}

function seconds(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 604_800) {
    throw new Error(`${field} 必须是 1～604800 的整数秒`);
  }
  return Number(value);
}

function futureTimestamp(now: string | undefined, delaySeconds: number): string {
  const base = now === undefined ? Date.now() : new Date(now).getTime();
  if (!Number.isFinite(base)) throw new Error('Runtime 当前时间无效');
  return new Date(base + delaySeconds * 1_000).toISOString();
}

export function parseControlCall(call: LlmToolCall, memberIds: string[], senderId: string,
  version: RuntimeControlActionVersion = 2,
  options: { externalWaitVersion?: 1 | null; consultAnyVersion?: 1 | null; now?: string;
    messageVisibilityVersion?: 1 | null;
    messageAccess?: MessageAccess;
    historicalAlias?: boolean } = {}): CollaborationStoredControlAction {
  if (version === 2 && ['agent.send_message', 'agent.ask_many', 'agent.wait_for_user'].includes(call.name)
    && !options.historicalAlias) throw new Error(`旧协作工具别名已退役: ${call.name}`);
  const input = objectInput(call); const members = new Set(memberIds);
  if (input.visibility !== undefined && (!options.messageVisibilityVersion || !['public', 'private'].includes(String(input.visibility)))) {
    throw new Error('当前 Run 的消息可见性参数无效或尚未启用');
  }
  const visibility = input.visibility === undefined ? {} : { visibility: input.visibility as 'public' | 'private' };
  const validateRecipientAccess = (targets: string[]) => {
    if (!options.messageAccess || options.messageAccess.visibility !== 'private') return;
    if (input.visibility === 'public') throw new Error('私密来源不能改为公开投递，请由所有者提供授权摘要');
    if (targets.some(target => !isMessageVisibleTo(options.messageAccess!, target))) {
      throw new Error('私密来源不在目标成员的可见范围内，即使再次声明 private 也不能扩大授权');
    }
  };
  if (call.name === 'agent.complete') {
    const summary = text(input.summary, 'summary');
    return version === 1 ? { type: 'finish' } : { version: 2, type: 'complete', summary };
  }
  if (call.name === 'agent.send_message' || call.name === 'agent.handoff') {
    const targetAgentId = member(input.target, members, 'target');
    if (targetAgentId === senderId) throw new Error('不能把工作交给自己');
    validateRecipientAccess([targetAgentId]);
    const objective = text(call.name === 'agent.handoff' ? input.objective : input.message,
      call.name === 'agent.handoff' ? 'objective' : 'message');
    const reason = text(input.reason, 'reason', 1_000);
    return version === 1
      ? { type: 'handoff', targetAgentId, message: objective, reason }
      : { version: 2, type: 'handoff', targetAgentId, objective, reason, ...visibility };
  }
  if (call.name === 'agent.ask_many' || call.name === 'agent.consult') {
    if (!Array.isArray(input.targets)) throw new Error('targets 必须是数组');
    const targetAgentIds = [...new Set(input.targets.map((id) => member(id, members, 'targets')))].filter((id) => id !== senderId);
    if (targetAgentIds.length === 0 || targetAgentIds.length > config.collaboration.maxTargets) throw new Error(`targets 必须包含 1～${config.collaboration.maxTargets} 位其他成员`);
    validateRecipientAccess(targetAgentIds);
    const objective = text(call.name === 'agent.consult' ? input.objective : input.question,
      call.name === 'agent.consult' ? 'objective' : 'question');
    const reason = text(input.reason, 'reason', 1_000);
    const join = call.name === 'agent.consult' && input.join !== undefined ? input.join : 'all';
    if (join !== 'all' && join !== 'any') throw new Error('join 必须是 all 或 any');
    if (join === 'any' && (version !== 2 || options.consultAnyVersion !== 1)) {
      throw new Error('当前 Run 未启用 consult join=any');
    }
    return version === 1
      ? { type: 'ask_many', targetAgentIds, question: objective, reason }
      : { version: 2, type: 'consult', targetAgentIds, objective, reason, join, ...visibility };
  }
  if (call.name === 'agent.wait_for_user' || call.name === 'agent.hold') {
    const reason = text(input.reason, 'reason', 1_000);
    if (call.name === 'agent.hold' && input.mode === 'timer') {
      if (version !== 2 || options.externalWaitVersion !== 1) throw new Error('当前 Run 未启用 timer Hold');
      const wakeAt = futureTimestamp(options.now, seconds(input.delaySeconds, 'delaySeconds'));
      return { version: 2, type: 'hold', wake: { kind: 'timer', wakeAt }, reason };
    }
    if (call.name === 'agent.hold' && input.mode === 'dependency') {
      if (version !== 2 || options.externalWaitVersion !== 1) throw new Error('当前 Run 未启用 dependency Hold');
      if (!Array.isArray(input.targets)) throw new Error('targets 必须是数组');
      const targetAgentIds = [...new Set(input.targets.map((id) => member(id, members, 'targets')))]
        .filter((id) => id !== senderId);
      if (targetAgentIds.length === 0 || targetAgentIds.length > config.collaboration.maxTargets) {
        throw new Error(`targets 必须包含 1～${config.collaboration.maxTargets} 位其他成员`);
      }
      if (input.policy !== 'all' && input.policy !== 'any') throw new Error('policy 必须是 all 或 any');
      const timeoutAt = futureTimestamp(options.now, seconds(input.timeoutSeconds, 'timeoutSeconds'));
      return { version: 2, type: 'hold', wake: { kind: 'dependency', targetAgentIds,
        policy: input.policy, timeoutAt }, reason };
    }
    if (call.name === 'agent.hold' && input.mode !== undefined && input.mode !== 'user') {
      throw new Error('agent.hold mode 必须是 user、timer 或 dependency');
    }
    const prompt = text(input.question, 'question');
    return version === 1
      ? { type: 'wait_user', question: prompt, reason }
      : { version: 2, type: 'hold', wake: { kind: 'user_decision', decisionKind: 'agent_question', prompt }, reason };
  }
  if (call.name === 'agent.propose_supervisor_task') {
    if (!Array.isArray(input.acceptanceCriteria) || !Array.isArray(input.suggestedAssigneeIds)) throw new Error('acceptanceCriteria 和 suggestedAssigneeIds 必须是数组');
    const acceptanceCriteria = input.acceptanceCriteria.map((item) => text(item, 'acceptanceCriteria', 1_000)).slice(0, 12);
    const suggestedAssigneeIds = [...new Set(input.suggestedAssigneeIds.map((id) => member(id, members, 'suggestedAssigneeIds')))];
    const suggestedReviewerId = input.suggestedReviewerId === undefined ? undefined : member(input.suggestedReviewerId, members, 'suggestedReviewerId');
    const proposal = { title: text(input.title, 'title', 120), goal: text(input.goal, 'goal'),
      acceptanceCriteria, suggestedAssigneeIds, ...(suggestedReviewerId ? { suggestedReviewerId } : {}), reason: text(input.reason, 'reason', 1_000) };
    return version === 1
      ? { type: 'propose_task', ...proposal }
      : { version: 2, type: 'hold', wake: { kind: 'user_decision', decisionKind: 'supervisor_task_proposal', proposal }, reason: proposal.reason };
  }
  throw new Error(`未知协作控制工具: ${call.name}`);
}

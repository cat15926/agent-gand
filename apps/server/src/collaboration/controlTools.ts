import type { CollaborationControlAction } from '@agent-gand/shared';
import type { LlmToolCall, LlmToolSchema } from '../llm/provider.ts';
import { config } from '../config.ts';

export const COLLABORATION_CONTROL_TOOLS: LlmToolSchema[] = [
  {
    name: 'agent.send_message',
    description: '把当前工作明确交给一位聊天室成员继续处理。调用后当前回合结束。',
    parameters: { type: 'object', additionalProperties: false, required: ['target', 'message', 'reason'], properties: {
      target: { type: 'string' }, message: { type: 'string' }, reason: { type: 'string' },
    } },
  },
  {
    name: 'agent.ask_many',
    description: '并行征询多位聊天室成员，全部结果将回流给你。调用后当前回合结束。',
    parameters: { type: 'object', additionalProperties: false, required: ['targets', 'question', 'reason'], properties: {
      targets: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: config.collaboration.maxTargets },
      question: { type: 'string' }, reason: { type: 'string' },
    } },
  },
  {
    name: 'agent.wait_for_user',
    description: '当前工作需要用户判断时提出一个明确问题并暂停本 Run。',
    parameters: { type: 'object', additionalProperties: false, required: ['question', 'reason'], properties: {
      question: { type: 'string' }, reason: { type: 'string' },
    } },
  },
  {
    name: 'agent.propose_supervisor_task',
    description: '提议把工作转为有验收和 Reviewer 的正式 Supervisor Run，必须等待用户确认。',
    parameters: { type: 'object', additionalProperties: false,
      required: ['title', 'goal', 'acceptanceCriteria', 'suggestedAssigneeIds', 'reason'], properties: {
        title: { type: 'string' }, goal: { type: 'string' },
        acceptanceCriteria: { type: 'array', items: { type: 'string' }, minItems: 1 },
        suggestedAssigneeIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
        suggestedReviewerId: { type: 'string' }, reason: { type: 'string' },
      } },
  },
];

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

export function parseControlCall(call: LlmToolCall, memberIds: string[], senderId: string): CollaborationControlAction {
  const input = objectInput(call); const members = new Set(memberIds);
  if (call.name === 'agent.send_message') {
    const targetAgentId = member(input.target, members, 'target');
    if (targetAgentId === senderId) throw new Error('不能把工作交给自己');
    return { type: 'handoff', targetAgentId, message: text(input.message, 'message'), reason: text(input.reason, 'reason', 1_000) };
  }
  if (call.name === 'agent.ask_many') {
    if (!Array.isArray(input.targets)) throw new Error('targets 必须是数组');
    const targetAgentIds = [...new Set(input.targets.map((id) => member(id, members, 'targets')))].filter((id) => id !== senderId);
    if (targetAgentIds.length === 0 || targetAgentIds.length > config.collaboration.maxTargets) throw new Error(`targets 必须包含 1～${config.collaboration.maxTargets} 位其他成员`);
    return { type: 'ask_many', targetAgentIds, question: text(input.question, 'question'), reason: text(input.reason, 'reason', 1_000) };
  }
  if (call.name === 'agent.wait_for_user') {
    return { type: 'wait_user', question: text(input.question, 'question'), reason: text(input.reason, 'reason', 1_000) };
  }
  if (call.name === 'agent.propose_supervisor_task') {
    if (!Array.isArray(input.acceptanceCriteria) || !Array.isArray(input.suggestedAssigneeIds)) throw new Error('acceptanceCriteria 和 suggestedAssigneeIds 必须是数组');
    const acceptanceCriteria = input.acceptanceCriteria.map((item) => text(item, 'acceptanceCriteria', 1_000)).slice(0, 12);
    const suggestedAssigneeIds = [...new Set(input.suggestedAssigneeIds.map((id) => member(id, members, 'suggestedAssigneeIds')))];
    const suggestedReviewerId = input.suggestedReviewerId === undefined ? undefined : member(input.suggestedReviewerId, members, 'suggestedReviewerId');
    return { type: 'propose_task', title: text(input.title, 'title', 120), goal: text(input.goal, 'goal'),
      acceptanceCriteria, suggestedAssigneeIds, ...(suggestedReviewerId ? { suggestedReviewerId } : {}), reason: text(input.reason, 'reason', 1_000) };
  }
  throw new Error(`未知协作控制工具: ${call.name}`);
}

import type { AgentTurnResult } from '../orchestration/agentStep.ts';

export type CollaborationTurnExit =
  | { kind: 'control_action' }
  | { kind: 'answer_candidate' }
  | { kind: 'truncated'; code: 'AGENT_TURN_TRUNCATED'; detail: string }
  | { kind: 'approval_wait'; code: 'AGENT_TURN_APPROVAL_STARVED'; detail: string }
  | { kind: 'empty'; code: 'AGENT_TURN_EMPTY'; detail: string };

/** 技术性停止先于正文和 ControlAction 判定，不能降级为一次成功的 finish。 */
export function classifyCollaborationTurnExit(turn: AgentTurnResult): CollaborationTurnExit {
  if (turn.truncated) return { kind: 'truncated', code: 'AGENT_TURN_TRUNCATED', detail: '模型输出被 max_tokens 截断，结果未完成' };
  if (turn.approvalStarved) return { kind: 'approval_wait', code: 'AGENT_TURN_APPROVAL_STARVED', detail: '审批连续超时，本轮未完成；请处理审批后重新发起' };
  if (turn.emptyResponse || (!turn.controlAction && !turn.content.trim())) {
    return { kind: 'empty', code: 'AGENT_TURN_EMPTY', detail: 'Agent 未生成有效回复或控制动作' };
  }
  return turn.controlAction ? { kind: 'control_action' } : { kind: 'answer_candidate' };
}

export function isTechnicalInterruption(error: string | null): boolean {
  return error?.startsWith('AGENT_TURN_') ?? false;
}

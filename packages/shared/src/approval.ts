/**
 * HITL 审批（P0-5）
 * 敏感动作中断 → 审批卡 → 批准 / 拒绝 / 编辑后继续
 */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'edited' | 'expired';

export type ApprovalDecision = 'approve' | 'reject' | 'edit';

export interface ApprovalRequest {
  id: string;
  runId: string;
  agentId: string;
  toolName: string;
  /** JSON 序列化的工具入参 */
  input: string | null;
  /** 为什么需要审批（给人类看） */
  reason: string | null;
  status: ApprovalStatus;
  /** decision=edit 时的人工修改后入参 */
  editedInput: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

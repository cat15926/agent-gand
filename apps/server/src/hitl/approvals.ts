/**
 * HITL 审批（规格 §4.2 hitl/approvals.ts，P0-5）
 * create/list/decide；decide 后广播 approval.updated；
 * 编排器用 waitForDecision 以 500ms 轮询等待人工决策
 */
import type { ApprovalDecision, ApprovalRequest, ApprovalStatus } from '@agent-gand/shared';
import { randomUUID } from 'node:crypto';
import { all, get, run } from '../db/database.ts';
import { emit } from '../messaging/bus.ts';

interface ApprovalRow {
  id: string;
  run_id: string;
  agent_id: string;
  tool_name: string;
  input: string | null;
  reason: string | null;
  status: string;
  edited_input: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

function rowToApproval(row: ApprovalRow): ApprovalRequest {
  return {
    id: row.id,
    runId: row.run_id,
    agentId: row.agent_id,
    toolName: row.tool_name,
    input: row.input,
    reason: row.reason,
    status: row.status as ApprovalStatus,
    editedInput: row.edited_input,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  };
}

export class ApprovalError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApprovalError';
  }
}

export interface CreateApprovalInput {
  runId: string;
  agentId: string;
  toolName: string;
  input: string | null; // JSON 序列化的工具入参
  reason: string | null;
}

export function createApproval(input: CreateApprovalInput): ApprovalRequest {
  const approval: ApprovalRequest = {
    id: randomUUID(),
    ...input,
    status: 'pending',
    editedInput: null,
    decidedBy: null,
    decidedAt: null,
    createdAt: new Date().toISOString(),
  };
  run(
    `INSERT INTO approvals (id, run_id, agent_id, tool_name, input, reason, status, edited_input, decided_by, decided_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    approval.id,
    approval.runId,
    approval.agentId,
    approval.toolName,
    approval.input,
    approval.reason,
    approval.status,
    approval.createdAt,
  );
  emit({ type: 'approval.updated', approval });
  return approval;
}

export function listApprovals(status?: string): ApprovalRequest[] {
  const rows =
    status === undefined
      ? all<ApprovalRow>('SELECT * FROM approvals ORDER BY created_at DESC')
      : all<ApprovalRow>('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC', status);
  return rows.map(rowToApproval);
}

export function getApproval(id: string): ApprovalRequest | undefined {
  const row = get<ApprovalRow>('SELECT * FROM approvals WHERE id = ?', id);
  return row ? rowToApproval(row) : undefined;
}

const DECISION_TO_STATUS: Record<ApprovalDecision, ApprovalStatus> = {
  approve: 'approved',
  reject: 'rejected',
  edit: 'edited',
};

export interface DecideInput {
  decision: ApprovalDecision;
  editedInput?: string;
  by: string; // 'user' 或操作者标识
}

/** 三态决策：approve / reject / edit（edit 需给出 editedInput） */
export function decide(id: string, input: DecideInput): ApprovalRequest {
  const row = get<ApprovalRow>('SELECT * FROM approvals WHERE id = ?', id);
  if (!row) throw new ApprovalError(`approval 不存在: ${id}`, 404);
  if (row.status !== 'pending') {
    throw new ApprovalError(`approval 已决策过（当前 ${row.status}）`, 409);
  }
  if (input.decision === 'edit' && (input.editedInput === undefined || input.editedInput.length === 0)) {
    throw new ApprovalError('decision=edit 时必须提供 editedInput', 400);
  }
  const status = DECISION_TO_STATUS[input.decision];
  const now = new Date().toISOString();
  const changes = run(
    `UPDATE approvals
     SET status = ?, edited_input = ?, decided_by = ?, decided_at = ?
     WHERE id = ? AND status = 'pending'`,
    status,
    input.decision === 'edit' ? (input.editedInput ?? null) : null,
    input.by,
    now,
    id,
  );
  if (changes === 0) throw new ApprovalError('approval 已被他人决策（并发冲突）', 409);
  const approval = getApproval(id);
  if (!approval) throw new ApprovalError(`approval 不存在: ${id}`, 404);
  emit({ type: 'approval.updated', approval });
  return approval;
}

export class ApprovalTimeoutError extends Error {
  constructor(approvalId: string) {
    super(`等待审批决策超时: ${approvalId}`);
    this.name = 'ApprovalTimeoutError';
  }
}

/**
 * 编排器轮询等待决策（500ms 间隔）。
 * TODO: durable pause/resume —— 超时/进程重启后 run 停在 awaiting_approval，重启后可续跑
 */
export async function waitForDecision(id: string, timeoutMs = 300_000): Promise<ApprovalRequest> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const approval = getApproval(id);
    if (!approval) throw new ApprovalError(`approval 不存在: ${id}`, 404);
    if (approval.status !== 'pending') return approval;
    if (Date.now() >= deadline) throw new ApprovalTimeoutError(id);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

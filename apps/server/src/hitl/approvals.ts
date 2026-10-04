/**
 * HITL 审批（规格 §4.2 hitl/approvals.ts，P0-5）
 * create/list/decide；decide 后广播 approval.updated；
 * 编排器用 waitForDecision 以 500ms 轮询等待人工决策
 */
import type { ApprovalDecision, ApprovalRequest, ApprovalStatus } from '@agent-gand/shared';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { afterCommit, all, get, run, tx } from '../db/database.ts';
import { emit } from '../messaging/bus.ts';
import { executionAuthorized } from '../execution/authority.ts';
import type { ExternalAgentExecution } from '@agent-gand/shared';
import {
  cancelDurableHoldsByCondition,
  createDurableHold,
  recordRuntimeWakeEvent,
  runtimeDurableHoldVersion,
} from '../runtime/holds.ts';

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
  idempotency_key: string | null;
  checkpoint_id: string | null;
}

function rowToApproval(row: ApprovalRow): ApprovalRequest {
  const native = get<{ binding: string }>('SELECT binding FROM external_agent_approvals WHERE approval_id=?', row.id);
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
    ...(native ? { native: JSON.parse(native.binding) as NonNullable<ApprovalRequest['native']> } : {}),
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
  idempotencyKey?: string;
  checkpointId?: string;
  attemptId?: string;
  native?: NonNullable<ApprovalRequest['native']>;
}

/** 审批卡是否仍可复用：pending 等待中 / approved / edited 已放行；expired 与 rejected 是终态裁定，重放需发新卡 */
function usableApproval(row: ApprovalRow): boolean {
  return row.status === 'pending' || row.status === 'approved' || row.status === 'edited';
}

function approvalHoldOpen(runId: string, approvalId: string): boolean {
  return all<{ condition: string }>("SELECT condition FROM runtime_holds WHERE run_id=? AND status IN ('open','claimed')", runId)
    .some((row) => {
      try { const value = JSON.parse(row.condition) as { kind?: string; approvalId?: string };
        return value.kind === 'approval' && value.approvalId === approvalId; } catch { return false; }
    });
}

function ensureApprovalHold(approval: ApprovalRequest, attemptId?: string): void {
  if (!attemptId || runtimeDurableHoldVersion(approval.runId) === null) return;
  // 已放行卡的重放不是等待：只补 Wake 审计，不能重新创建短暂 open Hold，
  // 否则工具完成后的 Candidate 会与后台 Hold 扫描发生竞态。
  if (approval.status !== 'pending') {
    recordRuntimeWakeEvent({ runId: approval.runId, kind: 'approval', sourceKey: approval.id,
      payload: { status: approval.status }, idempotencyKey: `approval-wake:${approval.id}:${approval.status}` });
    return;
  }
  const attempt = get<{ dispatch_id: string; agent_id: string }>(
    'SELECT dispatch_id,agent_id FROM collaboration_attempts WHERE id=? AND run_id=?', attemptId, approval.runId);
  const coordination = attempt ? undefined : get<{ subject_id: string; holder_agent_id: string | null }>(`SELECT m.subject_id,c.holder_agent_id
    FROM coordination_step_attempts a
    JOIN runtime_coordination_subjects m ON m.plan_id=a.plan_id AND m.revision=a.revision AND m.step_id=a.step_id
    JOIN runtime_custody c ON c.subject_id=m.subject_id
    WHERE a.id=? AND a.run_id=?`, attemptId, approval.runId);
  if (!attempt && (!coordination || !coordination.holder_agent_id)) return;
  createDurableHold({ runId: approval.runId,
    ...(attempt ? { sourceDispatchId: attempt.dispatch_id } : { subjectId: coordination!.subject_id }),
    sourceAttemptId: attemptId, holderAgentId: attempt?.agent_id ?? coordination!.holder_agent_id!,
    condition: { kind: 'approval', approvalId: approval.id }, recoveryPolicy: { kind: 'wake_run' },
    ...(runtimeDurableHoldVersion(approval.runId) === 2 && config.approvalTimeoutMs > 0 ? {
      timeoutAt: new Date(new Date(approval.createdAt).getTime() + config.approvalTimeoutMs).toISOString(),
      onTimeout: { kind: 'fail' as const, reason: '审批未在有效期内完成' },
    } : {}),
    idempotencyKey: `approval-hold:${approval.id}` });
}

export function createApproval(input: CreateApprovalInput): ApprovalRequest {
  return tx(() => {
    let idempotencyKey = input.idempotencyKey ?? null;
    if (idempotencyKey) {
      // AG-COORD-04：同一逻辑调用的重放（暂停恢复/进程重启）复用未决或已放行的卡；
      // 旧卡已 expired/rejected 时不得把旧裁定强加给新执行——顺延 #2/#3… 发一张新卡
      for (let sequence = 1; ; sequence += 1) {
        const key = sequence === 1 ? idempotencyKey : `${idempotencyKey}#${sequence}`;
        const existing = get<ApprovalRow>('SELECT * FROM approvals WHERE idempotency_key = ?', key);
        if (!existing) { idempotencyKey = key; break; }
        if (usableApproval(existing)) {
          const approval = rowToApproval(existing); ensureApprovalHold(approval, input.attemptId); return approval;
        }
      }
    }
    const approval: ApprovalRequest = {
      id: randomUUID(),
      runId: input.runId,
      agentId: input.agentId,
      toolName: input.toolName,
      input: input.input,
      reason: input.reason,
      status: 'pending',
      editedInput: null,
      decidedBy: null,
      decidedAt: null,
      createdAt: new Date().toISOString(),
    };
    run(
      `INSERT INTO approvals (id, run_id, agent_id, tool_name, input, reason, status, edited_input, decided_by, decided_at, created_at, idempotency_key, checkpoint_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
      approval.id, approval.runId, approval.agentId, approval.toolName, approval.input, approval.reason,
      approval.status, approval.createdAt, idempotencyKey, input.checkpointId ?? null,
    );
    ensureApprovalHold(approval, input.attemptId);
    if (input.native) {
      run('INSERT INTO external_agent_approvals (approval_id,execution_id,request_id,binding) VALUES (?,?,?,?)', approval.id, input.native.executionId, input.native.requestId, JSON.stringify(input.native));
      approval.native = input.native;
    }
    afterCommit(() => emit({ type: 'approval.updated', approval }));
    return approval;
  });
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
  return tx(() => {
    const row = get<ApprovalRow>('SELECT * FROM approvals WHERE id = ?', id);
    if (!row) throw new ApprovalError(`approval 不存在: ${id}`, 404);
    if (row.status !== 'pending') throw new ApprovalError(`approval 已决策过（当前 ${row.status}）`, 409);
    const native = get<{ execution_id: string; binding: string }>('SELECT execution_id,binding FROM external_agent_approvals WHERE approval_id=?', id);
    if (native) {
      const execution = get<{ record: string }>('SELECT record FROM external_agent_executions WHERE id=?', native.execution_id);
      if (!execution || !executionAuthorized(JSON.parse(execution.record) as ExternalAgentExecution)) throw new ApprovalError('原生审批绑定的执行或责任代际已失效', 409);
      if (input.decision === 'edit') throw new ApprovalError('原生审批支持批准或拒绝，不支持改写原生请求', 400);
    }
    if (input.decision === 'edit' && (input.editedInput === undefined || input.editedInput.length === 0)) {
      throw new ApprovalError('decision=edit 时必须提供 editedInput', 400);
    }
    const status = DECISION_TO_STATUS[input.decision]; const now = new Date().toISOString();
    const changes = run(`UPDATE approvals SET status=?,edited_input=?,decided_by=?,decided_at=?
      WHERE id=? AND status='pending'`, status,
    input.decision === 'edit' ? (input.editedInput ?? null) : null, input.by, now, id);
    if (changes === 0) throw new ApprovalError('approval 已被他人决策（并发冲突）', 409);
    const approval = getApproval(id);
    if (!approval) throw new ApprovalError(`approval 不存在: ${id}`, 404);
    if (runtimeDurableHoldVersion(approval.runId) !== null) {
      recordRuntimeWakeEvent({ runId: approval.runId, kind: 'approval', sourceKey: approval.id,
        payload: { status: approval.status, decidedBy: approval.decidedBy },
        idempotencyKey: `approval-wake:${approval.id}:${approval.status}` });
    }
    afterCommit(() => emit({ type: 'approval.updated', approval }));
    return approval;
  });
}

export class ApprovalTimeoutError extends Error {
  constructor(approvalId: string) {
    super(`等待审批决策超时: ${approvalId}`);
    this.name = 'ApprovalTimeoutError';
  }
}

/**
 * 超时把 pending 置 expired（规格 §8.2）：decidedBy='system:timeout'，
 * 不得遗留 pending（真机 run 32b19e2a 实证过遗留 2 条）。并发安全：仅当仍为 pending 时生效。
 */
export function expireApproval(id: string): ApprovalRequest {
  return tx(() => {
    const now = new Date().toISOString();
    run(`UPDATE approvals SET status='expired',edited_input=NULL,decided_by='system:timeout',decided_at=?
      WHERE id=? AND status='pending'`, now, id);
    const approval = getApproval(id);
    if (!approval) throw new ApprovalError(`approval 不存在: ${id}`, 404);
    if (runtimeDurableHoldVersion(approval.runId) !== null) {
      recordRuntimeWakeEvent({ runId: approval.runId, kind: 'approval', sourceKey: approval.id,
        payload: { status: approval.status }, idempotencyKey: `approval-wake:${approval.id}:${approval.status}` });
    }
    afterCommit(() => emit({ type: 'approval.updated', approval }));
    return approval;
  });
}

/**
 * AG-COORD-04：run 暂停/取消时把该 run 残留的 pending 审批一并置 expired，
 * 避免界面遗留无人处理的审批卡（每张都会等满 APPROVAL_TIMEOUT_MS 才消失）。
 */
export function expirePendingApprovalsForRun(runId: string, decidedBy = 'system:paused'): void {
  const rows = all<ApprovalRow>("SELECT id FROM approvals WHERE run_id = ? AND status = 'pending'", runId);
  const now = new Date().toISOString();
  for (const row of rows) {
    run(
      `UPDATE approvals SET status = 'expired', edited_input = NULL, decided_by = ?, decided_at = ?
       WHERE id = ? AND status = 'pending'`,
      decidedBy,
      now,
      row.id,
    );
    const approval = getApproval(row.id);
    if (approval) {
      cancelDurableHoldsByCondition(runId, 'approval', approval.id, decidedBy);
      emit({ type: 'approval.updated', approval });
    }
  }
}

/**
 * 编排器轮询等待决策（500ms 间隔）。超时默认取 APPROVAL_TIMEOUT_MS（0 = 不超时），
 * 到点置 expired 并返回（调用方按拒绝处理该工具），不再抛超时异常。
 * TODO: durable pause/resume —— 超时/进程重启后 run 停在 awaiting_approval，重启后可续跑
 */
export async function waitForDecision(
  id: string,
  timeoutMs: number = config.approvalTimeoutMs,
): Promise<ApprovalRequest> {
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
  for (;;) {
    const approval = getApproval(id);
    if (!approval) throw new ApprovalError(`approval 不存在: ${id}`, 404);
    if (approval.status !== 'pending') {
      // 决策行先于 API 路由触发 Wake 扫描可见。等待对应 Hold 真正终结，避免 Agent
      // 抢先继续并让 CompletionCandidate 被“已满足但尚未投影”的 Hold 误拒绝。
      if (runtimeDurableHoldVersion(approval.runId) !== null && approvalHoldOpen(approval.runId, approval.id)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      return approval;
    }
    if (Date.now() >= deadline) { expireApproval(id); continue; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

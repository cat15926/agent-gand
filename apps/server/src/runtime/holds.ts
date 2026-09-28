import { randomUUID } from 'node:crypto';
import type {
  RuntimeDurableHold,
  RuntimeDurableHoldCondition,
  RuntimeDurableHoldRecoveryPolicy,
  RuntimeRunContract,
  RuntimeWakeEvent,
  RuntimeWakeEventKind,
} from '@agent-gand/shared';
import { afterCommit, all, get, run, tx } from '../db/database.ts';
import { emit } from '../messaging/bus.ts';

interface HoldRow {
  id: string; run_id: string; subject_id: string; source_dispatch_id: string | null; source_attempt_id: string | null;
  holder_agent_id: string; generation: number; version: number; condition: string; deadline_at: string | null;
  recovery_policy: string; status: RuntimeDurableHold['status']; idempotency_key: string;
  claim_owner: string | null; claim_token: string | null; claim_expires_at: string | null;
  wake_event_id: string | null; resumed_dispatch_id: string | null; resolution: string | null;
  last_error: string | null; created_at: string; updated_at: string; resolved_at: string | null;
}

interface WakeEventRow {
  id: string; run_id: string; kind: RuntimeWakeEventKind; source_key: string;
  payload: string; idempotency_key: string; created_at: string;
}

interface CustodyRow { state: string; holder_agent_id: string | null; generation: number; }

const CLAIM_LEASE_MS = 30_000;
const ACTIVE_RUN_STATUSES = new Set(['pending', 'running', 'awaiting_approval', 'waiting_for_user']);

function toHold(row: HoldRow): RuntimeDurableHold {
  return {
    id: row.id, version: 1, runId: row.run_id, subjectId: row.subject_id,
    sourceDispatchId: row.source_dispatch_id, sourceAttemptId: row.source_attempt_id,
    holderAgentId: row.holder_agent_id, generation: row.generation,
    condition: JSON.parse(row.condition) as RuntimeDurableHoldCondition,
    deadlineAt: row.deadline_at,
    recoveryPolicy: JSON.parse(row.recovery_policy) as RuntimeDurableHoldRecoveryPolicy,
    status: row.status, idempotencyKey: row.idempotency_key,
    claimOwner: row.claim_owner, claimToken: row.claim_token, claimExpiresAt: row.claim_expires_at,
    wakeEventId: row.wake_event_id, resumedDispatchId: row.resumed_dispatch_id,
    resolution: row.resolution ? JSON.parse(row.resolution) as Record<string, unknown> : null,
    lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at, resolvedAt: row.resolved_at,
  };
}

function toWakeEvent(row: WakeEventRow): RuntimeWakeEvent {
  return {
    id: row.id, runId: row.run_id, kind: row.kind, sourceKey: row.source_key,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    idempotencyKey: row.idempotency_key, createdAt: row.created_at,
  };
}

function deadlineFor(condition: RuntimeDurableHoldCondition, explicit?: string | null): string | null {
  const value = explicit ?? (condition.kind === 'timer' ? condition.wakeAt
    : condition.kind === 'lease_recovery' ? condition.leaseExpiredAt : null);
  if (value !== null && !Number.isFinite(new Date(value).getTime())) throw new Error('Durable Hold deadline 无效');
  return value;
}

function validateCondition(runId: string, condition: RuntimeDurableHoldCondition): void {
  if (condition.kind === 'user_decision') {
    if (!get('SELECT 1 FROM collaboration_user_decisions WHERE id=? AND run_id=?', condition.decisionId, runId)) {
      throw new Error('Durable Hold 用户决策不属于当前 Run');
    }
    return;
  }
  if (condition.kind === 'approval') {
    if (!get('SELECT 1 FROM approvals WHERE id=? AND run_id=?', condition.approvalId, runId)) {
      throw new Error('Durable Hold 审批不属于当前 Run');
    }
    return;
  }
  if (condition.kind === 'dependency') {
    const unique = [...new Set(condition.subjectIds)];
    const count = unique.length === 0 ? 0 : get<{ n: number }>(`SELECT COUNT(*) n FROM runtime_subjects
      WHERE run_id=? AND id IN (${unique.map(() => '?').join(',')})`, runId, ...unique)?.n ?? 0;
    if (unique.length === 0 || unique.length !== condition.subjectIds.length || count !== unique.length) {
      throw new Error('Durable Hold 依赖 Subject 为空、重复或跨 Run');
    }
    return;
  }
  if (condition.kind === 'lease_recovery') {
    if (!get('SELECT 1 FROM collaboration_attempts WHERE id=? AND run_id=?', condition.attemptId, runId)) {
      throw new Error('Durable Hold 租约 Attempt 不属于当前 Run');
    }
    return;
  }
  if (condition.kind === 'event' && !condition.eventKey.trim()) throw new Error('Durable Hold 事件键不能为空');
}

export function runtimeDurableHoldVersion(runId: string): 1 | null {
  const row = get<{ payload: string }>('SELECT payload FROM runtime_contracts WHERE run_id=?', runId);
  if (!row) return null;
  try { return (JSON.parse(row.payload) as RuntimeRunContract).features?.durableHoldVersion === 1 ? 1 : null; }
  catch { return null; }
}

export function createDurableHold(input: {
  runId: string;
  subjectId?: string;
  sourceDispatchId?: string | null;
  sourceAttemptId?: string | null;
  holderAgentId: string;
  expectedGeneration?: number;
  condition: RuntimeDurableHoldCondition;
  deadlineAt?: string | null;
  recoveryPolicy: RuntimeDurableHoldRecoveryPolicy;
  idempotencyKey: string;
}): RuntimeDurableHold {
  return tx(() => {
    const subjectId = input.subjectId ?? (input.sourceDispatchId
      ? get<{ subject_id: string }>('SELECT subject_id FROM runtime_dispatch_subjects WHERE dispatch_id=?', input.sourceDispatchId)?.subject_id
      : undefined);
    if (!subjectId) throw new Error('Durable Hold 缺少 Subject');
    const encodedCondition = JSON.stringify(input.condition);
    const encodedPolicy = JSON.stringify(input.recoveryPolicy);
    const deadlineAt = deadlineFor(input.condition, input.deadlineAt);
    const existing = get<HoldRow>('SELECT * FROM runtime_holds WHERE idempotency_key=?', input.idempotencyKey);
    if (existing) {
      if (existing.run_id !== input.runId || existing.subject_id !== subjectId
        || existing.holder_agent_id !== input.holderAgentId || existing.condition !== encodedCondition
        || existing.recovery_policy !== encodedPolicy || existing.deadline_at !== deadlineAt) {
        throw new Error(`Durable Hold 幂等键冲突：${input.idempotencyKey}`);
      }
      return toHold(existing);
    }
    const subject = get<{ run_id: string }>('SELECT run_id FROM runtime_subjects WHERE id=?', subjectId);
    if (!subject || subject.run_id !== input.runId) throw new Error('Durable Hold Subject 不属于当前 Run');
    const custody = get<CustodyRow>('SELECT state,holder_agent_id,generation FROM runtime_custody WHERE subject_id=?', subjectId);
    if (!custody || !['owned', 'waiting'].includes(custody.state) || custody.holder_agent_id !== input.holderAgentId) {
      throw new Error('Durable Hold 创建者不是当前责任持有者');
    }
    if (input.expectedGeneration !== undefined && custody.generation !== input.expectedGeneration) {
      throw new Error('Durable Hold generation 已过期');
    }
    validateCondition(input.runId, input.condition);
    const id = randomUUID(); const now = new Date().toISOString();
    run(`INSERT INTO runtime_holds
      (id,run_id,subject_id,source_dispatch_id,source_attempt_id,holder_agent_id,generation,version,condition,
       deadline_at,recovery_policy,status,idempotency_key,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,1,?,?,?,'open',?,?,?)`,
    id, input.runId, subjectId, input.sourceDispatchId ?? null, input.sourceAttemptId ?? null,
    input.holderAgentId, custody.generation, encodedCondition, deadlineAt, encodedPolicy,
    input.idempotencyKey, now, now);
    const hold = toHold(get<HoldRow>('SELECT * FROM runtime_holds WHERE id=?', id)!);
    afterCommit(() => emit({ type: 'runtime.hold.updated', hold }));
    return hold;
  });
}

export function recordRuntimeWakeEvent(input: {
  runId: string;
  kind: RuntimeWakeEventKind;
  sourceKey: string;
  payload?: Record<string, unknown>;
  idempotencyKey: string;
}): RuntimeWakeEvent {
  return tx(() => {
    const existing = get<WakeEventRow>('SELECT * FROM runtime_wake_events WHERE idempotency_key=?', input.idempotencyKey);
    const payload = JSON.stringify(input.payload ?? {});
    if (existing) {
      if (existing.run_id !== input.runId || existing.kind !== input.kind
        || existing.source_key !== input.sourceKey || existing.payload !== payload) {
        throw new Error(`WakeEvent 幂等键冲突：${input.idempotencyKey}`);
      }
      return toWakeEvent(existing);
    }
    const id = randomUUID(); const createdAt = new Date().toISOString();
    run(`INSERT INTO runtime_wake_events (id,run_id,kind,source_key,payload,idempotency_key,created_at)
      VALUES (?,?,?,?,?,?,?)`, id, input.runId, input.kind, input.sourceKey, payload, input.idempotencyKey, createdAt);
    const wakeEvent = toWakeEvent(get<WakeEventRow>('SELECT * FROM runtime_wake_events WHERE id=?', id)!);
    afterCommit(() => emit({ type: 'runtime.wake_event.recorded', wakeEvent }));
    return wakeEvent;
  });
}

function wakeEventFor(hold: RuntimeDurableHold, now: string): RuntimeWakeEvent | null {
  const condition = hold.condition;
  if (condition.kind === 'user_decision' || condition.kind === 'approval' || condition.kind === 'event') {
    const sourceKey = condition.kind === 'user_decision' ? condition.decisionId
      : condition.kind === 'approval' ? condition.approvalId : condition.eventKey;
    const row = get<WakeEventRow>(`SELECT * FROM runtime_wake_events
      WHERE run_id=? AND kind=? AND source_key=? ORDER BY created_at,rowid LIMIT 1`, hold.runId, condition.kind, sourceKey);
    return row ? toWakeEvent(row) : null;
  }
  if (condition.kind === 'timer') {
    if (condition.wakeAt > now) return null;
    return recordRuntimeWakeEvent({ runId: hold.runId, kind: 'timer', sourceKey: hold.id,
      payload: { wakeAt: condition.wakeAt }, idempotencyKey: `timer:${hold.id}` });
  }
  if (condition.kind === 'dependency') {
    if (condition.subjectIds.length === 0) return null;
    const completed = all<{ id: string }>(`SELECT id FROM runtime_subjects
      WHERE run_id=? AND id IN (${condition.subjectIds.map(() => '?').join(',')}) AND status='completed'`,
    hold.runId, ...condition.subjectIds).length;
    const ready = condition.policy === 'all' ? completed === condition.subjectIds.length : completed > 0;
    if (!ready) return null;
    return recordRuntimeWakeEvent({ runId: hold.runId, kind: 'dependency', sourceKey: hold.id,
      payload: { subjectIds: condition.subjectIds, policy: condition.policy }, idempotencyKey: `dependency:${hold.id}` });
  }
  const attempt = get<{ status: string }>('SELECT status FROM collaboration_attempts WHERE id=? AND run_id=?', condition.attemptId, hold.runId);
  if (!attempt || attempt.status !== 'interrupted' || condition.leaseExpiredAt > now) return null;
  return recordRuntimeWakeEvent({ runId: hold.runId, kind: 'lease_recovery', sourceKey: condition.attemptId,
    payload: { leaseExpiredAt: condition.leaseExpiredAt }, idempotencyKey: `lease-recovery:${condition.attemptId}` });
}

export function claimReadyDurableHolds(input: {
  claimOwner: string;
  runId?: string;
  now?: string;
  limit?: number;
}): RuntimeDurableHold[] {
  return tx(() => {
    const now = input.now ?? new Date().toISOString();
    const rows = all<HoldRow>(`SELECT h.* FROM runtime_holds h JOIN runs r ON r.id=h.run_id
      WHERE (h.status='open' OR (h.status='claimed' AND h.claim_expires_at<=?))
        AND r.status IN ('pending','running','awaiting_approval','waiting_for_user')
        ${input.runId ? 'AND h.run_id=?' : ''}
      ORDER BY CASE WHEN h.deadline_at IS NULL THEN 1 ELSE 0 END,h.deadline_at,h.created_at,h.rowid`,
    now, ...(input.runId ? [input.runId] : []));
    const claimed: RuntimeDurableHold[] = [];
    for (const row of rows) {
      if (claimed.length >= (input.limit ?? 32)) break;
      const current = toHold(row); const wakeEvent = wakeEventFor(current, now);
      if (!wakeEvent) continue;
      const claimToken = randomUUID();
      const claimExpiresAt = new Date(new Date(now).getTime() + CLAIM_LEASE_MS).toISOString();
      const changed = run(`UPDATE runtime_holds SET status='claimed',claim_owner=?,claim_token=?,claim_expires_at=?,
        wake_event_id=?,last_error=NULL,updated_at=? WHERE id=?
        AND (status='open' OR (status='claimed' AND claim_expires_at<=?))`,
      input.claimOwner, claimToken, claimExpiresAt, wakeEvent.id, now, current.id, now);
      if (changed === 0) continue;
      const hold = toHold(get<HoldRow>('SELECT * FROM runtime_holds WHERE id=?', current.id)!);
      claimed.push(hold); afterCommit(() => emit({ type: 'runtime.hold.updated', hold }));
    }
    return claimed;
  });
}

export function assertDurableHoldClaim(id: string, claimToken: string, now = new Date().toISOString()): RuntimeDurableHold {
  const row = get<HoldRow>('SELECT * FROM runtime_holds WHERE id=?', id);
  if (!row || row.status !== 'claimed' || row.claim_token !== claimToken || !row.claim_expires_at || row.claim_expires_at <= now) {
    throw new Error('Durable Hold claim 已失效');
  }
  const runRow = get<{ status: string }>('SELECT status FROM runs WHERE id=?', row.run_id);
  if (!runRow || !ACTIVE_RUN_STATUSES.has(runRow.status)) throw new Error('Durable Hold 所属 Run 已终结');
  const custody = get<CustodyRow>('SELECT state,holder_agent_id,generation FROM runtime_custody WHERE subject_id=?', row.subject_id);
  if (!custody || !['owned', 'waiting'].includes(custody.state)
    || custody.holder_agent_id !== row.holder_agent_id || custody.generation !== row.generation) {
    throw new Error('Durable Hold 的责任代际已失效');
  }
  return toHold(row);
}

export function completeDurableHoldClaim(input: {
  id: string;
  claimToken: string;
  resumedDispatchId?: string | null;
  resolution?: Record<string, unknown>;
}): RuntimeDurableHold {
  return tx(() => {
    assertDurableHoldClaim(input.id, input.claimToken);
    const now = new Date().toISOString();
    const changed = run(`UPDATE runtime_holds SET status='resumed',resumed_dispatch_id=?,resolution=?,
      claim_expires_at=NULL,last_error=NULL,resolved_at=?,updated_at=? WHERE id=? AND status='claimed' AND claim_token=?`,
    input.resumedDispatchId ?? null, JSON.stringify(input.resolution ?? {}), now, now, input.id, input.claimToken);
    if (changed === 0) throw new Error('Durable Hold 已被其他执行者唤醒');
    const hold = toHold(get<HoldRow>('SELECT * FROM runtime_holds WHERE id=?', input.id)!);
    afterCommit(() => emit({ type: 'runtime.hold.updated', hold }));
    return hold;
  });
}

export function releaseDurableHoldClaim(id: string, claimToken: string, error: string): RuntimeDurableHold | null {
  return tx(() => {
    const now = new Date().toISOString();
    const changed = run(`UPDATE runtime_holds SET status='open',claim_owner=NULL,claim_token=NULL,claim_expires_at=NULL,
      wake_event_id=NULL,last_error=?,updated_at=? WHERE id=? AND status='claimed' AND claim_token=?`,
    error, now, id, claimToken);
    if (changed === 0) return null;
    const hold = toHold(get<HoldRow>('SELECT * FROM runtime_holds WHERE id=?', id)!);
    afterCommit(() => emit({ type: 'runtime.hold.updated', hold }));
    return hold;
  });
}

export function cancelDurableHolds(runId: string, reason: string): number {
  return tx(() => {
    const rows = all<HoldRow>("SELECT * FROM runtime_holds WHERE run_id=? AND status IN ('open','claimed')", runId);
    if (rows.length === 0) return 0;
    const now = new Date().toISOString();
    run(`UPDATE runtime_holds SET status='cancelled',claim_expires_at=NULL,resolution=?,resolved_at=?,updated_at=?
      WHERE run_id=? AND status IN ('open','claimed')`, JSON.stringify({ reason }), now, now, runId);
    for (const row of rows) {
      const hold = toHold(get<HoldRow>('SELECT * FROM runtime_holds WHERE id=?', row.id)!);
      afterCommit(() => emit({ type: 'runtime.hold.updated', hold }));
    }
    return rows.length;
  });
}

export function cancelDurableHoldsByCondition(runId: string, kind: RuntimeDurableHoldCondition['kind'],
  sourceKey: string, reason: string): number {
  return tx(() => {
    const rows = all<HoldRow>("SELECT * FROM runtime_holds WHERE run_id=? AND status IN ('open','claimed')", runId)
      .filter((row) => {
        const condition = JSON.parse(row.condition) as RuntimeDurableHoldCondition;
        if (condition.kind !== kind) return false;
        if (condition.kind === 'user_decision') return condition.decisionId === sourceKey;
        if (condition.kind === 'approval') return condition.approvalId === sourceKey;
        if (condition.kind === 'event') return condition.eventKey === sourceKey;
        if (condition.kind === 'lease_recovery') return condition.attemptId === sourceKey;
        return row.id === sourceKey;
      });
    if (rows.length === 0) return 0;
    const now = new Date().toISOString();
    for (const row of rows) {
      run(`UPDATE runtime_holds SET status='cancelled',claim_expires_at=NULL,resolution=?,resolved_at=?,updated_at=?
        WHERE id=? AND status IN ('open','claimed')`, JSON.stringify({ reason }), now, now, row.id);
      const hold = toHold(get<HoldRow>('SELECT * FROM runtime_holds WHERE id=?', row.id)!);
      afterCommit(() => emit({ type: 'runtime.hold.updated', hold }));
    }
    return rows.length;
  });
}

export function listDurableHolds(runId: string): RuntimeDurableHold[] {
  return all<HoldRow>('SELECT * FROM runtime_holds WHERE run_id=? ORDER BY created_at,rowid', runId).map(toHold);
}

export function listRuntimeWakeEvents(runId: string): RuntimeWakeEvent[] {
  return all<WakeEventRow>('SELECT * FROM runtime_wake_events WHERE run_id=? ORDER BY created_at,rowid', runId).map(toWakeEvent);
}

export function getRuntimeWakeEvent(id: string): RuntimeWakeEvent | null {
  const row = get<WakeEventRow>('SELECT * FROM runtime_wake_events WHERE id=?', id);
  return row ? toWakeEvent(row) : null;
}

export function hasOpenDurableHold(runId: string, subjectId?: string): boolean {
  return Boolean(get(`SELECT 1 FROM runtime_holds WHERE run_id=? ${subjectId ? 'AND subject_id=?' : ''}
    AND status IN ('open','claimed') LIMIT 1`, runId, ...(subjectId ? [subjectId] : [])));
}

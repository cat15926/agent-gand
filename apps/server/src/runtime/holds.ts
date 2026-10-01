import { createHash, randomUUID } from 'node:crypto';
import type {
  RuntimeDurableHold,
  RuntimeDurableHoldCondition,
  RuntimeDurableHoldRecoveryPolicy,
  RuntimeDurableHoldTimeoutPolicy,
  RuntimeHoldRecoveryAudit,
  RuntimeHoldRecoveryErrorKind,
  RuntimeHoldRecoveryReasonCode,
  RuntimeWakeEvent,
  RuntimeWakeEventKind,
} from '@agent-gand/shared';
import { afterCommit, all, get, run, tx } from '../db/database.ts';
import { emit } from '../messaging/bus.ts';
import { loadRuntimeContract, resolveRunPolicy, runtimeStateAuthoritative, RuntimePolicyError } from './runPolicy.ts';

interface HoldRow {
  id: string; run_id: string; subject_id: string; source_dispatch_id: string | null; source_attempt_id: string | null;
  holder_agent_id: string; generation: number; version: number; condition: string; deadline_at: string | null;
  wake_at: string | null; timeout_at: string | null; on_timeout: string | null;
  retry_count: number; next_retry_at: string | null; max_retries: number;
  recovery_policy: string; status: RuntimeDurableHold['status']; idempotency_key: string;
  claim_owner: string | null; claim_token: string | null; claim_expires_at: string | null;
  wake_event_id: string | null; resumed_dispatch_id: string | null; resolution: string | null;
  last_error: string | null; last_error_code: RuntimeHoldRecoveryReasonCode | null;
  created_at: string; updated_at: string; resolved_at: string | null;
}

interface WakeEventRow {
  id: string; run_id: string; kind: RuntimeWakeEventKind; source_key: string;
  payload: string; idempotency_key: string; created_at: string;
}

interface AuditRow {
  id: string; run_id: string; subject_id: string; generation: number; hold_id: string;
  outcome: RuntimeHoldRecoveryAudit['outcome']; reason_code: RuntimeHoldRecoveryReasonCode;
  reason: string; details: string; created_at: string;
}

interface CustodyRow { state: string; holder_agent_id: string | null; generation: number; }

const CLAIM_LEASE_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;
const ACTIVE_RUN_STATUSES = new Set(['pending', 'running', 'awaiting_approval', 'waiting_for_user']);

export interface RuntimeExternalEventReceiver {
  id: string;
  payloadSchemaVersion: 1;
  validatePayload: (payload: Record<string, unknown>) => boolean;
}

const externalEventReceivers = new Map<string, RuntimeExternalEventReceiver>();

function nonEmptyBounded(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${label} 必须是 1～${max} 个字符`);
  return normalized;
}

function externalEventKey(receiverId: string, correlationId: string, generation: number): string {
  const digest = createHash('sha256').update(correlationId).digest('hex');
  return `registered:${receiverId}:g${generation}:${digest}`;
}

/** 只有服务端代码可注册可信接收器；该注册表不会通过 Agent Tool 或 HTTP 动态扩展。 */
export function registerRuntimeExternalEventReceiver(receiver: RuntimeExternalEventReceiver): void {
  const id = nonEmptyBounded(receiver.id, 'External Event receiverId', 100);
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) throw new Error('External Event receiverId 格式无效');
  if (externalEventReceivers.has(id)) throw new Error(`External Event receiver 已注册：${id}`);
  externalEventReceivers.set(id, { ...receiver, id });
}

export function registeredRuntimeExternalEventCondition(input: {
  receiverId: string;
  correlationId: string;
  generation: number;
}): RuntimeDurableHoldCondition {
  const receiverId = nonEmptyBounded(input.receiverId, 'External Event receiverId', 100);
  const correlationId = nonEmptyBounded(input.correlationId, 'External Event correlationId', 500);
  if (!externalEventReceivers.has(receiverId)) throw new Error(`External Event receiver 未注册：${receiverId}`);
  if (!Number.isInteger(input.generation) || input.generation < 1) throw new Error('External Event generation 无效');
  return { kind: 'event', receiverId, correlationId, generation: input.generation,
    eventKey: externalEventKey(receiverId, correlationId, input.generation) };
}

export class RuntimeHoldRecoveryError extends Error {
  constructor(
    readonly kind: RuntimeHoldRecoveryErrorKind,
    readonly code: RuntimeHoldRecoveryReasonCode,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeHoldRecoveryError';
  }
}

export function classifyRuntimeHoldRecoveryError(error: unknown): RuntimeHoldRecoveryError {
  if (error instanceof RuntimeHoldRecoveryError) return error;
  // tsx/worker 或包的双实例加载可能破坏 instanceof；保留类型化错误的结构语义。
  if (error && typeof error === 'object') {
    const typed = error as { name?: unknown; kind?: unknown; code?: unknown; message?: unknown };
    if (['transient', 'permanent', 'stale', 'terminal'].includes(String(typed.kind))
      && typeof typed.code === 'string' && typeof typed.message === 'string') {
      return new RuntimeHoldRecoveryError(typed.kind as RuntimeHoldRecoveryErrorKind,
        typed.code as RuntimeHoldRecoveryReasonCode, typed.message);
    }
  }
  if (error instanceof RuntimePolicyError) {
    return new RuntimeHoldRecoveryError('permanent', 'POLICY_INVALID', error.message);
  }
  return new RuntimeHoldRecoveryError('transient', 'RECOVERY_TRANSIENT',
    error instanceof Error ? error.message : String(error));
}

function parseJson<T>(value: string | null): T | null {
  return value === null ? null : JSON.parse(value) as T;
}

function toHold(row: HoldRow): RuntimeDurableHold {
  const condition = JSON.parse(row.condition) as RuntimeDurableHoldCondition;
  const legacyWakeAt = condition.kind === 'timer' ? condition.wakeAt
    : condition.kind === 'lease_recovery' ? condition.leaseExpiredAt : null;
  return {
    id: row.id, version: row.version === 2 ? 2 : 1, runId: row.run_id, subjectId: row.subject_id,
    sourceDispatchId: row.source_dispatch_id, sourceAttemptId: row.source_attempt_id,
    holderAgentId: row.holder_agent_id, generation: row.generation, condition,
    deadlineAt: row.deadline_at, wakeAt: row.wake_at ?? legacyWakeAt,
    timeoutAt: row.timeout_at, onTimeout: parseJson<RuntimeDurableHoldTimeoutPolicy>(row.on_timeout),
    retryCount: row.retry_count ?? 0, nextRetryAt: row.next_retry_at, maxRetries: row.max_retries ?? 5,
    recoveryPolicy: JSON.parse(row.recovery_policy) as RuntimeDurableHoldRecoveryPolicy,
    status: row.status, idempotencyKey: row.idempotency_key,
    claimOwner: row.claim_owner, claimToken: row.claim_token, claimExpiresAt: row.claim_expires_at,
    wakeEventId: row.wake_event_id, resumedDispatchId: row.resumed_dispatch_id,
    resolution: parseJson<Record<string, unknown>>(row.resolution), lastError: row.last_error,
    lastErrorCode: row.last_error_code, createdAt: row.created_at, updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

function toWakeEvent(row: WakeEventRow): RuntimeWakeEvent {
  return {
    id: row.id, runId: row.run_id, kind: row.kind, sourceKey: row.source_key,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    idempotencyKey: row.idempotency_key, createdAt: row.created_at,
  };
}

function toAudit(row: AuditRow): RuntimeHoldRecoveryAudit {
  return {
    id: row.id, runId: row.run_id, subjectId: row.subject_id, generation: row.generation,
    holdId: row.hold_id, outcome: row.outcome, reasonCode: row.reason_code, reason: row.reason,
    details: JSON.parse(row.details) as Record<string, unknown>, createdAt: row.created_at,
  };
}

function normalizeTimestamp(value: string | null | undefined, label: string): string | null {
  if (value == null) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) throw new Error(`Durable Hold ${label} 无效`);
  return new Date(time).toISOString();
}

function beforeOrEqual(left: string, right: string): boolean {
  return new Date(left).getTime() <= new Date(right).getTime();
}

function defaultWakeAt(condition: RuntimeDurableHoldCondition): string | null {
  return condition.kind === 'timer' ? condition.wakeAt
    : condition.kind === 'lease_recovery' ? condition.leaseExpiredAt : null;
}

function earliestTimestamp(...values: Array<string | null>): string | null {
  return values.filter((value): value is string => value !== null)
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0] ?? null;
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
  if (condition.kind === 'event') {
    if (!condition.eventKey.trim()) throw new Error('Durable Hold 事件键不能为空');
    const registered = condition.receiverId !== undefined || condition.correlationId !== undefined
      || condition.generation !== undefined;
    if (!registered) return;
    if (!condition.receiverId || !condition.correlationId || !Number.isInteger(condition.generation)
      || Number(condition.generation) < 1 || !externalEventReceivers.has(condition.receiverId)
      || condition.eventKey !== externalEventKey(condition.receiverId, condition.correlationId, condition.generation!)) {
      throw new Error('Durable Hold 注册事件条件无效或接收器未注册');
    }
  }
}

function recordRecoveryAudit(input: {
  hold: RuntimeDurableHold;
  outcome: RuntimeHoldRecoveryAudit['outcome'];
  reasonCode: RuntimeHoldRecoveryReasonCode;
  reason: string;
  details?: Record<string, unknown>;
  createdAt?: string;
}): RuntimeHoldRecoveryAudit {
  const id = randomUUID(); const createdAt = input.createdAt ?? new Date().toISOString();
  run(`INSERT INTO runtime_hold_recovery_audit
    (id,run_id,subject_id,generation,hold_id,outcome,reason_code,reason,details,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, id, input.hold.runId, input.hold.subjectId, input.hold.generation,
  input.hold.id, input.outcome, input.reasonCode, input.reason, JSON.stringify(input.details ?? {}), createdAt);
  const audit = toAudit(get<AuditRow>('SELECT * FROM runtime_hold_recovery_audit WHERE id=?', id)!);
  afterCommit(() => emit({ type: 'runtime.hold_recovery.recorded', audit }));
  return audit;
}

export function runtimeDurableHoldVersion(runId: string): 1 | 2 | null {
  const version = loadRuntimeContract(runId)?.features?.durableHoldVersion;
  return version === 1 || version === 2 ? version : null;
}

export function runtimeExternalWaitVersion(runId: string): 1 | null {
  return loadRuntimeContract(runId)?.features?.externalWaitVersion === 1 ? 1 : null;
}

/** 把模型可见的成员 ID 解析成同 Run 的唯一 Subject；Subject ID 不进入模型参数。 */
export function resolveRunDependencySubjectIds(input: {
  runId: string;
  requesterSubjectId: string;
  targetAgentIds: string[];
}): string[] {
  if (runtimeExternalWaitVersion(input.runId) !== 1) throw new Error('当前 Run 未冻结 External Wait v1');
  const targets = [...new Set(input.targetAgentIds.map((item) => item.trim()))].filter(Boolean);
  if (targets.length === 0 || targets.length !== input.targetAgentIds.length) {
    throw new Error('Dependency Hold 的目标成员为空或重复');
  }
  return targets.map((agentId) => {
    const rows = all<{ id: string }>(`SELECT DISTINCT s.id FROM runtime_subjects s
      JOIN runtime_custody c ON c.subject_id=s.id
      LEFT JOIN runtime_dispatch_subjects m ON m.subject_id=s.id
      LEFT JOIN collaboration_dispatches d ON d.id=m.dispatch_id
      WHERE s.run_id=? AND s.id<>? AND
        (c.holder_agent_id=? OR c.pending_holder_agent_id=? OR (d.target_agent_id=? AND d.status IN ('queued','running')))`,
    input.runId, input.requesterSubjectId, agentId, agentId, agentId);
    if (rows.length === 0) throw new Error(`Dependency Hold 找不到成员 ${agentId} 的同 Run Subject`);
    if (rows.length > 1) throw new Error(`Dependency Hold 无法唯一确定成员 ${agentId} 的 Subject`);
    return rows[0]!.id;
  });
}

export function createDurableHold(input: {
  runId: string;
  subjectId?: string;
  sourceDispatchId?: string | null;
  sourceAttemptId?: string | null;
  holderAgentId: string;
  expectedGeneration?: number;
  condition: RuntimeDurableHoldCondition;
  /** v1 兼容字段。v2 应分别设置 wakeAt 与 timeoutAt。 */
  deadlineAt?: string | null;
  wakeAt?: string | null;
  timeoutAt?: string | null;
  onTimeout?: RuntimeDurableHoldTimeoutPolicy | null;
  maxRetries?: number;
  recoveryPolicy: RuntimeDurableHoldRecoveryPolicy;
  idempotencyKey: string;
}): RuntimeDurableHold {
  return tx(() => {
    const subjectId = input.subjectId ?? (input.sourceDispatchId
      ? get<{ subject_id: string }>('SELECT subject_id FROM runtime_dispatch_subjects WHERE dispatch_id=?', input.sourceDispatchId)?.subject_id
      : undefined);
    if (!subjectId) throw new Error('Durable Hold 缺少 Subject');
    const version = runtimeDurableHoldVersion(input.runId) ?? 1;
    const encodedCondition = JSON.stringify(input.condition);
    const encodedPolicy = JSON.stringify(input.recoveryPolicy);
    const wakeAt = normalizeTimestamp(input.wakeAt ?? defaultWakeAt(input.condition), 'wakeAt');
    const timeoutAt = normalizeTimestamp(input.timeoutAt, 'timeoutAt');
    const deadlineAt = normalizeTimestamp(input.deadlineAt, 'deadlineAt')
      ?? (version === 1 ? wakeAt : earliestTimestamp(wakeAt, timeoutAt));
    const onTimeout = timeoutAt ? input.onTimeout ?? { kind: 'fail' as const } : null;
    if (input.onTimeout && !timeoutAt) throw new Error('Durable Hold onTimeout 必须与 timeoutAt 一起设置');
    if (wakeAt && timeoutAt && new Date(timeoutAt).getTime() < new Date(wakeAt).getTime()
      && (input.condition.kind === 'timer' || input.condition.kind === 'lease_recovery')) {
      throw new Error('Durable Hold timeoutAt 不能早于计划 wakeAt');
    }
    const maxRetries = input.maxRetries ?? 5;
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 100) {
      throw new Error('Durable Hold maxRetries 必须是 0～100 的整数');
    }
    const encodedTimeout = onTimeout ? JSON.stringify(onTimeout) : null;
    const existing = get<HoldRow>('SELECT * FROM runtime_holds WHERE idempotency_key=?', input.idempotencyKey);
    if (existing) {
      if (existing.run_id !== input.runId || existing.subject_id !== subjectId
        || existing.holder_agent_id !== input.holderAgentId || existing.condition !== encodedCondition
        || existing.recovery_policy !== encodedPolicy || existing.deadline_at !== deadlineAt
        || existing.wake_at !== (version === 2 ? wakeAt : null)
        || existing.timeout_at !== (version === 2 ? timeoutAt : null)
        || existing.on_timeout !== (version === 2 ? encodedTimeout : null)
        || (existing.max_retries ?? 5) !== maxRetries) {
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
       deadline_at,wake_at,timeout_at,on_timeout,retry_count,next_retry_at,max_retries,recovery_policy,status,
       idempotency_key,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,?,?,'open',?,?,?)`,
    id, input.runId, subjectId, input.sourceDispatchId ?? null, input.sourceAttemptId ?? null,
    input.holderAgentId, custody.generation, version, encodedCondition, deadlineAt,
    version === 2 ? wakeAt : null, version === 2 ? timeoutAt : null, version === 2 ? encodedTimeout : null,
    maxRetries, encodedPolicy, input.idempotencyKey, now, now);
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

/** 可信接收器入口：固定 Run 作用域、correlation/generation、来源事件去重和 payload schema。 */
export function recordRegisteredRuntimeExternalEvent(input: {
  receiverId: string;
  runId: string;
  correlationId: string;
  generation: number;
  sourceEventId: string;
  payload: Record<string, unknown>;
}): RuntimeWakeEvent {
  const receiverId = nonEmptyBounded(input.receiverId, 'External Event receiverId', 100);
  const correlationId = nonEmptyBounded(input.correlationId, 'External Event correlationId', 500);
  const sourceEventId = nonEmptyBounded(input.sourceEventId, 'External Event sourceEventId', 200);
  const receiver = externalEventReceivers.get(receiverId);
  if (!receiver) throw new Error(`External Event receiver 未注册：${receiverId}`);
  if (!Number.isInteger(input.generation) || input.generation < 1) throw new Error('External Event generation 无效');
  if (!get('SELECT 1 FROM runs WHERE id=?', input.runId)) throw new Error('External Event Run 不存在');
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)
    || JSON.stringify(input.payload).length > 16_384 || !receiver.validatePayload(input.payload)) {
    throw new Error(`External Event payload 不符合 ${receiverId} schema v${receiver.payloadSchemaVersion}`);
  }
  const sourceKey = externalEventKey(receiverId, correlationId, input.generation);
  const sourceDigest = createHash('sha256').update(sourceEventId).digest('hex');
  return recordRuntimeWakeEvent({ runId: input.runId, kind: 'event', sourceKey,
    payload: { receiverId, correlationId, generation: input.generation, sourceEventId,
      payloadSchemaVersion: receiver.payloadSchemaVersion, data: input.payload },
    idempotencyKey: `external:${receiverId}:${sourceDigest}` });
}

type HoldReadiness =
  | { kind: 'waiting' }
  | { kind: 'ready'; event: RuntimeWakeEvent; reason: string }
  | { kind: 'close'; status: 'failed' | 'cancelled'; code: RuntimeHoldRecoveryReasonCode; reason: string };

function matchingExternalEvent(hold: RuntimeDurableHold): RuntimeWakeEvent | null {
  const condition = hold.condition;
  if (!['user_decision', 'approval', 'event'].includes(condition.kind)) return null;
  const sourceKey = condition.kind === 'user_decision' ? condition.decisionId
    : condition.kind === 'approval' ? condition.approvalId
      : condition.kind === 'event' ? condition.eventKey : '';
  const row = get<WakeEventRow>(`SELECT * FROM runtime_wake_events
    WHERE run_id=? AND kind=? AND source_key=? ${hold.timeoutAt ? 'AND created_at<=?' : ''}
    ORDER BY created_at,rowid LIMIT 1`, hold.runId, condition.kind, sourceKey,
  ...(hold.timeoutAt ? [hold.timeoutAt] : []));
  return row ? toWakeEvent(row) : null;
}

function timeoutReadiness(hold: RuntimeDurableHold, now: string): HoldReadiness {
  if (!hold.timeoutAt || !beforeOrEqual(hold.timeoutAt, now)) return { kind: 'waiting' };
  const policy = hold.onTimeout ?? { kind: 'fail' as const };
  const reason = policy.reason ?? `Durable Hold 在 ${hold.timeoutAt} 超时`;
  if (policy.kind === 'wake') {
    const event = recordRuntimeWakeEvent({ runId: hold.runId, kind: 'timeout', sourceKey: hold.id,
      payload: { timeoutAt: hold.timeoutAt, ...(policy.payload ?? {}) }, idempotencyKey: `timeout:${hold.id}` });
    return { kind: 'ready', event, reason };
  }
  return { kind: 'close', status: policy.kind === 'cancel' ? 'cancelled' : 'failed', code: 'HOLD_TIMEOUT', reason };
}

function holdReadiness(hold: RuntimeDurableHold, now: string): HoldReadiness {
  const condition = hold.condition;
  const external = matchingExternalEvent(hold);
  if (external) return { kind: 'ready', event: external, reason: '匹配的外部事件已持久化' };

  if (condition.kind === 'timer') {
    const semanticWakeAt = hold.wakeAt ?? condition.wakeAt;
    if (beforeOrEqual(semanticWakeAt, now)
      && (!hold.timeoutAt || beforeOrEqual(semanticWakeAt, hold.timeoutAt))) {
      return { kind: 'ready', event: recordRuntimeWakeEvent({ runId: hold.runId, kind: 'timer', sourceKey: hold.id,
        payload: { wakeAt: semanticWakeAt }, idempotencyKey: `timer:${hold.id}` }), reason: '计划唤醒时间已到' };
    }
  } else if (condition.kind === 'dependency') {
    const subjects = all<{ id: string; status: string; updated_at: string }>(`SELECT id,status,updated_at FROM runtime_subjects
      WHERE run_id=? AND id IN (${condition.subjectIds.map(() => '?').join(',')})`, hold.runId, ...condition.subjectIds);
    const timeoutAt = hold.timeoutAt;
    const effective = timeoutAt ? subjects.filter((subject) => beforeOrEqual(subject.updated_at, timeoutAt)) : subjects;
    const completed = effective.filter((subject) => subject.status === 'completed').length;
    const ready = condition.policy === 'all' ? completed === condition.subjectIds.length : completed > 0;
    if (ready) {
      return { kind: 'ready', event: recordRuntimeWakeEvent({ runId: hold.runId, kind: 'dependency', sourceKey: hold.id,
        payload: { subjectIds: condition.subjectIds, policy: condition.policy }, idempotencyKey: `dependency:${hold.id}` }),
      reason: '依赖 Subject 已满足' };
    }
    const failed = effective.filter((subject) => subject.status === 'failed').length;
    const cancelled = effective.filter((subject) => subject.status === 'cancelled').length;
    const allTerminal = effective.length === condition.subjectIds.length
      && effective.every((subject) => ['completed', 'failed', 'cancelled'].includes(subject.status));
    const cannotSatisfy = condition.policy === 'all' ? failed + cancelled > 0 : allTerminal && completed === 0;
    if (cannotSatisfy) {
      return failed > 0
        ? { kind: 'close', status: 'failed', code: 'DEPENDENCY_FAILED', reason: `${failed} 个依赖 Subject 失败` }
        : { kind: 'close', status: 'cancelled', code: 'DEPENDENCY_CANCELLED', reason: `${cancelled} 个依赖 Subject 已取消` };
    }
  } else if (condition.kind === 'lease_recovery') {
    const attempt = get<{ status: string }>('SELECT status FROM collaboration_attempts WHERE id=? AND run_id=?',
      condition.attemptId, hold.runId);
    const semanticWakeAt = hold.wakeAt ?? condition.leaseExpiredAt;
    if (attempt?.status === 'interrupted' && beforeOrEqual(semanticWakeAt, now)
      && (!hold.timeoutAt || beforeOrEqual(semanticWakeAt, hold.timeoutAt))) {
      return { kind: 'ready', event: recordRuntimeWakeEvent({ runId: hold.runId, kind: 'lease_recovery',
        sourceKey: condition.attemptId, payload: { leaseExpiredAt: semanticWakeAt },
        idempotencyKey: `lease-recovery:${condition.attemptId}` }), reason: 'Attempt 租约已过期且处于 interrupted' };
    }
  }
  return timeoutReadiness(hold, now);
}

function closeHold(row: HoldRow, status: 'failed' | 'cancelled', code: RuntimeHoldRecoveryReasonCode,
  reason: string, now: string, details: Record<string, unknown> = {}): RuntimeDurableHold | null {
  const changed = run(`UPDATE runtime_holds SET status=?,claim_owner=NULL,claim_token=NULL,claim_expires_at=NULL,
    next_retry_at=NULL,last_error=?,last_error_code=?,resolution=?,resolved_at=?,updated_at=?
    WHERE id=? AND status IN ('open','claimed')`, status, reason, code,
  JSON.stringify({ reason, reasonCode: code, ...details }), now, now, row.id);
  if (changed === 0) return null;
  const hold = toHold(get<HoldRow>('SELECT * FROM runtime_holds WHERE id=?', row.id)!);
  recordRecoveryAudit({ hold, outcome: status, reasonCode: code, reason, details, createdAt: now });
  afterCommit(() => emit({ type: 'runtime.hold.updated', hold }));
  return hold;
}

function custodyIsCurrent(row: HoldRow): boolean {
  const custody = get<CustodyRow>('SELECT state,holder_agent_id,generation FROM runtime_custody WHERE subject_id=?', row.subject_id);
  return Boolean(custody && ['owned', 'waiting'].includes(custody.state)
    && custody.holder_agent_id === row.holder_agent_id && custody.generation === row.generation);
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
        AND (h.next_retry_at IS NULL OR h.next_retry_at<=?)
        AND r.status IN ('pending','running','awaiting_approval','waiting_for_user')
        ${input.runId ? 'AND h.run_id=?' : ''}
      ORDER BY CASE WHEN COALESCE(h.wake_at,h.timeout_at,h.deadline_at) IS NULL THEN 1 ELSE 0 END,
        COALESCE(h.wake_at,h.timeout_at,h.deadline_at),h.created_at,h.rowid`,
    now, now, ...(input.runId ? [input.runId] : []));
    const claimed: RuntimeDurableHold[] = [];
    for (const row of rows) {
      if (claimed.length >= (input.limit ?? 32)) break;
      const current = toHold(row);
      try {
        if (!runtimeStateAuthoritative(resolveRunPolicy(row.run_id))) continue;
      } catch (error) {
        const classified = classifyRuntimeHoldRecoveryError(error);
        closeHold(row, 'failed', classified.code, classified.message, now);
        continue;
      }
      if (!custodyIsCurrent(row)) {
        closeHold(row, 'failed', 'STALE_GENERATION', 'Durable Hold 的责任代际已失效', now,
          { holderAgentId: row.holder_agent_id, generation: row.generation });
        continue;
      }
      if (row.status === 'claimed') {
        recordRecoveryAudit({ hold: current, outcome: 'retry_scheduled', reasonCode: 'CLAIM_LEASE_EXPIRED',
          reason: '上一个恢复执行者的 claim 租约已过期', createdAt: now,
          details: { previousClaimOwner: row.claim_owner, previousClaimExpiresAt: row.claim_expires_at } });
      }
      const readiness = holdReadiness(current, now);
      if (readiness.kind === 'waiting') continue;
      if (readiness.kind === 'close') {
        closeHold(row, readiness.status, readiness.code, readiness.reason, now);
        continue;
      }
      const claimToken = randomUUID();
      const claimExpiresAt = new Date(new Date(now).getTime() + CLAIM_LEASE_MS).toISOString();
      const changed = run(`UPDATE runtime_holds SET status='claimed',claim_owner=?,claim_token=?,claim_expires_at=?,
        wake_event_id=?,last_error=NULL,last_error_code=NULL,updated_at=? WHERE id=?
        AND (status='open' OR (status='claimed' AND claim_expires_at<=?))`,
      input.claimOwner, claimToken, claimExpiresAt, readiness.event.id, now, current.id, now);
      if (changed === 0) continue;
      const hold = toHold(get<HoldRow>('SELECT * FROM runtime_holds WHERE id=?', current.id)!);
      recordRecoveryAudit({ hold, outcome: 'claimed', reasonCode: 'WAKE_EVENT_READY', reason: readiness.reason,
        createdAt: now, details: { wakeEventId: readiness.event.id, claimOwner: input.claimOwner } });
      claimed.push(hold); afterCommit(() => emit({ type: 'runtime.hold.updated', hold }));
    }
    return claimed;
  });
}

export function assertDurableHoldClaim(id: string, claimToken: string, now = new Date().toISOString()): RuntimeDurableHold {
  const row = get<HoldRow>('SELECT * FROM runtime_holds WHERE id=?', id);
  if (!row || row.status !== 'claimed' || row.claim_token !== claimToken || !row.claim_expires_at || row.claim_expires_at <= now) {
    throw new RuntimeHoldRecoveryError('transient', 'CLAIM_LOST', 'Durable Hold claim 已失效');
  }
  const runRow = get<{ status: string }>('SELECT status FROM runs WHERE id=?', row.run_id);
  if (!runRow || !ACTIVE_RUN_STATUSES.has(runRow.status)) {
    throw new RuntimeHoldRecoveryError('terminal', 'RUN_TERMINAL', 'Durable Hold 所属 Run 已终结');
  }
  if (!custodyIsCurrent(row)) {
    throw new RuntimeHoldRecoveryError('stale', 'STALE_GENERATION', 'Durable Hold 的责任代际已失效');
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
      claim_owner=NULL,claim_token=NULL,claim_expires_at=NULL,next_retry_at=NULL,last_error=NULL,last_error_code=NULL,
      resolved_at=?,updated_at=? WHERE id=? AND status='claimed' AND claim_token=?`,
    input.resumedDispatchId ?? null, JSON.stringify(input.resolution ?? {}), now, now, input.id, input.claimToken);
    if (changed === 0) throw new RuntimeHoldRecoveryError('transient', 'CLAIM_LOST', 'Durable Hold 已被其他执行者唤醒');
    const hold = toHold(get<HoldRow>('SELECT * FROM runtime_holds WHERE id=?', input.id)!);
    recordRecoveryAudit({ hold, outcome: 'resumed', reasonCode: 'RECOVERY_SUCCEEDED', reason: 'Hold 恢复事务已提交',
      details: { resumedDispatchId: input.resumedDispatchId ?? null }, createdAt: now });
    afterCommit(() => emit({ type: 'runtime.hold.updated', hold }));
    return hold;
  });
}

export function releaseDurableHoldClaim(id: string, claimToken: string, error: unknown,
  now = new Date().toISOString()): RuntimeDurableHold | null {
  return tx(() => {
    const row = get<HoldRow>('SELECT * FROM runtime_holds WHERE id=?', id);
    if (!row || row.status !== 'claimed' || row.claim_token !== claimToken) return null;
    const classified = classifyRuntimeHoldRecoveryError(error);
    if (classified.kind !== 'transient') {
      return closeHold(row, classified.kind === 'terminal' ? 'cancelled' : 'failed', classified.code,
        classified.message, now, { errorKind: classified.kind });
    }
    const retryCount = (row.retry_count ?? 0) + 1;
    const maxRetries = row.max_retries ?? 5;
    if (retryCount > maxRetries) {
      return closeHold(row, 'failed', 'RETRY_EXHAUSTED',
        `Durable Hold 恢复已超过 ${maxRetries} 次重试：${classified.message}`, now,
        { retryCount, maxRetries, lastErrorCode: classified.code });
    }
    const delay = row.version === 2 ? Math.min(MAX_BACKOFF_MS, 1_000 * (2 ** Math.max(0, retryCount - 1))) : 0;
    const nextRetryAt = new Date(new Date(now).getTime() + delay).toISOString();
    const changed = run(`UPDATE runtime_holds SET status='open',claim_owner=NULL,claim_token=NULL,claim_expires_at=NULL,
      wake_event_id=NULL,retry_count=?,next_retry_at=?,last_error=?,last_error_code=?,updated_at=?
      WHERE id=? AND status='claimed' AND claim_token=?`, retryCount, nextRetryAt,
    classified.message, classified.code, now, id, claimToken);
    if (changed === 0) return null;
    const hold = toHold(get<HoldRow>('SELECT * FROM runtime_holds WHERE id=?', id)!);
    recordRecoveryAudit({ hold, outcome: 'retry_scheduled', reasonCode: 'RETRY_SCHEDULED',
      reason: classified.message, details: { retryCount, maxRetries, nextRetryAt, errorCode: classified.code }, createdAt: now });
    afterCommit(() => emit({ type: 'runtime.hold.updated', hold }));
    return hold;
  });
}

export function cancelDurableHolds(runId: string, reason: string,
  reasonCode: RuntimeHoldRecoveryReasonCode = 'CANCELLED'): number {
  return tx(() => {
    const rows = all<HoldRow>("SELECT * FROM runtime_holds WHERE run_id=? AND status IN ('open','claimed')", runId);
    const now = new Date().toISOString();
    for (const row of rows) closeHold(row, 'cancelled', reasonCode, reason, now);
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
    const now = new Date().toISOString();
    for (const row of rows) closeHold(row, 'cancelled', 'CANCELLED', reason, now, { conditionKind: kind, sourceKey });
    return rows.length;
  });
}

export function listDurableHolds(runId: string): RuntimeDurableHold[] {
  return all<HoldRow>('SELECT * FROM runtime_holds WHERE run_id=? ORDER BY created_at,rowid', runId).map(toHold);
}

export function listRuntimeWakeEvents(runId: string): RuntimeWakeEvent[] {
  return all<WakeEventRow>('SELECT * FROM runtime_wake_events WHERE run_id=? ORDER BY created_at,rowid', runId).map(toWakeEvent);
}

export function listRuntimeHoldRecoveryAudits(runId: string): RuntimeHoldRecoveryAudit[] {
  return all<AuditRow>('SELECT * FROM runtime_hold_recovery_audit WHERE run_id=? ORDER BY created_at,rowid', runId).map(toAudit);
}

export function getRuntimeWakeEvent(id: string): RuntimeWakeEvent | null {
  const row = get<WakeEventRow>('SELECT * FROM runtime_wake_events WHERE id=?', id);
  return row ? toWakeEvent(row) : null;
}

export function hasOpenDurableHold(runId: string, subjectId?: string): boolean {
  return Boolean(get(`SELECT 1 FROM runtime_holds WHERE run_id=? ${subjectId ? 'AND subject_id=?' : ''}
    AND status IN ('open','claimed') LIMIT 1`, runId, ...(subjectId ? [subjectId] : [])));
}

import { createHash, randomUUID } from 'node:crypto';
import type {
  CollaborationAttempt,
  CollaborationBatch,
  CollaborationBatchStatus,
  CollaborationBudgetLimits,
  CollaborationBudgetRevision,
  CollaborationBudgetSnapshot,
  CollaborationControlAction,
  CollaborationDecisionKind,
  CollaborationDecisionStatus,
  CollaborationDispatch,
  CollaborationDispatchKind,
  CollaborationDispatchStatus,
  CollaborationUserDecision,
} from '@agent-gand/shared';
import { all, get, run, tx } from '../db/database.ts';
import { emit } from '../messaging/bus.ts';
import { config } from '../config.ts';
import { READONLY_TOOLS } from '../tools/types.ts';

interface DispatchRow {
  id: string; run_id: string; conversation_id: string; source_message_id: string;
  parent_dispatch_id: string | null; batch_id: string | null; kind: string; from_actor: string;
  target_agent_id: string; reason: string | null; status: string; priority: string; depth: number;
  idempotency_key: string; content_hash: string | null; output_message_id: string | null; error: string | null;
  created_at: string; started_at: string | null; finished_at: string | null;
}
interface AttemptRow {
  id: string; dispatch_id: string; run_id: string; conversation_id: string; agent_id: string;
  attempt_no: number; status: string; input_context: string | null; output: string | null;
  control_action: string | null; deduplicated_to: string | null; error: string | null; lease_owner: string | null;
  lease_expires_at: string | null; created_at: string; started_at: string | null; ended_at: string | null;
}
interface BatchRow {
  id: string; run_id: string; conversation_id: string; initiator_agent_id: string;
  source_dispatch_id: string; question: string; target_agent_ids: string; result_dispatch_id: string | null;
  status: string; timeout_at: string; created_at: string; completed_at: string | null;
}
interface DecisionRow {
  id: string; run_id: string; conversation_id: string; dispatch_id: string | null;
  idempotency_key: string; kind: string; status: string; prompt_message_id: string;
  payload: string; resolution: string | null; linked_run_id: string | null;
  created_at: string; resolved_at: string | null;
}
interface BudgetRevisionRow {
  id: string; run_id: string; decision_id: string; increase_percent: number;
  previous_limits: string; new_limits: string; created_at: string;
}

const toDispatch = (r: DispatchRow): CollaborationDispatch => ({
  id: r.id, runId: r.run_id, conversationId: r.conversation_id, sourceMessageId: r.source_message_id,
  parentDispatchId: r.parent_dispatch_id, batchId: r.batch_id, kind: r.kind as CollaborationDispatchKind,
  from: r.from_actor, targetAgentId: r.target_agent_id, reason: r.reason,
  status: r.status as CollaborationDispatchStatus, priority: r.priority as 'urgent' | 'normal', depth: r.depth,
  idempotencyKey: r.idempotency_key, outputMessageId: r.output_message_id, error: r.error,
  createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
});
const toAttempt = (r: AttemptRow): CollaborationAttempt => ({
  id: r.id, dispatchId: r.dispatch_id, runId: r.run_id, conversationId: r.conversation_id,
  agentId: r.agent_id, attemptNo: r.attempt_no, status: r.status as CollaborationAttempt['status'],
  inputContext: r.input_context, output: r.output,
  controlAction: r.control_action ? JSON.parse(r.control_action) as CollaborationControlAction : null,
  deduplicatedTo: r.deduplicated_to, error: r.error, leaseOwner: r.lease_owner, leaseExpiresAt: r.lease_expires_at,
  createdAt: r.created_at, startedAt: r.started_at, endedAt: r.ended_at,
});
const toBatch = (r: BatchRow): CollaborationBatch => ({
  id: r.id, runId: r.run_id, conversationId: r.conversation_id, initiatorAgentId: r.initiator_agent_id,
  sourceDispatchId: r.source_dispatch_id, question: r.question,
  targetAgentIds: JSON.parse(r.target_agent_ids) as string[], resultDispatchId: r.result_dispatch_id,
  status: r.status as CollaborationBatchStatus, timeoutAt: r.timeout_at,
  createdAt: r.created_at, completedAt: r.completed_at,
});
const toDecision = (r: DecisionRow): CollaborationUserDecision => ({
  id: r.id, runId: r.run_id, conversationId: r.conversation_id, dispatchId: r.dispatch_id,
  idempotencyKey: r.idempotency_key, kind: r.kind as CollaborationDecisionKind,
  status: r.status as CollaborationDecisionStatus, promptMessageId: r.prompt_message_id,
  payload: JSON.parse(r.payload) as Record<string, unknown>,
  resolution: r.resolution ? JSON.parse(r.resolution) as Record<string, unknown> : null,
  linkedRunId: r.linked_run_id, createdAt: r.created_at, resolvedAt: r.resolved_at,
});
const toRevision = (r: BudgetRevisionRow): CollaborationBudgetRevision => ({
  id: r.id, runId: r.run_id, decisionId: r.decision_id, increasePercent: r.increase_percent,
  previousLimits: JSON.parse(r.previous_limits) as CollaborationBudgetLimits,
  newLimits: JSON.parse(r.new_limits) as CollaborationBudgetLimits, createdAt: r.created_at,
});

export interface CreateDispatchInput {
  runId: string; conversationId: string; sourceMessageId: string; parentDispatchId?: string | null;
  batchId?: string | null; kind: CollaborationDispatchKind; from: string; targetAgentId: string;
  reason?: string | null; priority?: 'urgent' | 'normal'; depth: number; idempotencyKey: string;
  dedupeText?: string | null;
}

export interface CreateDispatchResult {
  dispatch: CollaborationDispatch;
  created: boolean;
  deduplicatedTo: string | null;
}

function normalizedContentHash(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/gu, ' ');
  return normalized ? createHash('sha256').update(normalized).digest('hex') : null;
}

export function createDispatchDetailed(input: CreateDispatchInput): CreateDispatchResult {
  const existing = get<DispatchRow>('SELECT * FROM collaboration_dispatches WHERE run_id=? AND idempotency_key=?', input.runId, input.idempotencyKey);
  if (existing) return { dispatch: toDispatch(existing), created: false, deduplicatedTo: existing.id };
  const contentHash = normalizedContentHash(input.dedupeText);
  if (contentHash) {
    const duplicate = get<DispatchRow>(`SELECT * FROM collaboration_dispatches
      WHERE run_id=? AND parent_dispatch_id IS ? AND target_agent_id=? AND content_hash=? AND status IN ('queued','running')
      ORDER BY created_at,rowid LIMIT 1`, input.runId, input.parentDispatchId ?? null, input.targetAgentId, contentHash);
    if (duplicate) return { dispatch: toDispatch(duplicate), created: false, deduplicatedTo: duplicate.id };
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  run(`INSERT INTO collaboration_dispatches
    (id,run_id,conversation_id,source_message_id,parent_dispatch_id,batch_id,kind,from_actor,target_agent_id,reason,status,priority,depth,idempotency_key,content_hash,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'queued', ?,?,?,?,?)`,
    id, input.runId, input.conversationId, input.sourceMessageId, input.parentDispatchId ?? null,
    input.batchId ?? null, input.kind, input.from, input.targetAgentId, input.reason ?? null,
    input.priority ?? 'normal', input.depth, input.idempotencyKey, contentHash, now);
  const value = toDispatch(get<DispatchRow>('SELECT * FROM collaboration_dispatches WHERE id=?', id)!);
  emit({ type: 'collaboration.dispatch.updated', dispatch: value });
  return { dispatch: value, created: true, deduplicatedTo: null };
}

export function createDispatch(input: CreateDispatchInput): CollaborationDispatch {
  return createDispatchDetailed(input).dispatch;
}

export function getDispatch(id: string): CollaborationDispatch | undefined {
  const row = get<DispatchRow>('SELECT * FROM collaboration_dispatches WHERE id=?', id);
  return row ? toDispatch(row) : undefined;
}
export function listDispatches(runId: string): CollaborationDispatch[] {
  return all<DispatchRow>('SELECT * FROM collaboration_dispatches WHERE run_id=? ORDER BY created_at,rowid', runId).map(toDispatch);
}
export function listConversationDispatches(conversationId: string): CollaborationDispatch[] {
  return all<DispatchRow>('SELECT * FROM collaboration_dispatches WHERE conversation_id=? ORDER BY created_at,rowid', conversationId).map(toDispatch);
}

export function claimNextDispatch(conversationId: string, leaseOwner: string): { dispatch: CollaborationDispatch; attempt: CollaborationAttempt } | null {
  const claimed = tx(() => {
    const globalRunning = get<{ n: number }>("SELECT COUNT(*) n FROM collaboration_attempts WHERE status='running'")?.n ?? 0;
    if (globalRunning >= config.collaboration.maxConcurrency) return null;
    const row = get<DispatchRow>(`SELECT d.* FROM collaboration_dispatches d
      JOIN runs r ON r.id=d.run_id
      WHERE d.conversation_id=? AND d.status='queued' AND r.status='running'
        AND NOT EXISTS (SELECT 1 FROM collaboration_attempts a WHERE a.conversation_id=d.conversation_id AND a.agent_id=d.target_agent_id AND a.status='running')
        AND (SELECT COUNT(*) FROM collaboration_attempts prior WHERE prior.dispatch_id=d.id) < ?
      ORDER BY CASE d.priority WHEN 'urgent' THEN 0 ELSE 1 END, r.turn_no, d.depth, d.created_at, d.rowid LIMIT 1`, conversationId, config.collaboration.maxAttempts);
    if (!row) return null;
    const now = new Date();
    const changed = run("UPDATE collaboration_dispatches SET status='running',started_at=? WHERE id=? AND status='queued'", now.toISOString(), row.id);
    if (changed === 0) return null;
    const attemptNo = (get<{ n: number }>('SELECT COALESCE(MAX(attempt_no),0)+1 n FROM collaboration_attempts WHERE dispatch_id=?', row.id)?.n ?? 1);
    const attemptId = randomUUID();
    run(`INSERT INTO collaboration_attempts
      (id,dispatch_id,run_id,conversation_id,agent_id,attempt_no,status,lease_owner,lease_expires_at,created_at,started_at)
      VALUES (?,?,?,?,?,?,'running',?,?,?,?)`, attemptId, row.id, row.run_id, row.conversation_id,
      row.target_agent_id, attemptNo, leaseOwner, new Date(now.getTime() + config.collaboration.attemptLeaseMs).toISOString(), now.toISOString(), now.toISOString());
    return {
      dispatch: toDispatch(get<DispatchRow>('SELECT * FROM collaboration_dispatches WHERE id=?', row.id)!),
      attempt: toAttempt(get<AttemptRow>('SELECT * FROM collaboration_attempts WHERE id=?', attemptId)!),
    };
  });
  if (claimed) {
    emit({ type: 'collaboration.dispatch.updated', dispatch: claimed.dispatch });
    emit({ type: 'collaboration.attempt.updated', attempt: claimed.attempt });
  }
  return claimed;
}

export function finishAttempt(input: { attemptId: string; dispatchId: string; status: 'completed' | 'failed' | 'cancelled'; dispatchStatus?: CollaborationDispatchStatus; output?: string | null; action?: CollaborationControlAction | null; deduplicatedTo?: string | null; error?: string | null; outputMessageId?: string | null }): void {
  const now = new Date().toISOString();
  tx(() => {
    run("UPDATE collaboration_attempts SET status=?,output=?,control_action=?,deduplicated_to=?,error=?,ended_at=?,lease_expires_at=NULL WHERE id=? AND status='running'",
      input.status, input.output ?? null, input.action ? JSON.stringify(input.action) : null, input.deduplicatedTo ?? null, input.error ?? null, now, input.attemptId);
    run("UPDATE collaboration_dispatches SET status=?,output_message_id=COALESCE(?,output_message_id),error=?,finished_at=? WHERE id=? AND status='running'",
      input.dispatchStatus ?? (input.status === 'completed' ? 'completed' : input.status), input.outputMessageId ?? null, input.error ?? null, now, input.dispatchId);
  });
  const attempt = get<AttemptRow>('SELECT * FROM collaboration_attempts WHERE id=?', input.attemptId);
  const dispatch = get<DispatchRow>('SELECT * FROM collaboration_dispatches WHERE id=?', input.dispatchId);
  if (attempt) emit({ type: 'collaboration.attempt.updated', attempt: toAttempt(attempt) });
  if (dispatch) emit({ type: 'collaboration.dispatch.updated', dispatch: toDispatch(dispatch) });
}

export function setAttemptInputContext(attemptId: string, inputContext: string): void {
  run("UPDATE collaboration_attempts SET input_context=? WHERE id=? AND status='running'", inputContext, attemptId);
  const row = get<AttemptRow>('SELECT * FROM collaboration_attempts WHERE id=?', attemptId);
  if (row) emit({ type: 'collaboration.attempt.updated', attempt: toAttempt(row) });
}

export function listAttempts(runId: string): CollaborationAttempt[] {
  return all<AttemptRow>('SELECT * FROM collaboration_attempts WHERE run_id=? ORDER BY created_at,rowid', runId).map(toAttempt);
}

export function getCompletedDispatchOutput(dispatchId: string): string | null {
  return get<{ output: string | null }>(
    "SELECT output FROM collaboration_attempts WHERE dispatch_id=? AND status='completed' ORDER BY attempt_no DESC LIMIT 1",
    dispatchId,
  )?.output ?? null;
}

export function createBatch(input: { runId: string; conversationId: string; initiatorAgentId: string; sourceDispatchId: string; question: string; targetAgentIds: string[] }): CollaborationBatch {
  const now = new Date();
  const id = randomUUID();
  run(`INSERT INTO collaboration_batches
    (id,run_id,conversation_id,initiator_agent_id,source_dispatch_id,question,target_agent_ids,status,timeout_at,created_at)
    VALUES (?,?,?,?,?,?,?,'running',?,?)`, id, input.runId, input.conversationId, input.initiatorAgentId,
    input.sourceDispatchId, input.question, JSON.stringify(input.targetAgentIds),
    new Date(now.getTime() + config.collaboration.batchTimeoutMs).toISOString(), now.toISOString());
  const value = toBatch(get<BatchRow>('SELECT * FROM collaboration_batches WHERE id=?', id)!);
  emit({ type: 'collaboration.batch.updated', batch: value });
  return value;
}
export function listBatches(runId: string): CollaborationBatch[] {
  return all<BatchRow>('SELECT * FROM collaboration_batches WHERE run_id=? ORDER BY created_at,rowid', runId).map(toBatch);
}
export function getBatch(id: string): CollaborationBatch | undefined {
  const row = get<BatchRow>('SELECT * FROM collaboration_batches WHERE id=?', id);
  return row ? toBatch(row) : undefined;
}
export function updateBatch(id: string, status: CollaborationBatchStatus, resultDispatchId?: string | null): CollaborationBatch | null {
  const terminal = ['completed', 'timeout', 'failed'].includes(status);
  run('UPDATE collaboration_batches SET status=?,result_dispatch_id=COALESCE(?,result_dispatch_id),completed_at=? WHERE id=?',
    status, resultDispatchId ?? null, terminal ? new Date().toISOString() : null, id);
  const row = get<BatchRow>('SELECT * FROM collaboration_batches WHERE id=?', id);
  if (!row) return null;
  const value = toBatch(row); emit({ type: 'collaboration.batch.updated', batch: value }); return value;
}
export function listOpenBatches(): CollaborationBatch[] {
  return all<BatchRow>("SELECT * FROM collaboration_batches WHERE status IN ('pending','running','partial') ORDER BY timeout_at").map(toBatch);
}
export function expireBatch(id: string): CollaborationBatch | null {
  const now = new Date().toISOString();
  const queued = all<DispatchRow>("SELECT * FROM collaboration_dispatches WHERE batch_id=? AND status='queued'", id);
  run("UPDATE collaboration_dispatches SET status='cancelled',error='并行征询超时',finished_at=? WHERE batch_id=? AND status='queued'", now, id);
  run("UPDATE collaboration_batches SET status='timeout',completed_at=? WHERE id=? AND status IN ('pending','running','partial')", now, id);
  for (const row of queued) emit({ type: 'collaboration.dispatch.updated', dispatch: toDispatch({ ...row, status: 'cancelled', error: '并行征询超时', finished_at: now }) });
  const row = get<BatchRow>('SELECT * FROM collaboration_batches WHERE id=?', id);
  if (!row) return null; const value = toBatch(row); emit({ type: 'collaboration.batch.updated', batch: value }); return value;
}

export function createDecision(input: { runId: string; conversationId: string; dispatchId?: string | null; idempotencyKey: string; kind: CollaborationDecisionKind; promptMessageId: string; payload: Record<string, unknown> }): CollaborationUserDecision {
  const old = get<DecisionRow>('SELECT * FROM collaboration_user_decisions WHERE idempotency_key=?', input.idempotencyKey);
  if (old) return toDecision(old);
  const id = randomUUID(); const now = new Date().toISOString();
  run(`INSERT INTO collaboration_user_decisions
    (id,run_id,conversation_id,dispatch_id,idempotency_key,kind,status,prompt_message_id,payload,created_at)
    VALUES (?,?,?,?,?,?,'pending',?,?,?)`, id, input.runId, input.conversationId, input.dispatchId ?? null,
    input.idempotencyKey, input.kind, input.promptMessageId, JSON.stringify(input.payload), now);
  const value = toDecision(get<DecisionRow>('SELECT * FROM collaboration_user_decisions WHERE id=?', id)!);
  emit({ type: 'collaboration.decision.updated', decision: value }); return value;
}
export function getDecision(id: string): CollaborationUserDecision | undefined {
  const row = get<DecisionRow>('SELECT * FROM collaboration_user_decisions WHERE id=?', id); return row ? toDecision(row) : undefined;
}
export function listDecisions(runId: string): CollaborationUserDecision[] {
  return all<DecisionRow>('SELECT * FROM collaboration_user_decisions WHERE run_id=? ORDER BY created_at,rowid', runId).map(toDecision);
}
export function resolveDecision(id: string, status: CollaborationDecisionStatus, resolution: Record<string, unknown>, linkedRunId?: string | null): CollaborationUserDecision | null {
  const changed = run("UPDATE collaboration_user_decisions SET status=?,resolution=?,linked_run_id=?,resolved_at=? WHERE id=? AND status='pending'",
    status, JSON.stringify(resolution), linkedRunId ?? null, new Date().toISOString(), id);
  const row = get<DecisionRow>('SELECT * FROM collaboration_user_decisions WHERE id=?', id);
  if (!row) return null;
  const value = toDecision(row); if (changed > 0) emit({ type: 'collaboration.decision.updated', decision: value }); return value;
}

export function initialBudgetLimits(): CollaborationBudgetLimits {
  return { maxDispatches: config.collaboration.maxDispatches, maxTokens: config.collaboration.maxTokens,
    maxCostUsd: config.collaboration.maxCostUsd, maxDurationMs: config.collaboration.runTimeoutMs };
}
export function listBudgetRevisions(runId: string): CollaborationBudgetRevision[] {
  return all<BudgetRevisionRow>('SELECT * FROM collaboration_budget_revisions WHERE run_id=? ORDER BY created_at,rowid', runId).map(toRevision);
}
export function currentBudgetLimits(runId: string): CollaborationBudgetLimits {
  return listBudgetRevisions(runId).at(-1)?.newLimits ?? initialBudgetLimits();
}
export function createBudgetRevision(runId: string, decisionId: string, increasePercent: number): CollaborationBudgetRevision {
  const existing = get<BudgetRevisionRow>('SELECT * FROM collaboration_budget_revisions WHERE decision_id=?', decisionId);
  if (existing) return toRevision(existing);
  const previous = currentBudgetLimits(runId);
  const factor = 1 + increasePercent / 100;
  const initial = initialBudgetLimits();
  const cap = config.collaboration.maxBudgetMultiplier;
  const next: CollaborationBudgetLimits = {
    maxDispatches: Math.min(Math.ceil(previous.maxDispatches * factor), Math.ceil(initial.maxDispatches * cap)),
    maxTokens: Math.min(Math.ceil(previous.maxTokens * factor), Math.ceil(initial.maxTokens * cap)),
    maxCostUsd: Math.min(Number((previous.maxCostUsd * factor).toFixed(6)), Number((initial.maxCostUsd * cap).toFixed(6))),
    maxDurationMs: Math.min(Math.ceil(previous.maxDurationMs * factor), Math.ceil(initial.maxDurationMs * cap)),
  };
  const id = randomUUID(); const now = new Date().toISOString();
  run(`INSERT INTO collaboration_budget_revisions (id,run_id,decision_id,increase_percent,previous_limits,new_limits,created_at)
    VALUES (?,?,?,?,?,?,?)`, id, runId, decisionId, increasePercent, JSON.stringify(previous), JSON.stringify(next), now);
  return { id, runId, decisionId, increasePercent, previousLimits: previous, newLimits: next, createdAt: now };
}

export function budgetSnapshot(runId: string): CollaborationBudgetSnapshot {
  const initial = initialBudgetLimits(); const current = currentBudgetLimits(runId);
  const usage = get<{ tokens: number; cost: number }>(`SELECT COALESCE(SUM(tokens_in+tokens_out),0) tokens,COALESCE(SUM(cost_usd),0) cost FROM run_events WHERE run_id=?`, runId) ?? { tokens: 0, cost: 0 };
  const dispatches = get<{ n: number }>('SELECT COUNT(*) n FROM collaboration_dispatches WHERE run_id=?', runId)?.n ?? 0;
  const created = get<{ created_at: string }>('SELECT created_at FROM runs WHERE id=?', runId)?.created_at;
  const duration = created ? Math.max(0, Date.now() - new Date(created).getTime()) : 0;
  return {
    dispatches: { used: dispatches, initialLimit: initial.maxDispatches, currentLimit: current.maxDispatches },
    tokens: { used: usage.tokens, initialLimit: initial.maxTokens, currentLimit: current.maxTokens },
    costUsd: { used: usage.cost, initialLimit: initial.maxCostUsd, currentLimit: current.maxCostUsd },
    durationMs: { used: duration, initialLimit: initial.maxDurationMs, currentLimit: current.maxDurationMs },
    cumulativeMultiplier: Math.max(current.maxDispatches / initial.maxDispatches, current.maxTokens / initial.maxTokens, current.maxCostUsd / initial.maxCostUsd, current.maxDurationMs / initial.maxDurationMs),
    maxMultiplier: config.collaboration.maxBudgetMultiplier, revisions: listBudgetRevisions(runId),
  };
}
export function budgetExceeded(runId: string): string | null {
  const b = budgetSnapshot(runId);
  if (b.dispatches.used > b.dispatches.currentLimit) return 'dispatches';
  if (b.tokens.used >= b.tokens.currentLimit) return 'tokens';
  if (b.costUsd.used >= b.costUsd.currentLimit) return 'costUsd';
  if (b.durationMs.used >= b.durationMs.currentLimit) return 'durationMs';
  return null;
}

export function cancelDispatch(id: string): CollaborationDispatch | null {
  run("UPDATE collaboration_dispatches SET status='cancelled',finished_at=? WHERE id=? AND status='queued'", new Date().toISOString(), id);
  const row = get<DispatchRow>('SELECT * FROM collaboration_dispatches WHERE id=?', id);
  if (!row) return null; const value = toDispatch(row); emit({ type: 'collaboration.dispatch.updated', dispatch: value }); return value;
}
export function cancelQueuedRun(runId: string): void {
  const ids = all<{ id: string }>("SELECT id FROM collaboration_dispatches WHERE run_id=? AND status='queued'", runId);
  for (const item of ids) cancelDispatch(item.id);
}
export function cancelCollaborationRun(runId: string): void {
  const now = new Date().toISOString();
  const dispatchRows = all<DispatchRow>("SELECT * FROM collaboration_dispatches WHERE run_id=? AND status IN ('queued','running')", runId);
  const attemptRows = all<AttemptRow>("SELECT * FROM collaboration_attempts WHERE run_id=? AND status='running'", runId);
  run("UPDATE collaboration_dispatches SET status='cancelled',error='用户停止运行',finished_at=? WHERE run_id=? AND status IN ('queued','running')", now, runId);
  run("UPDATE collaboration_attempts SET status='cancelled',error='用户停止运行',ended_at=?,lease_expires_at=NULL WHERE run_id=? AND status='running'", now, runId);
  for (const row of dispatchRows) emit({ type: 'collaboration.dispatch.updated', dispatch: toDispatch({ ...row, status: 'cancelled', error: '用户停止运行', finished_at: now }) });
  for (const row of attemptRows) emit({ type: 'collaboration.attempt.updated', attempt: toAttempt({ ...row, status: 'cancelled', error: '用户停止运行', ended_at: now, lease_expires_at: null }) });
}
export function cancelAgentWork(conversationId: string, agentId: string): number {
  const now = new Date().toISOString();
  const dispatchRows = all<DispatchRow>("SELECT * FROM collaboration_dispatches WHERE conversation_id=? AND target_agent_id=? AND status IN ('queued','running')", conversationId, agentId);
  const attemptRows = all<AttemptRow>("SELECT * FROM collaboration_attempts WHERE conversation_id=? AND agent_id=? AND status='running'", conversationId, agentId);
  run("UPDATE collaboration_dispatches SET status='cancelled',error='用户停止 Agent',finished_at=? WHERE conversation_id=? AND target_agent_id=? AND status IN ('queued','running')", now, conversationId, agentId);
  run("UPDATE collaboration_attempts SET status='cancelled',error='用户停止 Agent',ended_at=?,lease_expires_at=NULL WHERE conversation_id=? AND agent_id=? AND status='running'", now, conversationId, agentId);
  for (const row of dispatchRows) emit({ type: 'collaboration.dispatch.updated', dispatch: toDispatch({ ...row, status: 'cancelled', error: '用户停止 Agent', finished_at: now }) });
  for (const row of attemptRows) emit({ type: 'collaboration.attempt.updated', attempt: toAttempt({ ...row, status: 'cancelled', error: '用户停止 Agent', ended_at: now, lease_expires_at: null }) });
  return dispatchRows.length;
}
export function hasPendingDecision(runId: string): boolean {
  return Boolean(get('SELECT 1 FROM collaboration_user_decisions WHERE run_id=? AND status=\'pending\' LIMIT 1', runId));
}
export function hasOpenDispatches(runId: string): boolean {
  return Boolean(get("SELECT 1 FROM collaboration_dispatches WHERE run_id=? AND status IN ('queued','running') LIMIT 1", runId));
}
export function activeConversationState(conversationId: string): { runIds: string[]; activeAgentIds: string[]; queued: number; blocked: number } {
  const runIds = all<{ run_id: string }>("SELECT DISTINCT run_id FROM collaboration_dispatches WHERE conversation_id=? AND status IN ('queued','running')", conversationId).map((x) => x.run_id);
  const activeAgentIds = all<{ agent_id: string }>("SELECT DISTINCT agent_id FROM collaboration_attempts WHERE conversation_id=? AND status='running'", conversationId).map((x) => x.agent_id);
  const counts = get<{ queued: number; blocked: number }>("SELECT SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) queued,SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) blocked FROM collaboration_dispatches WHERE conversation_id=?", conversationId);
  return { runIds, activeAgentIds, queued: counts?.queued ?? 0, blocked: counts?.blocked ?? 0 };
}

export function interruptExpiredAttempts(): string[] {
  const now = new Date().toISOString();
  const rows = all<AttemptRow>("SELECT * FROM collaboration_attempts WHERE status='running'");
  const conversations = new Set<string>();
  for (const item of rows) {
    run("UPDATE collaboration_attempts SET status='interrupted',error='服务重启或执行租约过期',ended_at=? WHERE id=?", now, item.id);
    const agentSpan = get<{ id: string }>("SELECT id FROM run_events WHERE run_id=? AND span_kind='agent' AND input LIKE ? ORDER BY started_at DESC LIMIT 1", item.run_id, `%\"dispatchId\":\"${item.dispatch_id}\"%`);
    const tools = agentSpan ? all<{ name: string }>("SELECT name FROM run_events WHERE parent_id=? AND span_kind='tool' AND status='ok'", agentSpan.id) : [];
    const hasPossibleSideEffect = tools.some((tool) => !READONLY_TOOLS.has(tool.name.replace(/^tool:/, '')));
    if (hasPossibleSideEffect || item.attempt_no >= config.collaboration.maxAttempts) {
      run("UPDATE collaboration_dispatches SET status='failed',error=?,finished_at=? WHERE id=? AND status='running'",
        hasPossibleSideEffect ? '执行中断且存在可能的工具副作用，未自动重试' : '执行中断且已达到最大重试次数', now, item.dispatch_id);
    } else {
      run("UPDATE collaboration_dispatches SET status='queued',started_at=NULL WHERE id=? AND status='running'", item.dispatch_id);
    }
    conversations.add(item.conversation_id);
  }
  return [...conversations];
}

export function listRecoverableConversationIds(): string[] {
  return all<{ conversation_id: string }>(`SELECT DISTINCT d.conversation_id FROM collaboration_dispatches d
    JOIN runs r ON r.id=d.run_id
    WHERE d.status IN ('queued','running') AND r.status='running'`).map((row) => row.conversation_id);
}
export function listRunningCollaborationRunIds(): string[] {
  return all<{ id: string }>("SELECT id FROM runs WHERE mode='collaboration' AND status='running'").map((row) => row.id);
}

import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ThreadedBinding, ThreadedMessageRecord, ThreadedQueueDispatch, ThreadedQueueRecord, ThreadedQueueState } from '@agent-gand/shared';
import type { createExecutionResourceCoordinator } from '../execution/resources/coordinator.ts';
import type { createThreadedLifecycle } from './lifecycle.ts';
import type { createThreadedBudget } from './budget.ts';
import type { BudgetAuthorization } from './budgetTypes.ts';
import type { ThreadedMessageAcl } from './messageContracts.ts';
import { createThreadedMessageAcl } from './acl.ts';
import { ThreadedQueueError } from './queueContracts.ts';
import type { ThreadedQueueClaim, ThreadedQueueEvent, ThreadedQueuePreparationContext,
  ThreadedQueueRecoveryPlan, ThreadedQueueResourcePreparation } from './queueContracts.ts';

type QueueRow = {
  seq: number; id: string; owner_id: string; thread_id: string; agent_id: string; wake_id: string;
  source_message_id: string; wave_id: string; input_max_seq: number; causal_root_id: string;
  state: ThreadedQueueState; reason: string | null; version: number; invocation_id: string | null;
  ticket_id: string | null; prepared_attempt_id: string | null; preparation: string | null;
  authorization_version: number; generation: number; available_at: string; created_at: string; updated_at: string;
};
type WakeRow = { age: number; id: string; owner_id: string; thread_id: string; target_agent_id: string;
  source_message_id: string; delivery_id: string; wave_id: string; input_max_seq: number; causal_root_id: string;
  authority_epoch: number; target_member_version: number; target_permission_version: number;
  status: string; purpose: string; routing_revision: number; created_at: string; available_at: string };
type DispatchRow = { id: string; queue_id: string; owner_id: string; thread_id: string; agent_id: string;
  generation: number; worker_id: string; owner_nonce: string; fencing_token: string; invocation_id: string;
  attempt_id: string; binding_id: string; budget_authorization_id: string;
  phase: ThreadedQueueDispatch['phase']; lease_expires_at: string };
type AuthorizationRow = { version: number; thread_epoch: number; identity_hash: string; source_acl_hash: string };
type InvocationRow = { id: string; status: string; reserved_run_id: string; current_attempt_id: string | null;
  pause_requested: number; cancel_requested: number; recovery_reason: string | null };
type MemberRow = { version: number; permission_version: number; role_version: number; account_version: number | null;
  status: string; agent_version: number; enabled: number; definition: string };
type ControlRow = { id: string; action: string; status: string; created_at: string; thread_epoch: number | null };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function deny(code: string): never { throw new ThreadedQueueError(code); }
const identifier = (value: string) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) deny('THREADED_QUEUE_INVALID_INPUT');
  return value;
};
const record = (row: QueueRow): ThreadedQueueRecord => ({
  schemaVersion: 1, id: row.id, seq: row.seq, ownerId: row.owner_id, threadId: row.thread_id,
  agentId: row.agent_id, wakeId: row.wake_id, sourceMessageId: row.source_message_id, waveId: row.wave_id,
  inputMaxSeq: row.input_max_seq, causalRootId: row.causal_root_id, state: row.state, reason: row.reason,
  version: row.version, invocationId: row.invocation_id, ticketId: row.ticket_id,
  authorizationVersion: row.authorization_version, generation: row.generation,
  createdAt: row.created_at, updatedAt: row.updated_at,
});
const dispatchRecord = (row: DispatchRow): ThreadedQueueDispatch => ({
  id: row.id, queueId: row.queue_id, generation: row.generation, workerId: row.worker_id,
  ownerNonce: row.owner_nonce, fencingToken: row.fencing_token, attemptId: row.attempt_id,
  bindingId: row.binding_id, budgetAuthorizationId: row.budget_authorization_id,
  phase: row.phase, leaseExpiresAt: row.lease_expires_at,
});

/** Durable queue only. A production instance has no executor or resource-preparation callback. */
export function createThreadedQueue(db: Database.Database, options: {
  lifecycle: ReturnType<typeof createThreadedLifecycle>;
  resources: ReturnType<typeof createExecutionResourceCoordinator>;
  budget: ReturnType<typeof createThreadedBudget>;
  acl?: ThreadedMessageAcl;
  prepareResources?: (context: ThreadedQueuePreparationContext) => ThreadedQueueResourcePreparation;
  now?: () => number;
  ownerNonce?: string;
  leaseMs?: number;
}) {
  if (db.pragma('foreign_keys', { simple: true }) !== 1) deny('THREADED_QUEUE_FOREIGN_KEYS_REQUIRED');
  const ownerId = (db.prepare('SELECT instance_owner_id FROM threaded_instances WHERE singleton=1').get() as
    { instance_owner_id: string } | undefined)?.instance_owner_id;
  if (!ownerId) deny('THREADED_QUEUE_OWNER_REQUIRED');
  const acl = options.acl ?? createThreadedMessageAcl(db), ownerNonce = options.ownerNonce ?? randomUUID();
  const leaseMs = options.leaseMs ?? 15_000, now = options.now ?? Date.now;
  identifier(ownerNonce);
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 3_600_000) deny('THREADED_QUEUE_INVALID_LEASE');
  function time(): number {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) deny('THREADED_QUEUE_INVALID_CLOCK');
    return value;
  }
  const stamp = () => new Date(time()).toISOString();
  const queueRow = (id: string) => db.prepare('SELECT * FROM threaded_wake_queue WHERE id=? AND owner_id=?')
    .get(id, ownerId) as QueueRow | undefined;
  const queueForWake = (id: string) => db.prepare('SELECT * FROM threaded_wake_queue WHERE wake_id=? AND owner_id=?')
    .get(id, ownerId) as QueueRow | undefined;
  const wakeRow = (id: string) => db.prepare('SELECT rowid AS age,* FROM threaded_wakes WHERE id=? AND owner_id=?')
    .get(id, ownerId) as WakeRow | undefined;
  const source = (id: string): ThreadedMessageRecord | null => {
    const row = db.prepare('SELECT record FROM threaded_messages WHERE id=? AND owner_id=?').get(id, ownerId) as
      { record: string } | undefined;
    return row ? JSON.parse(row.record) as ThreadedMessageRecord : null;
  };
  const invocation = (id: string) => db.prepare('SELECT * FROM threaded_invocations WHERE id=? AND owner_id=?')
    .get(id, ownerId) as InvocationRow | undefined;
  const member = (threadId: string, agentId: string) => db.prepare(`SELECT m.version,m.permission_version,m.role_version,
    m.account_version,m.status,a.version agent_version,a.enabled,a.definition FROM threaded_members m
    JOIN agents a ON a.id=m.agent_id WHERE m.thread_id=? AND m.owner_id=? AND m.agent_id=?`)
    .get(threadId, ownerId, agentId) as MemberRow | undefined;
  const dispatchFor = (binding: ThreadedBinding) => db.prepare(`SELECT * FROM threaded_queue_claims
    WHERE binding_id=? AND attempt_id=? AND invocation_id=? AND owner_id=? AND thread_id=? AND agent_id=?`)
    .get(binding.id, binding.attemptId, binding.invocationId, binding.ownerId, binding.threadId, binding.agentId) as DispatchRow | undefined;
  const listeners = new Set<(event: ThreadedQueueEvent) => void>();
  let cursor = (db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM threaded_queue_events').get() as { n: number }).n;
  let notificationScheduled = false;
  function emitChanges(): void {
    if (!db.open || db.inTransaction) return;
    const events = db.prepare('SELECT seq,queue_id queueId,reason FROM threaded_queue_events WHERE seq>? ORDER BY seq')
      .all(cursor) as ThreadedQueueEvent[];
    cursor = events.at(-1)?.seq ?? cursor;
    for (const event of events) for (const listener of listeners) { try { listener(event); } catch { /* Scanning repairs missed hints. */ } }
  }
  function notify(id: string, reason: string): void {
    db.prepare('INSERT INTO threaded_queue_events(queue_id,reason,created_at) VALUES(?,?,?)').run(id, reason, stamp());
    if (!notificationScheduled) {
      notificationScheduled = true;
      queueMicrotask(() => { notificationScheduled = false; emitChanges(); });
    }
  }
  function state(row: QueueRow, next: ThreadedQueueState, reason: string | null): void {
    if (row.state === next && row.reason === reason) return;
    db.prepare(`UPDATE threaded_wake_queue SET state=?,reason=?,version=version+1,updated_at=? WHERE id=?`)
      .run(next, reason, stamp(), row.id);
    if (row.ticket_id) {
      const ticket = options.resources.getTicket(row.ticket_id);
      if (ticket?.status === 'waiting') {
        if (next === 'cancelled' || next === 'settled') options.resources.cancelTicket(ticket.id);
        else options.resources.setEligible(ticket.id, next === 'queued');
      }
    }
    notify(row.id, reason ?? next);
  }
  function currentBinding(row: DispatchRow): ThreadedBinding {
    const b = db.prepare('SELECT * FROM threaded_execution_bindings WHERE id=?').get(row.binding_id) as
      Record<string, string | number> | undefined;
    if (!b) deny('THREADED_QUEUE_BINDING_MISSING');
    return { schemaVersion: 1, origin: 'threaded_invocation_attempt', id: String(b.id), ownerId: String(b.owner_id),
      threadId: String(b.thread_id), agentId: String(b.agent_id), invocationId: String(b.invocation_id),
      runId: String(b.run_id), attemptId: String(b.attempt_id), authorityEpoch: Number(b.authority_epoch),
      claimId: String(b.claim_id), generation: Number(b.generation), fencingToken: String(b.fencing_token) };
  }
  function exactDispatch(binding: ThreadedBinding): DispatchRow {
    const d = dispatchFor(binding);
    if (!d) deny('THREADED_QUEUE_DISPATCH_NOT_FOUND');
    const canonical = currentBinding(d);
    for (const key of Object.keys(canonical) as Array<keyof ThreadedBinding>) {
      if (canonical[key] !== binding[key]) deny('THREADED_QUEUE_STALE_DISPATCH');
    }
    const row = queueRow(d.queue_id);
    if (!row || row.generation !== d.generation || row.invocation_id !== binding.invocationId
      || invocation(binding.invocationId)?.current_attempt_id !== binding.attemptId) deny('THREADED_QUEUE_STALE_DISPATCH');
    return d;
  }
  function controls(row: QueueRow, wake: WakeRow) {
    const boundary = (db.prepare('SELECT control_seq FROM threaded_message_control_boundaries WHERE message_id=?')
      .get(wake.source_message_id) as { control_seq: number } | undefined)?.control_seq ?? 0;
    const relevant = db.prepare(`SELECT c.id,c.action,c.status,c.created_at,e.thread_epoch FROM threaded_control_requests c
      LEFT JOIN threaded_control_epoch_receipts e ON e.control_request_id=c.id
      WHERE c.thread_id=? AND c.owner_id=? AND (c.scope='thread' OR (c.scope='member' AND c.agent_id=?))
      AND c.rowid>? ORDER BY c.rowid`).all(row.thread_id, row.owner_id, row.agent_id, boundary) as ControlRow[];
    return { cancelled: relevant.some(c => c.action === 'cancel' && c.status !== 'rejected'),
      resume: [...relevant].reverse().find(c => c.action === 'resume' && c.status === 'applied') };
  }
  function sourceFingerprint(message: ThreadedMessageRecord, agentId: string): string | null {
    const pending = [message], visited = new Set<string>(), facts: unknown[] = [];
    while (pending.length) {
      const current = pending.pop()!;
      if (visited.has(current.id)) continue;
      if (visited.size >= 1000) return null;
      visited.add(current.id);
      if (!acl.canRead({ ownerId: current.ownerId, threadId: current.threadId,
        viewer: { kind: 'agent', agentId } }, current)) return null;
      const m = member(current.threadId, agentId);
      if (!m) return null;
      facts.push({ id: current.id, recordHash: hash(current), member: m });
      for (const id of current.sourceRefs) { const parent = source(id); if (!parent) return null; pending.push(parent); }
    }
    return hash(facts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  }
  function authoritySnapshot(row: QueueRow, wake: WakeRow, message: ThreadedMessageRecord) {
    const m = member(row.thread_id, row.agent_id);
    if (!m || m.status !== 'joined' || m.enabled !== 1 || m.role_version !== m.agent_version
      || m.version !== wake.target_member_version || m.permission_version !== wake.target_permission_version) return null;
    const definition = JSON.parse(m.definition) as { accountRef?: string; requiresAccount?: boolean };
    const account = definition.accountRef ? db.prepare(`SELECT id,config_version,credential_version,identity_generation,
      enabled,archived FROM accounts WHERE id=? AND NOT EXISTS(SELECT 1 FROM account_revocations WHERE account_id=accounts.id)`)
      .get(definition.accountRef) as Record<string, unknown> | undefined : null;
    if ((definition.accountRef && (!account || account.enabled !== 1 || account.archived !== 0))
      || (!definition.accountRef && definition.requiresAccount)) return null;
    const sourceAclHash = sourceFingerprint(message, row.agent_id);
    if (!sourceAclHash) return null;
    return { identityHash: hash({ member: m, account }), sourceAclHash, record: { member: m, account } };
  }
  function authorize(row: QueueRow): { allowed: boolean; reason: string; cancelled?: boolean } {
    const wake = wakeRow(row.wake_id), message = source(row.source_message_id);
    if (!wake || !message || wake.source_message_id !== message.id || message.threadId !== row.thread_id
      || message.state !== 'published' || !message.targets.includes(row.agent_id) || wake.status === 'cancelled') {
      return { allowed: false, reason: 'THREADED_WAKE_SOURCE_UNAVAILABLE', cancelled: wake?.status === 'cancelled' };
    }
    const thread = db.prepare('SELECT state,authority_epoch FROM threaded_threads WHERE id=? AND owner_id=?')
      .get(row.thread_id, row.owner_id) as { state: string; authority_epoch: number } | undefined;
    const control = controls(row, wake);
    if (!thread || ['closed', 'archived'].includes(thread.state) || control.cancelled) {
      return { allowed: false, reason: 'THREADED_QUEUE_CONTROL_CANCELLED', cancelled: true };
    }
    const snapshot = authoritySnapshot(row, wake, message);
    if (!snapshot) return { allowed: false, reason: 'THREADED_QUEUE_SOURCE_AUTHORITY_CHANGED' };
    const prior = db.prepare(`SELECT * FROM threaded_wake_authorizations WHERE queue_id=? ORDER BY version DESC LIMIT 1`)
      .get(row.id) as AuthorizationRow | undefined;
    if (prior && (prior.identity_hash !== snapshot.identityHash || prior.source_acl_hash !== snapshot.sourceAclHash)) {
      return { allowed: false, reason: 'THREADED_QUEUE_SOURCE_AUTHORITY_CHANGED' };
    }
    const epoch = prior?.thread_epoch ?? wake.authority_epoch;
    if (thread.authority_epoch !== epoch && (!control.resume || control.resume.thread_epoch !== thread.authority_epoch || thread.state !== 'open')) {
      return { allowed: false, reason: 'THREADED_QUEUE_OWNER_RESUME_REQUIRED' };
    }
    if (!prior || prior.thread_epoch !== thread.authority_epoch) {
      const version = (prior?.version ?? 0) + 1;
      db.prepare(`INSERT INTO threaded_wake_authorizations(id,queue_id,owner_id,thread_id,agent_id,version,
        thread_epoch,identity_hash,source_acl_hash,record,control_request_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(randomUUID(), row.id, row.owner_id, row.thread_id, row.agent_id, version, thread.authority_epoch,
          snapshot.identityHash, snapshot.sourceAclHash, JSON.stringify(snapshot.record),
          thread.authority_epoch !== epoch ? control.resume!.id : null, stamp());
      db.prepare(`UPDATE threaded_wake_queue SET authorization_version=?,version=version+1,updated_at=? WHERE id=?`)
        .run(version, stamp(), row.id);
    }
    const memberControl = db.prepare(`SELECT action FROM threaded_control_requests WHERE thread_id=? AND owner_id=?
      AND scope='member' AND agent_id=? AND status<>'rejected' ORDER BY rowid DESC LIMIT 1`)
      .get(row.thread_id, row.owner_id, row.agent_id) as { action: string } | undefined;
    if (thread.state === 'paused' || (memberControl && memberControl.action !== 'resume')) {
      return { allowed: false, reason: 'THREADED_QUEUE_CONTROL_PAUSED' };
    }
    return { allowed: true, reason: '' };
  }
  function refreshWithin(row: QueueRow): QueueRow {
    if (['claimed', 'unknown', 'settled', 'cancelled'].includes(row.state)) return row;
    const access = authorize(row);
    if (!access.allowed) {
      state(row, access.cancelled ? 'cancelled' : 'blocked', access.reason);
      return queueRow(row.id)!;
    }
    if (row.invocation_id) {
      const inv = invocation(row.invocation_id);
      if (!inv) deny('THREADED_QUEUE_INVOCATION_MISSING');
      if (['completed', 'failed', 'cancelled'].includes(inv.status)) {
        state(row, inv.status === 'cancelled' ? 'cancelled' : 'settled', null); return queueRow(row.id)!;
      }
      if (inv.status !== 'queued' || inv.pause_requested || inv.cancel_requested) {
        state(row, 'blocked', 'THREADED_QUEUE_INVOCATION_NOT_READY'); return queueRow(row.id)!;
      }
      if (inv.current_attempt_id) {
        const previous = db.prepare('SELECT execution_stage,resource_release_state FROM threaded_attempts WHERE id=?')
          .get(inv.current_attempt_id) as { execution_stage: string; resource_release_state: string | null };
        if (previous.execution_stage !== 'quiescent' || previous.resource_release_state !== 'released') {
          state(row, 'blocked', 'THREADED_QUEUE_RESOURCE_RELEASE_PENDING'); return queueRow(row.id)!;
        }
      }
      if (row.preparation && row.prepared_attempt_id
        && row.ticket_id && options.resources.getTicket(row.ticket_id)?.status === 'waiting') {
        const assessment = budgetAssessment(row);
        if (!assessment.allowed) {
          state(row, 'blocked', assessment.reason ?? 'THREADED_BUDGET_BLOCKED'); return queueRow(row.id)!;
        }
      }
    }
    state(row, 'queued', null);
    return queueRow(row.id)!;
  }
  function enqueueWake(wakeId: string): ThreadedQueueRecord {
    identifier(wakeId);
    return db.transaction(() => {
      const existing = queueForWake(wakeId);
      if (existing) return record(existing);
      const wake = wakeRow(wakeId);
      if (!wake || wake.purpose !== 'message' || wake.routing_revision !== 1) deny('THREADED_QUEUE_WAKE_INVALID');
      const message = source(wake.source_message_id);
      if (!message || message.state !== 'published' || message.threadId !== wake.thread_id
        || message.waveId !== wake.wave_id || message.inputMaxSeq !== wake.input_max_seq
        || message.causalRootId !== wake.causal_root_id || !message.targets.includes(wake.target_agent_id)
        || !db.prepare(`SELECT 1 FROM threaded_deliveries WHERE id=? AND message_id=? AND thread_id=?
          AND owner_id=? AND target_agent_id=? AND wave_id=? AND input_max_seq=?`)
          .get(wake.delivery_id, message.id, wake.thread_id, wake.owner_id, wake.target_agent_id, wake.wave_id, wake.input_max_seq)) {
        deny('THREADED_QUEUE_WAKE_INVALID');
      }
      const id = randomUUID();
      // The durable Wake insertion order is independent of notification delivery order.
      db.prepare(`INSERT INTO threaded_wake_queue(seq,id,owner_id,thread_id,agent_id,wake_id,source_message_id,
        wave_id,input_max_seq,causal_root_id,state,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'queued',?,?,?)`)
        .run(wake.age, id, wake.owner_id, wake.thread_id, wake.target_agent_id, wake.id, wake.source_message_id,
          wake.wave_id, wake.input_max_seq, wake.causal_root_id, wake.available_at, wake.created_at, stamp());
      notify(id, 'enqueued');
      return record(refreshWithin(queueRow(id)!));
    }).immediate();
  }
  function scanPending(): ThreadedQueueRecord[] {
    const missing = db.prepare(`SELECT w.id FROM threaded_wakes w WHERE w.owner_id=?
      AND NOT EXISTS(SELECT 1 FROM threaded_wake_queue q WHERE q.wake_id=w.id) ORDER BY w.rowid LIMIT 1000`)
      .all(ownerId) as Array<{ id: string }>;
    for (const row of missing) enqueueWake(row.id);
    emitChanges();
    return (db.prepare(`SELECT * FROM threaded_wake_queue WHERE owner_id=? AND state NOT IN ('settled','cancelled') ORDER BY seq`)
      .all(ownerId) as QueueRow[]).map(record);
  }
  function prepare(row: QueueRow): QueueRow {
    return db.transaction(() => {
      row = refreshWithin(queueRow(row.id)!);
      if (row.state !== 'queued') return row;
      options.budget.ensureRootForMessage(row.source_message_id);
      let inv = row.invocation_id ? invocation(row.invocation_id) : undefined;
      if (!inv) {
        const message = source(row.source_message_id)!;
        const created = options.lifecycle.createInvocation({ ownerId: row.owner_id, threadId: row.thread_id,
          agentId: row.agent_id, causalRootId: row.causal_root_id, goal: message.body.slice(0, 100_000) || `Message ${message.id}`,
          requestId: `wake:${row.wake_id}` });
        db.prepare(`INSERT INTO threaded_invocation_wakes(invocation_id,wake_id,queue_id,owner_id,thread_id,agent_id,
          source_message_id,wave_id,input_max_seq,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
          .run(created.id, row.wake_id, row.id, row.owner_id, row.thread_id, row.agent_id, row.source_message_id,
            row.wave_id, row.input_max_seq, stamp());
        db.prepare(`UPDATE threaded_invocations SET wake_source_id=? WHERE id=?`).run(row.wake_id, created.id);
        db.prepare(`UPDATE threaded_wake_queue SET invocation_id=?,version=version+1,updated_at=? WHERE id=?`)
          .run(created.id, stamp(), row.id);
        inv = invocation(created.id)!; row = queueRow(row.id)!;
      }
      if (inv.current_attempt_id) {
        const previous = db.prepare('SELECT execution_stage,resource_release_state FROM threaded_attempts WHERE id=?')
          .get(inv.current_attempt_id) as { execution_stage: string; resource_release_state: string | null };
        if (previous.execution_stage !== 'quiescent' || previous.resource_release_state !== 'released') {
          state(row, 'blocked', 'THREADED_QUEUE_RESOURCE_RELEASE_PENDING'); return queueRow(row.id)!;
        }
      }
      if (row.ticket_id && options.resources.getTicket(row.ticket_id)?.status === 'waiting') return row;
      if (!options.prepareResources) deny('THREADED_QUEUE_PREPARATION_DISABLED');
      const attemptId = randomUUID();
      const prepared = options.prepareResources({ queue: record(row), invocationId: inv.id,
        reservedRunId: inv.reserved_run_id, attemptId });
      if (!prepared || typeof (prepared as unknown as { then?: unknown }).then === 'function'
        || !prepared.session || !Array.isArray(prepared.workspaces)) deny('THREADED_QUEUE_PREPARATION_INVALID');
      const admission = options.budget.assessAdmission({ invocationId: inv.id, attemptId,
        sourceMessageId: row.source_message_id, requestKey: `queue:${row.id}:${attemptId}`, quote: prepared.quote });
      const ticket = options.resources.enqueue({ requestKey: `queue:${row.id}:${attemptId}`, operationId: `queue:${row.id}:${attemptId}`,
        mode: 'threaded', ownerId: row.owner_id, threadId: row.thread_id, agentId: row.agent_id,
        invocationId: inv.id, runId: inv.reserved_run_id, attemptId, capacity: true,
        session: prepared.session, workspaces: prepared.workspaces, providerKey: prepared.providerKey,
        accountId: prepared.accountId, accountIdentityGeneration: prepared.accountIdentityGeneration, eligible: admission.allowed });
      db.prepare(`UPDATE threaded_wake_queue SET ticket_id=?,prepared_attempt_id=?,preparation=?,version=version+1,updated_at=? WHERE id=?`)
        .run(ticket.id, attemptId, JSON.stringify(prepared), stamp(), row.id);
      row = queueRow(row.id)!;
      if (!admission.allowed) state(row, 'blocked', admission.reason ?? 'THREADED_BUDGET_BLOCKED');
      notify(row.id, 'prepared');
      return queueRow(row.id)!;
    }).immediate();
  }
  function budgetAssessment(row: QueueRow) {
    if (!row.invocation_id || !row.prepared_attempt_id || !row.preparation) deny('THREADED_QUEUE_NOT_PREPARED');
    return options.budget.assessAdmission({ invocationId: row.invocation_id, attemptId: row.prepared_attempt_id,
      sourceMessageId: row.source_message_id, requestKey: `queue:${row.id}:${row.prepared_attempt_id}`,
      quote: (JSON.parse(row.preparation) as ThreadedQueueResourcePreparation).quote });
  }
  function claimNext(workerId: string): ThreadedQueueClaim | null {
    identifier(workerId);
    if (process.env.AGENT_GAND_ISOLATED_WORKER !== '1') deny('THREADED_EXECUTION_NOT_ENABLED');
    scanPending();
    const rows = db.prepare(`SELECT * FROM threaded_wake_queue WHERE owner_id=? AND state IN ('queued','blocked')
      AND available_at<=? ORDER BY seq`).all(ownerId, stamp()) as QueueRow[];
    const heads = new Map<string, QueueRow>();
    for (const candidate of rows) {
      let ready = db.transaction(() => refreshWithin(queueRow(candidate.id)!)).immediate();
      if (ready.state !== 'queued') continue;
      const lane = `${ready.thread_id}:${ready.agent_id}`;
      if (heads.has(lane)) {
        db.transaction(() => {
          const fresh = queueRow(ready.id)!;
          if (fresh.ticket_id && options.resources.getTicket(fresh.ticket_id)?.status === 'waiting') {
            options.resources.setEligible(fresh.ticket_id, false);
          }
        }).immediate();
        continue;
      }
      try { ready = prepare(ready); }
      catch (error) {
        const code = error instanceof Error ? ('code' in error ? String(error.code) : error.message) : '';
        if (!/^(THREADED_(BUDGET|ROOT|ACCOUNT|MEMBER|SESSION)|RESOURCE_(SESSION|ACCOUNT))/.test(code)) throw error;
        db.transaction(() => {
          const fresh = queueRow(candidate.id)!;
          if (['queued', 'blocked'].includes(fresh.state)) state(fresh, 'blocked', code);
        }).immediate(); continue;
      }
      if (ready.state !== 'queued') continue;
      const stillWaiting = db.transaction(() => {
        const fresh = queueRow(ready.id)!;
        if (fresh.state !== 'queued' || !fresh.ticket_id
          || options.resources.getTicket(fresh.ticket_id)?.status !== 'waiting') return false;
        const assessment = budgetAssessment(fresh);
        if (!assessment.allowed) {
          state(fresh, 'blocked', assessment.reason ?? 'THREADED_BUDGET_BLOCKED'); return false;
        }
        options.resources.setEligible(fresh.ticket_id, true);
        return true;
      }).immediate();
      if (stillWaiting) heads.set(lane, ready);
    }
    for (const head of heads.values()) {
      const acquired = db.transaction((): ThreadedQueueClaim | null => {
        const row = refreshWithin(queueRow(head.id)!);
        if (row.state !== 'queued' || !row.ticket_id || !row.prepared_attempt_id || !row.preparation || !row.invocation_id) return null;
        const assessment = budgetAssessment(row);
        if (!assessment.allowed) { state(row, 'blocked', assessment.reason ?? 'THREADED_BUDGET_BLOCKED'); return null; }
        const resourceClaim = options.resources.tryAcquire(row.ticket_id);
        if (!resourceClaim) return null;
        const preparation = JSON.parse(row.preparation) as ThreadedQueueResourcePreparation;
        const authorization = options.budget.reserveAdmission({ invocationId: row.invocation_id, attemptId: row.prepared_attempt_id,
          sourceMessageId: row.source_message_id, requestKey: `queue:${row.id}:${row.prepared_attempt_id}`,
          quote: preparation.quote, claim: resourceClaim });
        const binding = options.lifecycle.prepareAttempt({ ownerId: row.owner_id, invocationId: row.invocation_id, claim: resourceClaim });
        const id = randomUUID(), generation = row.generation + 1, token = randomUUID(), createdAt = stamp();
        db.prepare(`INSERT INTO threaded_queue_claims(id,queue_id,owner_id,thread_id,agent_id,generation,worker_id,owner_nonce,
          fencing_token,invocation_id,attempt_id,binding_id,budget_authorization_id,phase,lease_expires_at,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?,?)`)
          .run(id, row.id, row.owner_id, row.thread_id, row.agent_id, generation, workerId, ownerNonce, token,
            row.invocation_id, binding.attemptId, binding.id, authorization.id,
            new Date(time() + leaseMs).toISOString(), createdAt, createdAt);
        db.prepare(`UPDATE threaded_wake_queue SET generation=?,state='claimed',reason=NULL,version=version+1,updated_at=? WHERE id=?`)
          .run(generation, createdAt, row.id);
        notify(row.id, 'claimed');
        return { queue: record(queueRow(row.id)!), dispatch: dispatchRecord(dispatchFor(binding)!), binding,
          budgetAuthorization: authorization, sourceMessageId: row.source_message_id, waveId: row.wave_id,
          inputMaxSeq: row.input_max_seq, sessionBindingId: preparation.session.id };
      }).immediate();
      if (acquired) return acquired;
    }
    return null;
  }
  function assertExecutable(binding: ThreadedBinding): void {
    const d = exactDispatch(binding);
    if (d.owner_nonce !== ownerNonce || !['prepared', 'started'].includes(d.phase) || d.lease_expires_at <= stamp()) {
      deny('THREADED_QUEUE_STALE_DISPATCH');
    }
    const inv = invocation(binding.invocationId);
    if (!inv || inv.status !== 'running' || inv.pause_requested || inv.cancel_requested) deny('THREADED_QUEUE_NOT_EXECUTABLE');
    const row = queueRow(d.queue_id)!, wake = wakeRow(row.wake_id), message = source(row.source_message_id);
    const authorization = db.prepare(`SELECT * FROM threaded_wake_authorizations WHERE queue_id=? AND version=?`)
      .get(row.id, row.authorization_version) as AuthorizationRow | undefined;
    const snapshot = wake && message ? authoritySnapshot(row, wake, message) : null;
    const thread = db.prepare('SELECT authority_epoch FROM threaded_threads WHERE id=? AND owner_id=?')
      .get(row.thread_id, row.owner_id) as { authority_epoch: number } | undefined;
    if (!snapshot || !authorization || authorization.identity_hash !== snapshot.identityHash
      || authorization.source_acl_hash !== snapshot.sourceAclHash || thread?.authority_epoch !== authorization.thread_epoch) {
      deny('THREADED_QUEUE_SOURCE_AUTHORITY_CHANGED');
    }
    const resource = options.resources.getClaim(binding.claimId);
    if (!resource || resource.identity.attemptId !== binding.attemptId || resource.identity.fencingToken !== binding.fencingToken) {
      deny('THREADED_QUEUE_STALE_RESOURCE');
    }
    options.resources.assertExecutable(resource.identity);
  }
  function authorizationForBinding(binding: ThreadedBinding): BudgetAuthorization {
    const d = exactDispatch(binding), authorization = options.budget.getAuthorization(d.budget_authorization_id);
    if (!authorization) deny('THREADED_QUEUE_BUDGET_AUTHORIZATION_MISSING');
    return authorization;
  }
  function getBinding(queueId: string): ThreadedBinding | null {
    const row = queueRow(queueId);
    if (!row || !row.generation) return null;
    const d = db.prepare('SELECT * FROM threaded_queue_claims WHERE queue_id=? AND generation=?')
      .get(row.id, row.generation) as DispatchRow | undefined;
    return d ? currentBinding(d) : null;
  }
  return {
    enqueueWake, scanPending, claimNext, assertExecutable, authorizationForBinding, getBinding,
    getQueue(id: string) { const row = queueRow(id); return row ? record(row) : null; },
    getQueueForWake(id: string) { const row = queueForWake(id); return row ? record(row) : null; },
    getDispatchForBinding(binding: ThreadedBinding) { return dispatchRecord(exactDispatch(binding)); },
    refreshEligibility(id: string): ThreadedQueueRecord {
      return db.transaction(() => { const row = queueRow(id); if (!row) deny('THREADED_QUEUE_NOT_FOUND');
        return record(refreshWithin(row)); }).immediate();
    },
    renew(binding: ThreadedBinding): void {
      db.transaction(() => {
        assertExecutable(binding);
        const d = exactDispatch(binding);
        db.prepare('UPDATE threaded_queue_claims SET lease_expires_at=?,updated_at=? WHERE id=?')
          .run(new Date(time() + leaseMs).toISOString(), stamp(), d.id);
      }).immediate();
    },
    startWithinTransaction(binding: ThreadedBinding): void {
      if (!db.inTransaction) deny('THREADED_QUEUE_TRANSACTION_REQUIRED');
      assertExecutable(binding);
      const d = exactDispatch(binding);
      if (d.phase !== 'prepared') deny('THREADED_QUEUE_ALREADY_STARTED');
      db.prepare("UPDATE threaded_queue_claims SET phase='started',updated_at=? WHERE id=?").run(stamp(), d.id);
      notify(d.queue_id, 'started');
    },
    applyOutcomeWithinTransaction(binding: ThreadedBinding): void {
      if (!db.inTransaction) deny('THREADED_QUEUE_TRANSACTION_REQUIRED');
      const d = exactDispatch(binding), row = queueRow(d.queue_id)!, inv = invocation(binding.invocationId)!;
      if (inv.status === 'unknown') {
        if (d.phase !== 'unknown') db.prepare("UPDATE threaded_queue_claims SET phase='unknown',updated_at=? WHERE id=?").run(stamp(), d.id);
        state(row, 'unknown', 'THREADED_QUEUE_EXECUTION_UNKNOWN'); return;
      }
      const attempt = db.prepare('SELECT execution_stage FROM threaded_attempts WHERE id=?').get(binding.attemptId) as { execution_stage: string };
      if (attempt.execution_stage !== 'quiescent') deny('THREADED_QUEUE_QUIESCENCE_REQUIRED');
      if (d.phase !== 'settled') db.prepare("UPDATE threaded_queue_claims SET phase='settled',updated_at=? WHERE id=?").run(stamp(), d.id);
      state(row, inv.status === 'queued' ? 'queued' : inv.status === 'waiting' ? 'blocked'
        : inv.status === 'cancelled' ? 'cancelled' : 'settled', inv.status === 'waiting' ? 'THREADED_QUEUE_WAITING' : null);
    },
    recover(): ThreadedQueueRecoveryPlan[] {
      scanPending();
      return db.transaction(() => (db.prepare(`SELECT c.* FROM threaded_queue_claims c JOIN threaded_wake_queue q
        ON q.id=c.queue_id AND q.generation=c.generation WHERE c.owner_id=? ORDER BY q.seq`)
        .all(ownerId) as DispatchRow[]).map(d => {
        const a = db.prepare('SELECT execution_stage,resource_release_state FROM threaded_attempts WHERE id=?')
          .get(d.attempt_id) as { execution_stage: string; resource_release_state: string | null };
        const inv = invocation(d.invocation_id)!;
        if (a.execution_stage === 'unknown' && d.phase !== 'unknown') {
          db.prepare("UPDATE threaded_queue_claims SET phase='unknown',updated_at=? WHERE id=?").run(stamp(), d.id);
          state(queueRow(d.queue_id)!, 'unknown', 'THREADED_QUEUE_EXECUTION_UNKNOWN');
          d.phase = 'unknown';
        }
        // Owner controls can terminalize a previously reconciled Attempt without
        // a new executor outcome. Repair only from its persisted current terminal,
        // never from lease expiry or an obsolete dispatch generation.
        if (inv.current_attempt_id === d.attempt_id && a.execution_stage === 'quiescent'
          && ['completed', 'failed', 'cancelled'].includes(inv.status)) {
          if (d.phase !== 'settled') {
            db.prepare("UPDATE threaded_queue_claims SET phase='settled',updated_at=? WHERE id=?").run(stamp(), d.id);
            d.phase = 'settled';
          }
          state(queueRow(d.queue_id)!, inv.status === 'cancelled' ? 'cancelled' : 'settled', null);
        }
        // A restart fence and persisted execution boundary are evidence. Expiry
        // alone neither proves non-start nor grants a successor permission.
        const action: ThreadedQueueRecoveryPlan['action'] = a.resource_release_state === 'pending' ? 'release_pending'
          : a.execution_stage === 'unknown' || d.phase === 'unknown' ? 'unknown'
            : a.execution_stage === 'not_started' && inv.recovery_reason === 'PROCESS_RESTART_NOT_STARTED'
              ? 'not_started' : 'none';
        return { queueId: d.queue_id, invocationId: d.invocation_id, dispatch: dispatchRecord(d),
          binding: currentBinding(d), action };
      })).immediate();
    },
    onAvailable(listener: (event: ThreadedQueueEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    scanEvents: emitChanges,
  };
}

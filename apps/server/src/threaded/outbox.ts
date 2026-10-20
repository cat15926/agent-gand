import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createThreadedMessageAcl } from './acl.ts';
import type { ThreadedAclMessage } from './acl.ts';

export type ThreadedOutboxEventType = 'message.created' | 'wake.available';

/** An internal invalidation hint, never a message body, execution request or backend ACK. */
export interface ThreadedInternalNotification {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly eventType: ThreadedOutboxEventType;
  readonly ownerId: string;
  readonly threadId: string;
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly authorityEpoch: number;
}

export interface ThreadedOutboxClaim {
  readonly id: string;
  readonly ownerId: string;
  readonly threadId: string;
  readonly eventType: string;
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly authorityEpoch: number;
  readonly workerId: string;
  readonly ownerNonce: string;
  readonly generation: number;
  readonly fencingToken: string;
  readonly leaseExpiresAt: string;
}

export interface ThreadedWakeSource {
  readonly ownerId: string;
  readonly threadId: string;
  readonly wakeId: string;
  readonly messageId: string;
  readonly agentId: string;
  readonly authorityEpoch: number;
}

export class ThreadedOutboxError extends Error {
  readonly status = 409;
  constructor(readonly code: string) { super(code); this.name = 'ThreadedOutboxError'; }
}

type OutboxRow = {
  seq: number; id: string; owner_id: string; thread_id: string; schema_version: number;
  event_type: string; source_id: string; source_version: number; authority_epoch: number;
  status: 'pending' | 'claimed' | 'acked' | 'rejected'; generation: number;
  claim_owner: string | null; owner_nonce: string | null; fencing_token: string | null;
  lease_expires_at: string | null; available_at: string;
};
type MessageRow = {
  id: string; owner_id: string; thread_id: string; schema_version: number; authority_epoch: number;
  state: string; visibility: string; sender_agent_id: string | null; audience: string; targets: string; record: string;
};
type WakeRow = {
  id: string; owner_id: string; thread_id: string; source_message_id: string; delivery_id: string;
  target_agent_id: string; version: number; routing_revision: number; purpose: string; status: string;
  target_member_version: number; target_permission_version: number; authority_epoch: number;
};
function deny(code: string): never { throw new ThreadedOutboxError(code); }
function text(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) deny('THREADED_OUTBOX_INVALID_INPUT');
}
function strings(value: string): string[] | null {
  try {
    const decoded: unknown = JSON.parse(value);
    return Array.isArray(decoded) && decoded.every(item => typeof item === 'string') ? decoded : null;
  } catch { return null; }
}
const identity = (row: OutboxRow): ThreadedOutboxClaim => Object.freeze({
  id: row.id, ownerId: row.owner_id, threadId: row.thread_id, eventType: row.event_type,
  sourceId: row.source_id, sourceVersion: row.source_version, authorityEpoch: row.authority_epoch,
  workerId: row.claim_owner!, ownerNonce: row.owner_nonce!, generation: row.generation,
  fencingToken: row.fencing_token!, leaseExpiresAt: row.lease_expires_at!,
});

/**
 * DB-injected, synchronous durable notification port. No singleton, network, executor or timer.
 * Hints are at-least-once. Consumers deduplicate their own durable effect by event/source identity.
 * Receipt/ack here means internal notification consumption, never delivered/seen/mention_ack.
 */
export function createThreadedOutbox(db: Database.Database, options: {
  now?: () => number;
  leaseMs?: number;
  /** Additional synchronous server policy. Throwing or returning false blocks the Wake. */
  authorizeWake?: (source: ThreadedWakeSource) => boolean;
} = {}) {
  if (db.pragma('foreign_keys', { simple: true }) !== 1) deny('THREADED_OUTBOX_FOREIGN_KEYS_REQUIRED');
  const ownerId = (db.prepare('SELECT instance_owner_id FROM threaded_instances WHERE singleton=1').get() as
    { instance_owner_id: string } | undefined)?.instance_owner_id;
  if (!ownerId) deny('THREADED_OUTBOX_OWNER_REQUIRED');
  const now = options.now ?? Date.now;
  const acl = createThreadedMessageAcl(db);
  const leaseMs = options.leaseMs ?? 15_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 3_600_000) deny('THREADED_OUTBOX_INVALID_LEASE');
  const time = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) deny('THREADED_OUTBOX_INVALID_CLOCK');
    return value;
  };
  const iso = (value: number) => new Date(value).toISOString();
  const row = (id: string) => db.prepare('SELECT * FROM threaded_outbox WHERE id=? AND owner_id=?').get(id, ownerId) as OutboxRow | undefined;
  const sameIdentity = (stored: OutboxRow, claim: ThreadedOutboxClaim) =>
    stored.id === claim.id && stored.owner_id === claim.ownerId && stored.thread_id === claim.threadId &&
    stored.event_type === claim.eventType && stored.source_id === claim.sourceId &&
    stored.source_version === claim.sourceVersion && stored.authority_epoch === claim.authorityEpoch &&
    stored.claim_owner === claim.workerId && stored.owner_nonce === claim.ownerNonce &&
    stored.generation === claim.generation && stored.fencing_token === claim.fencingToken;
  function current(claim: ThreadedOutboxClaim, allowTerminal = false): OutboxRow {
    const stored = row(claim.id);
    if (!stored || !sameIdentity(stored, claim)) deny('THREADED_OUTBOX_STALE_CLAIM');
    if (!allowTerminal || stored.status === 'claimed') {
      if (stored.status !== 'claimed' || !stored.lease_expires_at || stored.lease_expires_at <= iso(time())) {
        deny('THREADED_OUTBOX_STALE_CLAIM');
      }
    }
    return stored;
  }
  const fenceArgs = (claim: ThreadedOutboxClaim) =>
    [claim.id, claim.ownerId, claim.generation, claim.workerId, claim.ownerNonce, claim.fencingToken] as const;
  const fence = 'id=? AND owner_id=? AND generation=? AND claim_owner=? AND owner_nonce=? AND fencing_token=?';
  const message = (id: string, threadId: string) => db.prepare(`SELECT * FROM threaded_messages
    WHERE id=? AND owner_id=? AND thread_id=?`).get(id, ownerId, threadId) as MessageRow | undefined;
  const wake = (id: string, threadId: string) => db.prepare(`SELECT * FROM threaded_wakes
    WHERE id=? AND owner_id=? AND thread_id=?`).get(id, ownerId, threadId) as WakeRow | undefined;
  function blockWake(source: WakeRow): void {
    db.prepare(`UPDATE threaded_wakes SET status='blocked',version=version+1,updated_at=?
      WHERE id=? AND owner_id=? AND thread_id=? AND status='pending' AND version=?`)
      .run(iso(time()), source.id, ownerId, source.thread_id, source.version);
    // The source and its outbox remain durable; no Invocation or backend delivery is changed.
  }
  function authorizedWake(source: WakeRow): { value: ThreadedWakeSource | null; error: string } {
    if (source.status !== 'pending' || source.purpose !== 'message' || source.routing_revision !== 1) {
      return { value: null, error: 'THREADED_WAKE_NOT_PENDING' };
    }
    const origin = message(source.source_message_id, source.thread_id);
    const delivery = db.prepare(`SELECT 1 FROM threaded_deliveries WHERE id=? AND owner_id=? AND thread_id=?
      AND message_id=? AND target_agent_id=? AND purpose=? AND routing_revision=?`)
      .get(source.delivery_id, ownerId, source.thread_id, source.source_message_id,
        source.target_agent_id, source.purpose, source.routing_revision);
    const thread = db.prepare(`SELECT state,authority_epoch FROM threaded_threads
      WHERE id=? AND owner_id=?`).get(source.thread_id, ownerId) as { state: string; authority_epoch: number } | undefined;
    const member = db.prepare(`SELECT m.status,m.version,m.permission_version,m.role_version,a.enabled,a.version agent_version
      FROM threaded_members m JOIN agents a ON a.id=m.agent_id
      WHERE m.thread_id=? AND m.owner_id=? AND m.agent_id=?`)
      .get(source.thread_id, ownerId, source.target_agent_id) as
        { status: string; enabled: number; version: number; permission_version: number; role_version: number; agent_version: number } | undefined;
    const audience = origin ? strings(origin.audience) : null;
    const targets = origin ? strings(origin.targets) : null;
    if (!delivery || !origin || origin.schema_version !== 1 || origin.state !== 'published' || !thread ||
      !['open', 'paused'].includes(thread.state) || origin.authority_epoch !== thread.authority_epoch ||
      source.authority_epoch !== origin.authority_epoch || !member || member.status !== 'joined' || member.enabled !== 1 ||
      member.role_version !== member.agent_version ||
      source.target_member_version !== member.version || source.target_permission_version !== member.permission_version ||
      !audience || !targets ||
      !targets.includes(source.target_agent_id) ||
      (origin.visibility !== 'public' && !(origin.visibility === 'private' &&
        (audience.includes(source.target_agent_id) || origin.sender_agent_id === source.target_agent_id)))) {
      return { value: null, error: 'THREADED_WAKE_AUTHORITY_CHANGED' };
    }
    try {
      if (!acl.canRead({ ownerId: source.owner_id, threadId: source.thread_id,
        viewer: { kind: 'agent', agentId: source.target_agent_id } }, JSON.parse(origin.record) as ThreadedAclMessage)) {
        return { value: null, error: 'THREADED_WAKE_SOURCE_FORBIDDEN' };
      }
    } catch { return { value: null, error: 'THREADED_WAKE_SOURCE_FORBIDDEN' }; }
    const value: ThreadedWakeSource = Object.freeze({
      ownerId: source.owner_id, threadId: source.thread_id, wakeId: source.id,
      messageId: source.source_message_id, agentId: source.target_agent_id, authorityEpoch: origin.authority_epoch,
    });
    if (options.authorizeWake) {
      try { if (options.authorizeWake(value) !== true) return { value: null, error: 'THREADED_WAKE_POLICY_BLOCKED' }; }
      catch { return { value: null, error: 'THREADED_WAKE_POLICY_BLOCKED' }; }
    }
    return { value, error: '' };
  }
  function notificationInTransaction(claim: ThreadedOutboxClaim): ThreadedInternalNotification | null {
    const stored = current(claim);
    let error = '';
    if (stored.schema_version !== 1 || !['message.created', 'wake.available'].includes(stored.event_type)) {
      error = 'THREADED_OUTBOX_UNKNOWN_EVENT';
    } else if (stored.event_type === 'message.created') {
      const source = message(stored.source_id, stored.thread_id);
      if (!source || source.schema_version !== stored.source_version || source.authority_epoch !== stored.authority_epoch) {
        error = 'THREADED_OUTBOX_SOURCE_MISMATCH';
      }
    } else {
      const source = wake(stored.source_id, stored.thread_id);
      const origin = source && message(source.source_message_id, source.thread_id);
      if (!source || source.version !== stored.source_version || origin?.authority_epoch !== stored.authority_epoch) {
        error = 'THREADED_OUTBOX_SOURCE_MISMATCH';
      } else {
        const authorization = authorizedWake(source);
        if (!authorization.value) { error = authorization.error; blockWake(source); }
      }
    }
    // A policy hook can take time; never let its result revive an expired/replaced claim.
    current(claim);
    if (error) {
      db.prepare(`UPDATE threaded_outbox SET status='rejected',last_error=?,updated_at=?
        WHERE ${fence} AND status='claimed'`).run(error, iso(time()), ...fenceArgs(claim));
      return null;
    }
    return Object.freeze({
      schemaVersion: 1, eventId: stored.id, eventType: stored.event_type as ThreadedOutboxEventType,
      ownerId: stored.owner_id, threadId: stored.thread_id, sourceId: stored.source_id,
      sourceVersion: stored.source_version, authorityEpoch: stored.authority_epoch,
    });
  }
  function claim(workerId: string): ThreadedOutboxClaim | null {
    text(workerId);
    return db.transaction(() => {
      const stamp = iso(time());
      const candidate = db.prepare(`SELECT * FROM threaded_outbox WHERE owner_id=? AND available_at<=?
        AND (status='pending' OR (status='claimed' AND lease_expires_at<=?))
        ORDER BY seq LIMIT 1`).get(ownerId, stamp, stamp) as OutboxRow | undefined;
      if (!candidate) return null;
      const ownerNonce = randomUUID(), fencingToken = randomUUID();
      const expires = iso(time() + leaseMs);
      const changed = db.prepare(`UPDATE threaded_outbox SET status='claimed',generation=generation+1,
        claim_owner=?,owner_nonce=?,fencing_token=?,lease_expires_at=?,attempts=attempts+1,updated_at=?
        WHERE id=? AND owner_id=? AND generation=?
        AND (status='pending' OR (status='claimed' AND lease_expires_at<=?))`)
        .run(workerId, ownerNonce, fencingToken, expires, stamp, candidate.id, ownerId, candidate.generation, stamp);
      return changed.changes === 1 ? identity(row(candidate.id)!) : null;
    }).immediate();
  }
  function renew(claimed: ThreadedOutboxClaim): ThreadedOutboxClaim {
    return db.transaction(() => {
      current(claimed);
      db.prepare(`UPDATE threaded_outbox SET lease_expires_at=?,updated_at=? WHERE ${fence} AND status='claimed'`)
        .run(iso(time() + leaseMs), iso(time()), ...fenceArgs(claimed));
      return identity(row(claimed.id)!);
    }).immediate();
  }
  function release(claimed: ThreadedOutboxClaim, input: { error?: string; delayMs?: number } = {}): void {
    const delay = input.delayMs ?? 0;
    if (!Number.isSafeInteger(delay) || delay < 0 || delay > 3_600_000) deny('THREADED_OUTBOX_INVALID_DELAY');
    if (input.error !== undefined) text(input.error);
    db.transaction(() => {
      const stored = current(claimed, true);
      if (stored.status === 'pending') return;
      if (stored.status !== 'claimed') deny('THREADED_OUTBOX_STALE_CLAIM');
      db.prepare(`UPDATE threaded_outbox SET status='pending',available_at=?,last_error=?,updated_at=?
        WHERE ${fence} AND status='claimed'`)
        .run(iso(time() + delay), input.error ?? null, iso(time()), ...fenceArgs(claimed));
    }).immediate();
  }
  function notification(claimed: ThreadedOutboxClaim): ThreadedInternalNotification | null {
    return db.transaction(() => notificationInTransaction(claimed)).immediate();
  }
  function ack(claimed: ThreadedOutboxClaim, consumerId: string): boolean {
    text(consumerId);
    return db.transaction(() => {
      const stored = current(claimed, true);
      const existingReceipt = () => db.prepare(`SELECT thread_id,authority_epoch FROM threaded_outbox_receipts
        WHERE owner_id=? AND consumer_id=? AND event_type=? AND source_id=? AND source_version=?`)
        .get(stored.owner_id, consumerId, stored.event_type, stored.source_id, stored.source_version) as
          { thread_id: string; authority_epoch: number } | undefined;
      if (stored.status === 'acked') {
        const receipt = existingReceipt();
        if (!receipt || receipt.thread_id !== stored.thread_id || receipt.authority_epoch !== stored.authority_epoch) {
          deny('THREADED_OUTBOX_CONSUMER_MISMATCH');
        }
        return false;
      }
      if (stored.status !== 'claimed') deny('THREADED_OUTBOX_STALE_CLAIM');
      if (!notificationInTransaction(claimed)) return false;
      const stamp = iso(time());
      const receipt = db.prepare(`INSERT OR IGNORE INTO threaded_outbox_receipts
        (outbox_id,consumer_id,owner_id,thread_id,source_id,source_version,event_type,authority_epoch,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(stored.id, consumerId, stored.owner_id, stored.thread_id,
          stored.source_id, stored.source_version, stored.event_type, stored.authority_epoch, stamp);
      const confirmed = existingReceipt();
      if (!confirmed || confirmed.thread_id !== stored.thread_id || confirmed.authority_epoch !== stored.authority_epoch) {
        deny('THREADED_OUTBOX_CONSUMER_MISMATCH');
      }
      db.prepare(`UPDATE threaded_outbox SET status='acked',acked_at=?,updated_at=?
        WHERE ${fence} AND status='claimed'`).run(stamp, stamp, ...fenceArgs(claimed));
      return receipt.changes === 1;
    }).immediate();
  }
  return {
    claim, renew, release, notification, ack,
    /** A synchronous process-local hint callback only. Never pass network/business operations. */
    dispatchOne(workerId: string, consumerId: string, notify: (hint: ThreadedInternalNotification) => void):
      { status: 'empty' | 'acked' | 'rejected' | 'retry'; eventId?: string } {
      if (db.inTransaction) deny('THREADED_OUTBOX_NOTIFY_IN_TRANSACTION');
      text(consumerId);
      const acquired = claim(workerId);
      if (!acquired) return { status: 'empty' };
      const hint = notification(acquired);
      if (!hint) return { status: 'rejected', eventId: acquired.id };
      try {
        const result: unknown = notify(hint);
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          // No async transport contract in T05; drain a rejected promise without awaiting it.
          void Promise.resolve(result).catch(() => {});
          deny('THREADED_OUTBOX_ASYNC_NOTIFY_FORBIDDEN');
        }
      } catch {
        try { release(acquired, { error: 'THREADED_OUTBOX_NOTIFY_FAILED', delayMs: 100 }); }
        catch (error) {
          if (!(error instanceof ThreadedOutboxError) || error.code !== 'THREADED_OUTBOX_STALE_CLAIM') throw error;
        }
        return { status: 'retry', eventId: acquired.id };
      }
      ack(acquired, consumerId);
      return { status: row(acquired.id)?.status === 'acked' ? 'acked' : 'rejected', eventId: acquired.id };
    },
    /** Recovery plan only: callers restart from cursor zero on a repair pass so delayed rows are not lost. */
    scanPending(input: { afterSeq?: number; limit?: number } = {}) {
      const after = input.afterSeq ?? 0, limit = input.limit ?? 100;
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
        deny('THREADED_OUTBOX_INVALID_INPUT');
      }
      const stamp = iso(time());
      const rows = db.prepare(`SELECT * FROM threaded_outbox WHERE owner_id=? AND seq>? AND available_at<=?
        AND (status='pending' OR (status='claimed' AND lease_expires_at<=?)) ORDER BY seq LIMIT ?`)
        .all(ownerId, after, stamp, stamp, limit) as OutboxRow[];
      return { cursor: rows.at(-1)?.seq ?? after, events: rows.map(stored => ({
        id: stored.id, seq: stored.seq, generation: stored.generation, eventType: stored.event_type,
        sourceId: stored.source_id, threadId: stored.thread_id,
      })) };
    },
    /** Recheck durable Wake eligibility without claiming a Wake or creating execution. */
    scanPendingWakes(input: { limit?: number } = {}): ThreadedWakeSource[] {
      const limit = input.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) deny('THREADED_OUTBOX_INVALID_INPUT');
      return db.transaction(() => {
        const sources = db.prepare(`SELECT * FROM threaded_wakes WHERE owner_id=? AND status='pending'
          AND available_at<=? ORDER BY created_at,id LIMIT ?`).all(ownerId, iso(time()), limit) as WakeRow[];
        const result: ThreadedWakeSource[] = [];
        for (const source of sources) {
          const authorization = authorizedWake(source);
          if (authorization.value) result.push(authorization.value);
          else blockWake(source);
        }
        return result;
      }).immediate();
    },
  };
}

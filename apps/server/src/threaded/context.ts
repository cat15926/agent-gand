import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ThreadedBinding, ThreadedMessageRecord } from '@agent-gand/shared';
import { assertResourceSessionCurrent } from '../execution/resources/sessions.ts';
import type { ResourceSessionReference, TrustedResourceRequest } from '../execution/resources/types.ts';
import type { QuiescenceProof, ThreadedAuthority } from './contracts.ts';
import { createThreadedMessageAcl } from './acl.ts';
import type { ThreadedMessageAcl } from './messageContracts.ts';
import { ThreadedContextError } from './contextTypes.ts';
import type { ThreadedContextCursor, ThreadedContextDeliveryOutcome, ThreadedContextItem,
  ThreadedContextManifest, ThreadedContextMessage, ThreadedContextPayload, ThreadedContextPrepareInput,
  ThreadedContextSendIntent, ThreadedPreparedContext } from './contextTypes.ts';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hash = (value: unknown) => digest(JSON.stringify(value));
function fail(code: string): never { throw new ThreadedContextError(code); }
function identifier(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) fail('THREADED_CONTEXT_INVALID_INPUT');
  return value;
}
type ManifestRow = { id: string; binding_id: string; request_hash: string; record: string; payload: string };
type IntentRow = { id: string; manifest_id: string; binding_id: string; request_key: string;
  payload_hash: string; status: ThreadedContextSendIntent['status'] };
const intentRecord = (row: IntentRow): ThreadedContextSendIntent => ({ id: row.id, manifestId: row.manifest_id,
  bindingId: row.binding_id, requestKey: row.request_key, payloadHash: row.payload_hash, status: row.status });
const payload = (messages: ThreadedContextMessage[]): ThreadedContextPayload => ({
  messages, serialized: JSON.stringify({ messages }),
});

/** Injected storage only. This module never starts a provider or treats a notification as delivery. */
export function createThreadedContext(db: Database.Database, options: {
  authority: ThreadedAuthority;
  acl?: ThreadedMessageAcl;
  assertExecutable?: (binding: ThreadedBinding) => void;
  tokenEstimator?: { id: string; estimate: (serialized: string) => number };
  verifyDeliveryEvidence?: (binding: ThreadedBinding, manifest: ThreadedContextManifest,
    intent: ThreadedContextSendIntent, outcome: ThreadedContextDeliveryOutcome) => boolean;
  now?: () => number;
}) {
  if (db.pragma('foreign_keys', { simple: true }) !== 1) fail('THREADED_CONTEXT_FOREIGN_KEYS_REQUIRED');
  const acl = options.acl ?? createThreadedMessageAcl(db), now = options.now ?? Date.now;
  const estimator = options.tokenEstimator ?? { id: 'utf8-bytes-v1', estimate: (text: string) => Buffer.byteLength(text, 'utf8') };
  identifier(estimator.id);
  const stamp = () => new Date(now()).toISOString();
  const estimate = (text: string) => {
    const value = estimator.estimate(text);
    if (!Number.isSafeInteger(value) || value < 0 || (text.length > 0 && value === 0)) fail('THREADED_CONTEXT_INVALID_ESTIMATE');
    return value;
  };
  const manifestRow = (id: string) => db.prepare('SELECT * FROM threaded_context_manifests WHERE id=?').get(id) as ManifestRow | undefined;
  const intentRow = (id: string) => db.prepare('SELECT * FROM threaded_context_send_intents WHERE id=?').get(id) as IntentRow | undefined;
  const message = (id: string) => {
    const row = db.prepare('SELECT record FROM threaded_messages WHERE id=?').get(id) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as ThreadedMessageRecord : null;
  };
  function canonical(binding: ThreadedBinding): void {
    const claim = options.authority.claim(binding);
    if (claim.ownerId !== binding.ownerId || claim.threadId !== binding.threadId || claim.agentId !== binding.agentId
      || claim.invocationId !== binding.invocationId || claim.attemptId !== binding.attemptId || claim.runId !== binding.runId
      || claim.claimId !== binding.claimId || claim.generation !== binding.generation
      || claim.fencingToken !== binding.fencingToken) fail('THREADED_CONTEXT_BINDING_MISMATCH');
  }
  function executable(binding: ThreadedBinding, started = false): void {
    canonical(binding); options.authority.assertAuthorized(binding); options.assertExecutable?.(binding);
    if (started) {
      const attempt = db.prepare('SELECT execution_stage FROM threaded_attempts WHERE id=?').get(binding.attemptId) as { execution_stage: string } | undefined;
      if (attempt?.execution_stage !== 'started') fail('THREADED_CONTEXT_NOT_STARTED');
    }
  }
  function sessionCurrent(binding: ThreadedBinding, session: ResourceSessionReference): void {
    const row = db.prepare(`SELECT t.request FROM execution_resource_claims c
      JOIN execution_resource_tickets t ON t.id=c.ticket_id WHERE c.id=?`).get(binding.claimId) as { request: string } | undefined;
    if (!row) fail('THREADED_CONTEXT_RESOURCE_MISSING');
    const request = JSON.parse(row.request) as TrustedResourceRequest, expected = request.session;
    if (!expected || expected.id !== session.id || expected.version !== session.version || expected.nativeId !== session.nativeId
      || expected.resourceKey !== session.resourceKey || request.ownerId !== binding.ownerId || request.threadId !== binding.threadId
      || request.agentId !== binding.agentId || request.attemptId !== binding.attemptId) fail('THREADED_CONTEXT_SESSION_MISMATCH');
    assertResourceSessionCurrent(db, request);
  }
  function aclFingerprint(binding: ThreadedBinding, root: ThreadedMessageRecord): string | null {
    const pending = [root], visited = new Set<string>(), facts: unknown[] = [];
    while (pending.length) {
      const current = pending.pop()!;
      if (visited.has(current.id)) continue;
      if (visited.size >= 1000 || current.ownerId !== binding.ownerId || current.state !== 'published'
        || !acl.canRead({ ownerId: binding.ownerId, threadId: current.threadId,
          viewer: { kind: 'agent', agentId: binding.agentId } }, current)) return null;
      visited.add(current.id);
      const member = db.prepare(`SELECT m.version,m.permission_version,m.role_version,m.account_version,m.status,
        a.enabled,a.version agent_version,a.definition FROM threaded_members m JOIN agents a ON a.id=m.agent_id
        WHERE m.owner_id=? AND m.thread_id=? AND m.agent_id=?`)
        .get(binding.ownerId, current.threadId, binding.agentId);
      if (!member) return null;
      facts.push({ id: current.id, messageHash: hash(current), member });
      for (const id of current.sourceRefs) { const parent = message(id); if (!parent) return null; pending.push(parent); }
    }
    return hash(facts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  }
  function modelMessage(binding: ThreadedBinding, value: ThreadedMessageRecord): ThreadedContextMessage {
    if (!aclFingerprint(binding, value)) fail('THREADED_CONTEXT_SOURCE_FORBIDDEN');
    const attachments = value.attachments.map(metadata => {
      const row = db.prepare(`SELECT content FROM threaded_message_attachments
        WHERE id=? AND message_id=? AND owner_id=? AND thread_id=?`)
        .get(metadata.id, value.id, value.ownerId, value.threadId) as { content: Buffer } | undefined;
      if (!row || row.content.length !== metadata.byteLength || digest(row.content) !== metadata.contentHash) {
        fail('THREADED_CONTEXT_ATTACHMENT_CORRUPTED');
      }
      return { ...metadata, encoding: 'base64' as const, contentBase64: row.content.toString('base64') };
    });
    return { id: value.id, seq: value.seq, sender: value.sender, origin: value.origin,
      body: value.body, bodyHash: value.bodyHash, sourceRefs: value.sourceRefs, attachments };
  }
  function loadManifest(id: string): ThreadedContextManifest | null {
    const row = manifestRow(id);
    return row ? JSON.parse(row.record) as ThreadedContextManifest : null;
  }
  function nativeCutoffCurrent(binding: ThreadedBinding, session: ResourceSessionReference, inputMaxSeq: number): void {
    if (!session.nativeId) return;
    // Omitting a later message from this prompt cannot remove it from native
    // memory. Possible sends count too until trusted evidence proves not_sent.
    if (db.prepare(`SELECT 1 FROM threaded_context_send_intents s
      JOIN threaded_context_manifest_items i ON i.manifest_id=s.manifest_id AND i.decision='included'
      JOIN threaded_messages m ON m.id=i.message_id
      WHERE s.session_id=? AND s.session_version=? AND s.status<>'not_sent'
        AND m.owner_id=? AND m.thread_id=? AND m.seq>? LIMIT 1`)
      .get(session.id, session.version, binding.ownerId, binding.threadId, inputMaxSeq)) {
      fail('THREADED_CONTEXT_NATIVE_CUTOFF_REQUIRES_COLD');
    }
  }
  function assertManifestCurrent(binding: ThreadedBinding, id: string, evidence?: { quiescence?: QuiescenceProof }): ThreadedContextManifest {
    if (evidence?.quiescence) { canonical(binding); options.authority.assertAuthorized(binding, evidence); }
    else executable(binding);
    const row = manifestRow(id), manifest = row && JSON.parse(row.record) as ThreadedContextManifest;
    if (!row || !manifest || manifest.bindingId !== binding.id || manifest.attemptId !== binding.attemptId
      || manifest.ownerId !== binding.ownerId || manifest.threadId !== binding.threadId || manifest.agentId !== binding.agentId
      || manifest.invocationId !== binding.invocationId) fail('THREADED_CONTEXT_MANIFEST_MISMATCH');
    sessionCurrent(binding, manifest.session);
    nativeCutoffCurrent(binding, manifest.session, manifest.inputMaxSeq);
    if (manifest.state !== 'ready') fail(manifest.reason ?? 'THREADED_CONTEXT_BLOCKED');
    if (digest(row.payload) !== manifest.payloadHash) fail('THREADED_CONTEXT_PAYLOAD_CORRUPTED');
    for (const item of manifest.items.filter(item => item.decision === 'included' || item.decision === 'already_delivered')) {
      const current = message(item.messageId);
      if (!current || current.seq > manifest.inputMaxSeq || hash(current) !== item.messageHash
        || aclFingerprint(binding, current) !== item.aclHash) fail('THREADED_CONTEXT_SOURCE_AUTHORITY_CHANGED');
      modelMessage(binding, current); // Recheck attachment ownership and bytes at the send boundary.
    }
    return manifest;
  }
  function prepareManifest(binding: ThreadedBinding, input: ThreadedContextPrepareInput): ThreadedPreparedContext {
    return db.transaction(() => {
      executable(binding); sessionCurrent(binding, input.session); identifier(input.requestKey);
      if (!['reconstructed', 'native_incremental'].includes(input.mode)
        || input.mode === 'native_incremental' && !input.session.nativeId
        || !Number.isSafeInteger(input.budget.maxInputTokens) || input.budget.maxInputTokens < 1 || input.budget.maxInputTokens > 10_000_000
        || !Number.isSafeInteger(input.budget.reservedSystemTokens) || input.budget.reservedSystemTokens < 0
        || input.budget.reservedSystemTokens >= input.budget.maxInputTokens) fail('THREADED_CONTEXT_INVALID_BUDGET');
      const requestHash = hash({ input, estimatorId: estimator.id });
      const existing = db.prepare('SELECT * FROM threaded_context_manifests WHERE binding_id=? AND request_key=?')
        .get(binding.id, input.requestKey) as ManifestRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) fail('THREADED_CONTEXT_IDEMPOTENCY_CONFLICT');
        const saved = JSON.parse(existing.record) as ThreadedContextManifest;
        if (saved.state === 'ready') assertManifestCurrent(binding, saved.id);
        return { manifest: saved, payload: { ...JSON.parse(existing.payload), serialized: existing.payload } as ThreadedContextPayload };
      }
      const wake = db.prepare(`SELECT source_message_id,wave_id,input_max_seq FROM threaded_invocation_wakes
        WHERE invocation_id=? AND owner_id=? AND thread_id=? AND agent_id=?`)
        .get(binding.invocationId, binding.ownerId, binding.threadId, binding.agentId) as
        { source_message_id: string; wave_id: string; input_max_seq: number } | undefined;
      if (!wake) fail('THREADED_CONTEXT_WAKE_REQUIRED');
      nativeCutoffCurrent(binding, input.session, wake.input_max_seq);
      const records = (db.prepare('SELECT record FROM threaded_messages WHERE owner_id=? AND thread_id=? AND seq<=? ORDER BY seq')
        .all(binding.ownerId, binding.threadId, wake.input_max_seq) as Array<{ record: string }>)
        .map(row => JSON.parse(row.record) as ThreadedMessageRecord);
      const source = records.find(value => value.id === wake.source_message_id);
      if (!source || !aclFingerprint(binding, source)) fail('THREADED_CONTEXT_SOURCE_FORBIDDEN');
      const items: ThreadedContextItem[] = records.map(value => {
        const fingerprint = value.state === 'published' ? aclFingerprint(binding, value) : null;
        const delivered = input.mode === 'native_incremental' && value.id !== source.id && fingerprint
          && db.prepare(`SELECT 1 FROM threaded_context_deliveries WHERE session_id=? AND session_version=?
            AND message_id=? AND message_hash=?`).get(input.session.id, input.session.version, value.id, hash(value));
        return { messageId: value.id, seq: value.seq, bodyHash: value.bodyHash, messageHash: hash(value),
          attachmentHashes: value.attachments.map(a => ({ id: a.id, contentHash: a.contentHash })), sourceRefs: value.sourceRefs,
          acl: fingerprint ? 'allowed' : 'denied', aclHash: fingerprint, purpose: value.id === source.id ? 'wake_source' : 'history',
          estimatedTokens: 0, truncated: false,
          decision: value.state !== 'published' ? 'unpublished' : !fingerprint ? 'denied_acl' : delivered ? 'already_delivered' : 'deferred_budget' };
      });
      const included: ThreadedContextMessage[] = [], available = input.budget.maxInputTokens - input.budget.reservedSystemTokens;
      let blocked = false;
      for (const value of [source, ...records.filter(value => value.id !== source.id)]) {
        const item = items.find(item => item.messageId === value.id)!;
        if (item.decision !== 'deferred_budget') continue;
        const selected = modelMessage(binding, value);
        item.estimatedTokens = estimate(JSON.stringify(selected));
        const candidate = [...included, selected].sort((a, b) => a.seq - b.seq);
        if (!blocked && estimate(payload(candidate).serialized) <= available) {
          included.push(selected); item.decision = 'included';
        } else if (value.id === source.id) blocked = true;
      }
      const modelPayload = payload(included.sort((a, b) => a.seq - b.seq));
      const manifest: ThreadedContextManifest = { schemaVersion: 1, id: randomUUID(), ownerId: binding.ownerId,
        threadId: binding.threadId, agentId: binding.agentId, invocationId: binding.invocationId, attemptId: binding.attemptId,
        bindingId: binding.id, sourceMessageId: source.id, waveId: wake.wave_id, inputMaxSeq: wake.input_max_seq,
        session: input.session, mode: input.mode, budget: input.budget, estimatorId: estimator.id,
        state: blocked ? 'blocked' : 'ready', reason: blocked ? 'THREADED_CONTEXT_SOURCE_OVER_BUDGET' : null,
        estimatedTokens: estimate(modelPayload.serialized) + input.budget.reservedSystemTokens,
        items, payloadHash: digest(modelPayload.serialized), createdAt: stamp() };
      db.prepare(`INSERT INTO threaded_context_manifests(id,owner_id,thread_id,agent_id,invocation_id,attempt_id,binding_id,
        session_id,session_version,request_key,request_hash,payload_hash,record,payload,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(manifest.id, binding.ownerId, binding.threadId, binding.agentId, binding.invocationId, binding.attemptId, binding.id,
          input.session.id, input.session.version, input.requestKey, requestHash, manifest.payloadHash, JSON.stringify(manifest),
          modelPayload.serialized, manifest.createdAt);
      for (const [position, item] of items.entries()) db.prepare(`INSERT INTO threaded_context_manifest_items
        (manifest_id,message_id,position,decision,record) VALUES(?,?,?,?,?)`).run(manifest.id, item.messageId, position, item.decision, JSON.stringify(item));
      return { manifest, payload: modelPayload };
    }).immediate();
  }
  function markSending(binding: ThreadedBinding, manifestId: string, requestKey: string): ThreadedContextSendIntent {
    return db.transaction(() => {
      executable(binding, true); identifier(requestKey);
      const manifest = assertManifestCurrent(binding, manifestId);
      const existing = db.prepare('SELECT * FROM threaded_context_send_intents WHERE binding_id=? AND request_key=?')
        .get(binding.id, requestKey) as IntentRow | undefined;
      if (existing) {
        if (existing.manifest_id !== manifestId) fail('THREADED_CONTEXT_IDEMPOTENCY_CONFLICT');
        return intentRecord(existing);
      }
      if (db.prepare(`SELECT 1 FROM threaded_context_send_intents WHERE
        (session_id=? AND session_version=? AND status IN ('sending','unknown'))
        OR (manifest_id=? AND status<>'not_sent')`).get(manifest.session.id, manifest.session.version, manifestId)) {
        fail('THREADED_CONTEXT_SEND_RECONCILIATION_REQUIRED');
      }
      const id = randomUUID(), createdAt = stamp();
      db.prepare(`INSERT INTO threaded_context_send_intents(id,manifest_id,binding_id,session_id,session_version,request_key,
        payload_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'sending',?,?)`)
        .run(id, manifestId, binding.id, manifest.session.id, manifest.session.version, requestKey, manifest.payloadHash, createdAt, createdAt);
      return intentRecord(intentRow(id)!);
    }).immediate();
  }
  function cursorFact(binding: ThreadedBinding, kind: ThreadedContextCursor['kind'], value: ThreadedMessageRecord,
    requestKey: string, receiptId: string | null): void {
    db.prepare(`INSERT OR IGNORE INTO threaded_context_cursor_facts(id,owner_id,thread_id,agent_id,kind,message_id,message_seq,
      binding_id,request_key,receipt_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), binding.ownerId, binding.threadId, binding.agentId, kind, value.id, value.seq, binding.id, requestKey, receiptId, stamp());
    db.prepare(`INSERT INTO threaded_context_cursors(owner_id,thread_id,agent_id,kind,max_seq,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,thread_id,agent_id,kind)
      DO UPDATE SET max_seq=MAX(max_seq,excluded.max_seq),updated_at=excluded.updated_at`)
      .run(binding.ownerId, binding.threadId, binding.agentId, kind, value.seq, stamp());
  }
  function recordDeliveryOutcome(binding: ThreadedBinding, outcome: ThreadedContextDeliveryOutcome): ThreadedContextSendIntent {
    return db.transaction(() => {
      canonical(binding); identifier(outcome.evidence.key); identifier(outcome.evidence.reference);
      const row = intentRow(outcome.intentId), manifest = row && loadManifest(row.manifest_id);
      if (!row || !manifest || row.binding_id !== binding.id || manifest.attemptId !== binding.attemptId) fail('THREADED_CONTEXT_INTENT_MISMATCH');
      const outcomeHash = hash(outcome);
      const existing = db.prepare('SELECT outcome_hash FROM threaded_context_send_receipts WHERE intent_id=? AND evidence_key=?')
        .get(row.id, outcome.evidence.key) as { outcome_hash: string } | undefined;
      if (existing) {
        if (existing.outcome_hash !== outcomeHash) fail('THREADED_CONTEXT_IDEMPOTENCY_CONFLICT');
        return intentRecord(row);
      }
      if (!['delivered', 'unknown', 'not_sent'].includes(outcome.status)
        || options.verifyDeliveryEvidence?.(binding, manifest, intentRecord(row), outcome) !== true) fail('THREADED_CONTEXT_DELIVERY_EVIDENCE_REQUIRED');
      if (row.status === 'not_sent') fail('THREADED_CONTEXT_DELIVERY_ALREADY_SETTLED');
      const receiptId = randomUUID();
      db.prepare(`INSERT INTO threaded_context_send_receipts(id,intent_id,evidence_key,outcome_hash,status,record,created_at)
        VALUES(?,?,?,?,?,?,?)`).run(receiptId, row.id, outcome.evidence.key, outcomeHash, outcome.status, JSON.stringify(outcome), stamp());
      if (outcome.status === 'delivered' && row.status !== 'delivered') {
        // Exposure is historical evidence. A late verified receipt remains recordable
        // after revocation, but grants no new send or model execution authority.
        for (const item of manifest.items.filter(item => item.decision === 'included')) {
          const value = message(item.messageId);
          if (!value || hash(value) !== item.messageHash) fail('THREADED_CONTEXT_MESSAGE_CORRUPTED');
          db.prepare(`INSERT INTO threaded_context_deliveries(receipt_id,manifest_id,message_id,owner_id,thread_id,agent_id,
            session_id,session_version,message_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
            .run(receiptId, manifest.id, item.messageId, binding.ownerId, binding.threadId, binding.agentId,
              manifest.session.id, manifest.session.version, item.messageHash, stamp());
          cursorFact(binding, 'delivery', value, receiptId, receiptId);
        }
      }
      // One fixed input may appear in multiple actual backend requests. Each
      // transport receipt remains auditable, but later uncertainty cannot erase
      // a previous confirmed exposure or advance its message cursor twice.
      const status = row.status === 'delivered' ? 'delivered' : outcome.status;
      db.prepare('UPDATE threaded_context_send_intents SET status=?,updated_at=? WHERE id=?').run(status, stamp(), row.id);
      return intentRecord(intentRow(row.id)!);
    }).immediate();
  }
  function markCursor(binding: ThreadedBinding, kind: 'seen' | 'mention_ack', messageIds: string[], requestKey: string): void {
    db.transaction(() => {
      executable(binding, true); identifier(requestKey);
      if (!Array.isArray(messageIds) || !messageIds.length || messageIds.length > 1000) fail('THREADED_CONTEXT_INVALID_INPUT');
      const ids = [...new Set(messageIds.map(identifier))].sort();
      const existing = db.prepare(`SELECT message_id FROM threaded_context_cursor_facts WHERE binding_id=? AND kind=? AND request_key=? ORDER BY message_id`)
        .all(binding.id, kind, requestKey) as Array<{ message_id: string }>;
      if (existing.length && JSON.stringify(existing.map(row => row.message_id)) !== JSON.stringify(ids)) fail('THREADED_CONTEXT_IDEMPOTENCY_CONFLICT');
      for (const id of ids) {
        const value = message(id);
        if (!value || value.threadId !== binding.threadId || !aclFingerprint(binding, value)) fail('THREADED_CONTEXT_SOURCE_FORBIDDEN');
        if (kind === 'mention_ack' && !db.prepare(`SELECT 1 FROM threaded_deliveries
          WHERE message_id=? AND owner_id=? AND thread_id=? AND target_agent_id=?`)
          .get(value.id, binding.ownerId, binding.threadId, binding.agentId)) fail('THREADED_CONTEXT_MENTION_NOT_ADDRESSED');
        cursorFact(binding, kind, value, requestKey, null);
      }
    }).immediate();
  }
  return {
    prepareManifest, markSending, recordDeliveryOutcome, loadManifest, assertManifestCurrent,
    /** Read-only repair candidates. A pending row is never permission to resend. */
    listPendingSends(): ThreadedContextSendIntent[] {
      return (db.prepare(`SELECT s.* FROM threaded_context_send_intents s
        JOIN threaded_context_manifests m ON m.id=s.manifest_id
        JOIN threaded_instances i ON i.singleton=1 AND i.instance_owner_id=m.owner_id
        WHERE s.status IN ('sending','unknown') ORDER BY s.rowid`).all() as IntentRow[]).map(intentRecord);
    },
    getPayload(binding: ThreadedBinding, id: string): ThreadedContextPayload {
      assertManifestCurrent(binding, id);
      const row = manifestRow(id)!;
      return { ...JSON.parse(row.payload), serialized: row.payload } as ThreadedContextPayload;
    },
    markSeen(binding: ThreadedBinding, messageIds: string[], requestKey: string) { markCursor(binding, 'seen', messageIds, requestKey); },
    acknowledgeMentions(binding: ThreadedBinding, messageIds: string[], requestKey: string) { markCursor(binding, 'mention_ack', messageIds, requestKey); },
    getCursors(binding: ThreadedBinding): ThreadedContextCursor[] {
      canonical(binding); options.authority.assertAuthorized(binding);
      return (['delivery', 'seen', 'mention_ack'] as const).map(kind => {
        const cursor = db.prepare(`SELECT max_seq FROM threaded_context_cursors WHERE owner_id=? AND thread_id=? AND agent_id=? AND kind=?`)
          .get(binding.ownerId, binding.threadId, binding.agentId, kind) as { max_seq: number } | undefined;
        const facts = db.prepare(`SELECT DISTINCT message_id,message_seq FROM threaded_context_cursor_facts
          WHERE owner_id=? AND thread_id=? AND agent_id=? AND kind=? ORDER BY message_seq,message_id`)
          .all(binding.ownerId, binding.threadId, binding.agentId, kind) as Array<{ message_id: string }>;
        return { kind, maxSeq: cursor?.max_seq ?? 0, messageIds: facts.flatMap(row => {
          const value = message(row.message_id);
          return value && aclFingerprint(binding, value) ? [value.id] : [];
        }) };
      });
    },
  };
}

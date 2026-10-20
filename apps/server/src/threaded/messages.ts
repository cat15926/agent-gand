import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  ThreadedAttachmentRecord, ThreadedBinding, ThreadedDeliveryRecord, ThreadedMessageOrigin,
  ThreadedMessageReceipt, ThreadedMessageRecord, ThreadedWakeRecord,
} from '@agent-gand/shared';
import { createThreadedMessageAcl } from './acl.ts';
import type { QuiescenceProof, ThreadedAuthority } from './contracts.ts';
import { ThreadedMessageError } from './messageContracts.ts';
import type {
  ThreadedAgentPostInput, ThreadedAgentResponseInput, ThreadedMessageAcl, ThreadedMessageActor,
  ThreadedMessagePayload, ThreadedMessageReadScope, ThreadedMessageWriteAuthorization,
  ThreadedSystemMessageInput, ThreadedUserMessageInput,
} from './messageContracts.ts';

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
function deny(code: string): never { throw new ThreadedMessageError(code); }
const invalid = (): never => deny('THREADED_MESSAGE_INVALID_INPUT');
function identifier(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f]/u.test(value)) invalid();
  return value;
}
function identifiers(value: string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) invalid();
  return [...new Set(value.map(identifier))].sort();
}
type Attachment = { name: string; mediaType: string; contentBase64: string; content: Buffer; contentHash: string };
function normalize(input: ThreadedMessagePayload) {
  if (!input || typeof input.body !== 'string' || Buffer.byteLength(input.body, 'utf8') > 1_048_576) invalid();
  const state = input.state ?? 'published', visibility = input.visibility ?? 'public';
  if (!['published', 'draft'].includes(state) || !['public', 'private'].includes(visibility)) invalid();
  if (input.attachments !== undefined && (!Array.isArray(input.attachments) || input.attachments.length > 16)) invalid();
  let total = 0;
  const attachments: Attachment[] = (input.attachments ?? []).map(item => {
    if (!item || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 200
      || /[\\/\u0000-\u001f]/u.test(item.name) || item.name === '.' || item.name === '..'
      || typeof item.mediaType !== 'string' || item.mediaType.length > 120
      || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu.test(item.mediaType)
      || typeof item.contentBase64 !== 'string' || item.contentBase64.length > 11_184_812
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(item.contentBase64)) invalid();
    const content = Buffer.from(item.contentBase64, 'base64');
    if (content.toString('base64') !== item.contentBase64 || content.length > 8_388_608) invalid();
    total += content.length;
    if (total > 16_777_216) invalid();
    return { name: item.name, mediaType: item.mediaType, contentBase64: item.contentBase64,
      content, contentHash: hash(content) };
  });
  return { body: input.body, targets: identifiers(input.targets), audience: identifiers(input.audience),
    sourceRefs: identifiers(input.sourceRefs), state, visibility, attachments };
}
type Intent = {
  ownerId: string; threadId: string; origin: ThreadedMessageOrigin; actor: ThreadedMessageActor;
  requestScope: string; requestKey: string; binding?: ThreadedBinding; quiescence?: QuiescenceProof;
  causalParentInvocationId?: string;
};
type MessageRow = { id: string; thread_id: string; request_hash: string; record: string; receipt: string };
type ListOptions = { afterSeq?: number; limit?: number };

/** Durable authored messages. All execution identity and policy are injected server authority. */
export function createThreadedMessages(db: Database.Database, options: {
  authority?: Pick<ThreadedAuthority, 'assertAuthorized'>;
  acl?: ThreadedMessageAcl;
  now?: () => number;
  authorizeSystem?: (input: { ownerId: string; threadId: string; systemKey: string }) => boolean;
  /** Best-effort invalidation only, after standalone COMMIT. Durable outbox repairs lost hints. */
  onCommitted?: () => void;
} = {}) {
  if (db.pragma('foreign_keys', { simple: true }) !== 1) deny('THREADED_MESSAGE_FOREIGN_KEYS_REQUIRED');
  const acl: ThreadedMessageAcl = options.acl ?? createThreadedMessageAcl(db);
  const now = options.now ?? Date.now;
  const getRow = (id: string) => db.prepare('SELECT id,thread_id,request_hash,record,receipt FROM threaded_messages WHERE id=?')
    .get(id) as MessageRow | undefined;
  function actorAuthorized(intent: Intent): void {
    if (intent.binding) {
      if (!options.authority) deny('THREADED_MESSAGE_AUTHORITY_REQUIRED');
      options.authority.assertAuthorized(intent.binding, intent.quiescence ? { quiescence: intent.quiescence } : undefined);
      if (!db.prepare(`SELECT 1 FROM threaded_attempts WHERE id=? AND invocation_id=? AND owner_id=?
        AND thread_id=? AND agent_id=? AND status='running' AND execution_stage='started'`)
        .get(intent.binding.attemptId, intent.binding.invocationId, intent.ownerId,
          intent.binding.threadId, intent.binding.agentId)) deny('THREADED_MESSAGE_ATTEMPT_NOT_RUNNING');
    } else if (intent.actor.kind === 'system') {
      if (!options.authorizeSystem || options.authorizeSystem({ ownerId: intent.ownerId,
        threadId: intent.threadId, systemKey: intent.actor.key }) !== true) deny('THREADED_MESSAGE_SYSTEM_FORBIDDEN');
    }
    if (!db.prepare(`SELECT 1 FROM threaded_threads t JOIN threaded_instances i
      ON i.singleton=1 AND i.instance_owner_id=t.owner_id WHERE t.id=? AND t.owner_id=? AND t.mode='threaded'`)
      .get(intent.threadId, intent.ownerId)) deny('THREADED_MESSAGE_FORBIDDEN');
  }
  function readScope(intent: Intent): ThreadedMessageReadScope {
    return { ownerId: intent.ownerId, threadId: intent.threadId,
      viewer: intent.actor.kind === 'agent' ? { kind: 'agent', agentId: intent.actor.agentId } : { kind: 'owner' } };
  }
  function append(intent: Intent, input: ThreadedMessagePayload): { receipt: ThreadedMessageReceipt; inserted: boolean } {
    const payload = normalize(input);
    actorAuthorized(intent);
    const requestHash = hash(JSON.stringify({ ownerId: intent.ownerId, threadId: intent.threadId,
      origin: intent.origin, actor: intent.actor, body: payload.body, state: payload.state, visibility: payload.visibility,
      targets: payload.targets, audience: payload.audience, sourceRefs: payload.sourceRefs,
      ...(intent.causalParentInvocationId ? { causalParentInvocationId: intent.causalParentInvocationId } : {}),
      attachments: payload.attachments.map(a => ({ name: a.name, mediaType: a.mediaType,
        byteLength: a.content.length, contentHash: a.contentHash })) }));
    const existing = db.prepare(`SELECT id,thread_id,request_hash,record,receipt FROM threaded_messages
      WHERE owner_id=? AND origin=? AND request_scope=? AND request_key=?`)
      .get(intent.ownerId, intent.origin, intent.requestScope, intent.requestKey) as MessageRow | undefined;
    if (existing) {
      if (existing.request_hash !== requestHash) deny('THREADED_MESSAGE_IDEMPOTENCY_CONFLICT');
      if (!acl.canRead(readScope(intent), JSON.parse(existing.record) as ThreadedMessageRecord)) deny('THREADED_MESSAGE_FORBIDDEN');
      return { receipt: JSON.parse(existing.receipt) as ThreadedMessageReceipt, inserted: false };
    }
    const access: ThreadedMessageWriteAuthorization = { ...intent, ...payload,
      attachments: payload.attachments.map(a => ({ name: a.name, mediaType: a.mediaType, contentBase64: a.contentBase64 })) };
    acl.authorizeWrite(access);
    const thread = db.prepare('SELECT state,authority_epoch FROM threaded_threads WHERE id=? AND owner_id=?')
      .get(intent.threadId, intent.ownerId) as { state: string; authority_epoch: number };
    if (!['open', 'paused'].includes(thread.state)) deny('THREADED_MESSAGE_THREAD_NOT_OPEN');
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) deny('THREADED_MESSAGE_INVALID_CLOCK');
    const createdAt = new Date(timestamp).toISOString();
    db.prepare('INSERT OR IGNORE INTO threaded_message_sequences(thread_id,owner_id,last_seq) VALUES(?,?,0)')
      .run(intent.threadId, intent.ownerId);
    const sequence = db.prepare(`UPDATE threaded_message_sequences SET last_seq=last_seq+1
      WHERE thread_id=? AND owner_id=? RETURNING last_seq`).get(intent.threadId, intent.ownerId) as { last_seq: number };
    if (!Number.isSafeInteger(sequence.last_seq)) deny('THREADED_MESSAGE_SEQUENCE_EXHAUSTED');
    const messageId = randomUUID(), seq = sequence.last_seq, waveId = payload.state === 'published' ? randomUUID() : null;
    const binding = intent.binding;
    const parent = intent.causalParentInvocationId ? db.prepare(`SELECT causal_root_id,thread_id FROM threaded_invocations
      WHERE id=? AND owner_id=?`).get(intent.causalParentInvocationId, intent.ownerId) as
      { causal_root_id: string; thread_id: string } | undefined : undefined;
    if (intent.causalParentInvocationId && (!parent || !['system','owner'].includes(intent.actor.kind))) deny('THREADED_MESSAGE_BINDING_INVALID');
    const causalRootId = binding ? (db.prepare(`SELECT causal_root_id FROM threaded_invocations
      WHERE id=? AND thread_id=? AND owner_id=? AND agent_id=?`).get(binding.invocationId, binding.threadId,
      binding.ownerId, binding.agentId) as { causal_root_id: string } | undefined)?.causal_root_id : parent?.causal_root_id ?? messageId;
    if (!causalRootId) deny('THREADED_MESSAGE_BINDING_INVALID');
    const attachments: ThreadedAttachmentRecord[] = payload.attachments.map(a => ({ id: randomUUID(),
      name: a.name, mediaType: a.mediaType, byteLength: a.content.length, contentHash: a.contentHash }));
    const message: ThreadedMessageRecord = {
      schemaVersion: 1, id: messageId, ownerId: intent.ownerId, threadId: intent.threadId, seq,
      origin: intent.origin, state: payload.state, visibility: payload.visibility,
      sender: intent.actor.kind === 'agent' ? { kind: 'agent', agentId: intent.actor.agentId }
        : intent.actor.kind === 'system' ? { kind: 'system', systemKey: intent.actor.key } : { kind: 'user' },
      body: payload.body, bodyHash: hash(payload.body), targets: payload.targets, audience: payload.audience,
      sourceRefs: payload.sourceRefs, sourceThreadId: binding?.threadId ?? null,
      sourceInvocationId: binding?.invocationId ?? null, sourceAttemptId: binding?.attemptId ?? null,
      sourceBindingId: binding?.id ?? null, causalRootId, waveId, inputMaxSeq: seq,
      authorityEpoch: thread.authority_epoch, attachments, createdAt,
    };
    const deliveries: ThreadedDeliveryRecord[] = [], wakes: ThreadedWakeRecord[] = [];
    if (waveId) for (const targetAgentId of payload.targets) {
      const member = db.prepare(`SELECT version,permission_version FROM threaded_members
        WHERE thread_id=? AND owner_id=? AND agent_id=? AND status='joined'`)
        .get(intent.threadId, intent.ownerId, targetAgentId) as { version: number; permission_version: number } | undefined;
      if (!member) deny('THREADED_MESSAGE_TARGET_UNAVAILABLE');
      const delivery: ThreadedDeliveryRecord = { schemaVersion: 1, id: randomUUID(), ownerId: intent.ownerId,
        threadId: intent.threadId, messageId, targetAgentId, purpose: 'message', routingRevision: 1,
        waveId, inputMaxSeq: seq, createdAt };
      deliveries.push(delivery);
      wakes.push({ schemaVersion: 1, id: randomUUID(), ownerId: intent.ownerId, threadId: intent.threadId,
        sourceMessageId: messageId, deliveryId: delivery.id, targetAgentId, purpose: 'message', routingRevision: 1,
        waveId, inputMaxSeq: seq, causalRootId, authorityEpoch: thread.authority_epoch,
        targetMemberVersion: member.version, targetPermissionVersion: member.permission_version,
        status: 'pending', version: 1, createdAt, updatedAt: createdAt });
    }
    const events = [
      { id: randomUUID(), eventType: 'message.created', sourceId: messageId, sourceVersion: 1 },
      ...wakes.map(w => ({ id: randomUUID(), eventType: 'wake.available', sourceId: w.id, sourceVersion: w.version })),
    ];
    const receipt: ThreadedMessageReceipt = { message, deliveries, wakes, outboxIds: events.map(e => e.id) };
    db.prepare(`INSERT INTO threaded_messages(id,owner_id,thread_id,seq,schema_version,origin,state,visibility,
      sender_kind,sender_agent_id,system_key,source_thread_id,source_invocation_id,source_attempt_id,source_binding_id,
      request_scope,request_key,request_hash,body,body_hash,targets,audience,source_refs,causal_root_id,wave_id,
      input_max_seq,authority_epoch,record,receipt,created_at) VALUES(${Array(30).fill('?').join(',')})`)
      .run(message.id, message.ownerId, message.threadId, message.seq, 1, message.origin, message.state, message.visibility,
        message.sender.kind, message.sender.agentId ?? null, message.sender.systemKey ?? null,
        message.sourceThreadId, message.sourceInvocationId, message.sourceAttemptId, message.sourceBindingId,
        intent.requestScope, intent.requestKey, requestHash, message.body, message.bodyHash,
        JSON.stringify(message.targets), JSON.stringify(message.audience), JSON.stringify(message.sourceRefs),
        message.causalRootId, message.waveId, message.inputMaxSeq, message.authorityEpoch,
        JSON.stringify(message), JSON.stringify(receipt), createdAt);
    if(intent.causalParentInvocationId)db.prepare('INSERT INTO threaded_callback_lineage VALUES(?,?)').run(message.id,intent.causalParentInvocationId);
    for (const [position, attachment] of attachments.entries()) {
      db.prepare(`INSERT INTO threaded_message_attachments(id,message_id,thread_id,owner_id,position,name,
        media_type,byte_length,content_hash,content,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(attachment.id, messageId, intent.threadId, intent.ownerId, position, attachment.name,
          attachment.mediaType, attachment.byteLength, attachment.contentHash, payload.attachments[position]!.content, createdAt);
    }
    for (const d of deliveries) {
      db.prepare(`INSERT INTO threaded_deliveries(id,owner_id,thread_id,message_id,schema_version,target_agent_id,
        purpose,routing_revision,wave_id,input_max_seq,record,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(d.id, d.ownerId, d.threadId, d.messageId, 1, d.targetAgentId, d.purpose, 1, d.waveId, d.inputMaxSeq, JSON.stringify(d), createdAt);
    }
    for (const w of wakes) {
      db.prepare(`INSERT INTO threaded_wakes(id,owner_id,thread_id,source_message_id,delivery_id,schema_version,target_agent_id,
        purpose,routing_revision,wave_id,input_max_seq,causal_root_id,authority_epoch,target_member_version,
        target_permission_version,status,version,available_at,record,created_at,updated_at) VALUES(${Array(21).fill('?').join(',')})`)
        .run(w.id, w.ownerId, w.threadId, w.sourceMessageId, w.deliveryId, 1, w.targetAgentId, w.purpose, 1,
          w.waveId, w.inputMaxSeq, w.causalRootId, w.authorityEpoch, w.targetMemberVersion, w.targetPermissionVersion,
          w.status, w.version, createdAt, JSON.stringify(w), createdAt, createdAt);
    }
    for (const event of events) {
      const envelope = { eventType: event.eventType, ownerId: intent.ownerId, threadId: intent.threadId,
        sourceId: event.sourceId, sourceVersion: event.sourceVersion, authorityEpoch: thread.authority_epoch };
      db.prepare(`INSERT INTO threaded_outbox(id,owner_id,thread_id,event_type,schema_version,source_id,source_version,
        authority_epoch,dedupe_key,request_hash,status,available_at,created_at,updated_at)
        VALUES(?,?,?,?,1,?,?,?,?,?,'pending',?,?,?)`)
        .run(event.id, intent.ownerId, intent.threadId, event.eventType, event.sourceId, event.sourceVersion,
          thread.authority_epoch, `${event.eventType}:${event.sourceId}:${event.sourceVersion}`, hash(JSON.stringify(envelope)),
          createdAt, createdAt, createdAt);
    }
    return { receipt, inserted: true };
  }
  function standalone(intent: Intent, input: ThreadedMessagePayload): ThreadedMessageReceipt {
    if (db.inTransaction) deny('THREADED_MESSAGE_STANDALONE_TRANSACTION_REQUIRED');
    const result = db.transaction(() => append(intent, input)).immediate();
    if (result.inserted) {
      // Callback failure cannot turn durable acceptance into a failed request.
      try { options.onCommitted?.(); } catch { /* A later outbox scan repairs a lost invalidation. */ }
    }
    return result.receipt;
  }
  function agentIntent(binding: ThreadedBinding, origin: 'agent_post' | 'agent_response', key: string,
    destination?: string, quiescence?: QuiescenceProof): Intent {
    if (!binding) deny('THREADED_MESSAGE_BINDING_INVALID');
    return { ownerId: identifier(binding.ownerId), threadId: identifier(destination ?? binding.threadId),
      origin, actor: { kind: 'agent', agentId: identifier(binding.agentId), sourceThreadId: identifier(binding.threadId) },
      requestScope: identifier(binding.attemptId), requestKey: identifier(key), binding, quiescence };
  }
  function getMessage(scope: ThreadedMessageReadScope, messageId: string): ThreadedMessageRecord | null {
    if (!scope || typeof messageId !== 'string') return null;
    const stored = getRow(messageId);
    if (!stored) return null;
    const message = JSON.parse(stored.record) as ThreadedMessageRecord;
    return acl.canRead(scope, message) ? message : null;
  }
  function queryMessages(scope: ThreadedMessageReadScope, input: ListOptions, query?: string): ThreadedMessageRecord[] {
    const afterSeq = input.afterSeq ?? 0, limit = input.limit ?? 50;
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) invalid();
    const result: ThreadedMessageRecord[] = [];
    // ACL precedes the visible limit; hidden rows never consume a page position.
    for (const row of db.prepare(`SELECT record FROM threaded_messages WHERE owner_id=? AND thread_id=?
      AND seq>? ORDER BY seq`).iterate(scope.ownerId, scope.threadId, afterSeq) as Iterable<{ record: string }>) {
      const message = JSON.parse(row.record) as ThreadedMessageRecord;
      if (acl.canRead(scope, message) && (query === undefined || message.body.toLocaleLowerCase().includes(query))) result.push(message);
      if (result.length === limit) break;
    }
    return result;
  }
  return {
    acceptUserMessageWithinTransaction(input: ThreadedUserMessageInput,lineage?:{causalParentInvocationId:string}): ThreadedMessageReceipt {
      if (!db.inTransaction) deny('THREADED_MESSAGE_RESPONSE_TRANSACTION_REQUIRED');
      return db.transaction(() => append({ ownerId: identifier(input.ownerId), threadId: identifier(input.threadId),
        origin: 'user', actor: { kind: 'owner' }, requestScope: identifier(input.threadId),
        requestKey: identifier(input.clientRequestId),causalParentInvocationId:lineage?.causalParentInvocationId }, input).receipt)();
    },
    acceptUserMessage(input: ThreadedUserMessageInput): ThreadedMessageReceipt {
      return standalone({ ownerId: identifier(input.ownerId), threadId: identifier(input.threadId),
        origin: 'user', actor: { kind: 'owner' }, requestScope: identifier(input.threadId),
        requestKey: identifier(input.clientRequestId) }, input);
    },
    postAgentMessage(input: ThreadedAgentPostInput): ThreadedMessageReceipt {
      return standalone(agentIntent(input.binding, 'agent_post', input.toolCallId, input.threadId), input);
    },
    postAgentMessageWithinTransaction(input: ThreadedAgentPostInput): ThreadedMessageReceipt {
      if (!db.inTransaction) deny('THREADED_MESSAGE_RESPONSE_TRANSACTION_REQUIRED');
      return db.transaction(() => append(agentIntent(input.binding, 'agent_post', input.toolCallId, input.threadId), input).receipt)();
    },
    postSystemMessageWithinTransaction(input: ThreadedSystemMessageInput): ThreadedMessageReceipt {
      if (!db.inTransaction) deny('THREADED_MESSAGE_RESPONSE_TRANSACTION_REQUIRED');
      return db.transaction(() => append({ ownerId: identifier(input.ownerId), threadId: identifier(input.threadId),
        origin: 'system', actor: { kind: 'system', key: identifier(input.systemKey) },
        requestScope: identifier(input.systemKey), requestKey: identifier(input.requestId),
        causalParentInvocationId: input.causalParentInvocationId }, input).receipt)();
    },
    appendResponseWithinTransaction(input: ThreadedAgentResponseInput): ThreadedMessageReceipt {
      if (!db.inTransaction) deny('THREADED_MESSAGE_RESPONSE_TRANSACTION_REQUIRED');
      if (!input.quiescence) deny('THREADED_MESSAGE_QUIESCENCE_REQUIRED');
      if (input.quiescence.reason === 'not_started') deny('THREADED_MESSAGE_RESPONSE_NOT_STARTED');
      // A savepoint also protects callers that catch a write fault and continue their
      // outer terminal transaction: a partial message intent must never survive.
      return db.transaction(() => append(agentIntent(input.binding, 'agent_response',
        input.responseCommitKey, undefined, input.quiescence), input).receipt)();
    },
    postSystemMessage(input: ThreadedSystemMessageInput): ThreadedMessageReceipt {
      return standalone({ ownerId: identifier(input.ownerId), threadId: identifier(input.threadId),
        origin: 'system', actor: { kind: 'system', key: identifier(input.systemKey) },
        requestScope: identifier(input.systemKey), requestKey: identifier(input.requestId),
        causalParentInvocationId: input.causalParentInvocationId }, input);
    },
    getMessage,
    listMessages(scope: ThreadedMessageReadScope, input: ListOptions = {}): ThreadedMessageRecord[] {
      return queryMessages(scope, input);
    },
    searchMessages(scope: ThreadedMessageReadScope, input: ListOptions & { query: string }): ThreadedMessageRecord[] {
      if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 1000) invalid();
      return queryMessages(scope, input, input.query.toLocaleLowerCase());
    },
    getAttachment(scope: ThreadedMessageReadScope, attachmentId: string): { attachment: ThreadedAttachmentRecord; content: Buffer } | null {
      const row = db.prepare(`SELECT message_id,content FROM threaded_message_attachments WHERE id=? AND thread_id=? AND owner_id=?`)
        .get(attachmentId, scope.threadId, scope.ownerId) as { message_id: string; content: Buffer } | undefined;
      if (!row) return null;
      const message = getMessage(scope, row.message_id), attachment = message?.attachments.find(a => a.id === attachmentId);
      return attachment ? { attachment, content: Buffer.from(row.content) } : null;
    },
    getSources(scope: ThreadedMessageReadScope, messageId: string): ThreadedMessageRecord[] | null {
      const message = getMessage(scope, messageId);
      if (!message) return null;
      const sources: ThreadedMessageRecord[] = [];
      for (const id of message.sourceRefs) {
        const row = getRow(id);
        if (!row) return null;
        const source = getMessage({ ...scope, threadId: row.thread_id }, id);
        if (!source) return null;
        sources.push(source);
      }
      return sources;
    },
  };
}

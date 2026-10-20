import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ThreadedBinding, ThreadedMessageRecord } from '@agent-gand/shared';
import type { ResourceSessionReference } from '../execution/resources/types.ts';
import { assertExpectedNativeSession, assertResourceSessionCurrent, prepareThreadedSession } from '../execution/resources/sessions.ts';
import type { QuiescenceProof } from './contracts.ts';
import { createThreadedMessageAcl } from './acl.ts';
import type { ThreadedContextManifest } from './contextTypes.ts';
import type {
  ThreadedSessionAnchor, ThreadedSessionAnchorEvidence, ThreadedSessionContextDecision,
  ThreadedSessionContextOptions, ThreadedSessionContextPort, ThreadedSessionContextPreparation,
  ThreadedSessionInputIntent,
} from './sessionContextTypes.ts';
import { ThreadedSessionContextError } from './sessionContextTypes.ts';

type SessionRow = { id: string; owner_id: string; version: number; native_id: string | null;
  resource_key: string | null; state: string; record: string };
type Policy = { ownerId: string; threadId: string; agentId: string; backend: 'api' | 'claude-sdk';
  backendVersion: string; workspace: string; informationBoundary: string;
  account: { id: string; identity_generation: number | null } | null };
type VersionRow = { session_id: string; session_version: number; owner_id: string; thread_id: string;
  agent_id: string; backend: 'api' | 'claude-sdk'; boundary_version: number; base_boundary: string;
  effective_boundary: string; policy_hash: string; boundary_sources: string; reason: string };
type AnchorRow = { id: string; binding_id: string; input_intent_seq: number; compaction_seq: number; record: string };
type IntentRow = { seq: number; id: string; binding_id: string; manifest_id: string; request_hash: string;
  source_message_ids: string; record: string };
type EventRow = { seq: number; id: string; binding_id: string; kind: 'seal' | 'compaction'; request_hash: string; record: string };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function deny(code: string): never { throw new ThreadedSessionContextError(code); }
function text(value: string, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/u.test(value)) {
    deny('THREADED_SESSION_CONTEXT_INVALID_INPUT');
  }
  return value;
}
function ids(value: string[] = []): string[] {
  if (!Array.isArray(value) || value.length > 10_000) deny('THREADED_SESSION_CONTEXT_INVALID_INPUT');
  return [...new Set(value.map(id => text(id, 200)))].sort();
}
const sameReference = (left: ResourceSessionReference, right: ResourceSessionReference) =>
  left.id === right.id && left.version === right.version && left.nativeId === right.nativeId && left.resourceKey === right.resourceKey;
const reference = (row: SessionRow): ResourceSessionReference => ({ id: row.id, version: row.version,
  nativeId: row.native_id, resourceKey: row.resource_key });

/** Native continuity metadata only; private transcripts stay with their owning backend/member. */
export function createThreadedSessionContext(db: Database.Database, options: ThreadedSessionContextOptions): ThreadedSessionContextPort {
  if (db.pragma('foreign_keys', { simple: true }) !== 1) deny('THREADED_SESSION_CONTEXT_FOREIGN_KEYS_REQUIRED');
  const acl = createThreadedMessageAcl(db);
  const clock = options.now ?? Date.now;
  const stamp = () => {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) deny('THREADED_SESSION_CONTEXT_INVALID_CLOCK');
    return new Date(value).toISOString();
  };
  const session = (id: string) => db.prepare('SELECT * FROM execution_resource_sessions WHERE id=?').get(id) as SessionRow | undefined;
  const version = (ref: ResourceSessionReference) => db.prepare(`SELECT * FROM threaded_session_context_versions
    WHERE session_id=? AND session_version=?`).get(ref.id, ref.version) as VersionRow | undefined;
  const lastAnchor = (ref: ResourceSessionReference, exceptBinding?: string) => db.prepare(`SELECT * FROM threaded_session_anchors
    WHERE session_id=? AND session_version=? ${exceptBinding ? 'AND binding_id<>?' : ''} ORDER BY seq DESC LIMIT 1`)
    .get(...[ref.id, ref.version, ...(exceptBinding ? [exceptBinding] : [])]) as AnchorRow | undefined;
  const intents = (ref: ResourceSessionReference, exceptBinding?: string) => db.prepare(`SELECT * FROM threaded_session_input_intents
    WHERE session_id=? AND session_version=? ${exceptBinding ? 'AND binding_id<>?' : ''} ORDER BY seq`)
    .all(...[ref.id, ref.version, ...(exceptBinding ? [exceptBinding] : [])]) as IntentRow[];
  const events = (ref: ResourceSessionReference) => db.prepare(`SELECT * FROM threaded_session_context_events
    WHERE session_id=? AND session_version=? ORDER BY seq`).all(ref.id, ref.version) as EventRow[];
  const included = (manifest: ThreadedContextManifest) => ids(manifest.items.filter(item => item.decision === 'included').map(item => item.messageId));
  function allSources(row: VersionRow, ref: ResourceSessionReference): string[] {
    return ids([...JSON.parse(row.boundary_sources) as string[],
      ...intents(ref).flatMap(intent => JSON.parse(intent.source_message_ids) as string[]),
      ...(db.prepare(`SELECT DISTINCT i.message_id FROM threaded_context_send_intents s
        JOIN threaded_context_manifest_items i ON i.manifest_id=s.manifest_id AND i.decision='included'
        WHERE s.session_id=? AND s.session_version=? AND s.status<>'not_sent'`)
        .all(ref.id, ref.version) as { message_id: string }[]).map(item => item.message_id)]);
  }
  function uncoveredCoreIntent(ref: ResourceSessionReference, throughSeq: number): boolean {
    return !!db.prepare(`SELECT 1 FROM threaded_context_send_intents s
      WHERE s.session_id=? AND s.session_version=? AND s.status<>'not_sent' AND NOT EXISTS (
        SELECT 1 FROM threaded_session_input_intents i WHERE i.binding_id=s.binding_id
          AND i.manifest_id=s.manifest_id AND i.request_id=s.request_key AND i.seq<=?) LIMIT 1`)
      .get(ref.id, ref.version, throughSeq);
  }
  function beyondCutoff(row: VersionRow, ref: ResourceSessionReference, cutoff: number): boolean {
    return allSources(row, ref).some(id => !!db.prepare(`SELECT 1 FROM threaded_messages
      WHERE id=? AND owner_id=? AND thread_id=? AND seq>?`).get(id, row.owner_id, row.thread_id, cutoff));
  }
  function memberCurrent(scope: { ownerId: string; threadId: string; agentId: string }): boolean {
    return !!db.prepare(`SELECT 1 FROM threaded_members m JOIN agents a ON a.id=m.agent_id
      JOIN threaded_instances i ON i.singleton=1 AND i.instance_owner_id=m.owner_id
      WHERE m.owner_id=? AND m.thread_id=? AND m.agent_id=? AND m.status='joined'
        AND a.enabled=1 AND m.role_version=a.version`).get(scope.ownerId, scope.threadId, scope.agentId);
  }
  function sourcesAllowed(scope: { ownerId: string; threadId: string; agentId: string }, sources: string[]): boolean {
    if (!memberCurrent(scope)) return false;
    return sources.every(id => {
      const saved = db.prepare('SELECT record FROM threaded_messages WHERE id=? AND owner_id=?').get(id, scope.ownerId) as { record: string } | undefined;
      if (!saved) return false;
      const message = JSON.parse(saved.record) as ThreadedMessageRecord;
      return message.state === 'published' && acl.canRead({ ownerId: scope.ownerId, threadId: message.threadId,
        viewer: { kind: 'agent', agentId: scope.agentId } }, message);
    });
  }
  function rowScope(row: VersionRow) {
    return { ownerId: row.owner_id, threadId: row.thread_id, agentId: row.agent_id };
  }
  function currentVersion(decision: ThreadedSessionContextDecision, binding?: ThreadedBinding): { row: VersionRow; policy: Policy } {
    if (!decision || !decision.session) deny('THREADED_SESSION_CONTEXT_DECISION_REQUIRED');
    const current = session(decision.session.id), row = version(decision.session);
    if (!current || !row || current.state !== 'ready' || !sameReference(reference(current), decision.session)
      || decision.policyHash !== row.policy_hash || decision.boundaryVersion !== row.boundary_version
      || hash(JSON.parse(current.record).policy) !== row.policy_hash) deny('THREADED_SESSION_CONTEXT_STALE');
    const policy = (JSON.parse(current.record) as { policy: Policy }).policy;
    if (current.owner_id !== row.owner_id || policy.ownerId !== row.owner_id || policy.threadId !== row.thread_id
      || policy.agentId !== row.agent_id || policy.backend !== row.backend) deny('THREADED_SESSION_CONTEXT_SCOPE_MISMATCH');
    if (binding && (binding.ownerId !== row.owner_id || binding.threadId !== row.thread_id || binding.agentId !== row.agent_id)) {
      deny('THREADED_SESSION_CONTEXT_SCOPE_MISMATCH');
    }
    if (!sourcesAllowed(rowScope(row), allSources(row, decision.session))) deny('THREADED_SESSION_CONTEXT_SOURCE_REVOKED');
    return { row, policy };
  }
  function validateMode(binding: ThreadedBinding, decision: ThreadedSessionContextDecision, row: VersionRow) {
    if (row.backend === 'api') {
      if (decision.sessionKind !== 'reconstructed' || decision.mode !== 'reconstructed' || decision.anchorId !== null
        || decision.session.nativeId !== null) deny('THREADED_SESSION_CONTEXT_MODE_MISMATCH');
      return;
    }
    if (decision.sessionKind !== 'native' || !decision.session.nativeId) deny('THREADED_SESSION_CONTEXT_MODE_MISMATCH');
    if (events(decision.session).some(event => event.kind === 'seal')) deny('THREADED_SESSION_CONTEXT_SEALED');
    const priorAnchor = lastAnchor(decision.session, binding.id);
    const priorIntents = intents(decision.session, binding.id);
    if (decision.mode === 'cold') {
      if (decision.anchorId !== null || priorAnchor || priorIntents.length) deny('THREADED_SESSION_CONTEXT_COLD_REQUIRED');
    } else if (decision.mode === 'resume') {
      if (!decision.anchorId || !priorAnchor || priorAnchor.id !== decision.anchorId
        || priorIntents.some(intent => intent.seq > priorAnchor.input_intent_seq)) deny('THREADED_SESSION_CONTEXT_ANCHOR_UNCONFIRMED');
      const anchor = JSON.parse(priorAnchor.record) as ThreadedSessionAnchor;
      if (!sameReference(anchor.session, decision.session) || anchor.policyHash !== row.policy_hash
        || !sourcesAllowed(rowScope(row), anchor.sourceMessageIds)) deny('THREADED_SESSION_CONTEXT_ANCHOR_STALE');
      if (events(decision.session).some(event => event.kind === 'compaction' && event.binding_id !== binding.id
        && event.seq > priorAnchor.compaction_seq)) deny('THREADED_SESSION_CONTEXT_COMPACTION_UNCONFIRMED');
    } else deny('THREADED_SESSION_CONTEXT_MODE_MISMATCH');
  }
  function assertManifest(binding: ThreadedBinding, manifestId: string, decision: ThreadedSessionContextDecision,
    quiescence?: QuiescenceProof): ThreadedContextManifest {
    options.authority.assertAuthorized(binding, quiescence ? { quiescence } : undefined);
    const { row, policy } = currentVersion(decision, binding);
    const manifest = options.context.assertManifestCurrent(binding, text(manifestId, 200), quiescence ? { quiescence } : undefined);
    if (manifest.ownerId !== binding.ownerId || manifest.threadId !== binding.threadId || manifest.agentId !== binding.agentId
      || manifest.bindingId !== binding.id || manifest.attemptId !== binding.attemptId
      || manifest.invocationId !== binding.invocationId || manifest.state !== 'ready'
      || !sameReference(manifest.session, decision.session)
      || manifest.mode !== (row.backend === 'api' ? 'reconstructed' : 'native_incremental')) deny('THREADED_SESSION_CONTEXT_MANIFEST_MISMATCH');
    assertResourceSessionCurrent(db, { requestKey: 'context-check', operationId: 'context-check', mode: 'threaded',
      ownerId: binding.ownerId, threadId: binding.threadId, agentId: binding.agentId, invocationId: binding.invocationId,
      runId: binding.runId, attemptId: binding.attemptId, session: decision.session,
      accountId: policy.account?.id, accountIdentityGeneration: policy.account?.identity_generation ?? undefined,
      workspaces: [{ path: policy.workspace, access: 'read' }] });
    validateMode(binding, decision, row);
    if (row.backend === 'claude-sdk' && beyondCutoff(row, decision.session, manifest.inputMaxSeq)) {
      deny('THREADED_SESSION_CONTEXT_CUTOFF_REQUIRES_COLD');
    }
    if (!sourcesAllowed(rowScope(row), included(manifest))) deny('THREADED_SESSION_CONTEXT_SOURCE_REVOKED');
    return manifest;
  }
  function observeNative(binding: ThreadedBinding, manifestId: string, decision: ThreadedSessionContextDecision,
    nativeId: string, backendVersion: string, quiescence?: QuiescenceProof) {
    const manifest = assertManifest(binding, manifestId, decision, quiescence);
    const { policy } = currentVersion(decision, binding);
    if (policy.backend !== 'claude-sdk' || backendVersion !== policy.backendVersion) deny('THREADED_SESSION_CONTEXT_BACKEND_MISMATCH');
    if (nativeId !== decision.session.nativeId && db.inTransaction) deny('THREADED_SESSION_IDENTITY_OBSERVATION_REQUIRES_OUTERMOST_TRANSACTION');
    // A mismatch must persist reconciliation before throwing. Never wrap this
    // observation in our own transaction and roll the fence back with the error.
    assertExpectedNativeSession(db, decision.session, text(nativeId, 200));
    return manifest;
  }
  const inputRecord = (row: IntentRow) => JSON.parse(row.record) as ThreadedSessionInputIntent;

  return {
    prepare(input: ThreadedSessionContextPreparation): ThreadedSessionContextDecision {
      text(input.informationBoundary);
      if (!Number.isSafeInteger(input.inputMaxSeq) || input.inputMaxSeq < 0) deny('THREADED_SESSION_CONTEXT_INVALID_INPUT');
      const boundarySources = ids(input.boundarySources);
      return db.transaction((): ThreadedSessionContextDecision => {
        if (!sourcesAllowed(input, boundarySources)) deny('THREADED_SESSION_CONTEXT_SOURCE_REVOKED');
        const bindingKey = `threaded:${hash([input.ownerId, input.threadId, input.agentId, input.backend])}`;
        const old = db.prepare('SELECT * FROM execution_resource_sessions WHERE owner_id=? AND binding_key=?')
          .get(input.ownerId, bindingKey) as SessionRow | undefined;
        const previous = old ? version(reference(old)) : undefined;
        let reason = previous ? 'compatible' : 'new_context';
        let effectiveBoundary = previous?.effective_boundary;
        if (previous && (previous.base_boundary !== input.informationBoundary
          || previous.boundary_sources !== JSON.stringify(boundarySources))) reason = 'information_boundary_changed';
        else if (previous && !sourcesAllowed(rowScope(previous), allSources(previous, reference(old!)))) reason = 'source_authorization_changed';
        else if (previous && events(reference(old!)).some(event => event.kind === 'seal')) reason = 'session_sealed';
        else if (previous?.backend === 'claude-sdk' && beyondCutoff(previous, reference(old!), input.inputMaxSeq)) reason = 'input_boundary_rewound';
        else if (previous?.backend === 'claude-sdk') {
          const prior = lastAnchor(reference(old!)), exposed = intents(reference(old!));
          const compaction = events(reference(old!)).filter(event => event.kind === 'compaction').at(-1);
          if ((exposed.length && (!prior || exposed.at(-1)!.seq > prior.input_intent_seq))
            || uncoveredCoreIntent(reference(old!), prior?.input_intent_seq ?? 0)) reason = 'unconfirmed_input';
          else if (compaction && (!prior || compaction.seq > prior.compaction_seq)) reason = 'unconfirmed_compaction';
        }
        if (!effectiveBoundary || reason !== 'compatible') effectiveBoundary = `threaded-context-v1:${hash([
          input.informationBoundary, boundarySources, randomUUID(),
        ])}`;
        const ref = prepareThreadedSession(db, { ...input, informationBoundary: effectiveBoundary });
        const saved = session(ref.id)!;
        let row = version(ref);
        if (!row) {
          if (reason === 'compatible') reason = 'policy_changed';
          const boundaryVersion = (previous?.boundary_version ?? 0) + 1;
          db.prepare(`INSERT INTO threaded_session_context_versions(session_id,session_version,owner_id,thread_id,agent_id,
            backend,boundary_version,base_boundary,effective_boundary,policy_hash,boundary_sources,reason,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(ref.id, ref.version, input.ownerId, input.threadId, input.agentId,
              input.backend, boundaryVersion, input.informationBoundary, effectiveBoundary, hash(JSON.parse(saved.record).policy),
              JSON.stringify(boundarySources), reason, stamp());
          row = version(ref)!;
        }
        const anchor = lastAnchor(ref);
        return { session: ref, sessionKind: input.backend === 'api' ? 'reconstructed' : 'native',
          mode: input.backend === 'api' ? 'reconstructed' : anchor ? 'resume' : 'cold',
          reason: input.backend === 'api' ? 'api_reconstructed' : anchor ? 'compatible_anchor' : row.reason,
          anchorId: input.backend === 'api' ? null : anchor?.id ?? null,
          boundaryVersion: row.boundary_version, policyHash: row.policy_hash };
      }).immediate();
    },
    assertForManifest: assertManifest,
    recordInputIntent(binding, input) {
      return db.transaction(() => {
        const manifest = assertManifest(binding, input.manifestId, input.decision);
        const requestId = text(input.requestId, 200), fingerprint = hash(input);
        const prior = db.prepare('SELECT * FROM threaded_session_input_intents WHERE binding_id=? AND request_id=?')
          .get(binding.id, requestId) as IntentRow | undefined;
        if (prior) {
          if (prior.request_hash !== fingerprint) deny('THREADED_SESSION_CONTEXT_IDEMPOTENCY_CONFLICT');
          return inputRecord(prior);
        }
        const record: ThreadedSessionInputIntent = { id: randomUUID(), manifestId: manifest.id,
          session: input.decision.session, sourceMessageIds: included(manifest) };
        db.prepare(`INSERT INTO threaded_session_input_intents(id,owner_id,thread_id,agent_id,session_id,session_version,
          manifest_id,binding_id,request_id,request_hash,payload_hash,source_message_ids,record,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(record.id, binding.ownerId, binding.threadId, binding.agentId,
            record.session.id, record.session.version, manifest.id, binding.id, requestId, fingerprint,
            manifest.payloadHash, JSON.stringify(record.sourceMessageIds), JSON.stringify(record), stamp());
        return record;
      })();
    },
    recordAnchor(binding, input) {
      const evidence = input.evidence;
      for (const key of ['reference', 'nativeId', 'backendVersion', 'requestReceiptId', 'terminalRecordUuid', 'resumeToken'] as const) {
        text(evidence?.[key], key === 'resumeToken' ? 4096 : 512);
      }
      observeNative(binding, input.manifestId, input.decision, evidence.nativeId, evidence.backendVersion, input.quiescence);
      return db.transaction(() => {
        const manifest = assertManifest(binding, input.manifestId, input.decision, input.quiescence);
        const requestId = text(input.requestId, 200), fingerprint = hash(input);
        const prior = db.prepare('SELECT request_hash,record FROM threaded_session_anchors WHERE binding_id=? AND request_id=?')
          .get(binding.id, requestId) as { request_hash: string; record: string } | undefined;
        if (prior) {
          if (prior.request_hash !== fingerprint) deny('THREADED_SESSION_CONTEXT_IDEMPOTENCY_CONFLICT');
          return JSON.parse(prior.record) as ThreadedSessionAnchor;
        }
        if (!options.verifyAnchor || options.verifyAnchor(binding, manifest, input.decision, evidence, input.quiescence) !== true) {
          deny('THREADED_SESSION_CONTEXT_ANCHOR_UNVERIFIED');
        }
        const supplied = intents(input.decision.session), last = supplied.at(-1);
        if (!last || last.binding_id !== binding.id || last.manifest_id !== manifest.id) deny('THREADED_SESSION_CONTEXT_INPUT_INTENT_REQUIRED');
        if (uncoveredCoreIntent(input.decision.session, last.seq)) deny('THREADED_SESSION_CONTEXT_INPUT_INTENT_REQUIRED');
        const compaction = events(input.decision.session).filter(event => event.kind === 'compaction').at(-1);
        if (compaction && evidence.compactionBoundary !== (JSON.parse(compaction.record) as { boundary: string }).boundary) {
          deny('THREADED_SESSION_CONTEXT_COMPACTION_UNCONFIRMED');
        }
        const row = currentVersion(input.decision, binding).row;
        const record: ThreadedSessionAnchor = { id: randomUUID(), ownerId: binding.ownerId, threadId: binding.threadId,
          agentId: binding.agentId, manifestId: manifest.id, payloadHash: manifest.payloadHash,
          session: input.decision.session, boundaryVersion: row.boundary_version, policyHash: row.policy_hash,
          sourceMessageIds: allSources(row, input.decision.session), evidence: { ...evidence }, createdAt: stamp() };
        db.prepare(`INSERT INTO threaded_session_anchors(id,owner_id,thread_id,agent_id,session_id,session_version,
          manifest_id,binding_id,request_id,request_hash,input_intent_seq,compaction_seq,record,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(record.id, binding.ownerId, binding.threadId, binding.agentId,
            record.session.id, record.session.version, manifest.id, binding.id, requestId, fingerprint,
            last.seq, compaction?.seq ?? 0, JSON.stringify(record), record.createdAt);
        return record;
      })();
    },
    recordCompaction(binding, input) {
      const evidence = input.evidence;
      text(evidence?.reference); text(evidence?.boundary);
      observeNative(binding, input.manifestId, input.decision, evidence.nativeId, evidence.backendVersion);
      return db.transaction(() => {
        const manifest = assertManifest(binding, input.manifestId, input.decision);
        const requestId = text(input.requestId, 200), fingerprint = hash(input);
        const prior = db.prepare('SELECT * FROM threaded_session_context_events WHERE binding_id=? AND request_id=?')
          .get(binding.id, requestId) as EventRow | undefined;
        if (prior) {
          if (prior.request_hash !== fingerprint) deny('THREADED_SESSION_CONTEXT_IDEMPOTENCY_CONFLICT');
          return { id: prior.id, boundary: evidence.boundary };
        }
        const row = currentVersion(input.decision, binding).row, possible = allSources(row, input.decision.session);
        const summarySources = input.summary ? ids(input.summary.sourceMessageIds) : [];
        if (input.summary && (typeof input.summary.text !== 'string' || !input.summary.text.trim()
          || input.summary.text.length > 100_000 || !summarySources.length
          || summarySources.some(id => !possible.includes(id)) || !sourcesAllowed(rowScope(row), summarySources))) {
          deny('THREADED_SESSION_CONTEXT_SUMMARY_FORBIDDEN');
        }
        if (!options.verifyCompaction || options.verifyCompaction(binding, manifest, input.decision, evidence, input.summary) !== true) {
          deny('THREADED_SESSION_CONTEXT_COMPACTION_UNVERIFIED');
        }
        const record = { id: randomUUID(), boundary: evidence.boundary, evidence, sourceMessageIds: possible,
          summary: input.summary ? { text: input.summary.text, sourceMessageIds: summarySources } : null };
        db.prepare(`INSERT INTO threaded_session_context_events(id,owner_id,thread_id,agent_id,session_id,session_version,
          manifest_id,binding_id,kind,request_id,request_hash,record,created_at)
          VALUES(?,?,?,?,?,?,?,?,'compaction',?,?,?,?)`).run(record.id, binding.ownerId, binding.threadId, binding.agentId,
            input.decision.session.id, input.decision.session.version, manifest.id, binding.id, requestId, fingerprint, JSON.stringify(record), stamp());
        return { id: record.id, boundary: record.boundary };
      })();
    },
    seal(binding, input) {
      return db.transaction(() => {
        options.authority.assertAuthorized(binding);
        currentVersion(input.decision, binding);
        const requestId = text(input.requestId, 200), fingerprint = hash(input);
        const prior = db.prepare('SELECT * FROM threaded_session_context_events WHERE binding_id=? AND request_id=?')
          .get(binding.id, requestId) as EventRow | undefined;
        if (prior) {
          if (prior.request_hash !== fingerprint) deny('THREADED_SESSION_CONTEXT_IDEMPOTENCY_CONFLICT');
          return { id: prior.id };
        }
        const manifest = assertManifest(binding, input.manifestId, input.decision);
        const record = { id: randomUUID(), reason: text(input.reason) };
        db.prepare(`INSERT INTO threaded_session_context_events(id,owner_id,thread_id,agent_id,session_id,session_version,
          manifest_id,binding_id,kind,request_id,request_hash,record,created_at)
          VALUES(?,?,?,?,?,?,?,?,'seal',?,?,?,?)`).run(record.id, binding.ownerId, binding.threadId, binding.agentId,
            input.decision.session.id, input.decision.session.version, manifest.id, binding.id, requestId, fingerprint, JSON.stringify(record), stamp());
        return { id: record.id };
      })();
    },
    getAnchor(scope, anchorId) {
      const row = db.prepare('SELECT record FROM threaded_session_anchors WHERE id=? AND owner_id=? AND thread_id=? AND agent_id=?')
        .get(anchorId, scope.ownerId, scope.threadId, scope.agentId) as { record: string } | undefined;
      if (!row) return null;
      const anchor = JSON.parse(row.record) as ThreadedSessionAnchor;
      return sourcesAllowed(scope, anchor.sourceMessageIds) ? anchor : null;
    },
  };
}

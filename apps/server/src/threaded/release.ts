import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export type ThreadedReleaseMode = 'closed' | 'observe' | 'execute';
/** Server registered metadata only; connection headers, credentials and private role text are excluded. */
export interface ThreadedReleaseMember {
  agentId: string; backend: 'api' | 'claude-sdk'; backendVersion: string; model: string;
  roleVersion: number; permissionVersion: number;
  accountId?: string | null; accountConfigVersion?: number | null;
  accountCredentialVersion?: number | null; accountIdentityGeneration?: number | null;
}
export interface ThreadedReleaseState { ownerId: string; version: number; admissionOpen: boolean; dispatchOpen: boolean; updatedAt: number | null }
export interface ThreadedReleaseFrozenMember extends ThreadedReleaseMember { memberVersion: number; definitionHash: string }
export interface ThreadedReleaseGrant { ownerId: string; threadId: string; controlVersion: number; members: ThreadedReleaseFrozenMember[]; grantedAt: number }
export class ThreadedReleaseError extends Error {
  readonly status: number;
  constructor(readonly code: string, status = 409) { super(code); this.name = 'ThreadedReleaseError'; this.status = status; }
}
function fail(code: string, status = 409): never { throw new ThreadedReleaseError(code, status); }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = (value: string) => { if (typeof value !== 'string' || !value.trim() || value.length > 300 || /[\u0000-\u001f]/u.test(value)) fail('THREADED_RELEASE_INPUT_INVALID', 400); return value; };
const positive = (value: number) => Number.isSafeInteger(value) && value >= 1;

/** Pure injected DB/configuration. Construction and every read leave the database unchanged. */
export function createThreadedRelease(db: Database.Database, options: {
  mode: () => ThreadedReleaseMode;
  members: () => readonly ThreadedReleaseMember[];
  now?: () => number;
}) {
  if (db.pragma('foreign_keys', { simple: true }) !== 1) fail('THREADED_RELEASE_FOREIGN_KEYS_REQUIRED');
  const now = () => { const value = options.now?.() ?? Date.now(); if (!Number.isSafeInteger(value) || value < 0) fail('THREADED_RELEASE_CLOCK_INVALID'); return value; };
  function mode() { const value = options.mode(); if (!['closed', 'observe', 'execute'].includes(value)) fail('THREADED_RELEASE_MODE_INVALID', 503); return value; }
  function owner(ownerId: string) { id(ownerId); if (!db.prepare('SELECT 1 FROM threaded_instances WHERE singleton=1 AND instance_owner_id=?').get(ownerId)) fail('THREADED_RELEASE_OWNER_FORBIDDEN', 403); }
  function state(ownerId: string): ThreadedReleaseState {
    owner(ownerId);
    const row = db.prepare('SELECT * FROM threaded_release_controls WHERE owner_id=?').get(ownerId) as { version: number; admission_open: number; dispatch_open: number; updated_at: number } | undefined;
    return { ownerId, version: row?.version ?? 0, admissionOpen: row?.admission_open === 1, dispatchOpen: row?.dispatch_open === 1, updatedAt: row?.updated_at ?? null };
  }
  function grant(ownerId: string, threadId: string): ThreadedReleaseGrant | null {
    owner(ownerId); id(threadId);
    const row = db.prepare('SELECT record FROM threaded_release_grants WHERE thread_id=? AND owner_id=?').get(threadId, ownerId) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as ThreadedReleaseGrant : null;
  }
  function registered() {
    const value = options.members();
    if (!Array.isArray(value) || value.length < 1 || value.length > 32) fail('THREADED_RELEASE_PACK_INVALID', 503);
    const allowed = ['agentId','backend','backendVersion','model','roleVersion','permissionVersion','accountId','accountConfigVersion','accountCredentialVersion','accountIdentityGeneration'];
    const result = value.map(member => {
      if (!member || typeof member !== 'object' || Object.keys(member).some(key => !allowed.includes(key))
        || !['api','claude-sdk'].includes(member.backend) || !positive(member.roleVersion) || !positive(member.permissionVersion)) fail('THREADED_RELEASE_PACK_INVALID', 503);
      for (const key of ['accountConfigVersion','accountCredentialVersion','accountIdentityGeneration'] as const) if (member[key] != null && !positive(member[key]!)) fail('THREADED_RELEASE_PACK_INVALID', 503);
      return { agentId: id(member.agentId), backend: member.backend, backendVersion: id(member.backendVersion), model: id(member.model),
        roleVersion: member.roleVersion, permissionVersion: member.permissionVersion, accountId: member.accountId == null ? null : id(member.accountId),
        accountConfigVersion: member.accountConfigVersion ?? null, accountCredentialVersion: member.accountCredentialVersion ?? null,
        accountIdentityGeneration: member.accountIdentityGeneration ?? null };
    }).sort((a,b) => a.agentId.localeCompare(b.agentId));
    if (new Set(result.map(member => member.agentId)).size !== result.length) fail('THREADED_RELEASE_PACK_INVALID', 503);
    return result;
  }
  function liveMembers(ownerId: string, threadId: string, members: readonly ThreadedReleaseMember[], wholeRoster = true): ThreadedReleaseFrozenMember[] {
    const thread = db.prepare('SELECT state FROM threaded_threads WHERE id=? AND owner_id=?').get(threadId, ownerId) as { state: string } | undefined;
    if (!thread || thread.state === 'archived') fail('THREADED_RELEASE_THREAD_FORBIDDEN', 403);
    const rows = db.prepare(`SELECT m.*,a.enabled,a.version agent_version,a.definition FROM threaded_members m JOIN agents a ON a.id=m.agent_id
      WHERE m.thread_id=? AND m.owner_id=? ORDER BY m.agent_id`).all(threadId, ownerId) as Array<{ agent_id: string; version: number; role_version: number; permission_version: number; account_version: number | null; status: string; enabled: number; agent_version: number; definition: string }>;
    if (wholeRoster && rows.length !== members.length) fail('THREADED_RELEASE_ROSTER_CHANGED');
    return members.map(member => {
      const row = rows.find(candidate => candidate.agent_id === member.agentId);
      if (!row || row.status !== 'joined' || row.enabled !== 1 || row.role_version !== member.roleVersion
        || row.agent_version !== member.roleVersion || row.permission_version !== member.permissionVersion) fail('THREADED_RELEASE_MEMBER_CHANGED');
      let definition: { accountRef?: string; requiresAccount?: boolean; model?: string };
      try { definition = JSON.parse(row.definition); } catch { return fail('THREADED_RELEASE_ROLE_INVALID'); }
      if ((definition.accountRef ?? null) !== (member.accountId ?? null) || !definition.accountRef && definition.requiresAccount) fail('THREADED_RELEASE_ACCOUNT_CHANGED');
      if (member.accountId) {
        const account = db.prepare('SELECT * FROM accounts WHERE id=? AND NOT EXISTS(SELECT 1 FROM account_revocations WHERE account_id=accounts.id)').get(member.accountId) as
          { enabled: number; archived: number; config_version: number; credential_version: number | null; identity_generation: number | null } | undefined;
        if (!account || account.enabled !== 1 || account.archived !== 0 || account.config_version !== member.accountConfigVersion
          || account.credential_version !== member.accountCredentialVersion || account.identity_generation !== member.accountIdentityGeneration
          || row.account_version !== member.accountConfigVersion) fail('THREADED_RELEASE_ACCOUNT_CHANGED');
      } else if (member.accountConfigVersion != null || member.accountCredentialVersion != null || member.accountIdentityGeneration != null || row.account_version !== null) fail('THREADED_RELEASE_ACCOUNT_CHANGED');
      return { ...member, accountId: member.accountId ?? null, accountConfigVersion: member.accountConfigVersion ?? null,
        accountCredentialVersion: member.accountCredentialVersion ?? null, accountIdentityGeneration: member.accountIdentityGeneration ?? null,
        memberVersion: row.version, definitionHash: hash(row.definition) };
    });
  }
  function assertNewRoot(ownerId: string, threadId: string, targets?: readonly string[]): ThreadedReleaseGrant {
    const control = state(ownerId);
    if (mode() !== 'execute') fail(mode() === 'observe' ? 'THREADED_RELEASE_OBSERVE_ONLY' : 'THREADED_MODE_CLOSED', 403);
    if (!control.admissionOpen) fail('THREADED_RELEASE_ADMISSION_CLOSED', 403);
    const frozen = grant(ownerId, threadId); if (!frozen) fail('THREADED_RELEASE_THREAD_NOT_GRANTED', 403);
    const current = liveMembers(ownerId, threadId, registered());
    if (hash(current) !== hash(frozen.members)) fail('THREADED_RELEASE_PACK_CHANGED');
    if (targets !== undefined && (!Array.isArray(targets) || targets.some(target => !frozen.members.some(member => member.agentId === target)))) fail('THREADED_RELEASE_TARGET_NOT_GRANTED', 403);
    return frozen;
  }
  function assertExistingWork(scope: { ownerId: string; threadId: string; agentId: string; causalRootId: string }, trusted: { allowDispatchClosed?: boolean } = {}): ThreadedReleaseFrozenMember {
    const control = state(scope.ownerId); id(scope.threadId); id(scope.agentId); id(scope.causalRootId);
    if (mode() === 'observe') fail('THREADED_RELEASE_OBSERVE_ONLY', 403);
    if (!control.dispatchOpen && trusted.allowDispatchClosed !== true) fail('THREADED_RELEASE_DISPATCH_CLOSED', 403);
    const root = db.prepare('SELECT 1 FROM threaded_release_roots WHERE causal_root_id=? AND owner_id=?').get(scope.causalRootId, scope.ownerId);
    if (!root) fail('THREADED_RELEASE_ROOT_NOT_GRANTED', 403);
    return assertGrantedMember(scope);
  }
  /** Pure scope check for current capabilities; does not create a root or authorize dispatch. */
  function assertGrantedMember(scope: {ownerId:string;threadId:string;agentId:string}):ThreadedReleaseFrozenMember {
    owner(scope.ownerId);id(scope.threadId);id(scope.agentId);
    const frozen = grant(scope.ownerId, scope.threadId); if (!frozen) fail('THREADED_RELEASE_THREAD_NOT_GRANTED', 403);
    const member = frozen.members.find(item => item.agentId === scope.agentId) ?? fail('THREADED_RELEASE_TARGET_NOT_GRANTED', 403);
    const current = liveMembers(scope.ownerId, scope.threadId, [member], false);
    if (hash(current[0]) !== hash(member)) fail('THREADED_RELEASE_MEMBER_CHANGED');
    return member;
  }
  function change(input: { ownerId: string; expectedVersion: number; requestId: string; admissionOpen: boolean; dispatchOpen: boolean; reason: string }) {
    owner(input.ownerId); id(input.requestId); id(input.reason);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || typeof input.admissionOpen !== 'boolean' || typeof input.dispatchOpen !== 'boolean') fail('THREADED_RELEASE_INPUT_INVALID', 400);
    const fingerprint = hash(input);
    return db.transaction(() => {
      const previous = db.prepare('SELECT request_hash,record FROM threaded_release_changes WHERE owner_id=? AND request_id=?').get(input.ownerId, input.requestId) as { request_hash: string; record: string } | undefined;
      if (previous) { if (previous.request_hash !== fingerprint) fail('THREADED_RELEASE_IDEMPOTENCY_CONFLICT'); return (JSON.parse(previous.record) as { result: ThreadedReleaseState }).result; }
      const before = state(input.ownerId); if (before.version !== input.expectedVersion) fail('THREADED_RELEASE_VERSION_CONFLICT');
      const result: ThreadedReleaseState = { ownerId: input.ownerId, version: before.version + 1, admissionOpen: input.admissionOpen, dispatchOpen: input.dispatchOpen, updatedAt: now() };
      if (!before.version) db.prepare('INSERT INTO threaded_release_controls VALUES(?,?,?,?,?)').run(input.ownerId, result.version, Number(result.admissionOpen), Number(result.dispatchOpen), result.updatedAt);
      else db.prepare('UPDATE threaded_release_controls SET version=?,admission_open=?,dispatch_open=?,updated_at=? WHERE owner_id=? AND version=?')
        .run(result.version, Number(result.admissionOpen), Number(result.dispatchOpen), result.updatedAt, input.ownerId, before.version);
      db.prepare('INSERT INTO threaded_release_changes VALUES(?,?,?,?,?,?)').run(input.ownerId, input.requestId, fingerprint, result.version,
        JSON.stringify({ result, expectedVersion: input.expectedVersion, requestId: input.requestId, reason: input.reason }), result.updatedAt);
      return result;
    }).immediate();
  }
  function grantThread(input: { ownerId: string; threadId: string; requestId: string }): ThreadedReleaseGrant {
    owner(input.ownerId); id(input.threadId); id(input.requestId);
    const fingerprint = hash(input);
    return db.transaction(() => {
      const prior = db.prepare('SELECT request_hash,record FROM threaded_release_grants WHERE owner_id=? AND request_id=?').get(input.ownerId, input.requestId) as { request_hash: string; record: string } | undefined;
      if (prior) { if (prior.request_hash !== fingerprint) fail('THREADED_RELEASE_IDEMPOTENCY_CONFLICT'); return JSON.parse(prior.record) as ThreadedReleaseGrant; }
      const control = state(input.ownerId);
      if (mode() !== 'execute') fail(mode() === 'observe' ? 'THREADED_RELEASE_OBSERVE_ONLY' : 'THREADED_MODE_CLOSED', 403);
      if (!control.admissionOpen) fail('THREADED_RELEASE_ADMISSION_CLOSED', 403);
      if (grant(input.ownerId, input.threadId)) fail('THREADED_RELEASE_THREAD_ALREADY_GRANTED');
      if (db.prepare('SELECT 1 FROM threaded_messages WHERE thread_id=? LIMIT 1').get(input.threadId)
        || db.prepare('SELECT 1 FROM threaded_invocations WHERE thread_id=? LIMIT 1').get(input.threadId)
        || db.prepare('SELECT 1 FROM threaded_actions WHERE thread_id=? LIMIT 1').get(input.threadId)) fail('THREADED_RELEASE_HISTORICAL_THREAD_REJECTED');
      const result: ThreadedReleaseGrant = { ownerId: input.ownerId, threadId: input.threadId, controlVersion: control.version,
        members: liveMembers(input.ownerId, input.threadId, registered()), grantedAt: now() };
      db.prepare('INSERT INTO threaded_release_grants VALUES(?,?,?,?,?,?,?)').run(input.threadId, input.ownerId, input.requestId, fingerprint, control.version, JSON.stringify(result), result.grantedAt);
      return result;
    }).immediate();
  }
  function recordRootWithin(ownerId: string, threadId: string, messageId: string): void {
    if (!db.inTransaction) fail('THREADED_RELEASE_TRANSACTION_REQUIRED');
    owner(ownerId); id(threadId); id(messageId);
    const source = db.prepare('SELECT causal_root_id,origin,state,record FROM threaded_messages WHERE id=? AND thread_id=? AND owner_id=?').get(messageId, threadId, ownerId) as { causal_root_id: string; origin: string; state: string; record: string } | undefined;
    if (!source || source.causal_root_id !== messageId || source.origin !== 'user' || source.state !== 'published') fail('THREADED_RELEASE_ROOT_SOURCE_INVALID');
    const prior = db.prepare('SELECT home_thread_id FROM threaded_release_roots WHERE causal_root_id=? AND owner_id=?').get(messageId, ownerId) as { home_thread_id: string } | undefined;
    if (prior) { if (prior.home_thread_id !== threadId) fail('THREADED_RELEASE_ROOT_SOURCE_INVALID'); return; }
    const frozen = assertNewRoot(ownerId, threadId, (JSON.parse(source.record) as { targets: string[] }).targets), control = state(ownerId);
    db.prepare('INSERT INTO threaded_release_roots VALUES(?,?,?,?,?,?,?)').run(messageId, ownerId, threadId, frozen.threadId, control.version,
      JSON.stringify({ ownerId, causalRootId: messageId, homeThreadId: threadId, grantThreadId: frozen.threadId, controlVersion: control.version, members: frozen.members }), now());
  }
  function snapshot(ownerId: string, threadId?: string) {
    owner(ownerId); if (threadId !== undefined) id(threadId);
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name));
    const count = (table: string, where: string) => tables.has(table) ? (db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE owner_id=?${threadId === undefined ? '' : ' AND thread_id=?'} AND (${where})`).get(...(threadId === undefined ? [ownerId] : [ownerId,threadId])) as { n: number }).n : 0;
    const joinedCount = (table: string, join: string, scopeAlias: string, where: string) => tables.has(table) ? (db.prepare(`SELECT COUNT(*) n FROM ${table} x ${join}
      WHERE ${scopeAlias}.owner_id=?${threadId === undefined ? '' : ` AND ${scopeAlias}.thread_id=?`} AND (${where})`)
      .get(...(threadId === undefined ? [ownerId] : [ownerId,threadId])) as { n: number }).n : 0;
    const work = { queued: count('threaded_wake_queue', "state IN ('queued','blocked')"), running: count('threaded_invocations', "status='running'"),
      waiting: count('threaded_invocations', "status IN ('queued','waiting')"), unknownExecutions: count('threaded_invocations', "status='unknown'"),
      undispatchedWakes: joinedCount('threaded_wakes', 'LEFT JOIN threaded_wake_queue q ON q.wake_id=x.id', 'x', "x.status IN ('pending','blocked') AND q.id IS NULL"),
      activeClaims: joinedCount('execution_resource_claims', 'JOIN execution_resource_tickets s ON s.id=x.ticket_id', 's', "s.mode='threaded' AND x.state<>'released'"),
      unresolvedActions: count('threaded_actions', "state<>'completed'"),
      pendingOutbox: count('threaded_outbox', "status IN ('pending','claimed')"),
      unresolvedCommands: count('threaded_commands', "state NOT IN ('completed','failed','cancelled')"),
      durableWaits: count('threaded_waits', "state='awaiting'"), consultations: count('threaded_consultations', "state='collecting'"),
      callbacks: count('threaded_collaboration_callbacks', "state IN ('pending','waiting')"),
      pendingApprovals: count('threaded_approvals', "status='pending'"),
      unknownUsage: count('threaded_budget_requests', "usage_state='unknown' OR execution_state='unknown'"),
      activeProcesses: joinedCount('threaded_backend_processes', 'JOIN threaded_execution_bindings s ON s.id=x.binding_id', 's', "x.state<>'verified_stopped'") };
    const control = state(ownerId), configuredMode = mode();
    return { readOnly: true as const, mode: configuredMode, control, grants: threadId === undefined
      ? (db.prepare('SELECT record FROM threaded_release_grants WHERE owner_id=? ORDER BY created_at,thread_id').all(ownerId) as Array<{ record: string }>).map(row => JSON.parse(row.record) as ThreadedReleaseGrant)
      : [grant(ownerId, threadId)].filter((item): item is ThreadedReleaseGrant => Boolean(item)), work,
      drain: { scope: 'threaded_only' as const, compatibleWorkerRequired: Object.values(work).some(value => value > 0), ready: (configuredMode !== 'execute' || !control.admissionOpen) && Object.values(work).every(value => value === 0),
        dispatchAllowed: configuredMode !== 'observe' && control.dispatchOpen, unknownNeedsReview: work.unknownExecutions + work.unknownUsage + work.activeProcesses > 0 },
      wholeDatabaseRollbackReady: false as const,
      rollback: 'Retain new schema and compatible workers. Restore only a matching consistent backup with its matching application revision; never erase unknown facts or lower migration versions.' };
  }
  return { state, change, grantThread, grant, assertNewRoot, assertGrantedMember, assertExistingWork, recordRootWithin, snapshot };
}

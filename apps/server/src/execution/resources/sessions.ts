import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import type Database from 'better-sqlite3';
import type { ResourceSessionReference, TrustedResourceRequest } from './types.ts';

type SessionRow = { id: string; owner_id: string; binding_key: string; version: number; native_id: string | null;
  resource_key: string | null; state: string; record: string };
type SessionAccount = { id: string; config_version: number; credential_version: number | null;
  identity_generation: number | null; auth_type: string };
export type ThreadedSessionPreparation = {
  ownerId: string; threadId: string; agentId: string; backend: 'api' | 'claude-sdk';
  backendVersion: string; model: string; workspace: string; informationBoundary: string;
  /** A caller that already read a binding can require a compare-and-swap. Zero means absent. */
  expectedVersion?: number;
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code: string): never => { throw new Error(code); };
const reference = (row: SessionRow): ResourceSessionReference => ({ id: row.id, version: row.version,
  nativeId: row.native_id, resourceKey: row.resource_key });

export function canonicalWorkspace(workspace: string): string {
  const canonical = realpathSync(workspace);
  if (!statSync(canonical).isDirectory()) fail('RESOURCE_WORKSPACE_NOT_DIRECTORY');
  return canonical;
}

/** Policy/binding hashes deliberately do not appear in the native mutex identity. */
export function nativeSessionResourceKey(input: { backend: string; accountIdentity: string; host: string; nativeId: string }): string {
  if (Object.values(input).some(value => !value)) fail('RESOURCE_SESSION_IDENTITY_REQUIRED');
  return `native-session:${hash([input.backend, input.accountIdentity, input.host, input.nativeId])}`;
}

function save(db: Database.Database, input: { ownerId: string; bindingKey: string; nativeId: string | null;
  resourceKey: string | null; record: unknown; expectedVersion?: number }): ResourceSessionReference {
  const current = db.prepare('SELECT * FROM execution_resource_sessions WHERE owner_id=? AND binding_key=?')
    .get(input.ownerId, input.bindingKey) as SessionRow | undefined;
  if (input.expectedVersion !== undefined && input.expectedVersion !== (current?.version ?? 0)) fail('RESOURCE_SESSION_CAS_CONFLICT');
  if ((input.nativeId === null) !== (input.resourceKey === null)) fail('RESOURCE_SESSION_IDENTITY_REQUIRED');
  const record = JSON.stringify(input.record);
  if (current?.state === 'ready' && current.native_id === input.nativeId && current.resource_key === input.resourceKey
    && current.record === record) return reference(current);
  const id = current?.id ?? randomUUID(); const version = (current?.version ?? 0) + 1;
  const now = Date.now();
  if (current) {
    const changed = db.prepare(`UPDATE execution_resource_sessions SET version=?,native_id=?,resource_key=?,state='ready',record=?,updated_at=?
      WHERE id=? AND version=?`).run(version, input.nativeId, input.resourceKey, record, now, id, current.version).changes;
    if (changed !== 1) fail('RESOURCE_SESSION_CAS_CONFLICT');
  } else db.prepare(`INSERT INTO execution_resource_sessions(id,owner_id,binding_key,version,native_id,resource_key,state,record,updated_at)
    VALUES(?,?,?,?,?,?,'ready',?,?)`).run(id, input.ownerId, input.bindingKey, version, input.nativeId, input.resourceKey, record, now);
  db.prepare(`INSERT INTO execution_resource_session_versions(session_id,version,native_id,resource_key,record,created_at)
    VALUES(?,?,?,?,?,?)`).run(id, version, input.nativeId, input.resourceKey, record, now);
  return { id, version, nativeId: input.nativeId, resourceKey: input.resourceKey };
}

/** Compatibility index only; the legacy session ledger continues to own its transcript. */
export function registerLegacyResourceSession(db: Database.Database, input: { ownerId: string; bindingKey: string;
  nativeId: string | null; resourceKey: string | null; record: unknown; expectedVersion?: number }): ResourceSessionReference {
  return db.transaction(() => save(db, { ...input, bindingKey: `legacy:${input.bindingKey}` })).immediate();
}

function policySnapshot(db: Database.Database, input: ThreadedSessionPreparation) {
  if (!['api', 'claude-sdk'].includes(input.backend)) fail('THREADED_SESSION_BACKEND_DISABLED');
  if (!input.backendVersion || !input.model || !input.informationBoundary) fail('RESOURCE_SESSION_POLICY_REQUIRED');
  const row = db.prepare(`SELECT m.*,a.version agent_version,a.definition,a.enabled,t.state thread_state
    FROM threaded_members m JOIN agents a ON a.id=m.agent_id
    JOIN threaded_threads t ON t.id=m.thread_id AND t.owner_id=m.owner_id
    JOIN threaded_instances i ON i.singleton=1 AND i.instance_owner_id=m.owner_id
    WHERE m.owner_id=? AND m.thread_id=? AND m.agent_id=?`).get(input.ownerId, input.threadId, input.agentId) as
    { version: number; role_version: number; permission_version: number; account_version: number | null;
      agent_version: number; definition: string; enabled: number; thread_state: string; status: string } | undefined;
  if (!row || row.status !== 'joined' || row.enabled !== 1 || row.thread_state !== 'open'
    || row.role_version !== row.agent_version) return fail('THREADED_SESSION_MEMBER_UNAVAILABLE');
  const definition = JSON.parse(row.definition) as { accountRef?: string; requiresAccount?: boolean };
  let account: SessionAccount | null = null;
  if (definition.accountRef) {
    account = db.prepare(`SELECT id,config_version,credential_version,identity_generation,auth_type FROM accounts
      WHERE id=? AND enabled=1 AND archived=0 AND NOT EXISTS(SELECT 1 FROM account_revocations WHERE account_id=accounts.id)`)
      .get(definition.accountRef) as SessionAccount | null;
    if (!account) return fail('THREADED_SESSION_ACCOUNT_UNAVAILABLE');
    if (account.auth_type === 'native_login' && !db.prepare(`SELECT 1 FROM account_native_identities
      WHERE account_id=? AND generation=? AND status='authenticated'`).get(account.id, account.identity_generation)) {
      return fail('THREADED_SESSION_ACCOUNT_UNAVAILABLE');
    }
  } else if (definition.requiresAccount) return fail('THREADED_SESSION_ACCOUNT_UNAVAILABLE');
  return { ownerId: input.ownerId, threadId: input.threadId, agentId: input.agentId,
    backend: input.backend, backendVersion: input.backendVersion, model: input.model,
    workspace: canonicalWorkspace(input.workspace), workspaceInput: input.workspace, informationBoundary: input.informationBoundary,
    memberVersion: row.version, roleVersion: row.role_version, permissionVersion: row.permission_version,
    memberAccountVersion: row.account_version, agentVersion: row.agent_version, definitionHash: hash(row.definition), account,
    host: hostname() };
}

/** Short metadata CAS only: no provider, capacity, process or execution resource is acquired here. */
export function prepareThreadedSession(db: Database.Database, input: ThreadedSessionPreparation): ResourceSessionReference {
  return db.transaction(() => {
    const policy = policySnapshot(db, input);
    const bindingKey = `threaded:${hash([input.ownerId, input.threadId, input.agentId, input.backend])}`;
    const current = db.prepare('SELECT * FROM execution_resource_sessions WHERE owner_id=? AND binding_key=?')
      .get(input.ownerId, bindingKey) as SessionRow | undefined;
    if (input.expectedVersion !== undefined && input.expectedVersion !== (current?.version ?? 0)) fail('RESOURCE_SESSION_CAS_CONFLICT');
    const record = { kind: 'threaded', policy };
    if (current?.state === 'reconciling') fail('RESOURCE_SESSION_RECONCILIATION_REQUIRED');
    if (current?.state === 'ready' && current.record === JSON.stringify(record)) return reference(current);
    const nativeId = input.backend === 'claude-sdk' ? randomUUID() : null;
    const accountIdentity = policy.account ? `${policy.account.id}:${policy.account.identity_generation ?? 0}` : `instance:${input.ownerId}`;
    const resourceKey = nativeId ? nativeSessionResourceKey({ backend: input.backend, accountIdentity, host: policy.host, nativeId }) : null;
    return save(db, { ownerId: input.ownerId, bindingKey, nativeId, resourceKey, record, expectedVersion: input.expectedVersion });
  }).immediate();
}

/** Called inside resource acquisition, so a stale preparation never creates a partial claim. */
export function assertResourceSessionCurrent(db: Database.Database, request: TrustedResourceRequest): void {
  if (!request.session) { if (request.mode === 'threaded') fail('THREADED_SESSION_PREPARATION_REQUIRED'); return; }
  const ref = request.session;
  const row = db.prepare('SELECT * FROM execution_resource_sessions WHERE id=? AND owner_id=?')
    .get(ref.id, request.ownerId) as SessionRow | undefined;
  if (!row || row.state !== 'ready' || row.version !== ref.version || row.native_id !== ref.nativeId
    || row.resource_key !== ref.resourceKey) return fail('RESOURCE_SESSION_STALE');
  if (request.mode === 'legacy') return;
  const record = JSON.parse(row.record) as { kind: string; policy: ReturnType<typeof policySnapshot> };
  if (record.kind !== 'threaded' || record.policy.threadId !== request.threadId || record.policy.agentId !== request.agentId) fail('RESOURCE_SESSION_SCOPE_MISMATCH');
  const p = record.policy;
  const live = policySnapshot(db, { ...p, workspace: p.workspaceInput });
  if (JSON.stringify(live) !== JSON.stringify(p) || (p.account?.id ?? undefined) !== request.accountId
    || (p.account?.identity_generation ?? undefined) !== request.accountIdentityGeneration) fail('RESOURCE_SESSION_POLICY_CHANGED');
  if (!request.workspaces?.some(w => w.path === p.workspace)) fail('RESOURCE_SESSION_WORKSPACE_REQUIRED');
}

export function invalidateResourceSession(db: Database.Database, ref: ResourceSessionReference, reason: string): void {
  const changed = db.prepare(`UPDATE execution_resource_sessions SET state='reconciling',record=json_set(record,'$.reconciliationReason',?),updated_at=?
    WHERE id=? AND version=? AND native_id IS ? AND resource_key IS ?`).run(reason, Date.now(), ref.id, ref.version, ref.nativeId, ref.resourceKey).changes;
  if (!changed) fail('RESOURCE_SESSION_STALE');
}

/** The adapter must stop further tools/resume when this throws, and mark its claim unknown. */
export function assertExpectedNativeSession(db: Database.Database, ref: ResourceSessionReference, observedNativeId: string): void {
  if (ref.nativeId !== observedNativeId) {
    invalidateResourceSession(db, ref, 'unexpected_native_id');
    fail('RESOURCE_SESSION_IDENTITY_RECONCILIATION_REQUIRED');
  }
  const row = db.prepare("SELECT 1 FROM execution_resource_sessions WHERE id=? AND version=? AND state='ready' AND native_id=?")
    .get(ref.id, ref.version, observedNativeId);
  if (!row) fail('RESOURCE_SESSION_STALE');
}

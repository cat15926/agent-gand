import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ThreadedBinding } from '@agent-gand/shared';
import { ThreadedAuthorityError, unavailableThreadedResources } from './contracts.ts';
import type { ExecutionResourcesPort, ThreadedAuthority, ThreadedClaimIdentity } from './contracts.ts';

type BindingRow = {
  id: string; attempt_id: string; invocation_id: string; thread_id: string; owner_id: string;
  agent_id: string; run_id: string; authority_epoch: number; thread_authority_epoch: number;
  claim_id: string; claim_owner: string; generation: number; fencing_token: string;
  member_version: number; role_version: number; permission_version: number; member_account_version: number | null;
  agent_version: number; agent_definition_hash: string; account_id: string | null;
  account_config_version: number | null; account_credential_version: number | null; account_identity_generation: number | null;
};
type Context = {
  attempt_id: string; invocation_id: string; thread_id: string; owner_id: string; agent_id: string;
  run_id: string; run_mode: string; run_status: string; run_conversation_id: string; conversation_id: string;
  thread_mode: string; thread_state: string; thread_epoch: number; instance_owner_id: string;
  invocation_epoch: number; invocation_status: string; current_attempt_id: string | null;
  pause_requested: number; cancel_requested: number; invocation_account_id: string | null; invocation_account_identity_generation: number | null;
  attempt_epoch: number; attempt_status: string; execution_stage: string;
  claim_id: string | null; claim_owner: string | null; generation: number; fencing_token: string | null;
  member_status: string; member_version: number; role_version: number; permission_version: number; member_account_version: number | null;
  agent_enabled: number; agent_version: number; agent_definition: string;
};
type AccountRow = {
  id: string; enabled: number; archived: number; config_version: number;
  credential_version: number | null; identity_generation: number | null; auth_type: string;
};

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const terminal = (status: string) => ['completed', 'failed', 'cancelled'].includes(status);
const deny = (code = 'THREADED_BINDING_UNAUTHORIZED'): never => { throw new ThreadedAuthorityError(code); };
const bindingFrom = (row: BindingRow): ThreadedBinding => ({
  schemaVersion: 1, id: row.id, origin: 'threaded_invocation_attempt', threadId: row.thread_id,
  invocationId: row.invocation_id, runId: row.run_id, attemptId: row.attempt_id,
  ownerId: row.owner_id, agentId: row.agent_id, authorityEpoch: row.authority_epoch,
  claimId: row.claim_id, generation: row.generation, fencingToken: row.fencing_token,
});
const claimFrom = (row: BindingRow): ThreadedClaimIdentity => ({
  claimId: row.claim_id, generation: row.generation, fencingToken: row.fencing_token,
  claimOwner: row.claim_owner, ownerId: row.owner_id, threadId: row.thread_id,
  invocationId: row.invocation_id, runId: row.run_id, attemptId: row.attempt_id, agentId: row.agent_id,
});

/** Pure DB injection: no business singleton, credential resolution, driver or model imports. */
export function createThreadedAuthority(db: Database.Database, resources: ExecutionResourcesPort = unavailableThreadedResources): ThreadedAuthority {
  if (db.pragma('foreign_keys', { simple: true }) !== 1) deny('THREADED_FOREIGN_KEYS_REQUIRED');
  function context(attemptId: string): Context {
    const found = db.prepare(`SELECT
      a.id attempt_id,a.invocation_id,a.thread_id,a.owner_id,a.agent_id,
      a.authority_epoch attempt_epoch,a.status attempt_status,a.execution_stage,
      a.claim_id,a.claim_owner,a.generation,a.fencing_token,
      i.authority_epoch invocation_epoch,i.status invocation_status,i.current_attempt_id,
      i.pause_requested,i.cancel_requested,i.account_id invocation_account_id,i.account_identity_generation invocation_account_identity_generation,
      t.mode thread_mode,t.state thread_state,t.authority_epoch thread_epoch,t.conversation_id,
      m.status member_status,m.version member_version,m.role_version,m.permission_version,m.account_version member_account_version,
      g.enabled agent_enabled,g.version agent_version,g.definition agent_definition,
      r.id run_id,r.mode run_mode,r.status run_status,r.conversation_id run_conversation_id,s.instance_owner_id
      FROM threaded_attempts a
      JOIN threaded_invocations i ON i.id=a.invocation_id AND i.thread_id=a.thread_id AND i.owner_id=a.owner_id AND i.agent_id=a.agent_id
      JOIN threaded_threads t ON t.id=a.thread_id AND t.owner_id=a.owner_id
      JOIN threaded_members m ON m.thread_id=a.thread_id AND m.owner_id=a.owner_id AND m.agent_id=a.agent_id
      JOIN agents g ON g.id=a.agent_id
      JOIN threaded_run_bindings b ON b.invocation_id=a.invocation_id AND b.thread_id=a.thread_id AND b.owner_id=a.owner_id
      JOIN runs r ON r.id=b.run_id
      JOIN threaded_instances s ON s.singleton=1 AND s.instance_owner_id=a.owner_id
      WHERE a.id=?`).get(attemptId) as Context | undefined;
    if (!found) return deny();
    return found;
  }
  function persisted(binding: ThreadedBinding): BindingRow {
    if (!binding || binding.schemaVersion !== 1 || binding.origin !== 'threaded_invocation_attempt'
      || typeof binding.id !== 'string' || !binding.id) return deny();
    const row = db.prepare('SELECT * FROM threaded_execution_bindings WHERE id=?').get(binding.id) as BindingRow | undefined;
    if (!row) return deny();
    const expected = bindingFrom(row);
    for (const key of Object.keys(expected) as Array<keyof ThreadedBinding>) if (binding[key] !== expected[key]) return deny();
    // Workspace snapshots belong to a later dedicated resource protocol, never client-provided authority.
    if (binding.workspaceSnapshot !== undefined) return deny();
    return row;
  }
  function current(row: BindingRow): Context {
    const live = context(row.attempt_id);
    if (live.current_attempt_id !== row.attempt_id || live.run_id !== row.run_id
      || live.thread_id !== row.thread_id || live.owner_id !== row.owner_id || live.agent_id !== row.agent_id
      || live.invocation_id !== row.invocation_id || live.instance_owner_id !== row.owner_id
      || live.run_mode !== 'threaded' || live.thread_mode !== 'threaded'
      || live.run_conversation_id !== live.conversation_id
      || live.claim_id !== row.claim_id || live.claim_owner !== row.claim_owner
      || live.generation !== row.generation || live.fencing_token !== row.fencing_token
      || live.attempt_epoch !== row.authority_epoch) return deny();
    resources.assertCurrent(claimFrom(row));
    return live;
  }
  function accountSnapshot(live: Context): AccountRow | null {
    let definition: { accountRef?: unknown; requiresAccount?: unknown };
    try { definition = JSON.parse(live.agent_definition) as typeof definition; } catch { return deny(); }
    if (!definition || typeof definition !== 'object') return deny();
    if (definition.accountRef == null) {
      if (definition.requiresAccount || live.invocation_account_id !== null || live.invocation_account_identity_generation !== null) return deny();
      return null;
    }
    if (typeof definition.accountRef !== 'string' || !definition.accountRef) return deny();
    const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(definition.accountRef) as AccountRow | undefined;
    if (!account || account.enabled !== 1 || account.archived !== 0
      || db.prepare('SELECT 1 FROM account_revocations WHERE account_id=?').get(account.id)) return deny();
    if (live.invocation_account_id !== account.id || live.invocation_account_identity_generation !== account.identity_generation) return deny();
    if (account.auth_type === 'native_login' && (account.identity_generation === null
      || !db.prepare("SELECT 1 FROM account_native_identities WHERE account_id=? AND generation=? AND status='authenticated'")
        .get(account.id, account.identity_generation))) return deny();
    return account;
  }
  function authorize(row: BindingRow, options: { allowApproval?: boolean } = {}): void {
    const live = current(row);
    for (const scope of ['member', 'invocation'] as const) {
      const control = db.prepare(`SELECT action FROM threaded_control_requests WHERE thread_id=? AND owner_id=? AND scope=?
        AND ${scope === 'member' ? 'agent_id' : 'invocation_id'}=? ORDER BY rowid DESC LIMIT 1`)
        .get(row.thread_id, row.owner_id, scope, scope === 'member' ? row.agent_id : row.invocation_id) as { action: string } | undefined;
      if (control && control.action !== 'resume') return deny();
    }
    if (live.thread_state !== 'open' || live.member_status !== 'joined' || live.agent_enabled !== 1
      || live.role_version !== live.agent_version
      || terminal(live.run_status) || terminal(live.invocation_status) || terminal(live.attempt_status)
      || live.pause_requested || live.cancel_requested || live.invocation_status === 'unknown'
      || live.attempt_status === 'unknown' || live.execution_stage === 'unknown'
      || live.invocation_epoch !== row.authority_epoch || live.thread_epoch !== row.thread_authority_epoch
      || live.member_version !== row.member_version || live.role_version !== row.role_version
      || live.permission_version !== row.permission_version || live.member_account_version !== row.member_account_version
      || live.agent_version !== row.agent_version || hash(live.agent_definition) !== row.agent_definition_hash) return deny();
    if (!options.allowApproval && (live.attempt_status === 'waiting'
      || db.prepare("SELECT 1 FROM threaded_approvals WHERE attempt_id=? AND status='pending'").get(row.attempt_id))) return deny();
    const account = accountSnapshot(live);
    if ((account?.id ?? null) !== row.account_id || (account?.config_version ?? null) !== row.account_config_version
      || (account?.credential_version ?? null) !== row.account_credential_version
      || (account?.identity_generation ?? null) !== row.account_identity_generation) return deny();
  }
  return {
    capture(attemptId) {
      const existing = db.prepare('SELECT * FROM threaded_execution_bindings WHERE attempt_id=?').get(attemptId) as BindingRow | undefined;
      if (existing) { authorize(existing); return bindingFrom(existing); }
      if (!db.inTransaction) return deny('THREADED_BINDING_TRANSACTION_REQUIRED');
      const live = context(attemptId);
      if (!live.claim_id || !live.claim_owner || !live.fencing_token || !Number.isSafeInteger(live.generation) || live.generation < 1
        || live.attempt_epoch !== live.invocation_epoch) return deny();
      const account = accountSnapshot(live);
      const row: BindingRow = {
        id: randomUUID(), attempt_id: live.attempt_id, invocation_id: live.invocation_id, thread_id: live.thread_id,
        owner_id: live.owner_id, agent_id: live.agent_id, run_id: live.run_id,
        authority_epoch: live.invocation_epoch, thread_authority_epoch: live.thread_epoch,
        claim_id: live.claim_id, claim_owner: live.claim_owner, generation: live.generation, fencing_token: live.fencing_token,
        member_version: live.member_version, role_version: live.role_version, permission_version: live.permission_version,
        member_account_version: live.member_account_version, agent_version: live.agent_version,
        agent_definition_hash: hash(live.agent_definition), account_id: account?.id ?? null,
        account_config_version: account?.config_version ?? null, account_credential_version: account?.credential_version ?? null,
        account_identity_generation: account?.identity_generation ?? null,
      };
      // Retrying an Invocation reuses its Run and frozen authority policy. A new Attempt may
      // change execution epochs/resources, but cannot silently adopt new credentials or grants.
      const first = db.prepare(`SELECT b.* FROM threaded_execution_bindings b
        JOIN threaded_attempts a ON a.id=b.attempt_id AND a.invocation_id=b.invocation_id
        WHERE b.invocation_id=? ORDER BY a.attempt_no LIMIT 1`).get(live.invocation_id) as BindingRow | undefined;
      if (first) {
        const frozen = [
          'member_version', 'role_version', 'permission_version', 'member_account_version',
          'agent_version', 'agent_definition_hash', 'account_id', 'account_config_version',
          'account_credential_version', 'account_identity_generation',
        ] as const;
        for (const field of frozen) if (row[field] !== first[field]) return deny('THREADED_INVOCATION_SNAPSHOT_CHANGED');
      }
      authorize(row);
      const keys = Object.keys(row);
      db.prepare(`INSERT INTO threaded_execution_bindings(${keys.join(',')},created_at) VALUES(${keys.map(() => '?').join(',')},?)`)
        .run(...Object.values(row), new Date().toISOString());
      return bindingFrom(row);
    },
    assertAuthorized(binding, options) { authorize(persisted(binding), options); },
    authorized(binding) { try { authorize(persisted(binding)); return true; } catch { return false; } },
    assertCurrent(binding) { current(persisted(binding)); },
    claim(binding) { return claimFrom(persisted(binding)); },
  };
}

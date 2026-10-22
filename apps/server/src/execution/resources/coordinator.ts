import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { ExecutionResourcesPort, QuiescenceProof } from '../../threaded/contracts.ts';
import type {
  ResourceAvailability, ResourceClaimIdentity, ResourceClaimRecord, ResourceEvidence,
  ResourcePolicy, ResourceTicket, TrustedResourceRequest,
} from './types.ts';

export class ResourceCoordinatorError extends Error {
  readonly status = 409;
  constructor(readonly code: string) { super(code); this.name = 'ResourceCoordinatorError'; }
}
const deny = (code: string): never => { throw new ResourceCoordinatorError(code); };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const required = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) deny('RESOURCE_INVALID_REQUEST');
};
type TicketRow = { id: string; seq: number; status: ResourceTicket['status']; eligible: number; request: string; request_hash: string; policy_version: number };
type ClaimRow = { id: string; ticket_id: string; owner_nonce: string; generation: number; fencing_token: string;
  state: ResourceClaimRecord['state']; expires_at: number; request: string };
type Item = { key: string; kind: 'agent' | 'session' | 'workspace' | 'capacity'; access: 'exclusive' | 'slot' | 'read' | 'write' | 'capacity' };
const ticketFrom = (row: TicketRow): ResourceTicket => ({ id: row.id, seq: row.seq, status: row.status,
  eligible: row.eligible === 1, request: JSON.parse(row.request) as TrustedResourceRequest });
const identityFrom = (row: ClaimRow): ResourceClaimIdentity => {
  const request = JSON.parse(row.request) as TrustedResourceRequest;
  return { claimId: row.id, generation: row.generation, fencingToken: row.fencing_token, claimOwner: row.owner_nonce,
    ownerId: request.ownerId, threadId: request.threadId ?? '', invocationId: request.invocationId ?? '',
    runId: request.runId, attemptId: request.attemptId, agentId: request.agentId };
};

/** Durable, DB-injected coordinator. It never imports a provider, business singleton or executor. */
export function createExecutionResourceCoordinator(db: Database.Database, options: {
  ownerNonce: string;
  now?: () => number;
  leaseMs?: number;
  defaultCapacity?: number;
  validateRequest?: (request: TrustedResourceRequest) => void;
  /** Must resolve durable host/process and side-effect evidence; a client boolean is not evidence. */
  verifyEvidence?: (request: TrustedResourceRequest, claim: ResourceClaimIdentity, evidence: ResourceEvidence) => boolean;
}): ExecutionResourcesPort & {
  enqueue(request: TrustedResourceRequest): ResourceTicket;
  tryAcquire(ticketId: string): ResourceClaimIdentity | null;
  getTicket(ticketId: string): ResourceTicket | null;
  getTicketByKey(requestKey: string): ResourceTicket | null;
  getClaim(claimId: string): ResourceClaimRecord | null;
  getClaimForTicket(ticketId: string): ResourceClaimRecord | null;
  listClaims(): ResourceClaimRecord[];
  setEligible(ticketId: string, eligible: boolean): void;
  cancelTicket(ticketId: string): void;
  requeuePreparation(ticketId: string): ResourceTicket;
  renew(claim: ResourceClaimIdentity): void;
  markStarted(claim: ResourceClaimIdentity): void;
  markUnknown(claim: ResourceClaimIdentity): void;
  assertExecutable(claim: ResourceClaimIdentity): void;
  recordQuiescence(claim: ResourceClaimIdentity, evidence: ResourceEvidence): QuiescenceProof;
  recoverExpired(): ResourceClaimRecord[];
  getPolicy(): ResourcePolicy;
  configurePolicy(ownerId: string, patch: Partial<Omit<ResourcePolicy, 'version'>>, expectedVersion: number): ResourcePolicy;
  onAvailable(listener: (event: ResourceAvailability) => void): () => void;
  scanPending(afterSeq?: number): { cursor: number; events: ResourceAvailability[]; tickets: ResourceTicket[] };
} {
  required(options.ownerNonce);
  if (db.pragma('foreign_keys', { simple: true }) !== 1) deny('RESOURCE_FOREIGN_KEYS_REQUIRED');
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? 15_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) deny('RESOURCE_INVALID_LEASE');
  const owner = (db.prepare('SELECT instance_owner_id FROM threaded_instances WHERE singleton=1').get() as { instance_owner_id: string } | undefined)?.instance_owner_id;
  if (!owner) deny('RESOURCE_INSTANCE_OWNER_REQUIRED');
  const defaultCapacity = options.defaultCapacity ?? 3;
  if (!Number.isSafeInteger(defaultCapacity) || defaultCapacity < 1) deny('RESOURCE_INVALID_CAPACITY');
  const defaultPolicy: ResourcePolicy = { version: 1, globalLimit: defaultCapacity, threadLimit: defaultCapacity, accountLimit: defaultCapacity, accountLimits: {}, providerLimits: {} };
  db.prepare('INSERT OR IGNORE INTO execution_resource_policy(singleton,owner_id,version,record) VALUES(1,?,1,?)')
    .run(owner, JSON.stringify(defaultPolicy));
  const getPolicy = () => JSON.parse((db.prepare('SELECT record FROM execution_resource_policy WHERE singleton=1').get() as { record: string }).record) as ResourcePolicy;
  const listeners = new Set<(event: ResourceAvailability) => void>();
  let cursor = (db.prepare('SELECT COALESCE(MAX(seq),0) seq FROM execution_resource_availability').get() as { seq: number }).seq;
  let scheduled = false;
  const ticketRow = (id: string) => db.prepare('SELECT * FROM execution_resource_tickets WHERE id=?').get(id) as TicketRow | undefined;
  const claimRow = (id: string) => db.prepare(`SELECT c.*,t.request FROM execution_resource_claims c
    JOIN execution_resource_tickets t ON t.id=c.ticket_id WHERE c.id=?`).get(id) as ClaimRow | undefined;
  const claimRecord = (row: ClaimRow): ResourceClaimRecord => ({ identity: identityFrom(row), ticketId: row.ticket_id,
    state: row.state, expiresAt: row.expires_at, request: JSON.parse(row.request) as TrustedResourceRequest });
  const activeRows = () => db.prepare(`SELECT c.*,t.request FROM execution_resource_claims c
    JOIN execution_resource_tickets t ON t.id=c.ticket_id WHERE c.state<>'released'`).all() as ClaimRow[];
  function scanPending(afterSeq?: number) {
    const from = afterSeq ?? cursor;
    const events = db.prepare('SELECT seq,reason,agent_id agentId FROM execution_resource_availability WHERE seq>? ORDER BY seq')
      .all(from) as ResourceAvailability[];
    const next = events.at(-1)?.seq ?? from;
    if (afterSeq === undefined) {
      cursor = next;
      for (const event of events) for (const listener of listeners) { try { listener(event); } catch { /* Notification failure cannot undo durable release. */ } }
    }
    return { cursor: next, events, tickets: (db.prepare("SELECT * FROM execution_resource_tickets WHERE status='waiting' AND eligible=1 ORDER BY seq").all() as TicketRow[]).map(ticketFrom) };
  }
  function notify(reason: string, agentId = '') {
    db.prepare('INSERT INTO execution_resource_availability(reason,agent_id,created_at) VALUES(?,?,?)').run(reason, agentId, now());
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => { scheduled = false; if (db.open && !db.inTransaction) scanPending(); });
    }
  }
  function exact(claim: ResourceClaimIdentity, allowReleased = false): ClaimRow {
    const row = claim && claimRow(claim.claimId);
    if (!row) return deny('RESOURCE_CLAIM_NOT_FOUND');
    const saved = identityFrom(row);
    for (const key of Object.keys(saved) as Array<keyof ResourceClaimIdentity>) if (claim[key] !== saved[key]) deny('RESOURCE_STALE_FENCE');
    if (!allowReleased && row.state === 'released') deny('RESOURCE_CLAIM_RELEASED');
    return row;
  }
  function ancestors(request: TrustedResourceRequest): Set<string> {
    const ids = new Set<string>();
    let parent = request.parentClaim;
    while (parent) {
      if (ids.has(parent.claimId) || ids.size > 8) deny('RESOURCE_PARENT_CYCLE');
      const row = exact(parent);
      if (row.state === 'unknown' || row.state === 'quiescent') deny('RESOURCE_PARENT_UNAVAILABLE');
      const parentRequest = JSON.parse(row.request) as TrustedResourceRequest;
      if (request.mode !== 'legacy' || parentRequest.capacity !== false) deny('RESOURCE_PARENT_NOT_PREPARATION');
      if (parentRequest.ownerId !== request.ownerId || parentRequest.runId !== request.runId || parentRequest.agentId !== request.agentId
        || parentRequest.mode !== request.mode || (parentRequest.threadId ?? null) !== (request.threadId ?? null)) deny('RESOURCE_PARENT_SCOPE_MISMATCH');
      ids.add(row.id); parent = parentRequest.parentClaim;
    }
    return ids;
  }
  function validateScope(request: TrustedResourceRequest) {
    if (request.ownerId !== owner) deny('RESOURCE_OWNER_MISMATCH');
    const agent = db.prepare('SELECT enabled FROM agents WHERE id=?').get(request.agentId) as { enabled: number } | undefined;
    if (!agent || agent.enabled !== 1) deny('RESOURCE_AGENT_UNAVAILABLE');
    if (request.threadedCommand) {
      if (request.mode !== 'threaded' || request.capacity !== false || request.parentClaim || request.session || request.accountId || request.providerKey
        || !request.workspaces?.length) deny('RESOURCE_COMMAND_REQUEST_INVALID');
      const command = db.prepare(`SELECT c.*,o.registration_id,o.binding_id os_binding_id,json_extract(o.record,'$.cwd') command_cwd,
        json_extract(o.record,'$.workspaceClaims') command_workspaces,b.attempt_id,b.invocation_id,b.run_id,
        t.state thread_state,m.status member_status,a.state action_state,a.generation action_generation,h.outcome
        FROM threaded_commands c JOIN threaded_os_commands o ON o.command_id=c.id
        JOIN threaded_execution_bindings b ON b.id=c.binding_id
        JOIN threaded_threads t ON t.id=c.thread_id AND t.owner_id=c.owner_id
        JOIN threaded_members m ON m.thread_id=c.thread_id AND m.owner_id=c.owner_id AND m.agent_id=c.agent_id
        JOIN threaded_actions a ON a.id=c.action_id
        JOIN threaded_action_holders h ON h.action_id=c.action_id AND h.generation=c.generation AND h.agent_id=c.agent_id WHERE c.id=?`)
        .get(request.threadedCommand.commandId) as {owner_id:string;thread_id:string;agent_id:string;binding_id:string;os_binding_id:string;
          port:string;registration_id:string;command_cwd:string;command_workspaces:string|null;generation:number;attempt_id:string;invocation_id:string;run_id:string;thread_state:string;member_status:string;
          action_state:string;action_generation:number;outcome:string|null}|undefined;
      if (!command || command.owner_id !== request.ownerId || command.thread_id !== request.threadId || command.agent_id !== request.agentId
        || command.attempt_id !== request.attemptId || command.invocation_id !== request.invocationId || command.run_id !== request.runId
        || command.binding_id !== command.os_binding_id || command.registration_id !== request.threadedCommand.registrationId
        || command.port !== command.registration_id || command.thread_state !== 'open' || command.member_status !== 'joined'
        || command.action_state !== 'active' || command.action_generation !== command.generation || command.outcome !== null) deny('RESOURCE_COMMAND_SCOPE_UNAVAILABLE');
      // Compare the entire server-frozen declaration. A command cannot acquire a
      // smaller lease than its registered effects, or add an unrelated workspace.
      if(!command)return deny('RESOURCE_COMMAND_SCOPE_UNAVAILABLE');
      const declared=command.command_workspaces?JSON.parse(command.command_workspaces) as Array<{path:string;access:'read'|'write'}>
        :[{path:command.command_cwd,access:'write' as const}];
      if(!Array.isArray(declared)||!declared.length||declared.some(w=>!w||!path.isAbsolute(w.path)||!['read','write'].includes(w.access)
        ||realpathSync(w.path)!==w.path)||new Set(declared.map(w=>w.path)).size!==declared.length
        ||JSON.stringify([...declared].sort((a,b)=>a.path.localeCompare(b.path)))!==JSON.stringify(request.workspaces))deny('RESOURCE_COMMAND_WORKSPACES_CHANGED');
    } else if (request.mode === 'threaded') {
      const inv = db.prepare(`SELECT i.*,t.state thread_state,m.status member_status FROM threaded_invocations i
        JOIN threaded_threads t ON t.id=i.thread_id AND t.owner_id=i.owner_id
        JOIN threaded_members m ON m.thread_id=i.thread_id AND m.owner_id=i.owner_id AND m.agent_id=i.agent_id WHERE i.id=?`)
        .get(request.invocationId) as { owner_id: string; thread_id: string; agent_id: string; reserved_run_id: string;
          status: string; pause_requested: number; cancel_requested: number; thread_state: string; member_status: string } | undefined;
      if (!inv || inv.owner_id !== owner || inv.thread_id !== request.threadId || inv.agent_id !== request.agentId
        || inv.reserved_run_id !== request.runId || inv.thread_state !== 'open' || inv.member_status !== 'joined'
        || inv.pause_requested || inv.cancel_requested || ['completed','failed','cancelled','unknown'].includes(inv.status)) deny('RESOURCE_THREADED_SCOPE_UNAVAILABLE');
    } else {
      if (request.threadId || request.invocationId) deny('RESOURCE_LEGACY_SCOPE_MISMATCH');
      const run = db.prepare(`SELECT r.mode,r.status FROM runs r WHERE r.id=?
        AND NOT EXISTS(SELECT 1 FROM threaded_run_bindings b WHERE b.run_id=r.id)
        AND NOT EXISTS(SELECT 1 FROM threaded_threads t WHERE t.conversation_id=r.conversation_id)`).get(request.runId) as { mode: string; status: string } | undefined;
      if (!run || !['pipeline','supervisor','collaboration'].includes(run.mode) || ['completed','failed','cancelled'].includes(run.status)) deny('RESOURCE_LEGACY_SCOPE_UNAVAILABLE');
    }
    if (request.accountId) {
      const account = db.prepare(`SELECT enabled,archived,identity_generation FROM accounts WHERE id=?
        AND NOT EXISTS(SELECT 1 FROM account_revocations WHERE account_id=accounts.id)`).get(request.accountId) as { enabled: number; archived: number; identity_generation: number | null } | undefined;
      const legacyProjection = request.mode === 'legacy' && ['legacy-llm-openai','legacy-llm-anthropic','legacy-claude-sdk','legacy-claude-cli','legacy-codex-native'].includes(request.accountId)
        && request.accountIdentityGeneration === undefined;
      if (!legacyProjection && (!account || account.enabled !== 1 || account.archived !== 0
        || (request.accountIdentityGeneration !== undefined && account.identity_generation !== request.accountIdentityGeneration))) deny('RESOURCE_ACCOUNT_UNAVAILABLE');
    }
    if (request.session) {
      const session = db.prepare('SELECT * FROM execution_resource_sessions WHERE id=? AND owner_id=?').get(request.session.id, owner) as { version: number; native_id: string | null; resource_key: string | null; state: string } | undefined;
      if (!session || session.state !== 'ready' || session.version !== request.session.version || session.native_id !== request.session.nativeId
        || session.resource_key !== request.session.resourceKey) deny('RESOURCE_SESSION_CHANGED');
    }
    if (request.legacyExecutionId) {
      if (request.mode !== 'legacy') deny('RESOURCE_LATE_SESSION_FORBIDDEN');
      if (!db.prepare('SELECT 1 FROM external_agent_executions WHERE id=? AND run_id=? AND agent_id=?')
        .get(request.legacyExecutionId, request.runId, request.agentId)) deny('RESOURCE_LATE_SESSION_SCOPE_MISMATCH');
    }
    for (const workspace of request.workspaces ?? []) if (realpathSync(workspace.path) !== workspace.path) deny('RESOURCE_WORKSPACE_CHANGED');
    ancestors(request);
    options.validateRequest?.(request);
  }
  function normalize(input: TrustedResourceRequest): TrustedResourceRequest {
    for (const key of ['requestKey','operationId','ownerId','agentId','runId','attemptId'] as const) required(input?.[key]);
    if (!['legacy','threaded'].includes(input.mode)) deny('RESOURCE_INVALID_MODE');
    if (input.mode === 'threaded') { required(input.threadId); required(input.invocationId); }
    if (input.accountId !== undefined) required(input.accountId);
    if (input.accountIdentityGeneration !== undefined && (!Number.isSafeInteger(input.accountIdentityGeneration) || input.accountIdentityGeneration < 1)) deny('RESOURCE_INVALID_ACCOUNT_IDENTITY');
    if (input.providerKey !== undefined) required(input.providerKey);
    if (input.legacyExecutionId !== undefined) required(input.legacyExecutionId);
    if (input.threadedCommand) { required(input.threadedCommand.commandId); required(input.threadedCommand.registrationId); }
    const workspaces = new Map<string, 'read' | 'write'>();
    for (const workspace of input.workspaces ?? []) {
      if (!path.isAbsolute(workspace.path) || !['read','write'].includes(workspace.access)) deny('RESOURCE_INVALID_WORKSPACE');
      const canonical = realpathSync(workspace.path);
      workspaces.set(canonical, workspace.access === 'write' || workspaces.get(canonical) === 'write' ? 'write' : 'read');
    }
    const request: TrustedResourceRequest = { requestKey: input.requestKey, operationId: input.operationId, mode: input.mode,
      ownerId: input.ownerId, agentId: input.agentId, runId: input.runId, attemptId: input.attemptId,
      ...(input.threadId ? { threadId: input.threadId } : {}), ...(input.invocationId ? { invocationId: input.invocationId } : {}),
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.accountIdentityGeneration !== undefined ? { accountIdentityGeneration: input.accountIdentityGeneration } : {}),
      ...(input.providerKey ? { providerKey: input.providerKey } : {}),
      ...(input.legacyExecutionId ? { legacyExecutionId: input.legacyExecutionId } : {}),
      ...(input.session ? { session: { ...input.session } } : {}),
      workspaces: [...workspaces].sort(([a],[b]) => a.localeCompare(b)).map(([workspace, access]) => ({ path: workspace, access })),
      ...(input.threadedCommand ? { threadedCommand: { ...input.threadedCommand } } : {}),
      capacity: input.capacity !== false, ...(input.parentClaim ? { parentClaim: { ...input.parentClaim } } : {}),
    };
    if (request.session && ((!Number.isSafeInteger(request.session.version) || request.session.version < 1)
      || (request.session.nativeId === null) !== (request.session.resourceKey === null))) deny('RESOURCE_INVALID_SESSION');
    return request;
  }
  function items(request: TrustedResourceRequest): Item[] {
    const list: Item[] = [];
    if (request.threadedCommand) list.push({key: `command:${request.threadedCommand.commandId}`,kind:'agent',access:'exclusive'});
    if (!request.parentClaim) list.push({ key: `agent:${request.agentId}`, kind: 'agent', access: request.mode === 'legacy' ? 'exclusive' : 'slot' });
    if (request.session?.resourceKey) list.push({ key: `session:${request.session.resourceKey}`, kind: 'session', access: 'exclusive' });
    for (const workspace of request.workspaces ?? []) list.push({ key: `workspace:${workspace.path}`, kind: 'workspace', access: workspace.access });
    if (request.capacity !== false) {
      list.push({ key: 'capacity:global', kind: 'capacity', access: 'capacity' });
      if (request.threadId) list.push({ key: `capacity:thread:${request.threadId}`, kind: 'capacity', access: 'capacity' });
      if (request.accountId) list.push({ key: `capacity:account:${request.accountId}`, kind: 'capacity', access: 'capacity' });
      if (request.providerKey) list.push({ key: `capacity:provider:${request.providerKey}`, kind: 'capacity', access: 'capacity' });
    }
    return list;
  }
  const lane = (request: TrustedResourceRequest) => request.threadId ? `thread:${request.threadId}` : `legacy:${request.agentId}`;
  function canAcquire(ticket: ResourceTicket, active: ClaimRow[], pending: ResourceTicket[], policy: ResourcePolicy): boolean {
    const request = ticket.request;
    try { validateScope(request); } catch { return false; }
    const family = ancestors(request);
    const lateSessionPromotion = request.mode === 'legacy' && request.capacity === false && request.parentClaim
      && request.session && !request.workspaces?.length && request.legacyExecutionId
      && active.some(row => {
        const sibling = JSON.parse(row.request) as TrustedResourceRequest;
        return row.state === 'started' && sibling.parentClaim?.claimId === request.parentClaim!.claimId
          && sibling.capacity !== false && sibling.legacyExecutionId === request.legacyExecutionId;
      });
    if (!request.parentClaim) {
      const older = pending.filter(other => other.seq < ticket.seq && other.request.agentId === request.agentId && !other.request.parentClaim);
      if (older.some(other => other.request.mode === 'legacy' || request.mode === 'legacy'
        || other.request.threadId === request.threadId && !request.threadedCommand && !other.request.threadedCommand)) return false;
    }
    const ownItems = items(request);
    const activeRequests = active.filter(row => !family.has(row.id)).map(row => ({ row, request: JSON.parse(row.request) as TrustedResourceRequest }));
    for (const other of activeRequests) {
      // Real calls belonging to one legacy preparation cannot overlap each other.
      if (request.capacity !== false && other.request.capacity !== false && request.parentClaim
        && other.request.parentClaim?.claimId === request.parentClaim.claimId) return false;
      for (const mine of ownItems) for (const theirs of items(other.request)) {
        if (mine.kind === 'capacity') continue;
        const workspaceOverlap = mine.kind === 'workspace' && theirs.kind === 'workspace'
          && (mine.key.startsWith(`${theirs.key}${path.sep}`) || theirs.key.startsWith(`${mine.key}${path.sep}`));
        if (mine.key !== theirs.key && !workspaceOverlap) continue;
        if (mine.kind === 'agent' && mine.access === 'slot' && theirs.access === 'slot'
          && (request.threadId !== other.request.threadId || !!request.threadedCommand || !!other.request.threadedCommand)) continue;
        if (mine.kind === 'workspace' && mine.access === 'read' && theirs.access === 'read') continue;
        return false;
      }
    }
    // Pre-v27 leases and unverifiable native execution remain conservative blockers.
    for (const item of ownItems.filter(item => item.kind !== 'capacity')) {
      const oldKey = item.kind === 'agent' ? `member:${request.agentId}` : item.kind === 'session' ? `native-session:${request.session!.resourceKey}` : item.key;
      const old = db.prepare('SELECT readonly FROM external_workspace_leases WHERE resource=?').all(oldKey) as Array<{ readonly: number }>;
      if (old.some(lease => !(item.access === 'read' && lease.readonly === 1))) return false;
      if (item.kind === 'workspace') {
        const workspaceLeases = db.prepare("SELECT resource,readonly FROM external_workspace_leases WHERE resource LIKE 'workspace:%'").all() as Array<{ resource: string; readonly: number }>;
        if (workspaceLeases.some(lease => (item.key.startsWith(`${lease.resource}${path.sep}`) || lease.resource.startsWith(`${item.key}${path.sep}`))
          && !(item.access === 'read' && lease.readonly === 1))) return false;
      }
    }
    if (request.session?.nativeId && db.prepare(`SELECT 1 FROM external_agent_sessions s JOIN external_workspace_leases l
      ON l.resource='session:' || s.binding_key WHERE json_extract(s.record,'$.nativeId')=? LIMIT 1`).get(request.session.nativeId)) return false;
    if (db.prepare(`SELECT 1 FROM external_agent_executions WHERE (agent_id=? OR json_extract(record,'$.cwd') IN
      (SELECT json_extract(value,'$.path') FROM json_each(?))) AND json_extract(record,'$.recovery.state')='attention' LIMIT 1`)
      .get(request.agentId, JSON.stringify(request.workspaces ?? []))) return false;
    if (db.prepare(`SELECT 1 FROM external_agent_executions e JOIN external_native_processes p ON p.execution_id=e.id
      WHERE p.status='active' AND e.id<>? AND (e.agent_id=? OR json_extract(e.record,'$.cwd') IN
      (SELECT json_extract(value,'$.path') FROM json_each(?))) LIMIT 1`).get(lateSessionPromotion ? request.legacyExecutionId! : '', request.agentId, JSON.stringify(request.workspaces ?? []))) return false;
    if (request.capacity !== false) {
      const charged = activeRequests.filter(other => other.request.capacity !== false).map(other => other.request);
      if (charged.length >= policy.globalLimit) return false;
      if (request.threadId && charged.filter(other => other.threadId === request.threadId).length >= policy.threadLimit) return false;
      if (request.accountId && charged.filter(other => other.accountId === request.accountId).length
        >= Math.min(policy.accountLimit, policy.accountLimits[request.accountId] ?? policy.accountLimit)) return false;
      if (request.providerKey && policy.providerLimits[request.providerKey] !== undefined
        && charged.filter(other => other.providerKey === request.providerKey).length >= policy.providerLimits[request.providerKey]!) return false;
    }
    return true;
  }
  function epoch(key: string): number {
    const old = db.prepare('SELECT generation FROM execution_resource_epochs WHERE resource_key=?').get(key) as { generation: number } | undefined;
    const next = (old?.generation ?? 0) + 1;
    if (!Number.isSafeInteger(next)) deny('RESOURCE_GENERATION_EXHAUSTED');
    if (old) db.prepare('UPDATE execution_resource_epochs SET generation=? WHERE resource_key=?').run(next, key);
    else db.prepare('INSERT INTO execution_resource_epochs(resource_key,generation) VALUES(?,?)').run(key, next);
    return next;
  }
  function assertCurrent(claim: ResourceClaimIdentity) {
    const row = exact(claim);
    const request = JSON.parse(row.request) as TrustedResourceRequest;
    // Unknown remains current for reconciliation, but never becomes runnable merely due to TTL.
    for (const item of db.prepare('SELECT resource_key,generation FROM execution_resource_claim_items WHERE claim_id=?').all(row.id) as Array<{ resource_key: string; generation: number }>) {
      const current = db.prepare('SELECT generation FROM execution_resource_epochs WHERE resource_key=?').get(item.resource_key) as { generation: number } | undefined;
      if (!current || current.generation < item.generation) deny('RESOURCE_EPOCH_CORRUPT');
    }
    if (request.parentClaim) exact(request.parentClaim);
  }
  function verifyQuiescence(claim: ResourceClaimIdentity, proof: QuiescenceProof) {
    const row = exact(claim, true);
    const receipt = db.prepare('SELECT proof FROM execution_resource_quiescence WHERE claim_id=? AND id=?').get(row.id, proof?.id) as { proof: string } | undefined;
    if (!receipt || digest(JSON.parse(receipt.proof)) !== digest(proof)) deny('RESOURCE_QUIESCENCE_UNVERIFIED');
  }
  function assertPreparationToolsQuiescent(row: ClaimRow) {
    const request = JSON.parse(row.request) as TrustedResourceRequest;
    // Legacy builtin preparation owns the workspace around provider and tool
    // work. A provider finishing does not prove that its tools have stopped.
    if (row.state !== 'released' && request.mode === 'legacy' && request.capacity === false && !request.legacyExecutionId
      && db.prepare(`SELECT 1 FROM tool_executions WHERE run_id=? AND agent_id=?
        AND status IN ('running','needs_attention') LIMIT 1`).get(request.runId, request.agentId)) {
      deny('RESOURCE_QUIESCENCE_PENDING_TOOLS');
    }
  }
  return {
    enqueue(input) {
      const request = normalize(input);
      return db.transaction(() => {
        validateScope(request);
        const fingerprint = digest(request);
        const existing = db.prepare('SELECT * FROM execution_resource_tickets WHERE owner_id=? AND (request_key=? OR operation_id=?)')
          .get(owner, request.requestKey, request.operationId) as TicketRow | undefined;
        if (existing) {
          if (existing.request_hash !== fingerprint) deny('RESOURCE_IDEMPOTENCY_CONFLICT');
          return ticketFrom(existing);
        }
        const id = randomUUID();
        db.prepare(`INSERT INTO execution_resource_tickets(id,owner_id,request_key,operation_id,mode,agent_id,thread_id,run_id,attempt_id,
          parent_claim_id,request_hash,request,policy_version,status,eligible,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'waiting',?,?)`)
          .run(id, owner, request.requestKey, request.operationId, request.mode, request.agentId, request.threadId ?? null, request.runId,
            request.attemptId, request.parentClaim?.claimId ?? null, fingerprint, JSON.stringify(request), getPolicy().version, input.eligible === false ? 0 : 1, now());
        // New lanes join at the current service round; creating fresh Threads must
        // not obtain perpetual priority over a previously served waiting Thread.
        const currentRound = (db.prepare("SELECT generation FROM execution_resource_epochs WHERE resource_key='claim:global'").get() as { generation: number } | undefined)?.generation ?? 0;
        db.prepare('INSERT OR IGNORE INTO execution_resource_fairness(owner_id,lane,last_served) VALUES(?,?,?)')
          .run(owner, lane(request), currentRound);
        notify('enqueued', request.agentId);
        return ticketFrom(ticketRow(id)!);
      }).immediate();
    },
    tryAcquire(ticketId) {
      return db.transaction(() => {
        const row = ticketRow(ticketId);
        if (!row) return deny('RESOURCE_TICKET_NOT_FOUND');
        const ticket = ticketFrom(row);
        if (row.status === 'active') {
          const existing = activeRows().find(claim => claim.ticket_id === ticketId);
          return existing?.owner_nonce === options.ownerNonce ? identityFrom(existing) : null;
        }
        if (row.status !== 'waiting' || !ticket.eligible) return null;
        validateScope(ticket.request);
        const policy = getPolicy();
        if (row.policy_version !== policy.version) deny('RESOURCE_POLICY_CHANGED');
        const pending = (db.prepare("SELECT * FROM execution_resource_tickets WHERE status='waiting' AND eligible=1 ORDER BY seq").all() as TicketRow[])
          .filter(other => { try { validateScope(JSON.parse(other.request) as TrustedResourceRequest); return true; } catch { return false; } }).map(ticketFrom);
        const active = activeRows();
        const candidates = pending.filter(candidate => canAcquire(candidate, active, pending, policy));
        const served = (candidate: ResourceTicket) => (db.prepare('SELECT last_served FROM execution_resource_fairness WHERE owner_id=? AND lane=?')
          .get(owner, lane(candidate.request)) as { last_served: number } | undefined)?.last_served ?? 0;
        candidates.sort((a,b) => served(a)-served(b) || a.seq-b.seq);
        // Preparing a resource inside an already admitted legacy family is not a
        // second execution turn. It still competes atomically for every declared
        // resource; only actual calls and top-level admission use service rounds.
        const preparationChild = ticket.request.mode === 'legacy' && ticket.request.parentClaim && ticket.request.capacity === false;
        if (preparationChild ? !candidates.some(candidate => candidate.id === ticketId) : candidates[0]?.id !== ticketId) return null;
        const generation = epoch('claim:global'); const id = randomUUID(); const token = randomUUID();
        db.prepare(`INSERT INTO execution_resource_claims(id,ticket_id,owner_nonce,generation,fencing_token,state,expires_at,created_at)
          VALUES(?,?,?,?,?,'reserved',?,?)`).run(id, ticketId, options.ownerNonce, generation, token, now()+leaseMs, now());
        for (const item of items(ticket.request)) db.prepare(`INSERT INTO execution_resource_claim_items(claim_id,resource_key,kind,access,generation)
          VALUES(?,?,?,?,?)`).run(id, item.key, item.kind, item.access, epoch(item.key));
        db.prepare("UPDATE execution_resource_tickets SET status='active' WHERE id=? AND status='waiting'").run(ticketId);
        if (!preparationChild) db.prepare(`INSERT INTO execution_resource_fairness(owner_id,lane,last_served) VALUES(?,?,?)
          ON CONFLICT(owner_id,lane) DO UPDATE SET last_served=excluded.last_served`).run(owner, lane(ticket.request), generation);
        return identityFrom(claimRow(id)!);
      }).immediate();
    },
    getTicket(id) { const row = ticketRow(id); return row ? ticketFrom(row) : null; },
    getTicketByKey(key) { const row = db.prepare('SELECT * FROM execution_resource_tickets WHERE owner_id=? AND request_key=?').get(owner,key) as TicketRow | undefined; return row ? ticketFrom(row) : null; },
    getClaim(id) { const row = claimRow(id); return row ? claimRecord(row) : null; },
    getClaimForTicket(ticketId) { const row = db.prepare(`SELECT c.*,t.request FROM execution_resource_claims c JOIN execution_resource_tickets t ON t.id=c.ticket_id
      WHERE c.ticket_id=? ORDER BY c.generation DESC LIMIT 1`).get(ticketId) as ClaimRow | undefined; return row ? claimRecord(row) : null; },
    listClaims() { return activeRows().map(claimRecord); },
    setEligible(id, eligible) { db.transaction(() => { const row = ticketRow(id); if (!row || row.status !== 'waiting') deny('RESOURCE_TICKET_NOT_WAITING');
      if (row!.eligible === (eligible ? 1 : 0)) return;
      db.prepare('UPDATE execution_resource_tickets SET eligible=? WHERE id=?').run(eligible ? 1 : 0, id); notify('eligibility', ticketFrom(row!).request.agentId); }).immediate(); },
    cancelTicket(id) { db.transaction(() => { const row = ticketRow(id); if (!row) deny('RESOURCE_TICKET_NOT_FOUND');
      if (row!.status === 'active') deny('RESOURCE_ACTIVE_CANCELLATION_REQUIRES_QUIESCENCE');
      if (row!.status === 'waiting') { db.prepare("UPDATE execution_resource_tickets SET status='cancelled' WHERE id=?").run(id); notify('cancelled', ticketFrom(row!).request.agentId); } }).immediate(); },
    requeuePreparation(id) { return db.transaction(() => { const row = ticketRow(id); if (!row) return deny('RESOURCE_TICKET_NOT_FOUND');
      const ticket = ticketFrom(row); if (!['released','cancelled'].includes(row.status) || ticket.request.capacity !== false || ticket.request.parentClaim) deny('RESOURCE_TICKET_NOT_REOPENABLE');
      validateScope(ticket.request); db.prepare("UPDATE execution_resource_tickets SET status='waiting',eligible=1 WHERE id=?").run(id); notify('requeued', ticket.request.agentId); return ticketFrom(ticketRow(id)!); }).immediate(); },
    assertCurrent,
    assertExecutable(claim) { const row = exact(claim); if (!['reserved','started'].includes(row.state)) deny('RESOURCE_NOT_EXECUTABLE');
      validateScope(JSON.parse(row.request) as TrustedResourceRequest); },
    renew(claim) { db.transaction(() => { const row = exact(claim); if (row.owner_nonce !== options.ownerNonce) deny('RESOURCE_OWNER_PROCESS_MISMATCH');
      if (row.state === 'unknown' || row.state === 'quiescent') deny('RESOURCE_CLAIM_NOT_RENEWABLE');
      db.prepare('UPDATE execution_resource_claims SET expires_at=? WHERE id=?').run(now()+leaseMs,row.id); }).immediate(); },
    markStarted(claim) { db.transaction(() => { const row = exact(claim); if (row.owner_nonce !== options.ownerNonce) deny('RESOURCE_OWNER_PROCESS_MISMATCH');
      if (row.state !== 'reserved') deny('RESOURCE_ALREADY_STARTED'); validateScope(JSON.parse(row.request) as TrustedResourceRequest);
      db.prepare("UPDATE execution_resource_claims SET state='started' WHERE id=?").run(row.id); }).immediate(); },
    markUnknown(claim) { db.transaction(() => { const row = exact(claim); if (row.state === 'quiescent') return;
      db.prepare("UPDATE execution_resource_claims SET state='unknown' WHERE id=?").run(row.id); }).immediate(); },
    recordQuiescence(claim, evidence) { return db.transaction(() => {
      const row = exact(claim, true);
      assertPreparationToolsQuiescent(row);
      const existing = db.prepare('SELECT proof,evidence FROM execution_resource_quiescence WHERE claim_id=?').get(row.id) as { proof: string; evidence: string } | undefined;
      if (existing) { if (digest(JSON.parse(existing.evidence)) !== digest(evidence)) deny('RESOURCE_QUIESCENCE_CONFLICT'); return JSON.parse(existing.proof) as QuiescenceProof; }
      if (db.prepare(`SELECT 1 FROM execution_resource_claims c JOIN execution_resource_tickets t ON t.id=c.ticket_id
        WHERE t.parent_claim_id=? AND c.state<>'released'`).get(row.id)) deny('RESOURCE_CHILDREN_NOT_RELEASED');
      if (!['not_started','process_exited','reconciled'].includes(evidence?.reason) || !['none','reconciled'].includes(evidence?.sideEffects)) deny('RESOURCE_INVALID_EVIDENCE');
      const attempt = db.prepare('SELECT execution_stage FROM threaded_attempts WHERE id=?').get(claim.attemptId) as { execution_stage: string } | undefined;
      const notStarted = evidence.reason === 'not_started' && evidence.sideEffects === 'none' && row.state === 'reserved'
        && (!attempt || attempt.execution_stage === 'not_started');
      if (!notStarted && options.verifyEvidence?.(JSON.parse(row.request) as TrustedResourceRequest, identityFrom(row), evidence) !== true) deny('RESOURCE_QUIESCENCE_UNVERIFIED');
      const proof: QuiescenceProof = { schemaVersion: 1, id: randomUUID(), attemptId: claim.attemptId,
        claimId: claim.claimId, generation: claim.generation, fencingToken: claim.fencingToken, reason: evidence.reason, sideEffects: evidence.sideEffects };
      db.prepare('INSERT INTO execution_resource_quiescence(id,claim_id,proof,evidence,created_at) VALUES(?,?,?,?,?)')
        .run(proof.id, row.id, JSON.stringify(proof), JSON.stringify(evidence), now());
      db.prepare("UPDATE execution_resource_claims SET state='quiescent' WHERE id=?").run(row.id);
      return proof;
    }).immediate(); },
    verifyQuiescence,
    release(claim, proof) {
      if (db.inTransaction) deny('RESOURCE_RELEASE_REQUIRES_OUTERMOST_TRANSACTION');
      db.transaction(() => { const row = exact(claim, true); verifyQuiescence(claim, proof); if (row.state === 'released') return;
        // Recheck in the release transaction as a tool can start after proof
        // creation and before the separate durable release receipt commits.
        assertPreparationToolsQuiescent(row);
        if (db.prepare(`SELECT 1 FROM execution_resource_claims c JOIN execution_resource_tickets t ON t.id=c.ticket_id
          WHERE t.parent_claim_id=? AND c.state<>'released'`).get(row.id)) deny('RESOURCE_CHILDREN_NOT_RELEASED');
        db.prepare("UPDATE execution_resource_claims SET state='released',released_at=? WHERE id=?").run(now(),row.id);
        db.prepare("UPDATE execution_resource_tickets SET status='released' WHERE id=?").run(row.ticket_id); notify('released',claim.agentId);
      }).immediate();
    },
    recoverExpired() { return db.transaction(() => {
      for (const row of activeRows()) if (row.expires_at <= now() && ['reserved','started'].includes(row.state)) {
        db.prepare("UPDATE execution_resource_claims SET state='unknown' WHERE id=?").run(row.id);
      }
      return activeRows().filter(row => row.state === 'unknown').map(claimRecord);
    }).immediate(); },
    getPolicy,
    configurePolicy(ownerId, patch, expectedVersion) { return db.transaction(() => {
      if (ownerId !== owner) deny('RESOURCE_OWNER_MISMATCH');
      const policy = getPolicy(); if (policy.version !== expectedVersion) deny('RESOURCE_POLICY_VERSION_CONFLICT');
      if (db.prepare("SELECT 1 FROM execution_resource_tickets WHERE status IN ('waiting','active')").get()) deny('RESOURCE_POLICY_IN_USE');
      // A paused legacy turn can reopen its preparation ticket with its original
      // FIFO age and policy. Do not acknowledge a configuration it cannot resume.
      if (db.prepare(`SELECT 1 FROM execution_resource_tickets t JOIN runs r ON r.id=t.run_id
        WHERE t.mode='legacy' AND t.parent_claim_id IS NULL AND json_extract(t.request,'$.capacity')=0
          AND t.status IN ('released','cancelled') AND r.status NOT IN ('completed','failed','cancelled') LIMIT 1`).get()) {
        deny('RESOURCE_POLICY_REOPENABLE_PREPARATION');
      }
      const next: ResourcePolicy = { ...policy, ...patch, version: policy.version+1 };
      for (const limit of [next.globalLimit,next.threadLimit,next.accountLimit,...Object.values(next.accountLimits),...Object.values(next.providerLimits)]) {
        if (!Number.isSafeInteger(limit) || limit < 1) deny('RESOURCE_INVALID_CAPACITY');
      }
      db.prepare('UPDATE execution_resource_policy SET version=?,record=? WHERE singleton=1 AND version=?').run(next.version,JSON.stringify(next),expectedVersion);
      notify('policy'); return next;
    }).immediate(); },
    onAvailable(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    scanPending,
  };
}

import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ThreadedBinding } from '@agent-gand/shared';
import type { ExecutionOutcome, ExecutionResourcesPort, QuiescenceProof, ThreadedAuthority, ThreadedClaimIdentity } from './contracts.ts';
import type {
  BudgetAdmissionInput, BudgetAdmissionReservation, BudgetAuthorization, BudgetQuote, BudgetRoot,
  BudgetUsage, BudgetUsageEvidence, OwnerBudgetWindowPolicy, ThreadedBudgetPolicy,
} from './budgetTypes.ts';
export type * from './budgetTypes.ts';

export const DEFAULT_THREADED_BUDGET: Readonly<ThreadedBudgetPolicy> = Object.freeze({
  maxOutputTokens: 300_000, maxOutputTokensPerRequest: 24_576, maxInvocations: 20,
  maxAttemptsPerInvocation: 2, maxActivityMs: 30 * 60_000, maxCostMicrousd: 5_000_000,
  maxA2ADepth: 15, activityAllowanceMs: 1000, unknownCost: 'stop',
  unknownCostReserveMicrousd: null, deadlineAt: null,
});
export class ThreadedBudgetError extends Error {
  readonly status = 409;
  constructor(readonly code: string) { super(code); this.name = 'ThreadedBudgetError'; }
}
function deny(code: string): never { throw new ThreadedBudgetError(code); }
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 300) deny('THREADED_BUDGET_INVALID_INPUT');
}
function integer(value: unknown, minimum = 0): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) deny('THREADED_BUDGET_INVALID_INPUT');
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type RootRow = { id: string; owner_id: string; home_thread_id: string; current_version: number; state: BudgetRoot['state']; policy: string };
type InvocationRow = { id: string; owner_id: string; thread_id: string; agent_id: string; causal_root_id: string; reserved_run_id: string };
type SourceRow = { id: string; owner_id: string; thread_id: string; origin: string; state: string; causal_root_id: string; source_invocation_id: string | null };
type RequestRow = {
  id: string; root_id: string; owner_id: string; thread_id: string; invocation_id: string; attempt_id: string;
  request_key: string; request_hash: string; policy_version: number; claim_id: string; generation: number;
  fencing_token: string; claim_owner: string; reserved_output: number; reserved_cost: number;
  known_output: number | null; known_cost: number | null; execution_state: BudgetAuthorization['executionState'];
  usage_state: BudgetAuthorization['usageState']; outcome_hash: string | null; outcome_kind: string | null;
  created_at: number; started_at: number | null; settled_at: number | null;
};
type AttemptRow = { attempt_id: string; invocation_id: string; root_id: string; owner_id: string;
  reserved_activity_ms: number; activity_valid_until: number | null };
type SpanRow = { id: string; attempt_id: string; authorization_id: string; started_at: number;
  observed_at: number; ended_at: number | null; state: 'active' | 'unknown' | 'closed' };
const emptyUsage = (): BudgetUsage => ({ invocations: 0, attempts: 0, actualRequests: 0, outputTokens: 0,
  costMicrousd: 0, activityMs: 0, activityReservedMs: 0, unknownRequests: 0 });

function policy(value: ThreadedBudgetPolicy): ThreadedBudgetPolicy {
  if (!value || Object.keys(value).some(key => !Object.hasOwn(DEFAULT_THREADED_BUDGET, key))) deny('THREADED_BUDGET_INVALID_POLICY');
  for (const key of ['maxOutputTokens', 'maxOutputTokensPerRequest', 'maxInvocations', 'maxAttemptsPerInvocation',
    'maxActivityMs', 'maxCostMicrousd', 'activityAllowanceMs'] as const) integer(value[key], 1);
  integer(value.maxA2ADepth);
  if (!['stop', 'reserve'].includes(value.unknownCost)) deny('THREADED_BUDGET_INVALID_POLICY');
  if (value.unknownCost === 'reserve') integer(value.unknownCostReserveMicrousd, 1);
  else if (value.unknownCostReserveMicrousd !== null) deny('THREADED_BUDGET_INVALID_POLICY');
  if (value.deadlineAt !== null) integer(value.deadlineAt, 1);
  return { ...value };
}
function union(intervals: Array<[number, number]>): number {
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let total = 0, start = 0, end = 0, first = true;
  for (const next of intervals) {
    if (next[1] <= next[0]) continue;
    if (first) { [start, end] = next; first = false; }
    else if (next[0] <= end) end = Math.max(end, next[1]);
    else { total += end - start; [start, end] = next; }
  }
  return first ? 0 : total + end - start;
}

/** Pure durable budget ledger. All hooks are synchronous trusted evidence checks, never I/O. */
export function createThreadedBudget(db: Database.Database, options: {
  authority: ThreadedAuthority;
  resources?: ExecutionResourcesPort;
  now?: () => number;
  defaultPolicy?: Partial<ThreadedBudgetPolicy>;
  /** Verifies a final receipt for this exact actual request, never an interim usage event. */
  verifyUsage?: (binding: ThreadedBinding, authorization: BudgetAuthorization, usage: BudgetUsageEvidence) => boolean;
}) {
  if (db.pragma('foreign_keys', { simple: true }) !== 1) deny('THREADED_BUDGET_FOREIGN_KEYS_REQUIRED');
  const owner = (db.prepare('SELECT instance_owner_id FROM threaded_instances WHERE singleton=1').get() as
    { instance_owner_id: string } | undefined)?.instance_owner_id;
  if (!owner) deny('THREADED_BUDGET_OWNER_REQUIRED');
  const defaults = policy({ ...DEFAULT_THREADED_BUDGET, ...options.defaultPolicy });
  const clock = options.now ?? Date.now;
  const now = () => { const value = clock(); integer(value); return value; };
  const requireTransaction = () => { if (!db.inTransaction) deny('THREADED_BUDGET_TRANSACTION_REQUIRED'); };
  const request = (id: string) => db.prepare('SELECT * FROM threaded_budget_requests WHERE id=? AND owner_id=?')
    .get(id, owner) as RequestRow | undefined;
  const attempt = (id: string) => db.prepare('SELECT * FROM threaded_budget_attempts WHERE attempt_id=? AND owner_id=?')
    .get(id, owner) as AttemptRow | undefined;
  function getRoot(id: string): BudgetRoot | null {
    const row = db.prepare(`SELECT r.*,v.policy FROM threaded_budget_roots r JOIN threaded_budget_versions v
      ON v.root_id=r.id AND v.version=r.current_version WHERE r.id=? AND r.owner_id=?`).get(id, owner) as RootRow | undefined;
    return row ? { id: row.id, ownerId: row.owner_id, homeThreadId: row.home_thread_id,
      version: row.current_version, state: row.state, policy: JSON.parse(row.policy) as ThreadedBudgetPolicy } : null;
  }
  function rootRequired(id: string): BudgetRoot { return getRoot(id) ?? deny('THREADED_BUDGET_ROOT_REQUIRED'); }
  function authorization(row: RequestRow): BudgetAuthorization {
    return { id: row.id, rootId: row.root_id, ownerId: row.owner_id, threadId: row.thread_id,
      invocationId: row.invocation_id, attemptId: row.attempt_id, requestKey: row.request_key,
      policyVersion: row.policy_version, maxOutputTokens: row.reserved_output, reservedCostMicrousd: row.reserved_cost,
      activityValidUntil: attempt(row.attempt_id)?.activity_valid_until ?? null,
      executionState: row.execution_state, usageState: row.usage_state };
  }
  function source(id: string): SourceRow {
    return db.prepare(`SELECT id,owner_id,thread_id,origin,state,causal_root_id,source_invocation_id
      FROM threaded_messages WHERE id=? AND owner_id=?`).get(id, owner) as SourceRow | undefined
      ?? deny('THREADED_BUDGET_SOURCE_REQUIRED');
  }
  function ensureRootForMessage(messageId: string): BudgetRoot {
    identifier(messageId);
    return db.transaction(() => {
      const message = source(messageId), initial = source(message.causal_root_id);
      if (message.state !== 'published' || initial.origin !== 'user' || initial.state !== 'published' ||
        initial.id !== initial.causal_root_id) deny('THREADED_BUDGET_TRUSTED_ROOT_REQUIRED');
      const existing = getRoot(initial.id);
      if (existing) return existing;
      const stamp = now();
      db.prepare(`INSERT INTO threaded_budget_roots(id,owner_id,home_thread_id,current_version,state,created_at)
        VALUES(?,?,?,1,'open',?)`).run(initial.id, owner, initial.thread_id, stamp);
      db.prepare(`INSERT INTO threaded_budget_versions(root_id,owner_id,version,policy,state,request_id,request_hash,reason,created_at)
        VALUES(?,?,1,?,'open',?,?,?,?)`).run(initial.id, owner, JSON.stringify(defaults),
          `initial:${initial.id}`, digest(defaults), 'Initial frozen owner policy', stamp);
      if (!db.prepare('SELECT 1 FROM threaded_owner_budget_versions WHERE owner_id=?').get(owner)) {
        db.prepare(`INSERT INTO threaded_owner_budget_versions(owner_id,version,policy,request_id,request_hash,reason,created_at)
          VALUES(?,1,'{}','initial-owner-window',?,'Record rolling 24-hour usage; no extra cap configured',?)`)
          .run(owner, digest({}), stamp);
      }
      return rootRequired(initial.id);
    }).immediate();
  }
  function usage(scope: { rootId?: string; ownerId?: string; since?: number }): BudgetUsage {
    const stamp = now(), result = emptyUsage();
    const column = scope.rootId ? 'root_id' : 'owner_id', scopeId = scope.rootId ?? scope.ownerId ?? owner;
    const since = scope.since ?? 0;
    result.invocations = (db.prepare(`SELECT COUNT(*) n FROM threaded_budget_invocations WHERE ${column}=? AND admitted_at>=?`)
      .get(scopeId, since) as { n: number }).n;
    result.attempts = (db.prepare(`SELECT COUNT(*) n FROM threaded_budget_attempts WHERE ${column}=? AND admitted_at>=?`)
      .get(scopeId, since) as { n: number }).n;
    const requests = db.prepare(`SELECT * FROM threaded_budget_requests WHERE ${column}=?`).all(scopeId) as RequestRow[];
    for (const row of requests) {
      const within = (row.started_at ?? row.created_at) >= since;
      if (row.started_at !== null && row.execution_state !== 'not_started' && within) result.actualRequests++;
      result.outputTokens += row.known_output === null ? row.reserved_output : within ? row.known_output : 0;
      result.costMicrousd += row.known_cost === null ? row.reserved_cost : within ? row.known_cost : 0;
      if (row.usage_state === 'unknown') result.unknownRequests++;
    }
    const spans = db.prepare(`SELECT * FROM threaded_budget_activity WHERE ${column}=?`).all(scopeId) as SpanRow[];
    const byAttempt = new Map<string, Array<[number, number]>>();
    const active = new Set<string>();
    for (const span of spans) {
      const end = span.ended_at ?? Math.max(stamp, span.observed_at);
      const intervals = byAttempt.get(span.attempt_id) ?? [];
      intervals.push([Math.max(since, span.started_at), end]); byAttempt.set(span.attempt_id, intervals);
      if (span.ended_at === null) active.add(span.attempt_id);
    }
    for (const intervals of byAttempt.values()) result.activityMs += union(intervals);
    for (const row of db.prepare(`SELECT * FROM threaded_budget_attempts WHERE ${column}=?`).all(scopeId) as AttemptRow[]) {
      result.activityReservedMs += active.has(row.attempt_id)
        ? Math.max(0, (row.activity_valid_until ?? stamp) - stamp) : row.reserved_activity_ms;
    }
    for (const value of Object.values(result)) integer(value);
    return result;
  }
  function getOwnerWindow(ownerId = owner): { windowMs: number; version: number; policy: OwnerBudgetWindowPolicy; usage: BudgetUsage } {
    if (ownerId !== owner) deny('THREADED_BUDGET_OWNER_MISMATCH');
    const row = db.prepare('SELECT version,policy FROM threaded_owner_budget_versions WHERE owner_id=? ORDER BY version DESC LIMIT 1')
      .get(owner) as { version: number; policy: string } | undefined;
    return { windowMs: 86_400_000, version: row?.version ?? 0,
      policy: row ? JSON.parse(row.policy) as OwnerBudgetWindowPolicy : {}, usage: usage({ ownerId, since: Math.max(0, now() - 86_400_000) }) };
  }
  function activeRoot(root: BudgetRoot): void {
    if (root.state !== 'open') deny('THREADED_BUDGET_PAUSED');
    if (root.policy.deadlineAt !== null && now() >= root.policy.deadlineAt) deny('THREADED_BUDGET_DEADLINE');
  }
  function quote(value: BudgetQuote, root: BudgetRoot): { tokens: number; cost: number; reference: string | null } {
    if (!value || Object.keys(value).some(key => !['maxOutputTokens', 'estimatedCostMicrousd', 'pricingReference'].includes(key))) {
      deny('THREADED_BUDGET_INVALID_QUOTE');
    }
    const tokens = value.maxOutputTokens ?? root.policy.maxOutputTokensPerRequest;
    integer(tokens, 1);
    if (tokens > root.policy.maxOutputTokensPerRequest) deny('THREADED_BUDGET_PER_REQUEST_OUTPUT');
    if (value.estimatedCostMicrousd !== undefined) {
      integer(value.estimatedCostMicrousd); identifier(value.pricingReference);
      return { tokens, cost: value.estimatedCostMicrousd, reference: value.pricingReference };
    }
    if (root.policy.unknownCost !== 'reserve') deny('THREADED_BUDGET_PRICE_UNKNOWN');
    return { tokens, cost: root.policy.unknownCostReserveMicrousd!, reference: null };
  }
  function ownerCheck(add: { tokens?: number; cost?: number; invocations?: number; activity?: number }): void {
    const window = getOwnerWindow(), limits = window.policy, charged = window.usage;
    if (limits.maxOutputTokens !== undefined && charged.outputTokens + (add.tokens ?? 0) > limits.maxOutputTokens) deny('THREADED_OWNER_OUTPUT_BUDGET');
    if (limits.maxCostMicrousd !== undefined && charged.costMicrousd + (add.cost ?? 0) > limits.maxCostMicrousd) deny('THREADED_OWNER_COST_BUDGET');
    if (limits.maxInvocations !== undefined && charged.invocations + (add.invocations ?? 0) > limits.maxInvocations) deny('THREADED_OWNER_INVOCATION_BUDGET');
    if (limits.maxActivityMs !== undefined && charged.activityMs + charged.activityReservedMs + (add.activity ?? 0) > limits.maxActivityMs) {
      deny('THREADED_OWNER_ACTIVITY_BUDGET');
    }
  }
  function invocation(id: string): InvocationRow {
    return db.prepare('SELECT * FROM threaded_invocations WHERE id=? AND owner_id=?').get(id, owner) as InvocationRow | undefined
      ?? deny('THREADED_BUDGET_INVOCATION_REQUIRED');
  }
  function admission(input: BudgetAdmissionInput) {
    identifier(input.invocationId); identifier(input.attemptId); identifier(input.sourceMessageId);
    identifier(input.requestKey ?? 'initial');
    const inv = invocation(input.invocationId), root = rootRequired(inv.causal_root_id), message = source(input.sourceMessageId);
    if (message.thread_id !== inv.thread_id || message.causal_root_id !== root.id || message.state !== 'published' ||
      !db.prepare(`SELECT 1 FROM threaded_wakes WHERE source_message_id=? AND thread_id=? AND owner_id=? AND target_agent_id=?`)
        .get(message.id, inv.thread_id, owner, inv.agent_id)) deny('THREADED_BUDGET_SOURCE_SCOPE');
    const parent = message.source_invocation_id ? db.prepare(`SELECT a2a_depth FROM threaded_budget_invocations
      WHERE invocation_id=? AND root_id=? AND owner_id=?`).get(message.source_invocation_id, root.id, owner) as { a2a_depth: number } | undefined : null;
    const depth = message.origin === 'user' && message.id === root.id ? 0
      : parent ? parent.a2a_depth + 1 : deny('THREADED_BUDGET_CAUSAL_PARENT_REQUIRED');
    const hash = digest({ invocationId: input.invocationId, attemptId: input.attemptId, sourceMessageId: input.sourceMessageId,
      requestKey: input.requestKey ?? 'initial', quote: { maxOutputTokens: input.quote?.maxOutputTokens ?? null,
        estimatedCostMicrousd: input.quote?.estimatedCostMicrousd ?? null, pricingReference: input.quote?.pricingReference ?? null } });
    const existing = db.prepare('SELECT * FROM threaded_budget_requests WHERE attempt_id=? AND request_key=?')
      .get(input.attemptId, input.requestKey ?? 'initial') as RequestRow | undefined;
    if (existing) {
      if (existing.request_hash !== hash) deny('THREADED_BUDGET_IDEMPOTENCY_CONFLICT');
      return { inv, root, depth, hash, existing, quoted: { tokens: existing.reserved_output, cost: existing.reserved_cost, reference: null }, activity: 0 };
    }
    activeRoot(root);
    if (depth > root.policy.maxA2ADepth) deny('THREADED_BUDGET_A2A_DEPTH');
    const quoted = quote(input.quote, root), current = usage({ rootId: root.id });
    const invCharged = !!db.prepare('SELECT 1 FROM threaded_budget_invocations WHERE invocation_id=?').get(inv.id);
    const attemptCharged = attempt(input.attemptId);
    const attemptCount = (db.prepare('SELECT COUNT(*) n FROM threaded_budget_attempts WHERE invocation_id=?').get(inv.id) as { n: number }).n;
    if (!invCharged && current.invocations >= root.policy.maxInvocations) deny('THREADED_BUDGET_INVOCATION_LIMIT');
    if (!attemptCharged && attemptCount >= root.policy.maxAttemptsPerInvocation) deny('THREADED_BUDGET_ATTEMPT_LIMIT');
    if (current.outputTokens + quoted.tokens > root.policy.maxOutputTokens) deny('THREADED_BUDGET_OUTPUT_LIMIT');
    if (current.costMicrousd + quoted.cost > root.policy.maxCostMicrousd) deny('THREADED_BUDGET_COST_LIMIT');
    const remainingActivity = root.policy.maxActivityMs - current.activityMs - current.activityReservedMs;
    const activity = !attemptCharged ? Math.min(root.policy.activityAllowanceMs, remainingActivity) : 0;
    if (!attemptCharged && activity < 1) deny('THREADED_BUDGET_ACTIVITY_LIMIT');
    ownerCheck({ tokens: quoted.tokens, cost: quoted.cost, invocations: invCharged ? 0 : 1, activity });
    return { inv, root, depth, hash, existing: null, quoted, activity };
  }
  function assessAdmission(input: BudgetAdmissionInput): { allowed: boolean; reason?: string } {
    try { admission(input); return { allowed: true }; }
    catch (error) { if (error instanceof ThreadedBudgetError) return { allowed: false, reason: error.code }; throw error; }
  }
  function checkClaim(row: RequestRow, claim: ThreadedClaimIdentity): void {
    if (row.owner_id !== claim.ownerId || row.thread_id !== claim.threadId || row.invocation_id !== claim.invocationId ||
      row.attempt_id !== claim.attemptId || row.claim_id !== claim.claimId || row.generation !== claim.generation ||
      row.fencing_token !== claim.fencingToken || row.claim_owner !== claim.claimOwner) deny('THREADED_BUDGET_CLAIM_MISMATCH');
  }
  function reserveAdmission(input: BudgetAdmissionReservation): BudgetAuthorization {
    requireTransaction();
    return db.transaction(() => {
      const checked = admission(input), { inv, root, existing, quoted } = checked, claim = input.claim;
      if (input.invocationId !== claim.invocationId || input.attemptId !== claim.attemptId || claim.ownerId !== owner ||
        claim.threadId !== inv.thread_id || claim.agentId !== inv.agent_id || claim.runId !== inv.reserved_run_id) {
        deny('THREADED_BUDGET_CLAIM_MISMATCH');
      }
      if (!options.resources) deny('THREADED_BUDGET_RESOURCES_REQUIRED');
      options.resources.assertCurrent(claim);
      if (existing) { checkClaim(existing, claim); return authorization(existing); }
      const stamp = now(), attemptNumber = (db.prepare('SELECT COALESCE(MAX(attempt_no),0)+1 n FROM threaded_attempts WHERE invocation_id=?')
        .get(inv.id) as { n: number }).n;
      if (attemptNumber > root.policy.maxAttemptsPerInvocation && !attempt(input.attemptId)) deny('THREADED_BUDGET_ATTEMPT_LIMIT');
      db.prepare(`INSERT OR IGNORE INTO threaded_budget_invocations
        (invocation_id,root_id,owner_id,thread_id,source_message_id,a2a_depth,policy_version,admitted_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(inv.id, root.id, owner, inv.thread_id, input.sourceMessageId, checked.depth, root.version, stamp);
      db.prepare(`INSERT OR IGNORE INTO threaded_budget_attempts
        (attempt_id,invocation_id,root_id,owner_id,thread_id,attempt_no,reserved_activity_ms,admitted_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(claim.attemptId, inv.id, root.id, owner, inv.thread_id, attemptNumber, checked.activity, stamp);
      const id = randomUUID();
      db.prepare(`INSERT INTO threaded_budget_requests
        (id,root_id,owner_id,thread_id,invocation_id,attempt_id,request_key,request_hash,policy_version,
        claim_id,generation,fencing_token,claim_owner,reserved_output,reserved_cost,pricing_reference,execution_state,usage_state,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved','reserved',?)`)
        .run(id, root.id, owner, inv.thread_id, inv.id, claim.attemptId, input.requestKey ?? 'initial', checked.hash,
          root.version, claim.claimId, claim.generation, claim.fencingToken, claim.claimOwner, quoted.tokens, quoted.cost, quoted.reference, stamp);
      return authorization(request(id)!);
    })();
  }
  function persisted(id: string, binding: ThreadedBinding): RequestRow {
    const row = request(id);
    if (!row || !binding || binding.ownerId !== owner) deny('THREADED_BUDGET_AUTHORIZATION_REQUIRED');
    const saved = db.prepare('SELECT * FROM threaded_execution_bindings WHERE id=?').get(binding.id) as Record<string, unknown> | undefined;
    if (!saved || binding.schemaVersion !== 1 || binding.origin !== 'threaded_invocation_attempt' ||
      binding.workspaceSnapshot !== undefined ||
      Object.entries({ attempt_id: binding.attemptId, invocation_id: binding.invocationId, thread_id: binding.threadId,
        owner_id: binding.ownerId, agent_id: binding.agentId, run_id: binding.runId, authority_epoch: binding.authorityEpoch,
        claim_id: binding.claimId, generation: binding.generation, fencing_token: binding.fencingToken })
        .some(([key, value]) => saved[key] !== value)) deny('THREADED_BUDGET_BINDING_MISMATCH');
    checkClaim(row, { ...binding, claimOwner: String(saved.claim_owner) });
    return row;
  }
  function assertAuthorized(id: string, binding: ThreadedBinding): BudgetAuthorization {
    const row = persisted(id, binding);
    options.authority.assertAuthorized(binding);
    if (!['reserved', 'started'].includes(row.execution_state)) deny('THREADED_BUDGET_REQUEST_NOT_ACTIVE');
    const root = rootRequired(row.root_id); activeRoot(root);
    const current = usage({ rootId: row.root_id });
    if (current.outputTokens > root.policy.maxOutputTokens || current.costMicrousd > root.policy.maxCostMicrousd ||
      current.activityMs > root.policy.maxActivityMs) deny('THREADED_BUDGET_EXCEEDED');
    ownerCheck({});
    if (row.execution_state === 'started' && (attempt(row.attempt_id)?.activity_valid_until ?? 0) <= now()) {
      deny('THREADED_BUDGET_ACTIVITY_ALLOWANCE_EXPIRED');
    }
    return authorization(row);
  }
  function attemptRequest(binding: ThreadedBinding): RequestRow {
    const row = db.prepare('SELECT * FROM threaded_budget_requests WHERE attempt_id=? AND owner_id=? ORDER BY created_at,id LIMIT 1')
      .get(binding.attemptId, owner) as RequestRow | undefined;
    if (!row) deny('THREADED_BUDGET_AUTHORIZATION_REQUIRED');
    return persisted(row.id, binding);
  }
  function assertAttemptAuthorized(binding: ThreadedBinding): void {
    const row = attemptRequest(binding);
    options.authority.assertAuthorized(binding);
    const root = rootRequired(row.root_id); activeRoot(root);
    if (db.prepare("SELECT 1 FROM threaded_budget_requests WHERE attempt_id=? AND execution_state='unknown'")
      .get(binding.attemptId) || db.prepare("SELECT 1 FROM threaded_budget_activity WHERE attempt_id=? AND state='unknown'")
      .get(binding.attemptId)) deny('THREADED_BUDGET_EXECUTION_UNKNOWN');
    const current = usage({ rootId: row.root_id });
    if (current.outputTokens > root.policy.maxOutputTokens || current.costMicrousd > root.policy.maxCostMicrousd ||
      current.activityMs > root.policy.maxActivityMs) deny('THREADED_BUDGET_EXCEEDED');
    ownerCheck({});
    if (db.prepare("SELECT 1 FROM threaded_budget_activity WHERE attempt_id=? AND state<>'closed'").get(binding.attemptId) &&
      (attempt(binding.attemptId)?.activity_valid_until ?? 0) <= now()) deny('THREADED_BUDGET_ACTIVITY_ALLOWANCE_EXPIRED');
  }
  function allowActivity(row: RequestRow): number {
    const root = rootRequired(row.root_id); activeRoot(root);
    const charged = usage({ rootId: root.id }), stored = attempt(row.attempt_id)!;
    const hasActive = !!db.prepare("SELECT 1 FROM threaded_budget_activity WHERE attempt_id=? AND state<>'closed'").get(row.attempt_id);
    const oldReserve = hasActive ? Math.max(0, (stored.activity_valid_until ?? now()) - now()) : stored.reserved_activity_ms;
    const remaining = root.policy.maxActivityMs - charged.activityMs - charged.activityReservedMs + oldReserve;
    const duration = Math.min(root.policy.activityAllowanceMs, remaining,
      root.policy.deadlineAt === null ? Number.MAX_SAFE_INTEGER : root.policy.deadlineAt - now());
    if (duration < 1) deny('THREADED_BUDGET_ACTIVITY_LIMIT');
    ownerCheck({ activity: Math.max(0, duration - oldReserve) });
    const until = now() + duration;
    db.prepare('UPDATE threaded_budget_attempts SET reserved_activity_ms=?,activity_valid_until=? WHERE attempt_id=?')
      .run(duration, until, row.attempt_id);
    return until;
  }
  function beginSpan(row: RequestRow, operationKey: string, kind: 'model' | 'tool'): void {
    identifier(operationKey);
    const old = db.prepare('SELECT * FROM threaded_budget_activity WHERE attempt_id=? AND operation_key=?')
      .get(row.attempt_id, operationKey) as SpanRow | undefined;
    if (old) {
      if (old.authorization_id !== row.id || old.state !== 'active') deny('THREADED_BUDGET_ACTIVITY_CONFLICT');
      return;
    }
    db.prepare(`INSERT INTO threaded_budget_activity
      (id,root_id,owner_id,attempt_id,authorization_id,operation_key,kind,started_at,observed_at,state)
      VALUES(?,?,?,?,?,?,?,?,?,'active')`).run(randomUUID(), row.root_id, owner, row.attempt_id, row.id, operationKey, kind, now(), now());
  }
  function markStartedWithinTransaction(binding: ThreadedBinding, id: string): { validUntil: number } {
    requireTransaction();
    return db.transaction(() => {
      assertAuthorized(id, binding);
      const row = request(id)!;
      if (row.execution_state === 'started') return { validUntil: attempt(row.attempt_id)!.activity_valid_until! };
      const until = allowActivity(row);
      db.prepare("UPDATE threaded_budget_requests SET execution_state='started',started_at=? WHERE id=? AND execution_state='reserved'")
        .run(now(), id);
      beginSpan(row, `model:${id}`, 'model');
      return { validUntil: until };
    })();
  }
  function closeSpans(row: RequestRow, operationKey?: string): void {
    const spans = db.prepare(`SELECT * FROM threaded_budget_activity WHERE authorization_id=? AND state<>'closed'
      ${operationKey ? 'AND operation_key=?' : ''}`).all(...(operationKey ? [row.id, operationKey] : [row.id])) as SpanRow[];
    for (const span of spans) {
      const end = Math.max(now(), span.observed_at, span.started_at);
      db.prepare("UPDATE threaded_budget_activity SET state='closed',observed_at=?,ended_at=? WHERE id=?")
        .run(end, end, span.id);
    }
    if (!db.prepare("SELECT 1 FROM threaded_budget_activity WHERE attempt_id=? AND state<>'closed'").get(row.attempt_id)) {
      db.prepare('UPDATE threaded_budget_attempts SET reserved_activity_ms=0,activity_valid_until=NULL WHERE attempt_id=?').run(row.attempt_id);
    }
  }
  function verifiedUsage(binding: ThreadedBinding, row: RequestRow, evidence?: BudgetUsageEvidence): { output: number | null; cost: number | null } {
    if (!evidence) return { output: null, cost: null };
    identifier(evidence.evidenceReference);
    if (evidence.outputTokens !== undefined) integer(evidence.outputTokens);
    if (evidence.costMicrousd !== undefined) integer(evidence.costMicrousd);
    if (!options.verifyUsage || options.verifyUsage(binding, authorization(row), evidence) !== true) return { output: null, cost: null };
    return { output: evidence.outputTokens ?? null, cost: evidence.costMicrousd ?? null };
  }
  function attemptUsageState(attemptId: string): 'settled' | 'unknown' {
    return db.prepare("SELECT 1 FROM threaded_budget_requests WHERE attempt_id=? AND usage_state<>'settled'")
      .get(attemptId) ? 'unknown' : 'settled';
  }
  function settleOutcomeWithinTransaction(binding: ThreadedBinding, id: string, outcome: ExecutionOutcome): 'settled' | 'unknown' {
    requireTransaction();
    return db.transaction(() => {
      const row = persisted(id, binding), fingerprint = digest(outcome);
      if (row.outcome_hash !== null) {
        if (row.outcome_hash === fingerprint) return outcome.kind==='unknown'?'unknown':attemptUsageState(row.attempt_id);
        if (row.outcome_kind !== 'unknown' || outcome.kind === 'unknown') deny('THREADED_BUDGET_SETTLEMENT_CONFLICT');
      }
      if (outcome.kind === 'unknown') {
        db.prepare("UPDATE threaded_budget_requests SET outcome_hash=?,outcome_kind='unknown' WHERE id=?").run(fingerprint,id);
        db.prepare(`UPDATE threaded_budget_requests SET execution_state='unknown',
          usage_state=CASE WHEN known_output IS NOT NULL AND known_cost IS NOT NULL THEN 'settled' ELSE 'unknown' END
          WHERE attempt_id=? AND execution_state='started'`).run(row.attempt_id);
        db.prepare(`INSERT INTO threaded_budget_outcomes(authorization_id,outcome_hash,kind,record,created_at)
          VALUES(?,?,'unknown',?,?)`).run(id, fingerprint, JSON.stringify(outcome), now());
        db.prepare("UPDATE threaded_budget_activity SET state='unknown',observed_at=MAX(observed_at,?) WHERE attempt_id=? AND state='active'")
          .run(now(), row.attempt_id);
        return 'unknown';
      }
      if (!options.resources) deny('THREADED_BUDGET_RESOURCES_REQUIRED');
      options.resources.verifyQuiescence(options.authority.claim(binding), outcome.quiescence);
      if (outcome.kind === 'not_started' && (outcome.quiescence.reason !== 'not_started' || outcome.quiescence.sideEffects !== 'none')) {
        deny('THREADED_BUDGET_NOT_STARTED_PROOF_REQUIRED');
      }
      const unused = outcome.kind === 'not_started' || row.execution_state === 'reserved' && row.started_at === null;
      const reported = unused ? { output: 0, cost: 0 }
        : verifiedUsage(binding, row, outcome.budgetUsage);
      if (row.known_output !== null && reported.output !== null && row.known_output !== reported.output ||
        row.known_cost !== null && reported.cost !== null && row.known_cost !== reported.cost) deny('THREADED_BUDGET_SETTLEMENT_CONFLICT');
      const usageResult = { output: reported.output ?? row.known_output, cost: reported.cost ?? row.known_cost };
      const state = usageResult.output !== null && usageResult.cost !== null ? 'settled' : 'unknown';
      // Verified Attempt quiescence ends active intervals, independently of whether usage is known.
      const siblings = db.prepare('SELECT * FROM threaded_budget_requests WHERE attempt_id=?').all(row.attempt_id) as RequestRow[];
      for (const sibling of siblings) {
        closeSpans(sibling);
        if (sibling.id === row.id) continue;
        if (sibling.execution_state === 'reserved') {
          // Attempt quiescence proves an authorized but never-started request cannot begin later.
          db.prepare(`UPDATE threaded_budget_requests SET execution_state='not_started',usage_state='settled',
            known_output=0,known_cost=0,evidence_reference=?,settled_at=? WHERE id=?`)
            .run(outcome.quiescence.id, now(), sibling.id);
        } else if (['started', 'unknown'].includes(sibling.execution_state)) {
          db.prepare("UPDATE threaded_budget_requests SET execution_state='quiescent',usage_state=?,settled_at=? WHERE id=?")
            .run(sibling.known_output !== null && sibling.known_cost !== null ? 'settled' : 'unknown', now(), sibling.id);
        }
      }
      db.prepare(`UPDATE threaded_budget_requests SET execution_state=?,usage_state=?,known_output=?,known_cost=?,
        outcome_hash=?,outcome_kind=?,evidence_reference=?,settled_at=? WHERE id=?`)
        .run(unused ? 'not_started' : 'quiescent', state, usageResult.output, usageResult.cost,
          fingerprint, outcome.kind, outcome.kind === 'not_started' ? outcome.quiescence.id : outcome.budgetUsage?.evidenceReference ?? null, now(), id);
      db.prepare(`INSERT INTO threaded_budget_outcomes(authorization_id,outcome_hash,kind,record,created_at)
        VALUES(?,?,?,?,?)`).run(id, fingerprint, outcome.kind, JSON.stringify(outcome), now());
      return attemptUsageState(row.attempt_id);
    })();
  }
  return {
    ensureRootForMessage, getRoot, assessAdmission, reserveAdmission, assertAuthorized, markStartedWithinTransaction,
    settleOutcomeWithinTransaction, getOwnerWindow, assertAttemptAuthorized,
    markRequestUnknown(binding:ThreadedBinding,id:string):void {
      db.transaction(()=>{
        const row=persisted(id,binding);
        if(row.execution_state==='unknown')return;
        if(row.execution_state!=='started')deny('THREADED_BUDGET_REQUEST_NOT_STARTED');
        db.prepare(`UPDATE threaded_budget_requests SET execution_state='unknown',
          usage_state=CASE WHEN known_output IS NOT NULL AND known_cost IS NOT NULL THEN 'settled' ELSE 'unknown' END WHERE id=?`).run(id);
        db.prepare("UPDATE threaded_budget_activity SET state='unknown',observed_at=MAX(observed_at,?) WHERE authorization_id=? AND state='active'").run(now(),id);
      }).immediate();
    },
    /** Native initialization/tools remain activity, but are not themselves a model HTTP request. */
    beginAttemptActivity(binding: ThreadedBinding, initialAuthorizationId: string): { validUntil: number } {
      requireTransaction();
      return db.transaction(() => {
        const row = persisted(initialAuthorizationId, binding);
        assertAttemptAuthorized(binding);
        const validUntil = allowActivity(row);
        beginSpan(row, `attempt-runtime:${binding.attemptId}`, 'tool');
        return { validUntil };
      })();
    },
    checkpointAttempt(binding: ThreadedBinding): { validUntil: number } {
      return db.transaction(() => {
        assertAttemptAuthorized(binding);
        const row = attemptRequest(binding);
        if (!db.prepare("SELECT 1 FROM threaded_budget_activity WHERE attempt_id=? AND state='active'").get(binding.attemptId)) {
          deny('THREADED_BUDGET_ACTIVITY_REQUIRED');
        }
        db.prepare("UPDATE threaded_budget_activity SET observed_at=MAX(observed_at,?) WHERE attempt_id=? AND state='active'")
          .run(now(), binding.attemptId);
        return { validUntil: allowActivity(row) };
      }).immediate();
    },
    getAuthorization(id: string): BudgetAuthorization | null { const row = request(id); return row ? authorization(row) : null; },
    getUsage(rootId: string): BudgetUsage { rootRequired(rootId); return usage({ rootId }); },
    maxAttemptsForInvocation(id: string): number { return rootRequired(invocation(id).causal_root_id).policy.maxAttemptsPerInvocation; },
    /** Another actual provider request in the same Attempt needs its own unique reservation. */
    reserveRequest(binding: ThreadedBinding, requestKey: string, quoted: BudgetQuote): BudgetAuthorization {
      return db.transaction(() => {
        assertAttemptAuthorized(binding);
        const original = db.prepare('SELECT source_message_id FROM threaded_budget_invocations WHERE invocation_id=?')
          .get(binding.invocationId) as { source_message_id: string } | undefined;
        if (!original) deny('THREADED_BUDGET_INVOCATION_REQUIRED');
        return reserveAdmission({ invocationId: binding.invocationId, attemptId: binding.attemptId,
          sourceMessageId: original.source_message_id, requestKey, quote: quoted, claim: options.authority.claim(binding) });
      }).immediate();
    },
    checkpoint(binding: ThreadedBinding, id: string): { validUntil: number } {
      return db.transaction(() => {
        // Expired allowances cannot be silently renewed after a process or clock gap.
        assertAuthorized(id, binding);
        const row = request(id)!;
        if (row.execution_state !== 'started') deny('THREADED_BUDGET_REQUEST_NOT_STARTED');
        db.prepare("UPDATE threaded_budget_activity SET observed_at=MAX(observed_at,?) WHERE attempt_id=? AND state='active'")
          .run(now(), row.attempt_id);
        return { validUntil: allowActivity(row) };
      }).immediate();
    },
    beginActivity(binding: ThreadedBinding, id: string, operationKey: string): { validUntil: number } {
      return db.transaction(() => {
        assertAuthorized(id, binding);
        const row = request(id)!;
        if (row.execution_state !== 'started') deny('THREADED_BUDGET_REQUEST_NOT_STARTED');
        const validUntil = allowActivity(row); beginSpan(row, operationKey, 'tool');
        return { validUntil };
      }).immediate();
    },
    endActivity(binding: ThreadedBinding, id: string, operationKey: string): void {
      db.transaction(() => {
        const row = persisted(id, binding); identifier(operationKey);
        options.authority.assertAuthorized(binding);
        const span = db.prepare("SELECT state FROM threaded_budget_activity WHERE authorization_id=? AND operation_key=? AND kind='tool'")
          .get(id, operationKey) as { state: SpanRow['state'] } | undefined;
        if (!span) deny('THREADED_BUDGET_TOOL_ACTIVITY_REQUIRED');
        if (row.execution_state === 'unknown' || span.state === 'unknown') deny('THREADED_BUDGET_QUIESCENCE_REQUIRED');
        closeSpans(row, operationKey);
      }).immediate();
    },
    /** One completed provider request; the Attempt and other model/tool operations may continue. */
    settleRequest(binding: ThreadedBinding, id: string, evidence: BudgetUsageEvidence): BudgetAuthorization {
      return db.transaction(() => {
        const row = persisted(id, binding), known = verifiedUsage(binding, row, evidence);
        // A verified final transport receipt can prove completion while both usage dimensions remain unknown.
        if (known.output === null && known.cost === null && options.verifyUsage?.(binding, authorization(row), evidence) !== true) {
          deny('THREADED_BUDGET_USAGE_EVIDENCE_REQUIRED');
        }
        if (row.started_at === null || row.execution_state === 'not_started') deny('THREADED_BUDGET_REQUEST_NOT_STARTED');
        if (row.known_output !== null && known.output !== null && row.known_output !== known.output ||
          row.known_cost !== null && known.cost !== null && row.known_cost !== known.cost) deny('THREADED_BUDGET_SETTLEMENT_CONFLICT');
        const fingerprint = digest(evidence), receiptKey = `request:${evidence.evidenceReference}`;
        const previous = db.prepare('SELECT request_hash FROM threaded_budget_reconciliations WHERE authorization_id=? AND request_id=?')
          .get(id, receiptKey) as { request_hash: string } | undefined;
        if (previous) {
          if (previous.request_hash !== fingerprint) deny('THREADED_BUDGET_RECONCILIATION_CONFLICT');
          return authorization(row);
        }
        const output = known.output ?? row.known_output, cost = known.cost ?? row.known_cost;
        closeSpans(row, `model:${id}`);
        db.prepare(`UPDATE threaded_budget_requests SET execution_state='quiescent',usage_state=?,
          known_output=?,known_cost=?,evidence_reference=?,settled_at=? WHERE id=?`)
          .run(output !== null && cost !== null ? 'settled' : 'unknown', output, cost, evidence.evidenceReference, now(), id);
        db.prepare(`INSERT INTO threaded_budget_reconciliations(authorization_id,request_id,request_hash,evidence_reference,created_at)
          VALUES(?,?,?,?,?)`).run(id, receiptKey, fingerprint, evidence.evidenceReference, now());
        return authorization(request(id)!);
      }).immediate();
    },
    reconcileRequest(input: { binding: ThreadedBinding; authorizationId: string; requestId: string;
      usage: BudgetUsageEvidence; quiescence?: QuiescenceProof }): BudgetAuthorization {
      return db.transaction(() => {
        identifier(input.requestId);
        const row = persisted(input.authorizationId, input.binding), fingerprint = digest(input);
        const prior = db.prepare('SELECT request_hash FROM threaded_budget_reconciliations WHERE authorization_id=? AND request_id=?')
          .get(row.id, input.requestId) as { request_hash: string } | undefined;
        if (prior) {
          if (prior.request_hash !== fingerprint) deny('THREADED_BUDGET_RECONCILIATION_CONFLICT');
          return authorization(row);
        }
        const known = verifiedUsage(input.binding, row, input.usage);
        if (known.output === null && known.cost === null) deny('THREADED_BUDGET_USAGE_EVIDENCE_REQUIRED');
        if (row.known_output !== null && known.output !== null && row.known_output !== known.output ||
          row.known_cost !== null && known.cost !== null && row.known_cost !== known.cost) deny('THREADED_BUDGET_SETTLEMENT_CONFLICT');
        if (input.quiescence) {
          if (!options.resources) deny('THREADED_BUDGET_RESOURCES_REQUIRED');
          options.resources.verifyQuiescence(options.authority.claim(input.binding), input.quiescence); closeSpans(row);
        }
        const output = known.output ?? row.known_output, cost = known.cost ?? row.known_cost;
        db.prepare(`UPDATE threaded_budget_requests SET known_output=?,known_cost=?,usage_state=?,evidence_reference=?,
          execution_state=?,settled_at=? WHERE id=?`).run(output, cost,
            output !== null && cost !== null ? 'settled' : 'unknown', input.usage.evidenceReference,
            input.quiescence ? 'quiescent' : row.execution_state, now(), row.id);
        db.prepare(`INSERT INTO threaded_budget_reconciliations(authorization_id,request_id,request_hash,evidence_reference,created_at)
          VALUES(?,?,?,?,?)`).run(row.id, input.requestId, fingerprint, input.usage.evidenceReference, now());
        return authorization(request(row.id)!);
      }).immediate();
    },
    reviseRoot(input: { ownerId: string; rootId: string; expectedVersion: number; requestId: string;
      reason: string; patch?: Partial<ThreadedBudgetPolicy>; state?: 'open' | 'paused' }): BudgetRoot {
      identifier(input.requestId); identifier(input.reason);
      if (input.ownerId !== owner) deny('THREADED_BUDGET_OWNER_MISMATCH');
      return db.transaction(() => {
        const fingerprint = digest(input);
        const existing = db.prepare('SELECT request_hash,root_id FROM threaded_budget_versions WHERE owner_id=? AND request_id=?')
          .get(owner, input.requestId) as { request_hash: string; root_id: string } | undefined;
        if (existing) {
          if (existing.request_hash !== fingerprint || existing.root_id !== input.rootId) deny('THREADED_BUDGET_IDEMPOTENCY_CONFLICT');
          return rootRequired(input.rootId);
        }
        const root = rootRequired(input.rootId);
        if (root.version !== input.expectedVersion) deny('THREADED_BUDGET_VERSION_CONFLICT');
        const next = policy({ ...root.policy, ...input.patch }), state = input.state ?? root.state;
        if (!['open', 'paused'].includes(state)) deny('THREADED_BUDGET_INVALID_POLICY');
        // Later Owner decisions may change limits, but never erase reservations or usage facts.
        db.prepare(`INSERT INTO threaded_budget_versions(root_id,owner_id,version,policy,state,request_id,request_hash,reason,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(root.id, owner, root.version + 1, JSON.stringify(next), state,
            input.requestId, fingerprint, input.reason, now());
        db.prepare('UPDATE threaded_budget_roots SET current_version=?,state=? WHERE id=? AND current_version=?')
          .run(root.version + 1, state, root.id, root.version);
        return rootRequired(root.id);
      }).immediate();
    },
    configureOwnerWindow(input: { ownerId: string; expectedVersion: number; requestId: string;
      reason: string; policy: OwnerBudgetWindowPolicy }) {
      identifier(input.requestId); identifier(input.reason);
      if (input.ownerId !== owner) deny('THREADED_BUDGET_OWNER_MISMATCH');
      for (const [key, value] of Object.entries(input.policy)) {
        if (!['maxOutputTokens', 'maxCostMicrousd', 'maxActivityMs', 'maxInvocations'].includes(key)) deny('THREADED_BUDGET_INVALID_POLICY');
        integer(value, 1);
      }
      return db.transaction(() => {
        const hash = digest(input);
        const previous = db.prepare('SELECT request_hash FROM threaded_owner_budget_versions WHERE owner_id=? AND request_id=?')
          .get(owner, input.requestId) as { request_hash: string } | undefined;
        if (previous) {
          if (previous.request_hash !== hash) deny('THREADED_BUDGET_IDEMPOTENCY_CONFLICT');
          return getOwnerWindow();
        }
        const current = getOwnerWindow();
        if (current.version !== input.expectedVersion) deny('THREADED_BUDGET_VERSION_CONFLICT');
        db.prepare(`INSERT INTO threaded_owner_budget_versions(owner_id,version,policy,request_id,request_hash,reason,created_at)
          VALUES(?,?,?,?,?,?,?)`).run(owner, current.version + 1, JSON.stringify(input.policy),
            input.requestId, hash, input.reason, now());
        return getOwnerWindow();
      }).immediate();
    },
    /** Recovery changes certainty only; it never frees unknown usage or closes an unconfirmed activity span. */
    recover(): { unknownRequests: number } {
      return db.transaction(() => {
        const rows = db.prepare("SELECT * FROM threaded_budget_requests WHERE owner_id=? AND execution_state='started'").all(owner) as RequestRow[];
        for (const row of rows) {
          db.prepare("UPDATE threaded_budget_requests SET execution_state='unknown',usage_state='unknown' WHERE id=?").run(row.id);
          db.prepare("UPDATE threaded_budget_activity SET state='unknown',observed_at=MAX(observed_at,?) WHERE authorization_id=? AND state='active'")
            .run(now(), row.id);
        }
        db.prepare(`UPDATE threaded_budget_activity SET state='unknown',observed_at=MAX(observed_at,?)
          WHERE state='active' AND attempt_id IN (SELECT id FROM threaded_attempts WHERE execution_stage IN ('started','unknown'))`)
          .run(now());
        return { unknownRequests: rows.length };
      }).immediate();
    },
  };
}

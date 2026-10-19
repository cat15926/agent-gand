import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ThreadedBinding } from '@agent-gand/shared';
import {
  ThreadedAuthorityError, unavailableThreadedResources,
  type ExecutionOutcome, type ExecutionResourcesPort, type QuiescenceProof,
  type ThreadedAuthority, type ThreadedBudgetState, type ThreadedClaimIdentity,
} from './contracts.ts';

type InvocationStatus = 'queued' | 'running' | 'waiting' | 'unknown' | 'completed' | 'failed' | 'cancelled';
type TerminalStatus = 'completed' | 'failed' | 'cancelled';
type InvocationRow = {
  id: string; thread_id: string; owner_id: string; agent_id: string; authority_epoch: number;
  causal_root_id: string; current_attempt_id: string | null; status: InvocationStatus;
  goal: string; pause_requested: number; cancel_requested: number; recovery_reason: string | null;
  account_id: string | null; account_identity_generation: number | null;
  reserved_run_id: string | null; request_hash: string | null;
};
type AttemptRow = { id: string; invocation_id: string; status: string; execution_stage: string; attempt_no: number; generation: number; outcome_record: string | null; resource_release_state: 'pending' | 'released' | null; execution_reason: string | null };
type OutcomeReceipt = { outcomeDigest: string; quiescence: QuiescenceProof; budgetState: ThreadedBudgetState; retryPermitted: boolean };
type ThreadRow = { id: string; owner_id: string; conversation_id: string; state: string; authority_epoch: number };
type ApprovalRow = {
  id: string; thread_id: string; owner_id: string; invocation_id: string; attempt_id: string;
  binding_id: string; status: 'pending' | 'approved' | 'rejected' | 'expired';
  request_key: string; decision_request_id: string | null; record: string;
};
export interface TrustedControlCommand {
  ownerId: string;
  scope: { kind: 'invocation' | 'member' | 'thread'; threadId: string; invocationId?: string; agentId?: string };
  action: 'pause' | 'stop' | 'resume';
  requestId: string;
}
export interface ControlReceipt { id: string; status: 'applied' | 'pending'; invocationIds: string[] }
export interface InvocationResult {
  invocationId: string; runId: string; status: InvocationStatus; retryable?: boolean; terminal?: boolean; resourceReleasePending?: boolean;
}
export interface InvocationTerminalProof {
  binding: ThreadedBinding;
  status: TerminalStatus;
  outputId?: string;
  budgetState: ThreadedBudgetState;
  quiescence: QuiescenceProof;
  reason?: string;
}
export interface RecoveryPlan {
  invocationId: string; runId: string | null; status: InvocationStatus;
  action: 'none' | 'await_quiescence' | 'await_reconciliation' | 'await_control' | 'await_resource_release'; reason: string | null;
}

const terminal = (status: string) => ['completed', 'failed', 'cancelled'].includes(status);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fail = (code: string): never => { throw new ThreadedAuthorityError(code); };
function required(value: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('THREADED_INVALID_INPUT');
  return value;
}

/** Server-only lifecycle. HTTP callers must derive ownerId from the authenticated session. */
export function createThreadedLifecycle(db: Database.Database, authority: ThreadedAuthority, options: {
  resources?: ExecutionResourcesPort;
  onInvalidate?: (invocationIds: string[]) => void;
} = {}) {
  const resources = options.resources ?? unavailableThreadedResources;
  const getInvocation = (id: string): InvocationRow => {
    const row = db.prepare('SELECT * FROM threaded_invocations WHERE id=?').get(id) as InvocationRow | undefined;
    return row ?? fail('THREADED_INVOCATION_NOT_FOUND');
  };
  const getThread = (id: string, ownerId: string): ThreadRow => {
    const row = db.prepare(`SELECT t.* FROM threaded_threads t JOIN threaded_instances i
      ON i.instance_owner_id=t.owner_id WHERE t.id=? AND t.owner_id=?`).get(id, ownerId) as ThreadRow | undefined;
    return row ?? fail('THREADED_THREAD_NOT_FOUND');
  };
  const runId = (invocationId: string): string | null => (db.prepare(
    'SELECT run_id FROM threaded_run_bindings WHERE invocation_id=?').get(invocationId) as { run_id: string } | undefined)?.run_id ?? null;
  const attempt = (inv: InvocationRow): AttemptRow | null => inv.current_attempt_id
    ? db.prepare('SELECT * FROM threaded_attempts WHERE id=? AND invocation_id=?').get(inv.current_attempt_id, inv.id) as AttemptRow : null;
  const storedBinding = (id: string): ThreadedBinding => {
    const row = db.prepare('SELECT * FROM threaded_execution_bindings WHERE id=?').get(id) as Record<string, string | number> | undefined;
    if (!row) return fail('THREADED_BINDING_NOT_FOUND');
    return { schemaVersion: 1, origin: 'threaded_invocation_attempt', id: String(row.id),
      ownerId: String(row.owner_id), threadId: String(row.thread_id), invocationId: String(row.invocation_id),
      runId: String(row.run_id), attemptId: String(row.attempt_id), agentId: String(row.agent_id),
      authorityEpoch: Number(row.authority_epoch), claimId: String(row.claim_id),
      generation: Number(row.generation), fencingToken: String(row.fencing_token) };
  };
  const retainUnknownResources = (attemptId: string) => {
    if (!resources.markUnknown) return;
    const row = db.prepare('SELECT id FROM threaded_execution_bindings WHERE attempt_id=?').get(attemptId) as { id: string } | undefined;
    if (!row) fail('THREADED_BINDING_NOT_FOUND');
    resources.markUnknown(authority.claim(storedBinding(row!.id)));
  };
  const result = (invocationId: string): InvocationResult => ({ invocationId, runId: runId(invocationId)!, status: getInvocation(invocationId).status });
  const updateProjection = (invocationId: string, status: InvocationStatus, reason: string | null = null) => {
    const now = new Date().toISOString();
    db.prepare('UPDATE threaded_invocations SET status=?,recovery_reason=?,version=version+1,updated_at=? WHERE id=?')
      .run(status, reason, now, invocationId);
    const projection = status === 'queued' ? 'pending' : status === 'waiting' || status === 'unknown' ? 'waiting_for_user' : status;
    db.prepare('UPDATE runs SET status=? WHERE id=? AND finished_at IS NULL').run(projection, runId(invocationId));
  };
  const expireApprovals = (invocationId: string) => db.prepare(`UPDATE threaded_approvals SET status='expired',updated_at=?
    WHERE invocation_id=? AND status='pending'`).run(new Date().toISOString(), invocationId);
  const invalidate = (ids: string[]) => { if (ids.length) options.onInvalidate?.([...new Set(ids)]); };
  const completeControls = (inv: InvocationRow) => {
    const controls = db.prepare(`SELECT id,record FROM threaded_control_requests
      WHERE thread_id=? AND owner_id=? AND status='pending'`).all(inv.thread_id, inv.owner_id) as Array<{ id: string; record: string }>;
    for (const control of controls) {
      const record = JSON.parse(control.record) as { invocationIds?: string[] };
      if (record.invocationIds?.every(id => {
        const current = getInvocation(id); const currentAttempt = attempt(current);
        return terminal(current.status) || !currentAttempt || currentAttempt.execution_stage === 'quiescent';
      })) db.prepare(`UPDATE threaded_control_requests SET status='applied',version=version+1,updated_at=? WHERE id=?`)
        .run(new Date().toISOString(), control.id);
    }
  };

  function createInvocation(input: {
    ownerId: string; threadId: string; agentId: string; causalRootId: string; goal: string; requestId?: string;
  }) {
    required(input.goal, 100_000); required(input.causalRootId); if (input.requestId) required(input.requestId);
    const fingerprint = hash(JSON.stringify({ threadId: input.threadId, agentId: input.agentId, causalRootId: input.causalRootId, goal: input.goal }));
    return db.transaction(() => {
      const thread = getThread(input.threadId, input.ownerId);
      if (input.requestId) {
        const existing = db.prepare('SELECT * FROM threaded_invocations WHERE owner_id=? AND client_request_id=?')
          .get(input.ownerId, input.requestId) as InvocationRow | undefined;
        if (existing) {
          if (existing.request_hash !== fingerprint) fail('THREADED_IDEMPOTENCY_CONFLICT');
          return { id: existing.id, runId: existing.reserved_run_id!, threadId: existing.thread_id, ownerId: existing.owner_id, agentId: existing.agent_id };
        }
      }
      if (thread.state !== 'open') fail('THREADED_THREAD_NOT_OPEN');
      const member = db.prepare(`SELECT m.*,a.definition,a.enabled,a.version AS agent_version FROM threaded_members m
        JOIN agents a ON a.id=m.agent_id WHERE m.thread_id=? AND m.owner_id=? AND m.agent_id=?`)
        .get(input.threadId, input.ownerId, input.agentId) as { status: string; enabled: number; definition: string; role_version: number; agent_version: number } | undefined;
      if (!member || member.status !== 'joined' || member.enabled !== 1 || member.role_version !== member.agent_version) fail('THREADED_MEMBER_UNAVAILABLE');
      const memberControl = db.prepare(`SELECT action FROM threaded_control_requests WHERE thread_id=? AND owner_id=?
        AND scope='member' AND agent_id=? ORDER BY rowid DESC LIMIT 1`).get(input.threadId, input.ownerId, input.agentId) as { action: string } | undefined;
      if (memberControl && memberControl.action !== 'resume') fail('THREADED_MEMBER_PAUSED');
      const definition = JSON.parse(member!.definition) as { accountRef?: string };
      const accountId = definition.accountRef ?? null;
      let identityGeneration: number | null = null;
      if (accountId) {
        const account = db.prepare(`SELECT * FROM accounts WHERE id=? AND enabled=1 AND archived=0
          AND NOT EXISTS(SELECT 1 FROM account_revocations WHERE account_id=accounts.id)`).get(accountId) as { identity_generation?: number | null } | undefined;
        if (!account) fail('THREADED_ACCOUNT_UNAVAILABLE');
        identityGeneration = account?.identity_generation ?? null;
      }
      const id = randomUUID(); const reservedRunId = randomUUID(); const now = new Date().toISOString();
      db.prepare(`INSERT INTO threaded_invocations(id,thread_id,owner_id,agent_id,authority_epoch,causal_root_id,goal,
        account_id,account_identity_generation,client_request_id,request_hash,reserved_run_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.threadId, input.ownerId, input.agentId, thread.authority_epoch,
        input.causalRootId, input.goal, accountId, identityGeneration, input.requestId ?? null, fingerprint, reservedRunId, now, now);
      return { id, runId: reservedRunId, threadId: input.threadId, ownerId: input.ownerId, agentId: input.agentId };
    }).immediate();
  }

  function prepareAttempt(input: { ownerId: string; invocationId: string; claim: ThreadedClaimIdentity }): ThreadedBinding {
    return db.transaction(() => {
      const inv = getInvocation(input.invocationId); const thread = getThread(inv.thread_id, input.ownerId);
      if (inv.owner_id !== input.ownerId) fail('THREADED_OWNER_MISMATCH');
      const claim = input.claim;
      if (claim.ownerId !== inv.owner_id || claim.threadId !== inv.thread_id || claim.invocationId !== inv.id
        || claim.agentId !== inv.agent_id || claim.runId !== inv.reserved_run_id) fail('THREADED_CLAIM_SCOPE_MISMATCH');
      resources.assertCurrent(claim);
      if (thread.state !== 'open' || inv.pause_requested || inv.cancel_requested || inv.status !== 'queued') fail('THREADED_INVOCATION_NOT_QUEUED');
      const previous = attempt(inv);
      if (previous && (!terminal(previous.status) || previous.execution_stage !== 'quiescent' || previous.resource_release_state !== 'released')) fail('THREADED_PREVIOUS_ATTEMPT_NOT_QUIESCENT');
      if (previous && (!previous.outcome_record || !(JSON.parse(previous.outcome_record) as OutcomeReceipt).retryPermitted)) fail('THREADED_RECONCILIATION_REQUIRED');
      const attemptNo = (previous?.attempt_no ?? 0) + 1;
      if (attemptNo > 2) fail('THREADED_ATTEMPT_LIMIT');
      if (previous && claim.generation <= previous.generation) fail('THREADED_STALE_GENERATION');
      const now = new Date().toISOString();
      const frozenAgent = db.prepare('SELECT version,definition FROM run_agent_snapshots WHERE run_id=? AND agent_id=?')
        .get(claim.runId, inv.agent_id) as { version: number; definition: string } | undefined;
      if (frozenAgent) {
        const liveAgent = db.prepare('SELECT version,definition FROM agents WHERE id=?').get(inv.agent_id) as { version: number; definition: string };
        if (liveAgent.version !== frozenAgent.version || liveAgent.definition !== frozenAgent.definition) fail('THREADED_RUN_SNAPSHOT_CHANGED');
      }
      if (!runId(inv.id)) {
        const nextTurn = db.prepare('SELECT COALESCE(MAX(turn_no),0)+1 AS n FROM runs WHERE conversation_id=?')
          .get(thread.conversation_id) as { n: number };
        db.prepare(`INSERT INTO runs(id,conversation_id,turn_no,goal,mode,status,agent_ids,created_at)
          VALUES(?,?,?,?,'threaded','pending',?,?)`).run(claim.runId, thread.conversation_id, nextTurn.n, inv.goal, JSON.stringify([inv.agent_id]), now);
        db.prepare(`INSERT INTO threaded_run_bindings(invocation_id,run_id,thread_id,owner_id,created_at) VALUES(?,?,?,?,?)`)
          .run(inv.id, claim.runId, inv.thread_id, inv.owner_id, now);
        const agent = db.prepare('SELECT version,definition FROM agents WHERE id=?').get(inv.agent_id) as { version: number; definition: string };
        db.prepare('INSERT INTO run_agent_snapshots(run_id,agent_id,version,definition,created_at) VALUES(?,?,?,?,?)')
          .run(claim.runId, inv.agent_id, agent.version, agent.definition, now);
      }
      db.prepare(`INSERT INTO threaded_attempts(id,invocation_id,thread_id,owner_id,agent_id,attempt_no,generation,
        authority_epoch,claim_owner,claim_id,fencing_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(claim.attemptId, inv.id, inv.thread_id, inv.owner_id, inv.agent_id, attemptNo, claim.generation,
          inv.authority_epoch, claim.claimOwner, claim.claimId, claim.fencingToken, now, now);
      db.prepare(`UPDATE threaded_invocations SET current_attempt_id=?,status='running',version=version+1,updated_at=? WHERE id=?`)
        .run(claim.attemptId, now, inv.id);
      return authority.capture(claim.attemptId);
    }).immediate();
  }

  function startAttempt(binding: ThreadedBinding): void {
    db.transaction(() => {
      authority.assertAuthorized(binding);
      const changed = db.prepare(`UPDATE threaded_attempts SET status='running',execution_stage='started',version=version+1,updated_at=?
        WHERE id=? AND invocation_id=? AND status='prepared' AND execution_stage='not_started'`)
        .run(new Date().toISOString(), binding.attemptId, binding.invocationId).changes;
      if (changed !== 1) fail('THREADED_ATTEMPT_ALREADY_STARTED');
      resources.markStarted?.(authority.claim(binding));
      updateProjection(binding.invocationId, 'running');
    }).immediate();
  }

  function recordOutput(binding: ThreadedBinding, content: string, quiescence?: QuiescenceProof): { id: string; hash: string } {
    if (typeof content !== 'string') fail('THREADED_INVALID_OUTPUT');
    return db.transaction(() => {
      authority.assertAuthorized(binding, { quiescence });
      const current = attempt(getInvocation(binding.invocationId));
      if (current?.status !== 'running' || current.execution_stage !== 'started') fail('THREADED_ATTEMPT_NOT_RUNNING');
      const id = randomUUID(); const digest = hash(content);
      db.prepare(`INSERT INTO threaded_outputs(id,thread_id,owner_id,invocation_id,attempt_id,binding_id,content_hash,content,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id, binding.threadId, binding.ownerId, binding.invocationId, binding.attemptId, binding.id, digest, content, new Date().toISOString());
      return { id, hash: digest };
    }).immediate();
  }

  function assertPersistedIdentity(binding: ThreadedBinding): void {
    const saved = storedBinding(binding.id);
    for (const key of Object.keys(saved) as Array<keyof ThreadedBinding>) {
      if (binding[key] !== saved[key]) fail('THREADED_BINDING_UNAUTHORIZED');
    }
    if (binding.workspaceSnapshot !== undefined || getInvocation(binding.invocationId).current_attempt_id !== binding.attemptId) fail('THREADED_BINDING_UNAUTHORIZED');
  }
  function persistOutcomeReceipt(binding: ThreadedBinding, outcome: ExecutionOutcome, budgetState: ThreadedBudgetState, proof: QuiescenceProof): void {
    const retryPermitted = outcome.kind === 'not_started' || (outcome.kind === 'failed' && outcome.retryable && budgetState === 'settled')
      || (outcome.kind === 'cancelled' && proof.sideEffects === 'none' && budgetState === 'settled');
    const receipt: OutcomeReceipt = { outcomeDigest: hash(JSON.stringify(outcome)), quiescence: proof, budgetState, retryPermitted };
    db.prepare(`UPDATE threaded_attempts SET outcome_record=?,resource_release_state='pending' WHERE id=?`)
      .run(JSON.stringify(receipt), binding.attemptId);
  }
  function releaseVerified(binding: ThreadedBinding, proof: QuiescenceProof, claim: ThreadedClaimIdentity): boolean {
    try {
      resources.release(claim, proof);
      db.prepare(`UPDATE threaded_attempts SET resource_release_state='released' WHERE id=? AND execution_stage='quiescent' AND resource_release_state='pending'`)
        .run(binding.attemptId);
      return true;
    } catch {
      // A durable receipt survives release failure. Never rewind a committed terminal or retry this Attempt.
      return false;
    }
  }

  function terminalWithinTransaction(proof: InvocationTerminalProof, controlled = false, priorQuiescence = false): InvocationResult {
    if (!db.inTransaction) fail('THREADED_TERMINAL_REQUIRES_TRANSACTION');
    const { binding } = proof;
    if (!['completed', 'failed', 'cancelled'].includes(proof.status) || !['settled', 'unknown'].includes(proof.budgetState)) fail('THREADED_INVALID_TERMINAL_PROOF');
    const inv = getInvocation(binding.invocationId);
    if (priorQuiescence) {
      assertPersistedIdentity(binding);
      const current = attempt(inv); const receipt = current?.outcome_record ? JSON.parse(current.outcome_record) as OutcomeReceipt : null;
      if (!controlled || current?.execution_stage !== 'quiescent' || !receipt || receipt.quiescence.id !== proof.quiescence.id
        || receipt.budgetState !== proof.budgetState) fail('THREADED_QUIESCENCE_RECEIPT_REQUIRED');
    } else authority.assertCurrent(binding);
    if (!controlled) authority.assertAuthorized(binding, { quiescence: proof.quiescence });
    else if (proof.status !== 'cancelled' || !inv.cancel_requested) fail('THREADED_CONTROL_PROOF_REQUIRED');
    if (!priorQuiescence) resources.verifyQuiescence(authority.claim(binding), proof.quiescence);
    if (terminal(inv.status)) fail('THREADED_INVOCATION_ALREADY_TERMINAL');
    if (proof.status === 'completed') {
      const output = db.prepare(`SELECT content,content_hash FROM threaded_outputs WHERE id=? AND binding_id=? AND invocation_id=? AND attempt_id=?`)
        .get(proof.outputId, binding.id, binding.invocationId, binding.attemptId) as { content: string; content_hash: string } | undefined;
      if (!output || hash(output.content) !== output.content_hash) fail('THREADED_OUTPUT_PROOF_REQUIRED');
      if (attempt(inv)?.execution_stage !== 'started') fail('THREADED_EXECUTION_PROOF_REQUIRED');
    }
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO threaded_invocation_terminals(invocation_id,thread_id,owner_id,run_id,attempt_id,binding_id,output_id,status,proof,committed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(inv.id, inv.thread_id, inv.owner_id, binding.runId, binding.attemptId, binding.id,
        proof.outputId ?? null, proof.status, JSON.stringify({ ...proof, completionEvidence: 'trusted_executor_outcome', actionCompletion: false }), now);
    db.prepare(`UPDATE threaded_attempts SET status=?,execution_stage='quiescent',execution_reason=?,version=version+1,updated_at=? WHERE id=?`)
      .run(proof.status, proof.reason ?? null, now, binding.attemptId);
    updateProjection(inv.id, proof.status, proof.reason ?? null);
    db.prepare('UPDATE runs SET status=?,terminal_disposition=?,finished_at=? WHERE id=?')
      .run(proof.status, proof.status === 'completed' ? 'accepted' : proof.status, now, binding.runId);
    expireApprovals(inv.id); completeControls(inv);
    return { ...result(inv.id), terminal: true };
  }

  function commitTerminal(proof: InvocationTerminalProof): InvocationResult {
    if (db.inTransaction) fail('THREADED_OUTCOME_REQUIRES_OUTERMOST_TRANSACTION');
    const existing = db.prepare('SELECT proof FROM threaded_invocation_terminals WHERE invocation_id=?')
      .get(proof.binding.invocationId) as { proof: string } | undefined;
    if (existing) {
      assertPersistedIdentity(proof.binding);
      const saved = JSON.parse(existing.proof) as InvocationTerminalProof;
      if (saved.binding.id !== proof.binding.id || saved.status !== proof.status || saved.outputId !== proof.outputId
        || saved.budgetState !== proof.budgetState || saved.reason !== proof.reason
        || JSON.stringify(saved.quiescence) !== JSON.stringify(proof.quiescence)) fail('THREADED_TERMINAL_PROOF_CONFLICT');
      const inv = getInvocation(proof.binding.invocationId);
      return { ...result(inv.id), terminal: true, resourceReleasePending: attempt(inv)?.resource_release_state !== 'released' };
    }
    const claim = authority.claim(proof.binding);
    const committed = db.transaction(() => {
      resources.verifyQuiescence(claim, proof.quiescence);
      db.prepare(`UPDATE threaded_attempts SET outcome_record=?,resource_release_state='pending' WHERE id=?`)
        .run(JSON.stringify({ outcomeDigest: hash(JSON.stringify(proof)), quiescence: proof.quiescence, budgetState: proof.budgetState }), proof.binding.attemptId);
      return terminalWithinTransaction(proof);
    }).immediate();
    return { ...committed, resourceReleasePending: !releaseVerified(proof.binding, proof.quiescence, claim) };
  }

  function recordOutcome(binding: ThreadedBinding, outcome: ExecutionOutcome): InvocationResult {
    if (db.inTransaction) fail('THREADED_OUTCOME_REQUIRES_OUTERMOST_TRANSACTION');
    let release: QuiescenceProof | undefined; let releaseClaim: ThreadedClaimIdentity | undefined;
    const applied = db.transaction(() => {
      assertPersistedIdentity(binding);
      const inv = getInvocation(binding.invocationId); const current = attempt(inv);
      if (current?.execution_stage === 'quiescent') {
        const receipt = current.outcome_record ? JSON.parse(current.outcome_record) as OutcomeReceipt : null;
        if (!receipt || receipt.outcomeDigest !== hash(JSON.stringify(outcome))) fail('THREADED_OUTCOME_ALREADY_COMMITTED');
        return { ...result(inv.id), terminal: terminal(inv.status), resourceReleasePending: current.resource_release_state !== 'released' };
      }
      authority.assertCurrent(binding);
      if (terminal(inv.status)) fail('THREADED_INVOCATION_ALREADY_TERMINAL');
      const now = new Date().toISOString();
      if (outcome.kind === 'unknown') {
        resources.markUnknown?.(authority.claim(binding));
        if (inv.status === 'unknown' && inv.recovery_reason === outcome.reason && current?.status === 'unknown'
          && current.execution_stage === 'unknown' && current.execution_reason === outcome.reason) return result(inv.id);
        db.prepare(`UPDATE threaded_attempts SET status='unknown',execution_stage='unknown',execution_reason=?,version=version+1,updated_at=? WHERE id=?`)
          .run(outcome.reason, now, binding.attemptId);
        updateProjection(inv.id, 'unknown', outcome.reason); expireApprovals(inv.id);
        return result(inv.id);
      }
      resources.verifyQuiescence(authority.claim(binding), outcome.quiescence);
      release = outcome.quiescence; releaseClaim = authority.claim(binding);
      const budgetState = outcome.kind === 'not_started' ? 'settled' : outcome.budgetState;
      if (outcome.kind === 'not_started' && (outcome.quiescence.reason !== 'not_started' || outcome.quiescence.sideEffects !== 'none')) fail('THREADED_NOT_STARTED_PROOF_REQUIRED');
      persistOutcomeReceipt(binding, outcome, budgetState, outcome.quiescence);
      if (inv.cancel_requested) return terminalWithinTransaction({ binding, status: 'cancelled', budgetState, quiescence: outcome.quiescence, reason: 'CONTROL_CANCELLED' }, true);
      if (inv.pause_requested || !authority.authorized(binding, { quiescence: outcome.quiescence })) {
        db.prepare(`UPDATE threaded_attempts SET status='cancelled',execution_stage='quiescent',execution_reason=?,version=version+1,updated_at=? WHERE id=?`)
          .run(inv.pause_requested ? 'CONTROL_PAUSED' : 'AUTHORITY_CHANGED', now, binding.attemptId);
        updateProjection(inv.id, 'waiting', inv.pause_requested ? 'CONTROL_PAUSED' : 'AUTHORITY_CHANGED');
        expireApprovals(inv.id); completeControls(inv);
        return result(inv.id);
      }
      if (outcome.kind === 'completed') {
        const output = recordOutput(binding, outcome.content, outcome.quiescence);
        return terminalWithinTransaction({ binding, status: 'completed', outputId: output.id, budgetState, quiescence: outcome.quiescence });
      }
      const retryable = outcome.kind === 'not_started' || (outcome.kind === 'failed' && outcome.retryable && budgetState === 'settled');
      if (retryable && (attempt(inv)?.attempt_no ?? 2) < 2) {
        db.prepare(`UPDATE threaded_attempts SET status='failed',execution_stage='quiescent',execution_reason=?,version=version+1,updated_at=? WHERE id=?`)
          .run(outcome.reason, now, binding.attemptId);
        updateProjection(inv.id, 'queued', outcome.reason); expireApprovals(inv.id);
        return { ...result(inv.id), retryable: true };
      }
      return terminalWithinTransaction({ binding, status: outcome.kind === 'cancelled' ? 'cancelled' : 'failed', budgetState, quiescence: outcome.quiescence, reason: outcome.reason });
    }).immediate();
    return release && releaseClaim ? { ...applied, resourceReleasePending: !releaseVerified(binding, release, releaseClaim) } : applied;
  }

  /** Retry only the exact verified resource release; it grants no execution or output authority. */
  function releaseResources(binding: ThreadedBinding, proof: QuiescenceProof): InvocationResult {
    if (db.inTransaction) fail('THREADED_OUTCOME_REQUIRES_OUTERMOST_TRANSACTION');
    assertPersistedIdentity(binding);
    const inv = getInvocation(binding.invocationId); const current = attempt(inv);
    const receipt = current?.outcome_record ? JSON.parse(current.outcome_record) as OutcomeReceipt : null;
    if (current?.execution_stage !== 'quiescent' || !receipt || JSON.stringify(receipt.quiescence) !== JSON.stringify(proof)) fail('THREADED_QUIESCENCE_RECEIPT_REQUIRED');
    if (current!.resource_release_state === 'released') return { ...result(inv.id), terminal: terminal(inv.status), resourceReleasePending: false };
    const released = releaseVerified(binding, proof, authority.claim(binding));
    return { ...result(inv.id), terminal: terminal(inv.status), resourceReleasePending: !released };
  }

  function pausedByEffectiveControls(inv: InvocationRow, thread: ThreadRow, command: TrustedControlCommand): boolean {
    const threadPaused = command.scope.kind === 'thread' ? command.action !== 'resume' : thread.state !== 'open';
    const latest = (scope: 'member' | 'invocation', id: string) => {
      if (command.scope.kind === scope && (scope === 'member' ? command.scope.agentId : command.scope.invocationId) === id) return command.action;
      const column = scope === 'member' ? 'agent_id' : 'invocation_id';
      return (db.prepare(`SELECT action FROM threaded_control_requests WHERE thread_id=? AND owner_id=? AND scope=? AND ${column}=? ORDER BY rowid DESC LIMIT 1`)
        .get(inv.thread_id, inv.owner_id, scope, id) as { action: string } | undefined)?.action ?? 'resume';
    };
    return threadPaused || latest('member', inv.agent_id) !== 'resume' || latest('invocation', inv.id) !== 'resume';
  }

  function requestControl(command: TrustedControlCommand): ControlReceipt {
    required(command.requestId); const changed: string[] = [];
    const receipt = db.transaction(() => {
      const thread = getThread(command.scope.threadId, command.ownerId);
      const fingerprint = hash(JSON.stringify(command));
      const existing = db.prepare('SELECT id,status,record FROM threaded_control_requests WHERE owner_id=? AND request_key=?')
        .get(command.ownerId, command.requestId) as { id: string; status: ControlReceipt['status']; record: string } | undefined;
      if (existing) {
        const record = JSON.parse(existing.record) as { fingerprint: string; invocationIds: string[] };
        if (record.fingerprint !== fingerprint) fail('THREADED_IDEMPOTENCY_CONFLICT');
        return { id: existing.id, status: existing.status, invocationIds: record.invocationIds };
      }
      let rows = db.prepare('SELECT * FROM threaded_invocations WHERE thread_id=? AND owner_id=?').all(thread.id, command.ownerId) as InvocationRow[];
      if (command.scope.kind === 'invocation') {
        if (!command.scope.invocationId || command.scope.agentId) fail('THREADED_INVALID_CONTROL_SCOPE');
        rows = rows.filter(row => row.id === command.scope.invocationId);
        if (rows.length !== 1) fail('THREADED_INVOCATION_NOT_FOUND');
      } else if (command.scope.kind === 'member') {
        if (!command.scope.agentId || command.scope.invocationId || !db.prepare('SELECT 1 FROM threaded_members WHERE thread_id=? AND owner_id=? AND agent_id=?')
          .get(thread.id, command.ownerId, command.scope.agentId)) fail('THREADED_INVALID_CONTROL_SCOPE');
        rows = rows.filter(row => row.agent_id === command.scope.agentId);
      } else if (command.scope.kind !== 'thread' || command.scope.invocationId || command.scope.agentId) fail('THREADED_INVALID_CONTROL_SCOPE');
      const active = rows.filter(row => !terminal(row.status));
      if (command.action === 'resume') {
        if (thread.state === 'archived') fail('THREADED_THREAD_ARCHIVED');
        for (const row of active) {
          const current = attempt(row);
          const receipt = current?.outcome_record ? JSON.parse(current.outcome_record) as OutcomeReceipt : null;
          if (row.cancel_requested || row.status === 'unknown' || (current && (current.execution_stage !== 'quiescent'
            || current.resource_release_state !== 'released' || !receipt?.retryPermitted))) fail('THREADED_RECONCILIATION_REQUIRED');
        }
      } else if (command.action !== 'pause' && command.action !== 'stop') fail('THREADED_INVALID_CONTROL_ACTION');
      const now = new Date().toISOString(); let pending = false;
      if (command.scope.kind === 'thread') db.prepare(`UPDATE threaded_threads SET state=?,authority_epoch=authority_epoch+1,version=version+1,updated_at=? WHERE id=?`)
        .run(command.action === 'resume' ? 'open' : command.action === 'pause' ? 'paused' : 'closed', now, thread.id);
      for (const row of active) {
        const current = attempt(row); changed.push(row.id);
        const effectivePause = pausedByEffectiveControls(row, thread, command);
        db.prepare(`UPDATE threaded_invocations SET authority_epoch=authority_epoch+1,pause_requested=?,cancel_requested=?,version=version+1,updated_at=? WHERE id=?`)
          .run(effectivePause ? 1 : 0, command.action === 'stop' ? 1 : row.cancel_requested, now, row.id);
        expireApprovals(row.id);
        if (command.action === 'resume') updateProjection(row.id, effectivePause ? 'waiting' : 'queued', effectivePause ? 'SCOPED_CONTROL_PAUSED' : null);
        else if (!current) updateProjection(row.id, command.action === 'stop' ? 'cancelled' : 'waiting', `CONTROL_${command.action.toUpperCase()}`);
        else if (command.action === 'stop' && current.execution_stage === 'quiescent') {
          const receipt = current.outcome_record ? JSON.parse(current.outcome_record) as OutcomeReceipt : null;
          const bindingRow = db.prepare('SELECT id FROM threaded_execution_bindings WHERE attempt_id=?').get(current.id) as { id: string } | undefined;
          if (!receipt || !bindingRow) fail('THREADED_QUIESCENCE_RECEIPT_REQUIRED');
          terminalWithinTransaction({ binding: storedBinding(bindingRow!.id), status: 'cancelled', budgetState: receipt!.budgetState,
            quiescence: receipt!.quiescence, reason: 'CONTROL_CANCELLED' }, true, true);
        } else {
          const uncertain = ['started', 'unknown'].includes(current.execution_stage);
          pending ||= current.execution_stage !== 'quiescent';
          updateProjection(row.id, uncertain ? 'unknown' : 'waiting', `CONTROL_${command.action.toUpperCase()}`);
          if (uncertain) {
            retainUnknownResources(current.id);
            db.prepare(`UPDATE threaded_attempts SET status='unknown',execution_stage='unknown',version=version+1,updated_at=? WHERE id=?`).run(now, current.id);
          }
        }
      }
      const id = randomUUID(); const status = pending ? 'pending' : 'applied';
      const record = JSON.stringify({ fingerprint, invocationIds: active.map(row => row.id), executionAdmission: false });
      db.prepare(`INSERT INTO threaded_control_requests(id,thread_id,owner_id,scope,agent_id,invocation_id,action,status,request_key,record,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, thread.id, command.ownerId, command.scope.kind, command.scope.agentId ?? null,
          command.scope.invocationId ?? null, command.action === 'stop' ? 'cancel' : command.action, status, command.requestId, record, now, now);
      return { id, status, invocationIds: active.map(row => row.id) } as ControlReceipt;
    }).immediate();
    invalidate(changed); return receipt;
  }

  function registerApproval(binding: ThreadedBinding, input: { requestKey: string; record?: unknown }): ApprovalRow {
    required(input.requestKey);
    return db.transaction(() => {
      authority.assertAuthorized(binding, { allowApproval: true });
      const inv = getInvocation(binding.invocationId);
      if (attempt(inv)?.execution_stage !== 'started') fail('THREADED_ATTEMPT_NOT_RUNNING');
      const existing = db.prepare('SELECT * FROM threaded_approvals WHERE invocation_id=? AND request_key=?')
        .get(binding.invocationId, input.requestKey) as ApprovalRow | undefined;
      if (existing) {
        if (existing.binding_id !== binding.id || existing.record !== JSON.stringify(input.record ?? {})) fail('THREADED_APPROVAL_STALE');
        return existing;
      }
      authority.assertAuthorized(binding);
      const id = randomUUID(); const now = new Date().toISOString();
      db.prepare(`INSERT INTO threaded_approvals(id,thread_id,owner_id,invocation_id,attempt_id,binding_id,request_key,record,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, binding.threadId, binding.ownerId, binding.invocationId, binding.attemptId, binding.id, input.requestKey, JSON.stringify(input.record ?? {}), now, now);
      db.prepare(`UPDATE threaded_attempts SET status='waiting',version=version+1,updated_at=? WHERE id=?`).run(now, binding.attemptId);
      db.prepare(`UPDATE runs SET status='awaiting_approval' WHERE id=?`).run(binding.runId);
      return db.prepare('SELECT * FROM threaded_approvals WHERE id=?').get(id) as ApprovalRow;
    }).immediate();
  }

  function decideApproval(input: { ownerId: string; threadId: string; approvalId: string; decision: 'approve' | 'reject'; requestId: string }): ApprovalRow {
    required(input.requestId);
    let rejectedInvocation: string | undefined;
    const decided = db.transaction(() => {
      getThread(input.threadId, input.ownerId);
      const row = db.prepare('SELECT * FROM threaded_approvals WHERE id=? AND thread_id=? AND owner_id=?')
        .get(input.approvalId, input.threadId, input.ownerId) as ApprovalRow | undefined;
      if (!row) fail('THREADED_APPROVAL_NOT_FOUND');
      const desired = input.decision === 'approve' ? 'approved' : input.decision === 'reject' ? 'rejected' : fail('THREADED_INVALID_DECISION');
      if (row!.status !== 'pending') {
        if (row!.decision_request_id === input.requestId && row!.status === desired) return row!;
        return fail('THREADED_APPROVAL_ALREADY_DECIDED');
      }
      const binding = storedBinding(row!.binding_id);
      authority.assertAuthorized(binding, { allowApproval: true });
      const inv = getInvocation(binding.invocationId);
      if (inv.status !== 'running' || attempt(inv)?.execution_stage !== 'started') fail('THREADED_RECONCILIATION_REQUIRED');
      const now = new Date().toISOString();
      db.prepare('UPDATE threaded_approvals SET status=?,decision_request_id=?,updated_at=? WHERE id=? AND status=\'pending\'')
        .run(desired, input.requestId, now, row!.id);
      if (desired === 'approved') {
        db.prepare(`UPDATE threaded_attempts SET status='running',version=version+1,updated_at=? WHERE id=?`).run(now, binding.attemptId);
        updateProjection(inv.id, 'running');
      } else {
        retainUnknownResources(binding.attemptId);
        db.prepare(`UPDATE threaded_invocations SET cancel_requested=1,authority_epoch=authority_epoch+1 WHERE id=?`).run(inv.id);
        db.prepare(`UPDATE threaded_attempts SET status='unknown',execution_stage='unknown',version=version+1,updated_at=? WHERE id=?`).run(now, binding.attemptId);
        updateProjection(inv.id, 'unknown', 'APPROVAL_REJECTED'); rejectedInvocation = inv.id;
      }
      return db.prepare('SELECT * FROM threaded_approvals WHERE id=?').get(row!.id) as ApprovalRow;
    }).immediate();
    if (rejectedInvocation) invalidate([rejectedInvocation]); return decided;
  }

  function resumeAfterApproval(approvalId: string): void {
    const row = db.prepare('SELECT * FROM threaded_approvals WHERE id=?').get(approvalId) as ApprovalRow | undefined;
    if (!row || row.status !== 'approved') fail('THREADED_APPROVAL_NOT_APPROVED');
    const binding = storedBinding(row!.binding_id);
    authority.assertAuthorized(binding);
    if (getInvocation(binding.invocationId).status !== 'running' || attempt(getInvocation(binding.invocationId))?.execution_stage !== 'started') fail('THREADED_RECONCILIATION_REQUIRED');
    // The original driver may observe the approved receipt. This port never invokes a driver.
  }

  function revokeAccount(accountId: string, identityGeneration?: number | null): { affectedRunIds: string[] } {
    const ids: string[] = []; const affectedRunIds: string[] = [];
    db.transaction(() => {
      const rows = db.prepare(`SELECT * FROM threaded_invocations WHERE account_id=? AND status NOT IN ('completed','failed','cancelled')`)
        .all(accountId) as InvocationRow[];
      for (const row of rows) {
        if (row.cancel_requested) continue;
        if (identityGeneration != null && row.account_identity_generation !== identityGeneration) continue;
        const id = runId(row.id); if (id) affectedRunIds.push(id);
        const current = attempt(row); const now = new Date().toISOString(); ids.push(row.id);
        db.prepare(`UPDATE threaded_invocations SET cancel_requested=1,authority_epoch=authority_epoch+1,version=version+1,updated_at=? WHERE id=?`).run(now, row.id);
        expireApprovals(row.id);
        if (!current) updateProjection(row.id, 'cancelled', 'ACCOUNT_REVOKED');
        else if (current.execution_stage === 'quiescent') {
          const receipt = current.outcome_record ? JSON.parse(current.outcome_record) as OutcomeReceipt : null;
          const bindingRow = db.prepare('SELECT id FROM threaded_execution_bindings WHERE attempt_id=?').get(current.id) as { id: string } | undefined;
          if (!receipt || !bindingRow) fail('THREADED_QUIESCENCE_RECEIPT_REQUIRED');
          terminalWithinTransaction({ binding: storedBinding(bindingRow!.id), status: 'cancelled', budgetState: receipt!.budgetState,
            quiescence: receipt!.quiescence, reason: 'ACCOUNT_REVOKED' }, true, true);
        } else {
          const uncertain = ['started', 'unknown'].includes(current.execution_stage);
          updateProjection(row.id, uncertain ? 'unknown' : 'waiting', 'ACCOUNT_REVOKED');
          if (uncertain) {
            retainUnknownResources(current.id);
            db.prepare(`UPDATE threaded_attempts SET status='unknown',execution_stage='unknown',version=version+1,updated_at=? WHERE id=?`).run(now, current.id);
          }
        }
      }
    }).immediate();
    invalidate(ids); return { affectedRunIds };
  }

  function reconcile(invocationId: string): RecoveryPlan {
    let invalidated = false;
    const plan = db.transaction(() => {
      const inv = getInvocation(invocationId); const current = attempt(inv);
      if (!terminal(inv.status) && current && ['prepared', 'running', 'waiting'].includes(current.status) && current.execution_stage !== 'quiescent'
        && inv.recovery_reason !== 'PROCESS_RESTART_NOT_STARTED') {
        const uncertain = ['started', 'unknown'].includes(current.execution_stage);
        if (uncertain) retainUnknownResources(current.id);
        db.prepare(`UPDATE threaded_invocations SET authority_epoch=authority_epoch+1 WHERE id=?`).run(inv.id);
        db.prepare(`UPDATE threaded_attempts SET status=?,execution_stage=?,execution_reason='PROCESS_RESTART',version=version+1,updated_at=? WHERE id=?`)
          .run(uncertain ? 'unknown' : 'waiting', uncertain ? 'unknown' : current.execution_stage, new Date().toISOString(), current.id);
        updateProjection(inv.id, uncertain ? 'unknown' : 'waiting', uncertain ? 'PROCESS_RESTART_UNKNOWN' : 'PROCESS_RESTART_NOT_STARTED');
        expireApprovals(inv.id); invalidated = true;
      }
      const latest = getInvocation(inv.id); const latestAttempt = attempt(latest);
      return { invocationId: inv.id, runId: runId(inv.id), status: latest.status,
        action: latestAttempt?.resource_release_state === 'pending' ? 'await_resource_release'
          : latest.status === 'unknown' ? 'await_reconciliation'
          : latestAttempt && latestAttempt.execution_stage !== 'quiescent' && !terminal(latest.status) ? 'await_quiescence'
            : latest.status === 'waiting' ? 'await_control' : 'none', reason: latest.recovery_reason } as RecoveryPlan;
    }).immediate();
    if (invalidated) invalidate([invocationId]); return plan;
  }
  function recoverAll(): RecoveryPlan[] {
    return (db.prepare(`SELECT i.id FROM threaded_invocations i WHERE i.status NOT IN ('completed','failed','cancelled')
      OR EXISTS(SELECT 1 FROM threaded_attempts a WHERE a.id=i.current_attempt_id AND a.resource_release_state='pending') ORDER BY i.created_at,i.id`)
      .all() as Array<{ id: string }>).map(row => reconcile(row.id));
  }

  return { createInvocation, prepareAttempt, startAttempt, recordOutput, commitTerminal, recordOutcome, releaseResources,
    requestControl, registerApproval, createApproval: registerApproval, decideApproval, resumeAfterApproval, revokeAccount, reconcile, recoverAll };
}
export type ThreadedLifecycle = ReturnType<typeof createThreadedLifecycle>;

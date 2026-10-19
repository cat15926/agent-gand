import { randomUUID } from 'node:crypto';
import type { AgentDefinition } from '@agent-gand/shared';
import { db, all, get } from '../../db/database.ts';
import { implicitAccount } from '../../accounts/legacy.ts';
import { assertLegacyRun } from '../../runs/legacyMode.ts';
import { ExecutionError } from '../errors.ts';
import { executionResources } from './service.ts';
import { beginLegacyProviderEvidence, legacyNativeQuiescent } from './legacyEvidence.ts';
import type { ResourceClaimIdentity, ResourceClaimRecord, ResourceEvidence, ResourceSessionReference, TrustedResourceRequest } from './types.ts';

export function legacyResourceOwner(): string {
  return get<{ instance_owner_id: string }>('SELECT instance_owner_id FROM threaded_instances WHERE singleton=1')!.instance_owner_id;
}
const memberKey = (key: string) => `legacy:member:${key}`;
function ticketByKey(key: string) {
  const row = get<{ id: string }>('SELECT id FROM execution_resource_tickets WHERE owner_id=? AND request_key=?', legacyResourceOwner(), key);
  return row ? executionResources.getTicket(row.id) : undefined;
}
function requestBase(runId: string, agentId: string, key: string, attemptId?: string): TrustedResourceRequest {
  assertLegacyRun(runId);
  return { requestKey: key, operationId: key, mode: 'legacy', ownerId: legacyResourceOwner(), runId, agentId,
    attemptId: attemptId ?? `legacy:${key}`, capacity: false };
}

/** Queue the cross-mode Agent barrier at the same time as the old FIFO ticket. */
export function reserveLegacyMember(runId: string, agentId: string, key: string): void {
  // Legacy dispatch ledgers may reference an unavailable role before the old
  // executor rejects it. Do not turn a queue-only operation into execution.
  if (!get('SELECT 1 FROM agents WHERE id=?', agentId)) return;
  if (!ticketByKey(memberKey(key))) executionResources.enqueue({ ...requestBase(runId, agentId, memberKey(key)), eligible: false });
}
export function cancelLegacyMember(key: string): void {
  const ticket = ticketByKey(memberKey(key));
  if (ticket?.status === 'waiting') executionResources.cancelTicket(ticket.id);
}
export function acquireLegacyMember(runId: string, agentId: string, key: string): LegacyResourceHandle | null {
  reserveLegacyMember(runId, agentId, key);
  let ticket = ticketByKey(memberKey(key));
  if (!ticket) throw new ExecutionError('policy_rejected', '成员角色不存在，不能领取执行资源');
  if (ticket.status === 'released') { executionResources.requeuePreparation(ticket.id); ticket = executionResources.getTicket(ticket.id)!; }
  if (ticket.status === 'cancelled') throw new ExecutionError('cancelled', '成员排队占用已取消');
  if (!ticket.eligible) executionResources.setEligible(ticket.id, true);
  const claim = executionResources.tryAcquire(ticket.id);
  return claim ? handle(claim) : null;
}
export function legacyParentClaim(runId: string, agentId: string, attemptId?: string): ResourceClaimIdentity | undefined {
  const member = get<{ ticket_key: string }>(`SELECT ticket_key FROM execution_member_tickets
    WHERE run_id=? AND agent_id=? AND status='active' AND (? IS NULL OR attempt_id IS ?) ORDER BY seq DESC LIMIT 1`,
  runId, agentId, attemptId ?? null, attemptId ?? null);
  const ticket = member ? ticketByKey(memberKey(member.ticket_key)) : undefined;
  return ticket ? executionResources.getClaimForTicket(ticket.id)?.identity : undefined;
}

/** Frozen account ID is the capacity identity; credential versions do not create extra slots. */
function accountScope(runId: string, agentId: string, model?: string, backend?: string) {
  const pinned = get<{ account_id: string; identity_generation: number | null }>('SELECT account_id,identity_generation FROM run_account_bindings WHERE run_id=? AND agent_id=?', runId, agentId);
  const snapshot = get<{ definition: string }>('SELECT definition FROM run_agent_snapshots WHERE run_id=? AND agent_id=?', runId, agentId)
    ?? get<{ definition: string }>('SELECT definition FROM agents WHERE id=?', agentId);
  const definition = snapshot ? JSON.parse(snapshot.definition) as AgentDefinition : { model,
    ...(backend && backend !== 'builtin-llm' ? { execution: { kind: 'external', driver: backend } } : {}) };
  const accountId = pinned?.account_id ?? ('accountRef' in definition ? definition.accountRef : undefined) ?? implicitAccount(definition);
  const accountProvider = accountId ? get<{ provider: string }>('SELECT provider FROM accounts WHERE id=?', accountId)?.provider
    ?? (['legacy-llm-openai','legacy-codex-native'].includes(accountId) ? 'openai'
      : ['legacy-llm-anthropic','legacy-claude-sdk','legacy-claude-cli'].includes(accountId) ? 'anthropic' : undefined) : undefined;
  const modelProvider = definition.model?.split(':')[0];
  const providerKey = backend && backend !== 'builtin-llm' ? backend
    : accountProvider ?? (modelProvider && ['openai','anthropic','mock'].includes(modelProvider) ? modelProvider : 'builtin-llm');
  return { ...(accountId ? { accountId } : {}), ...(pinned?.identity_generation ? { accountIdentityGeneration: pinned.identity_generation } : {}),
    providerKey };
}

const pendingReleases = new Map<string, { claim: ResourceClaimIdentity; evidence: ResourceEvidence }>();
const timers = new Map<string, ReturnType<typeof setInterval>>();
let draining = false;
function releaseWhenSafe(claim: ResourceClaimIdentity, evidence: ResourceEvidence): boolean {
  try {
    if (get(`SELECT 1 FROM execution_resource_claims c JOIN execution_resource_tickets t ON t.id=c.ticket_id
      WHERE t.parent_claim_id=? AND c.state<>'released'`, claim.claimId)) {
      pendingReleases.set(claim.claimId, { claim, evidence }); return false;
    }
    const proof = executionResources.recordQuiescence(claim, evidence);
    executionResources.release(claim, proof);
    clearInterval(timers.get(claim.claimId)); timers.delete(claim.claimId); pendingReleases.delete(claim.claimId);
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code ?? '';
    if (/CHILD|QUIESCENCE|UNKNOWN/.test(code)) { pendingReleases.set(claim.claimId, { claim, evidence }); return false; }
    throw error;
  }
}
function drainPendingReleases(): void {
  if (draining) return;
  draining = true;
  try { for (const { claim, evidence } of [...pendingReleases.values()]) releaseWhenSafe(claim, evidence); }
  finally { draining = false; }
}
/** Tool completion may unblock a deferred cleanup; it does not authorize replay. */
export function retryPendingLegacyReleases(): void { drainPendingReleases(); }
export interface LegacyResourceHandle {
  claim: ResourceClaimIdentity;
  start(): void;
  unknown(): void;
  release(evidence?: ResourceEvidence): boolean;
}
function handle(claim: ResourceClaimIdentity): LegacyResourceHandle {
  if (!timers.has(claim.claimId)) {
    const timer = setInterval(() => { try { executionResources.renew(claim); } catch { clearInterval(timer); timers.delete(claim.claimId); } }, 2000);
    timer.unref(); timers.set(claim.claimId, timer);
  }
  return { claim, start() { executionResources.markStarted(claim); }, unknown() {
    const state = executionResources.getClaim(claim.claimId)?.state;
    if (state === 'reserved' || state === 'started') executionResources.markUnknown(claim);
  },
    release(evidence = { reason: 'not_started', sideEffects: 'none', reference: 'legacy-preparation' }) {
      const released = releaseWhenSafe(claim, evidence); drainPendingReleases(); return released;
    } };
}
export async function waitForLegacyResourceChange(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new ExecutionError('cancelled', '等待资源已取消');
  await new Promise<void>((resolve, reject) => {
    let unsubscribe = () => {};
    const finish = () => { clearTimeout(timer); unsubscribe(); signal?.removeEventListener('abort', abort); resolve(); };
    const abort = () => { clearTimeout(timer); unsubscribe(); signal?.removeEventListener('abort', abort); reject(signal?.reason ?? new ExecutionError('cancelled', '等待资源已取消')); };
    const timer = setTimeout(finish, 100); // bounded repair; normal release notifies immediately.
    unsubscribe = executionResources.onAvailable(finish);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
export async function acquireLegacyResources(input: { runId: string; agentId: string; attemptId?: string; operationId?: string;
  model?: string; backend?: string; capacity?: boolean; parentClaim?: ResourceClaimIdentity;
  legacyExecutionId?: string;
  workspaces?: TrustedResourceRequest['workspaces']; session?: ResourceSessionReference; signal?: AbortSignal }): Promise<LegacyResourceHandle> {
  const operationId = input.operationId ?? `legacy:resources:${randomUUID()}`;
  const parentClaim = input.parentClaim ?? legacyParentClaim(input.runId, input.agentId, input.attemptId);
  const ticket = executionResources.enqueue({ ...requestBase(input.runId, input.agentId, operationId, input.attemptId),
    ...accountScope(input.runId, input.agentId, input.model, input.backend), capacity: input.capacity === true,
    ...(input.legacyExecutionId ? { legacyExecutionId: input.legacyExecutionId } : {}),
    ...(parentClaim ? { parentClaim } : {}), ...(input.workspaces ? { workspaces: input.workspaces } : {}), ...(input.session ? { session: input.session } : {}) });
  try {
    for (;;) {
      if (input.signal?.aborted) throw input.signal.reason ?? new ExecutionError('cancelled', '等待资源已取消');
      const claim = executionResources.tryAcquire(ticket.id);
      if (claim) return handle(claim);
      await waitForLegacyResourceChange(input.signal);
    }
  } catch (error) { executionResources.cancelTicket(ticket.id); throw error; }
}
export function tryAcquireLegacySession(input: { runId: string; agentId: string; attemptId?: string; executionId?: string; session: ResourceSessionReference; parentClaim?: ResourceClaimIdentity }): LegacyResourceHandle {
  const key = `legacy:session-bind:${randomUUID()}`, parentClaim = input.parentClaim ?? legacyParentClaim(input.runId, input.agentId, input.attemptId);
  const ticket = executionResources.enqueue({ ...requestBase(input.runId, input.agentId, key, input.attemptId), session: input.session,
    ...(input.executionId && get("SELECT 1 FROM external_native_processes WHERE execution_id=? AND status='active'", input.executionId)
      ? { legacyExecutionId: input.executionId } : {}),
    ...(parentClaim ? { parentClaim } : {}) });
  const claim = executionResources.tryAcquire(ticket.id);
  if (!claim) { executionResources.cancelTicket(ticket.id); throw new ExecutionError('interrupted', '原生会话已被另一调用占用，禁止同时恢复'); }
  return handle(claim);
}

export async function acquireLegacyModelCall(callId: string, signal?: AbortSignal, legacyExecutionId?: string, parentClaim?: ResourceClaimIdentity): Promise<LegacyResourceHandle> {
  const call = get<{ run_id: string; agent_id: string; attempt_id: string | null; model: string; backend: string }>('SELECT * FROM orchestration_model_calls WHERE id=?', callId);
  if (!call) throw new ExecutionError('policy_rejected', '模型调用缺少持久入场记录');
  return acquireLegacyResources({ runId: call.run_id, agentId: call.agent_id, attemptId: call.attempt_id ?? undefined,
    operationId: callId, model: call.model, backend: call.backend, capacity: true, signal, legacyExecutionId, parentClaim });
}
export function runWithLegacyProviderEvidence<T>(resource: LegacyResourceHandle, callId: string, operation: () => Promise<T>, onStarted?: () => void): Promise<T> {
  const evidence = beginLegacyProviderEvidence(resource.claim.runId, resource.claim.agentId, callId);
  try { resource.start(); } catch (error) { evidence.forget(); throw error; }
  onStarted?.();
  return Promise.resolve().then(operation).finally(() => {
    evidence.settle();
    if (resource.release({ reason: 'process_exited', sideEffects: 'reconciled', reference: evidence.reference })) evidence.forget();
  });
}
export function releaseLegacyNativeResource(resource: LegacyResourceHandle, executionId: string): boolean {
  if (!legacyNativeQuiescent(db, executionId, resource.claim.runId, resource.claim.agentId)) { resource.unknown(); return false; }
  return resource.release({ reason: 'process_exited', sideEffects: 'reconciled', reference: `legacy-native:${executionId}` });
}
export function legacyClaimsForRun(runId: string): ResourceClaimRecord[] {
  return all<{ id: string }>('SELECT id FROM execution_resource_tickets WHERE run_id=? AND mode=\'legacy\'', runId)
    .map(row => executionResources.getClaimForTicket(row.id)).filter((claim): claim is ResourceClaimRecord => !!claim);
}

/** Runs after native-process recovery. No callback, retry, or model is launched. */
export function recoverLegacyResources(): { released: number; retained: number } {
  let released = 0;
  // Children release before their preparations; repeat to cover multiple levels.
  for (let pass = 0; pass < 10; pass++) {
    let progressed = false;
    const claims = executionResources.listClaims().filter(claim => claim.request.mode === 'legacy');
    for (const claim of claims) {
      if (claims.some(child => child.request.parentClaim?.claimId === claim.identity.claimId)) continue;
      try {
        if (claim.state === 'quiescent') {
          const saved = get<{ proof: string }>('SELECT proof FROM execution_resource_quiescence WHERE claim_id=?', claim.identity.claimId);
          if (!saved) continue;
          executionResources.release(claim.identity, JSON.parse(saved.proof));
        } else if (claim.request.legacyExecutionId) {
          if (!legacyNativeQuiescent(db, claim.request.legacyExecutionId, claim.identity.runId, claim.identity.agentId)) {
            handle(claim.identity).unknown(); continue;
          }
          if (!releaseWhenSafe(claim.identity, { reason: 'process_exited', sideEffects: 'reconciled',
            reference: `legacy-native:${claim.request.legacyExecutionId}` })) continue;
        } else if (claim.request.capacity === false) {
          // An old parent or builtin workspace is not proof that a still-started
          // child/provider/tool became quiescent across a server restart.
          const family = claim.request.parentClaim?.claimId ?? claim.identity.claimId;
          if (claims.some(other => other.identity.claimId !== claim.identity.claimId
            && (other.request.parentClaim?.claimId === family || other.identity.claimId === family)
            && (other.request.capacity !== false || other.state === 'started' || other.state === 'unknown'))) continue;
          if (get("SELECT 1 FROM tool_executions WHERE run_id=? AND status IN ('running','needs_attention')", claim.identity.runId)) continue;
          if (!releaseWhenSafe(claim.identity, { reason: 'not_started', sideEffects: 'none', reference: 'legacy-preparation' })) continue;
        } else {
          const call = get<{ started_at: string | null }>('SELECT started_at FROM orchestration_model_calls WHERE id=?', claim.request.operationId);
          if (claim.state !== 'reserved' || !call || call.started_at) { handle(claim.identity).unknown(); continue; }
          if (!releaseWhenSafe(claim.identity, { reason: 'not_started', sideEffects: 'none' })) continue;
        }
        clearInterval(timers.get(claim.identity.claimId)); timers.delete(claim.identity.claimId);
        pendingReleases.delete(claim.identity.claimId); released++; progressed = true;
      } catch { /* Retain a failed or unproven fence; recovery never replays work. */ }
    }
    if (!progressed) break;
  }
  return { released, retained: executionResources.listClaims().filter(claim => claim.request.mode === 'legacy').length };
}

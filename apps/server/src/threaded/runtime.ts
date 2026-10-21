import type Database from 'better-sqlite3';
import type { ThreadedBinding } from '@agent-gand/shared';
import type { createExecutionResourceCoordinator } from '../execution/resources/coordinator.ts';
import type { InvocationExecutionPort, QuiescenceProof } from './contracts.ts';
import { ThreadedAuthorityError } from './contracts.ts';
import type { BudgetAuthorization, BudgetUsageEvidence } from './budgetTypes.ts';
import type { ThreadedQueueClaim, ThreadedQueuePreparationContext, ThreadedQueueResourcePreparation } from './queueContracts.ts';
import { createThreadedAuthority } from './authority.ts';
import { createThreadedBudget } from './budget.ts';
import { createThreadedQueue } from './queue.ts';
import { createThreadedLifecycle } from './lifecycle.ts';
import { createThreadedMessaging } from './messaging.ts';
import { createThreadedRunner } from './runner.ts';
import { createThreadedDispatcher } from './dispatcher.ts';
import { abortThreadedExecution } from './executionSignals.ts';
import { createThreadedCollaboration } from './collaboration.ts';
import type { createThreadedContext } from './context.ts';
import type { ThreadedTrackingSource } from './tracking.ts';

/** Core composition; context preparation and execution are supplied through explicit ports. */
export function createThreadedRuntime(db: Database.Database, options: {
  resources: ReturnType<typeof createExecutionResourceCoordinator>;
  prepareResources: (context: ThreadedQueuePreparationContext) => ThreadedQueueResourcePreparation;
  executor?: InvocationExecutionPort;
  verifyUsage?: (binding: ThreadedBinding, authorization: BudgetAuthorization, usage: BudgetUsageEvidence) => boolean;
  messaging?: ReturnType<typeof createThreadedMessaging>;
  now?: () => number;
  ownerNonce?: string;
  leaseMs?: number;
  repairIntervalMs?: number;
  autoStart?: boolean;
  dispatchEnabled?: boolean;
  /** T07 prepares an actual manifest; T06 fixtures keep their explicit metadata references. */
  prepareExecution?: (claim: ThreadedQueueClaim) => { contextManifestId: string; sessionBindingId: string };
  assertExecutionContext?: (binding: ThreadedBinding) => void;
  deferRequestStart?: boolean;
  collaborationEnabled?: boolean;
  collaborationContext?: Pick<ReturnType<typeof createThreadedContext>,'markSeen'|'acknowledgeMentions'>;
  trackingSources?:Record<string,ThreadedTrackingSource>;
  actions?:import('./actionTypes.ts').ActionOptions;
}) {
  const { resources } = options;
  const authority = createThreadedAuthority(db, resources);
  const messaging = options.messaging ?? createThreadedMessaging(db, { authority, repairIntervalMs: options.repairIntervalMs,now:options.now });
  const budget = createThreadedBudget(db, { authority, resources, now: options.now, verifyUsage: options.verifyUsage });
  let queue: ReturnType<typeof createThreadedQueue>;
  let dispatcher: ReturnType<typeof createThreadedDispatcher<ThreadedQueueClaim>>;
  const activeInvocations = new Set<string>();
  let closed = false;
  const enabled = options.dispatchEnabled ?? Boolean(options.executor);
  if (enabled && (!options.executor || process.env.AGENT_GAND_ISOLATED_WORKER !== '1')) {
    throw new ThreadedAuthorityError('THREADED_EXECUTION_NOT_ENABLED');
  }
  const notify = () => {
    messaging.notifyCommitted();
    if (enabled) dispatcher?.wakeup();
    collaboration?.notifyCommitted();
  };
  const collaboration = options.collaborationEnabled ? createThreadedCollaboration(db,{authority,messages:messaging.messages,
    now:options.now,context:options.collaborationContext,trackingSources:options.trackingSources,actions:options.actions,
    onCommitted:()=>{messaging.notifyCommitted();if(enabled)dispatcher?.wakeup();}}) : undefined;
  const mapped = (invocationId: string) => db.prepare('SELECT 1 FROM threaded_invocation_wakes WHERE invocation_id=?').get(invocationId);
  const lifecycle = createThreadedLifecycle(db, authority, {
    resources,
    maxAttempts: id => mapped(id) ? budget.maxAttemptsForInvocation(id) : 2,
    onInvalidate(ids) {
      // A surrounding account transaction may still roll back. Recheck durable revocation
      // after its synchronous transaction exits before cancelling an in-process execution.
      queueMicrotask(() => {
        if (closed || !db.open) return;
        for (const id of ids) {
          const live = db.prepare(`SELECT i.status,i.pause_requested,i.cancel_requested,i.authority_epoch,
            a.authority_epoch AS attempt_epoch FROM threaded_invocations i LEFT JOIN threaded_attempts a
            ON a.id=i.current_attempt_id WHERE i.id=?`).get(id) as {
              status: string; pause_requested: number; cancel_requested: number; authority_epoch: number; attempt_epoch: number | null;
            } | undefined;
          if (live && (live.pause_requested || live.cancel_requested || live.status === 'unknown'
            || (live.attempt_epoch !== null && live.authority_epoch !== live.attempt_epoch))) abortThreadedExecution(id);
        }
        notify();
      });
    },
    onStartWithinTransaction(binding) {
      if (!mapped(binding.invocationId)) return;
      queue.startWithinTransaction(binding);
      if (options.deferRequestStart) budget.beginAttemptActivity(binding, queue.authorizationForBinding(binding).id);
      else budget.markStartedWithinTransaction(binding, queue.authorizationForBinding(binding).id);
    },
    onOutcomeWithinTransaction(binding, outcome) {
      if (!mapped(binding.invocationId)) return;
      return budget.settleOutcomeWithinTransaction(binding, queue.authorizationForBinding(binding).id, outcome);
    },
    onOutcomeAppliedWithinTransaction(binding) {
      if (mapped(binding.invocationId)) queue.applyOutcomeWithinTransaction(binding);
    },
    assertDirectTerminal(proof) {
      if (mapped(proof.binding.invocationId)) throw new ThreadedAuthorityError('THREADED_RUNTIME_OUTCOME_REQUIRED');
    },
    onTerminalWithinTransaction(proof) {
      if (!mapped(proof.binding.invocationId)) return;
      if (proof.status !== 'completed') {
        collaboration?.terminalWithin({binding:proof.binding,status:proof.status,quiescence:proof.quiescence});return;
      }
      const source = db.prepare(`SELECT m.source_message_id FROM threaded_invocation_wakes m WHERE m.invocation_id=?`)
        .get(proof.binding.invocationId) as { source_message_id: string };
      const message = messaging.messages.getMessage({ ownerId: proof.binding.ownerId, threadId: proof.binding.threadId,
        viewer: { kind: 'agent', agentId: proof.binding.agentId } }, source.source_message_id);
      if (!message) throw new ThreadedAuthorityError('THREADED_RUNTIME_SOURCE_UNAVAILABLE');
      const output = db.prepare('SELECT content FROM threaded_outputs WHERE id=? AND binding_id=?')
        .get(proof.outputId, proof.binding.id) as { content: string };
      const responseInput = {
        binding: proof.binding, responseCommitKey: `runtime-response:${proof.binding.attemptId}`, quiescence: proof.quiescence,
        body: output.content, ...proof.response,
        visibility: proof.response?.visibility ?? message.visibility,
        audience: proof.response?.audience ?? message.audience,
        sourceRefs: [...new Set([source.source_message_id, ...(proof.response?.sourceRefs ?? [])])],
      };
      const response=collaboration ? collaboration.responseWithin(proof.binding,responseInput.responseCommitKey,
        proof.quiescence,responseInput) : messaging.messages.appendResponseWithinTransaction(responseInput);
      collaboration?.terminalWithin({binding:proof.binding,status:proof.status,response,quiescence:proof.quiescence});
    },
    onCommitted: notify,
  });
  queue = createThreadedQueue(db, { lifecycle, resources, budget, prepareResources: options.prepareResources,
    additionalAdmission:collaboration?row=>{
      if(row.state==='claimed'||row.state==='unknown')return {allowed:true,reason:''};
      if(!collaboration.actions.admission(row.sourceMessageId,row.agentId))return {allowed:false,reason:'THREADED_ACTION_STALE_GENERATION',cancelled:true};
      const group=db.prepare(`SELECT g.state,g.deadline FROM threaded_consultation_targets t JOIN threaded_consultations g ON g.id=t.group_id
        WHERE t.question_message_id=? AND t.agent_id=?`).get(row.sourceMessageId,row.agentId) as {state:string;deadline:number}|undefined;
      return group&&(group.state!=='collecting'||group.deadline<=(options.now?.()??Date.now()))
        ?{allowed:false,reason:'THREADED_CONSULTATION_EXPIRED',cancelled:true}:{allowed:true,reason:''};
    }:undefined,
    now: options.now, ownerNonce: options.ownerNonce, leaseMs: options.leaseMs });
  const executor = options.executor ?? { async execute(): Promise<never> { throw new ThreadedAuthorityError('THREADED_EXECUTION_NOT_ENABLED'); } };
  const runner = createThreadedRunner(authority, lifecycle, executor, {
    assertExecutionAuthorized(binding, authorizationId) {
      queue.assertExecutable(binding);
      options.assertExecutionContext?.(binding);
      if (options.deferRequestStart) budget.assertAttemptAuthorized(binding);
      if (authorizationId !== null) budget.assertAuthorized(authorizationId, binding);
      else if (!options.deferRequestStart) throw new ThreadedAuthorityError('THREADED_BUDGET_AUTHORIZATION_REQUIRED');
    },
    checkpoint(binding, authorizationId) {
      const allowance = options.deferRequestStart ? budget.checkpointAttempt(binding)
        : authorizationId !== null ? budget.checkpoint(binding, authorizationId)
          : (() => { throw new ThreadedAuthorityError('THREADED_BUDGET_AUTHORIZATION_REQUIRED'); })();
      resources.renew(authority.claim(binding));
      queue.renew(binding);
      return allowance;
    },
    now: options.now,
  });
  async function executeClaim(claim: ThreadedQueueClaim) {
    if (closed) throw new ThreadedAuthorityError('THREADED_RUNTIME_CLOSED');
    if (activeInvocations.has(claim.binding.invocationId)) throw new ThreadedAuthorityError('THREADED_INVOCATION_ALREADY_EXECUTING');
    activeInvocations.add(claim.binding.invocationId);
    try {
      let prepared: { contextManifestId: string; sessionBindingId: string } | undefined;
      try {
        prepared = options.prepareExecution?.(claim);
        if (options.prepareExecution && (!prepared || typeof prepared.contextManifestId !== 'string' || !prepared.contextManifestId
          || typeof prepared.sessionBindingId !== 'string' || !prepared.sessionBindingId)) {
          throw new ThreadedAuthorityError('THREADED_EXECUTION_CONTEXT_REQUIRED');
        }
      } catch (error) {
        // Metadata preparation performs no external I/O. Park this source without spinning
        // through retries or keeping capacity while its input/Session needs an Owner decision.
        const reason = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          && /^THREADED_[A-Z0-9_]+$/.test(error.code) ? error.code : 'THREADED_CONTEXT_PREPARATION_FAILED';
        const proof = resources.recordQuiescence(authority.claim(claim.binding), { reason: 'not_started', sideEffects: 'none' });
        lifecycle.requestControl({ ownerId: claim.binding.ownerId, scope: { kind: 'invocation', threadId: claim.binding.threadId,
          invocationId: claim.binding.invocationId }, action: 'pause', requestId: `context-block:${claim.binding.attemptId}:${reason}` });
        return { ...lifecycle.recordOutcome(claim.binding, { kind: 'not_started', reason, quiescence: proof }), contextBlocked: reason };
      }
      return await runner.execute({ binding: claim.binding,
        contextManifestId: prepared?.contextManifestId ?? `wake:${claim.queue.wakeId}:${claim.waveId}:${claim.inputMaxSeq}`,
        sessionBindingId: prepared?.sessionBindingId ?? claim.sessionBindingId, budgetAuthorizationId: claim.budgetAuthorization.id });
    } finally { activeInvocations.delete(claim.binding.invocationId); }
  }
  dispatcher = createThreadedDispatcher<ThreadedQueueClaim>({
    claimNext() { queue.scanPending(); return queue.claimNext('threaded-runtime-v1'); },
    execute: executeClaim,
    onAvailable: enabled ? listener => resources.onAvailable(listener) : undefined,
    onWake: enabled ? listener => {
      const unwatchMessages = messaging.onNotification(listener);
      const unwatchQueue = queue.onAvailable(listener);
      return () => { unwatchMessages(); unwatchQueue(); };
    } : undefined,
    repairIntervalMs: enabled ? options.repairIntervalMs : 0,
  });
  function recover() {
    if (closed) throw new ThreadedAuthorityError('THREADED_RUNTIME_CLOSED');
    if (activeInvocations.size || dispatcher.diagnostics().active) throw new ThreadedAuthorityError('THREADED_RECOVERY_DURING_EXECUTION');
    if (db.inTransaction) throw new ThreadedAuthorityError('THREADED_RECOVERY_REQUIRES_OUTERMOST_TRANSACTION');
    // Revoke old callbacks before interpreting prepared/started crash boundaries.
    const lifecyclePlans = lifecycle.recoverAll();
    const budgetPlan = budget.recover();
    queue.scanPending();
    const plans = queue.recover();
    for (const plan of plans) {
      if (plan.action === 'release_pending') {
        const receipt = db.prepare('SELECT outcome_record FROM threaded_attempts WHERE id=?').get(plan.binding.attemptId) as { outcome_record: string | null };
        const proof = receipt.outcome_record ? (JSON.parse(receipt.outcome_record) as { quiescence?: QuiescenceProof }).quiescence : undefined;
        if (proof) lifecycle.releaseResources(plan.binding, proof);
      } else if (plan.action === 'not_started') {
        const claim = authority.claim(plan.binding);
        // A lease expiry marked unknown is weaker evidence than a prepared crash boundary.
        // Never replace that knowledge with an unverified not-started assertion.
        const record = resources.listClaims().find(item => item.identity.claimId === claim.claimId);
        if (record?.state !== 'reserved') continue;
        const proof = resources.recordQuiescence(claim, { reason: 'not_started', sideEffects: 'none' });
        lifecycle.recordOutcome(plan.binding, { kind: 'not_started', reason: 'PROCESS_RESTART_NOT_STARTED', quiescence: proof });
      } else if (plan.action === 'unknown') {
        const authorization = queue.authorizationForBinding(plan.binding);
        if (authorization.executionState === 'reserved' || authorization.executionState === 'started') {
          lifecycle.recordOutcome(plan.binding, { kind: 'unknown', reason: 'PROCESS_RESTART_UNKNOWN' });
        }
      }
    }
    queue.scanPending(); messaging.recover();
    collaboration?.recover();
    if (enabled) dispatcher.wakeup();
    return { lifecycle: lifecyclePlans, budget: budgetPlan, queue: queue.recover() };
  }
  if (options.autoStart !== false) {
    queue.scanPending();
    if (enabled) dispatcher.wakeup();
  }
  return {
    authority, resources, lifecycle, budget, queue, messaging, messages: messaging.messages, runner, dispatcher, collaboration,
    executeClaim, recover,
    reviseRoot(input: Parameters<typeof budget.reviseRoot>[0]) {
      if (db.inTransaction) throw new ThreadedAuthorityError('THREADED_BUDGET_DECISION_REQUIRES_OUTERMOST_TRANSACTION');
      const receipt = budget.reviseRoot(input); notify(); return receipt;
    },
    configureOwnerWindow(input: Parameters<typeof budget.configureOwnerWindow>[0]) {
      if (db.inTransaction) throw new ThreadedAuthorityError('THREADED_BUDGET_DECISION_REQUIRES_OUTERMOST_TRANSACTION');
      const receipt = budget.configureOwnerWindow(input); notify(); return receipt;
    },
    wakeup() { if (enabled) dispatcher.wakeup(); },
    whenIdle: dispatcher.whenIdle,
    diagnostics: () => ({ ...dispatcher.diagnostics(), executionEnabled: enabled, notifications: messaging.diagnostics() }),
    close() {
      if (closed) return;
      closed = true; dispatcher.close();
      collaboration?.close();
      // Cancellation is a hint; release still requires a durable quiescence proof.
      for (const id of activeInvocations) abortThreadedExecution(id);
      if (!options.messaging) messaging.close();
    },
  };
}

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

/** Pure composition. T06 has no provider, credentials, context builder or legacy executor. */
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
}) {
  const { resources } = options;
  const authority = createThreadedAuthority(db, resources);
  const messaging = options.messaging ?? createThreadedMessaging(db, { authority, repairIntervalMs: options.repairIntervalMs });
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
  };
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
      budget.markStartedWithinTransaction(binding, queue.authorizationForBinding(binding).id);
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
      if (proof.status !== 'completed' || !mapped(proof.binding.invocationId)) return;
      const source = db.prepare(`SELECT m.source_message_id FROM threaded_invocation_wakes m WHERE m.invocation_id=?`)
        .get(proof.binding.invocationId) as { source_message_id: string };
      const message = messaging.messages.getMessage({ ownerId: proof.binding.ownerId, threadId: proof.binding.threadId,
        viewer: { kind: 'agent', agentId: proof.binding.agentId } }, source.source_message_id);
      if (!message) throw new ThreadedAuthorityError('THREADED_RUNTIME_SOURCE_UNAVAILABLE');
      const output = db.prepare('SELECT content FROM threaded_outputs WHERE id=? AND binding_id=?')
        .get(proof.outputId, proof.binding.id) as { content: string };
      messaging.messages.appendResponseWithinTransaction({
        binding: proof.binding, responseCommitKey: `runtime-response:${proof.binding.attemptId}`, quiescence: proof.quiescence,
        body: output.content, ...proof.response,
        visibility: proof.response?.visibility ?? message.visibility,
        audience: proof.response?.audience ?? message.audience,
        sourceRefs: [...new Set([source.source_message_id, ...(proof.response?.sourceRefs ?? [])])],
      });
    },
    onCommitted: notify,
  });
  queue = createThreadedQueue(db, { lifecycle, resources, budget, prepareResources: options.prepareResources,
    now: options.now, ownerNonce: options.ownerNonce, leaseMs: options.leaseMs });
  const executor = options.executor ?? { async execute(): Promise<never> { throw new ThreadedAuthorityError('THREADED_EXECUTION_NOT_ENABLED'); } };
  const runner = createThreadedRunner(authority, lifecycle, executor, {
    assertExecutionAuthorized(binding, authorizationId) {
      queue.assertExecutable(binding);
      budget.assertAuthorized(authorizationId, binding);
    },
    checkpoint(binding, authorizationId) {
      const allowance = budget.checkpoint(binding, authorizationId);
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
      return await runner.execute({ binding: claim.binding,
        // References are deliberately metadata only until T07 builds actual input manifests.
        contextManifestId: `wake:${claim.queue.wakeId}:${claim.waveId}:${claim.inputMaxSeq}`,
        sessionBindingId: claim.sessionBindingId, budgetAuthorizationId: claim.budgetAuthorization.id });
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
    if (enabled) dispatcher.wakeup();
    return { lifecycle: lifecyclePlans, budget: budgetPlan, queue: queue.recover() };
  }
  if (options.autoStart !== false) {
    queue.scanPending();
    if (enabled) dispatcher.wakeup();
  }
  return {
    authority, resources, lifecycle, budget, queue, messaging, messages: messaging.messages, runner, dispatcher,
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
      // Cancellation is a hint; release still requires a durable quiescence proof.
      for (const id of activeInvocations) abortThreadedExecution(id);
      if (!options.messaging) messaging.close();
    },
  };
}

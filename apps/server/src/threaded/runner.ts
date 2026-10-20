import type { ThreadedBinding } from '@agent-gand/shared';
import type { ExecutionOutcome, InvocationExecutionPort, ScopedExecutionEvent, ThreadedAuthority } from './contracts.ts';
import { ThreadedAuthorityError } from './contracts.ts';
import { abortThreadedExecution, watchThreadedExecution } from './executionSignals.ts';

export interface ThreadedRunnerLifecycle {
  startAttempt(binding: ThreadedBinding): void;
  recordOutcome(binding: ThreadedBinding, outcome: ExecutionOutcome): unknown;
}

/** No production provider or legacy runner is reachable from this T03 port. */
export function createThreadedRunner(
  authority: ThreadedAuthority,
  lifecycle: ThreadedRunnerLifecycle,
  executor: InvocationExecutionPort,
  options: {
    onEvent?: (binding: ThreadedBinding, event: ScopedExecutionEvent) => void;
    assertExecutionAuthorized?: (binding: ThreadedBinding, authorizationId: string) => void;
    checkpoint?: (binding: ThreadedBinding, authorizationId: string) => { validUntil: number };
    now?: () => number;
  } = {},
) {
  return {
    cancelInvocation: abortThreadedExecution,
    async execute(input: {
      binding: ThreadedBinding;
      contextManifestId: string;
      sessionBindingId: string;
      budgetAuthorizationId: string;
    }): Promise<unknown> {
      if (process.env.AGENT_GAND_ISOLATED_WORKER !== '1') {
        throw new ThreadedAuthorityError('THREADED_EXECUTION_NOT_ENABLED');
      }
      if (!input || !input.binding) throw new ThreadedAuthorityError('THREADED_BINDING_REQUIRED');
      for (const value of [input.contextManifestId, input.sessionBindingId, input.budgetAuthorizationId]) {
        if (typeof value !== 'string' || !value.trim()) throw new ThreadedAuthorityError('THREADED_EXECUTION_CONTEXT_REQUIRED');
      }
      // Copy the canonical persisted identity: mutation of caller objects cannot change a callback's scope.
      authority.assertAuthorized(input.binding);
      const binding = Object.freeze({ ...authority.capture(input.binding.attemptId) });
      options.assertExecutionAuthorized?.(binding, input.budgetAuthorizationId);
      lifecycle.startAttempt(binding);
      const controller = new AbortController();
      const unwatch = watchThreadedExecution(binding.invocationId, controller);
      const assertAuthorized = () => {
        if (controller.signal.aborted) throw new ThreadedAuthorityError('THREADED_EXECUTION_ABORTED');
        authority.assertAuthorized(binding);
        options.assertExecutionAuthorized?.(binding, input.budgetAuthorizationId);
      };
      let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
      const checkpoint = () => {
        if (!options.checkpoint || controller.signal.aborted) return;
        try {
          assertAuthorized();
          const { validUntil } = options.checkpoint(binding, input.budgetAuthorizationId);
          const remaining = validUntil - (options.now?.() ?? Date.now());
          if (!Number.isFinite(remaining) || remaining <= 0) throw new ThreadedAuthorityError('THREADED_ACTIVITY_ALLOWANCE_EXPIRED');
          checkpointTimer = setTimeout(checkpoint, Math.max(1, Math.min(remaining, Math.floor(remaining / 2))));
          checkpointTimer.unref();
        } catch (error) {
          controller.abort(error);
        }
      };
      try {
        let outcome: ExecutionOutcome;
        try {
          assertAuthorized();
          checkpoint();
          assertAuthorized();
          outcome = await executor.execute({
            ...input, binding, signal: controller.signal, assertAuthorized,
            onEvent(event) {
              assertAuthorized();
              options.onEvent?.(binding, event);
            },
          });
        } catch {
          // A rejected Promise says nothing about the external process or its side effects.
          outcome = { kind: 'unknown', reason: 'EXECUTOR_OUTCOME_UNCONFIRMED' };
        }
        return lifecycle.recordOutcome(binding, outcome);
      } finally {
        if (checkpointTimer) clearTimeout(checkpointTimer);
        // Removing an in-process listener is safe; only lifecycle proof may release a resource claim.
        unwatch();
      }
    },
  };
}

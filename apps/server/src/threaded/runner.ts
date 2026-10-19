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
  options: { onEvent?: (binding: ThreadedBinding, event: ScopedExecutionEvent) => void } = {},
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
      lifecycle.startAttempt(binding);
      const controller = new AbortController();
      const unwatch = watchThreadedExecution(binding.invocationId, controller);
      const assertAuthorized = () => {
        if (controller.signal.aborted) throw new ThreadedAuthorityError('THREADED_EXECUTION_ABORTED');
        authority.assertAuthorized(binding);
      };
      try {
        let outcome: ExecutionOutcome;
        try {
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
        // Removing an in-process listener is safe; only lifecycle proof may release a resource claim.
        unwatch();
      }
    },
  };
}

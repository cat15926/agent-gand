import type Database from 'better-sqlite3';
import type { createExecutionResourceCoordinator } from '../execution/resources/coordinator.ts';
import type { createThreadedLifecycle } from './lifecycle.ts';

/** T06's scheduler may use this port. It creates no queue, provider or automatic dispatch. */
export function createThreadedResourceAdmission(db: Database.Database,
  resources: ReturnType<typeof createExecutionResourceCoordinator>, lifecycle: ReturnType<typeof createThreadedLifecycle>) {
  return {
    prepareAttempt(ticketId: string) {
      return db.transaction(() => {
        const ticket = resources.getTicket(ticketId);
        if (!ticket || ticket.request.mode !== 'threaded' || ticket.request.capacity === false || ticket.request.parentClaim) {
          throw new Error('THREADED_COMPLETE_RESOURCE_TICKET_REQUIRED');
        }
        const claim = resources.tryAcquire(ticketId);
        if (!claim) return null;
        // Run, Attempt and the complete resource set commit together. A failed authority
        // capture rolls back generation/fairness/claims, without a compensating release.
        return lifecycle.prepareAttempt({ ownerId: claim.ownerId, invocationId: claim.invocationId, claim });
      }).immediate();
    },
  };
}

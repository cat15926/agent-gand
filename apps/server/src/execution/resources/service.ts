import { db } from '../../db/database.ts';
import { config } from '../../config.ts';
import { hostOwner } from '../host.ts';
import { createExecutionResourceCoordinator } from './coordinator.ts';
import { verifyLegacyResourceEvidence } from './legacyEvidence.ts';
import { assertResourceSessionCurrent } from './sessions.ts';
import { verifyThreadedBackendResourceEvidence } from '../../threaded/backends/evidence.ts';

/** One shared instance for all production modes, including the active availability signal. */
export const executionResources = createExecutionResourceCoordinator(db, {
  ownerNonce: hostOwner.owner,
  defaultCapacity: config.collaboration.maxConcurrency,
  validateRequest: request => assertResourceSessionCurrent(db, request),
  verifyEvidence: (_request, claim, evidence) => {
    const saved = executionResources.getClaim(claim.claimId);
    return !!saved && (saved.request.mode === 'threaded'
      ? verifyThreadedBackendResourceEvidence(db, saved, evidence)
      : verifyLegacyResourceEvidence(db, saved, evidence));
  },
});

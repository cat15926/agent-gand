import type { FastifyInstance } from 'fastify';
import { assertManagementBoundary, requireManagementSession } from '../accounts/access.ts';
import { AccountError } from '../accounts/errors.ts';
import { redactSecrets } from '../accounts/secrets.ts';
import { applyBusinessCommand, businessFileEvidence, businessHistory, getBusinessState, listBusinessEvidence } from '../orchestration/business.ts';
import { OrchestrationError } from '../orchestration/normalize.ts';
import { acceptedBusinessGateRuns } from '../orchestration/businessGates.ts';
import { resumeCoordinationRun } from '../coordination/runtime.ts';
import { previewRunContinuation, submitRunContinuation } from '../orchestration/continuation.ts';
import { enqueueConversationRun } from '../conversations/dispatcher.ts';
import { previewBusinessRework, submitBusinessRework } from '../orchestration/businessRework.ts';

/** Existing owner management cookie is scoped to /api/accounts; reuse that boundary. */
export async function registerBusinessRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async managed => {
    managed.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
      assertManagementBoundary(request); requireManagementSession(request);
    });
    managed.setErrorHandler((error, request, reply) => {
      const status = error instanceof OrchestrationError || error instanceof AccountError ? error.status : (error as { statusCode?: number } | null)?.statusCode ?? 500;
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      if (status >= 500) request.log.error({ message });
      reply.code(status).send({ error: message, ...(error instanceof OrchestrationError ? { code: error.code } : {}) });
    });
    managed.get<{ Params: { runId: string } }>('/api/accounts/business/:runId', async req => getBusinessState(req.params.runId));
    managed.get<{ Params: { runId: string } }>('/api/accounts/business/:runId/evidence', async req => ({ choices: listBusinessEvidence(req.params.runId) }));
    managed.get<{ Params: { runId: string } }>('/api/accounts/business/:runId/history', async req => ({ events: businessHistory(req.params.runId) }));
    managed.post<{ Params: { runId: string }; Body: unknown }>('/api/accounts/business/:runId', async req => {
      const state = applyBusinessCommand(req.params.runId, req.body);
      if (acceptedBusinessGateRuns().includes(req.params.runId)) {
        // The ledger is the durable wake authorization; the scheduler deduplicates repeated requests.
        void resumeCoordinationRun(req.params.runId).catch(error => req.log.warn({ message: redactSecrets(String(error)) }, 'Stage wake stopped'));
      }
      return state;
    });
    managed.post<{ Params: { runId: string }; Body: unknown }>('/api/accounts/business/:runId/file-evidence', async req => businessFileEvidence(req.params.runId, req.body));
    managed.post<{ Params: { runId: string } }>('/api/accounts/business/:runId/continuation-preview', async req => previewRunContinuation(req.params.runId, true));
    managed.post<{ Params: { runId: string }; Body: unknown }>('/api/accounts/business/:runId/continuations', async (req, reply) => {
      const result = submitRunContinuation(req.params.runId, req.body, true);
      if (!result.deduplicated) enqueueConversationRun(result.run.id);
      reply.code(result.deduplicated ? 200 : 202); return result;
    });
    managed.post<{ Params: { runId: string }; Body: unknown }>('/api/accounts/business/:runId/rework-preview', async req => previewBusinessRework(req.params.runId, req.body, true));
    managed.post<{ Params: { runId: string }; Body: unknown }>('/api/accounts/business/:runId/reworks', async (req, reply) => {
      const result = submitBusinessRework(req.params.runId, req.body, true);
      if (!result.deduplicated) enqueueConversationRun(result.run.id);
      reply.code(result.deduplicated ? 200 : 202); return result;
    });
  });
}

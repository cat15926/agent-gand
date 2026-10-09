import type { FastifyInstance } from 'fastify';
import { assertManagementBoundary, requireManagementSession } from '../accounts/access.ts';
import { AccountError } from '../accounts/errors.ts';
import { redactSecrets } from '../accounts/secrets.ts';
import { applyBusinessCommand, businessFileEvidence, businessHistory, getBusinessState, listBusinessEvidence } from '../orchestration/business.ts';
import { OrchestrationError } from '../orchestration/normalize.ts';

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
    managed.post<{ Params: { runId: string }; Body: unknown }>('/api/accounts/business/:runId', async req => applyBusinessCommand(req.params.runId, req.body));
    managed.post<{ Params: { runId: string }; Body: unknown }>('/api/accounts/business/:runId/file-evidence', async req => businessFileEvidence(req.params.runId, req.body));
  });
}

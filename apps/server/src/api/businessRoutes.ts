import type { FastifyInstance } from 'fastify';
import { assertManagementBoundary, requireManagementSession } from '../accounts/access.ts';
import { AccountError } from '../accounts/errors.ts';
import { redactSecrets } from '../accounts/secrets.ts';
import { applyBusinessCommand, businessFileEvidence, businessHistory, getBusinessState, listBusinessEvidence } from '../orchestration/business.ts';
import { OrchestrationError, objectInput } from '../orchestration/normalize.ts';
import { acceptedBusinessGateRuns } from '../orchestration/businessGates.ts';
import { resumeCoordinationRun } from '../coordination/runtime.ts';
import { previewRunContinuation, submitRunContinuation } from '../orchestration/continuation.ts';
import { enqueueConversationRun } from '../conversations/dispatcher.ts';
import { previewBusinessRework, submitBusinessRework } from '../orchestration/businessRework.ts';
import { inspectBusinessRecovery, confirmBusinessRecovery, listBusinessRecoveryReviews } from '../orchestration/businessRecovery.ts';
import { costBudgetState, costRows } from '../orchestration/costBudget.ts';
import { getRun } from '../runs/trace.ts';

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
    managed.get<{ Params: { runId: string } }>('/api/accounts/business/:runId/cost-budget', async req => {
      if (!getRun(req.params.runId)) throw new OrchestrationError(404,'RUN_NOT_FOUND','任务不存在');
      return { budget: costBudgetState(req.params.runId), records: costRows(req.params.runId).slice(-100).map(r => ({ id: r.id, stageId: r.stage_id, agentId: r.agent_id, model: r.model, backend: r.backend, currency: r.currency, reserved: r.reserved / 1e6, known: r.known === null ? null : r.known / 1e6, status: r.status, costSource: r.cost_source, pricing: r.pricing ? JSON.parse(r.pricing) : null, sourceReservationId: r.source_reservation_id })) };
    });
    managed.get<{Params:{runId:string}}>('/api/accounts/business/:runId/recovery-reviews',async req=>({reviews:listBusinessRecoveryReviews(req.params.runId)}));
    managed.post<{Params:{runId:string}}>('/api/accounts/business/:runId/recovery-inspection',async req=>{if(Object.keys(objectInput(req.body)).length)throw new OrchestrationError(400,'INVALID_REQUEST','核对范围由来源任务确定，不能自行指定权限');return inspectBusinessRecovery(req.params.runId);});
    managed.post<{Params:{runId:string};Body:unknown}>('/api/accounts/business/:runId/recovery-reviews',async req=>confirmBusinessRecovery(req.params.runId,req.body,true));
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

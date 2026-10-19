/** Legacy transports never grant access to Threaded records, even through derived IDs. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerEvent } from '@agent-gand/shared';
import { get } from '../db/database.ts';

export class ThreadedLegacyBoundaryError extends Error {
  readonly status = 404;
  readonly statusCode = 404;
  readonly code = 'RESOURCE_NOT_FOUND';
  constructor() { super('此入口不存在该资源'); }
}

export function isThreadedConversation(id: string | null | undefined): boolean {
  if (!id) return false;
  return !!get(`SELECT 1 FROM conversations c WHERE c.id=? AND
    (c.mode='threaded' OR EXISTS (SELECT 1 FROM threaded_threads t WHERE t.conversation_id=c.id))`, id);
}

export function isThreadedRun(id: string | null | undefined): boolean {
  if (!id) return false;
  return !!get(`SELECT 1 FROM runs r WHERE r.id=? AND
    (r.mode='threaded' OR EXISTS (SELECT 1 FROM threaded_run_bindings b WHERE b.run_id=r.id)
      OR EXISTS (SELECT 1 FROM conversations c WHERE c.id=r.conversation_id AND c.mode='threaded')
      OR EXISTS (SELECT 1 FROM threaded_threads t WHERE t.conversation_id=r.conversation_id))`, id);
}

const runTables = {
  taskId: 'tasks', approvalId: 'approvals', dispatchId: 'collaboration_dispatches',
  decisionId: 'collaboration_user_decisions', subjectId: 'runtime_subjects',
  spanId: 'run_events', executionId: 'external_agent_executions',
  snapshotId: 'artifact_snapshots', planId: 'coordination_plans',
  releasePolicyId: 'information_release_policies', releaseGrantId: 'information_release_grants',
  autonomousDecisionId: 'autonomous_decision_proposals',
} as const;

function derivedRun(key: keyof typeof runTables, id: string): string | undefined {
  return get<{ run_id: string }>(`SELECT run_id FROM ${runTables[key]} WHERE id=?`, id)?.run_id;
}

/** Inspect typed references, never search arbitrary message text for IDs. */
export function hasThreadedReference(value: unknown): boolean {
  const pending = [value];
  const visited = new Set<object>();
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object' || visited.has(node)) continue;
    visited.add(node);
    if (Array.isArray(node)) { pending.push(...node); continue; }
    const item = node as Record<string, unknown>;
    if (item.mode === 'threaded' || item.origin === 'threaded_invocation_attempt' || typeof item.threadId === 'string') return true;
    for (const [key, field] of Object.entries(item)) {
      if (typeof field === 'string') {
        if (['runId', 'run_id', 'sourceRunId', 'targetRunId', 'parentRunId', 'revisionRunId', 'linkedRunId', 'executionRunId', 'run.id'].includes(key) && isThreadedRun(field)) return true;
        if (['conversationId', 'conversation_id', 'roomId'].includes(key) && isThreadedConversation(field)) return true;
        if (Object.hasOwn(runTables, key) && isThreadedRun(derivedRun(key as keyof typeof runTables, field))) return true;
        if (key === 'runIds' && field.split(',').some(isThreadedRun)) return true;
      }
      if (key === 'runIds' && Array.isArray(field) && field.some(id => typeof id === 'string' && isThreadedRun(id))) return true;
      if (typeof field === 'object') pending.push(field);
    }
  }
  return false;
}

function assertDerivedRoute(route: string, params: Record<string, unknown>): void {
  const id = typeof params.id === 'string' ? params.id : undefined;
  if (!id) return;
  const reject = (forbidden: boolean) => { if (forbidden) throw new ThreadedLegacyBoundaryError(); };
  if (route.startsWith('/api/runs/:id')) reject(isThreadedRun(id));
  else if (route.startsWith('/api/conversations/:id')) reject(isThreadedConversation(id));
  else if (route.startsWith('/api/tasks/:id')) reject(isThreadedRun(derivedRun('taskId', id)));
  else if (route.startsWith('/api/approvals/:id')) reject(isThreadedRun(derivedRun('approvalId', id)));
  else if (route.startsWith('/api/collaboration/dispatches/:id')) reject(isThreadedRun(derivedRun('dispatchId', id)));
  else if (route.startsWith('/api/coordination/plans/:id')) reject(isThreadedRun(derivedRun('planId', id)));
  else if (route.startsWith('/api/accounts/artifact-snapshots/:id')) reject(isThreadedRun(derivedRun('snapshotId', id)));
  else if (route.startsWith('/api/accounts/information-release-policies/:id')) reject(isThreadedRun(derivedRun('releasePolicyId', id)));
  else if (route.startsWith('/api/accounts/information-releases/grants/:id')) reject(isThreadedRun(derivedRun('releaseGrantId', id)));
  else if (route.startsWith('/api/accounts/autonomous-collaboration/decisions/:id')) reject(isThreadedRun(derivedRun('autonomousDecisionId', id)));
  else if (route.startsWith('/api/accounts/artifacts/:id')) {
    const artifact = get<{ conversation_id: string; run_id: string }>('SELECT conversation_id,run_id FROM managed_artifact_versions WHERE id=?', id);
    reject(!!artifact && (isThreadedConversation(artifact.conversation_id) || isThreadedRun(artifact.run_id)));
  } else {
    // These legacy documents have indirect run references in their frozen JSON.
    const table = route.startsWith('/api/coordination/drafts/:id') ? 'coordination_drafts'
      : route.startsWith('/api/coordination/capability-snapshots/:id') ? 'capability_snapshots' : null;
    if (table) {
      const row = get<{ payload: string }>(`SELECT payload FROM ${table} WHERE id=?`, id);
      if (row) { try { reject(hasThreadedReference(JSON.parse(row.payload))); } catch (error) { if (error instanceof ThreadedLegacyBoundaryError) throw error; } }
    }
  }
}

export function assertLegacyRequest(request: FastifyRequest): void {
  const route = request.routeOptions.url ?? '';
  if (route.startsWith('/api/threaded/') || route.startsWith('/api/accounts/threaded/')) return;
  assertDerivedRoute(route, (request.params ?? {}) as Record<string, unknown>);
  if ([request.params, request.query, request.body].some(hasThreadedReference)) throw new ThreadedLegacyBoundaryError();
}

export function registerLegacyThreadedBoundary(app: FastifyInstance): void {
  app.addHook('preHandler', async request => assertLegacyRequest(request));
  // Defence in depth for nested projections. Collections are filtered by their route.
  app.addHook('preSerialization', async (request, reply, payload) => {
    const route = request.routeOptions.url ?? '';
    if (route.startsWith('/api/threaded/') || route.startsWith('/api/accounts/threaded/')) return payload;
    if (reply.statusCode < 400 && hasThreadedReference(payload)) throw new ThreadedLegacyBoundaryError();
    return payload;
  });
}

/** New event kinds must opt into a transport explicitly; unknown events are not public. */
export function isLegacyEvent(event: ServerEvent): boolean {
  switch (event.type) {
    case 'agent.updated': case 'account.updated': case 'account.revoked': case 'account.login.updated':
    case 'message': case 'conversation.updated': case 'task.updated': case 'task.attempt.updated': case 'review.updated':
    case 'scheduler.updated': case 'collaboration.dispatch.updated': case 'collaboration.attempt.updated':
    case 'collaboration.batch.updated': case 'collaboration.decision.updated': case 'runtime.completion_candidate.updated':
    case 'runtime.action_command.committed': case 'runtime.evidence_bundle.updated': case 'runtime.route_guard.updated':
    case 'runtime.shadow_comparison.recorded': case 'runtime.hold.updated': case 'runtime.hold_recovery.recorded':
    case 'runtime.wake_event.recorded': case 'runtime.successor_obligation.updated': case 'collaboration.scheduler.updated':
    case 'coordination.step.updated': case 'run.updated': case 'run.event': case 'llm.delta': case 'llm.snapshot':
    case 'execution.updated': case 'execution.native': case 'approval.updated': case 'usage':
      return !hasThreadedReference(event);
    default: return false;
  }
}

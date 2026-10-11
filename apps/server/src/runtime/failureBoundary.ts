import { randomUUID } from 'node:crypto';
import { afterCommit, all, get, run } from '../db/database.ts';
import { getEvent } from '../runs/trace.ts';
import { emit } from '../messaging/bus.ts';

/** Capture the failed scopes seen by the terminal transaction, before later cleanup can obscure them. */
export function recordFailureBoundary(runId: string, source: string, status: 'failed' | 'cancelled'): void {
  const causes: string[] = [];
  const openScopes: string[] = [];
  if (status === 'failed') {
    for (const row of all<{ id: string }>("SELECT id FROM collaboration_dispatches WHERE run_id=? AND status IN ('failed','blocked')", runId)) causes.push(`dispatch:${row.id}`);
    const plan = get<{ id: string; revision: number }>('SELECT id,revision FROM coordination_plans WHERE run_id=?', runId);
    if (plan) for (const row of all<{ step_id: string }>("SELECT step_id FROM coordination_step_states WHERE plan_id=? AND revision=? AND status='failed'", plan.id, plan.revision)) causes.push(`step:${plan.id}:${plan.revision}:${row.step_id}`);
    for (const row of all<{ id: string }>("SELECT id FROM tasks WHERE run_id=? AND status='failed'", runId)) causes.push(`task:${row.id}`);
  }
  for (const row of all<{ id: string }>("SELECT id FROM collaboration_dispatches WHERE run_id=? AND status NOT IN ('failed','blocked','completed','cancelled')", runId)) openScopes.push(`dispatch:${row.id}`);
  const openPlan = get<{ id: string; revision: number }>('SELECT id,revision FROM coordination_plans WHERE run_id=?', runId);
  if (openPlan) for (const row of all<{ step_id: string }>("SELECT step_id FROM coordination_step_states WHERE plan_id=? AND revision=? AND status NOT IN ('failed','completed')", openPlan.id, openPlan.revision)) openScopes.push(`step:${openPlan.id}:${openPlan.revision}:${row.step_id}`);
  for (const row of all<{ id: string }>("SELECT id FROM tasks WHERE run_id=? AND status NOT IN ('failed','completed','cancelled')", runId)) openScopes.push(`task:${row.id}`);
  const id = randomUUID(), at = new Date().toISOString();
  // Metadata only: no failed prompt, tool input, summary, or credentials in the boundary.
  run(`INSERT INTO run_events(id,run_id,parent_id,span_kind,name,input,output,status,attributes,started_at,ended_at)
    VALUES(?,?,NULL,'orchestration','failure:terminal_boundary',NULL,NULL,'ok',?,?,?)`,
  id, runId, JSON.stringify({ 'observability.version': 1, 'run.id': runId, 'failure.version': 1,
    'failure.terminal_status': status, 'failure.source': source, 'failure.failed_scopes': causes, 'failure.open_scopes': openScopes }), at, at);
  afterCommit(() => {
    const event = getEvent(runId, id);
    if (event) emit({ type: 'run.event', event });
  });
}

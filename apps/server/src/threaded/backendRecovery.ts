import type Database from 'better-sqlite3';
import { hostname } from 'node:os';
import type { ThreadedBinding } from '@agent-gand/shared';
import { ThreadedAuthorityError, type ThreadedAuthority } from './contracts.ts';
import { createThreadedContext } from './context.ts';
import { createThreadedBackendEvidence, verifyThreadedBackendDelivery, verifyThreadedBackendUsage } from './backends/evidence.ts';
import { createThreadedBudget } from './budget.ts';
import { threadedProcessGroupStopped } from './backends/sdkProcess.ts';

type BindingRow = Record<string, string | number>;
const storedBinding = (row: BindingRow): ThreadedBinding => ({
  schemaVersion: 1, origin: 'threaded_invocation_attempt', id: String(row.id),
  ownerId: String(row.owner_id), threadId: String(row.thread_id), agentId: String(row.agent_id),
  invocationId: String(row.invocation_id), runId: String(row.run_id), attemptId: String(row.attempt_id),
  authorityEpoch: Number(row.authority_epoch), claimId: String(row.claim_id), generation: Number(row.generation),
  fencingToken: String(row.fencing_token),
});

/** Run after lifecycle has revoked interrupted epochs. Never invokes a transport or executor. */
export function recoverThreadedBackendFacts(db: Database.Database, authority: ThreadedAuthority, options: {
  budget?: Pick<ReturnType<typeof createThreadedBudget>, 'settleRequest'>;
  now?: () => number;
  /** Trusted local host inspection, never an API/model-supplied claim. Failure remains unknown. */
  processGroupStopped?: (pid: number) => boolean;
} = {}): { contextRepaired: number; requestUsageRepaired: number; processStopsRepaired: number } {
  if (db.inTransaction) throw new ThreadedAuthorityError('THREADED_BACKEND_RECOVERY_REQUIRES_OUTERMOST_TRANSACTION');
  const evidence = createThreadedBackendEvidence(db, { now: options.now });
  const budget = options.budget ?? createThreadedBudget(db, { authority, now: options.now,
    verifyUsage: (binding, authorization, usage) => verifyThreadedBackendUsage(db, binding, authorization, usage) });
  let requestUsageRepaired = 0, processStopsRepaired = 0;
  // Completion was persisted before usage settlement. Reapply only its immutable
  // exact receipt; this does not settle the Attempt, release a claim or recover output.
  const receipts = db.prepare(`SELECT r.binding_id,r.authorization_id,r.id,r.output_tokens,r.cost_microusd
    FROM threaded_backend_requests r WHERE r.state='complete' AND NOT EXISTS (
      SELECT 1 FROM threaded_budget_reconciliations c WHERE c.authorization_id=r.authorization_id
      AND c.request_id='request:threaded-backend-request:'||r.id) ORDER BY r.created_at,r.id`)
    .all() as Array<{ binding_id: string; authorization_id: string; id: string; output_tokens: number | null; cost_microusd: number | null }>;
  for (const receipt of receipts) db.transaction(() => {
    if (db.prepare('SELECT 1 FROM threaded_budget_reconciliations WHERE authorization_id=? AND request_id=?')
      .get(receipt.authorization_id, `request:threaded-backend-request:${receipt.id}`)) return;
    const row = db.prepare('SELECT * FROM threaded_execution_bindings WHERE id=?').get(receipt.binding_id) as BindingRow | undefined;
    if (!row) return;
    budget.settleRequest(storedBinding(row), receipt.authorization_id, {
      ...(receipt.output_tokens === null ? {} : { outputTokens: receipt.output_tokens }),
      ...(receipt.cost_microusd === null ? {} : { costMicrousd: receipt.cost_microusd }),
      evidenceReference: `threaded-backend-request:${receipt.id}`,
    });
    requestUsageRepaired++;
  }).immediate();
  // A persisted original close callback plus a current same-host group check
  // can complete the local process fact. PID absence alone cannot repair registered.
  const stopped = options.processGroupStopped ?? threadedProcessGroupStopped;
  const processes = db.prepare("SELECT token,pid FROM threaded_backend_processes WHERE state='closed' AND host=?")
    .all(hostname()) as Array<{ token: string; pid: number }>;
  for (const process of processes) {
    let verified = false;
    try { verified = stopped(process.pid) === true; } catch { /* Inspection failure is not a stop proof. */ }
    if (!verified) continue;
    db.transaction(() => {
      const current = db.prepare("SELECT 1 FROM threaded_backend_processes WHERE token=? AND pid=? AND host=? AND state='closed'")
        .get(process.token, process.pid, hostname());
      if (!current) return;
      evidence.confirmProcessStopped(process.token); processStopsRepaired++;
    }).immediate();
  }
  const context = createThreadedContext(db, { authority, now: options.now,
    verifyDeliveryEvidence: (binding, manifest, _intent, outcome) => verifyThreadedBackendDelivery(db, binding, manifest, outcome) });
  const interrupted = db.prepare(`SELECT r.id FROM threaded_backend_requests r JOIN threaded_attempts a
    ON a.id=r.attempt_id WHERE r.state='sending' AND a.execution_stage='unknown'`).all() as Array<{ id: string }>;
  for (const row of interrupted) evidence.unknown(row.id);
  let repaired = 0;
  for (const intent of context.listPendingSends()) {
    const row = db.prepare('SELECT * FROM threaded_execution_bindings WHERE id=?').get(intent.bindingId) as
      Record<string, string | number> | undefined;
    if (!row) continue;
    const binding = storedBinding(row);
    const receipt = db.prepare(`SELECT id,state,delivered,native_id FROM threaded_backend_requests
      WHERE binding_id=? AND manifest_id=? AND payload_hash=? AND state IN ('complete','unknown')
      ORDER BY delivered DESC,created_at,id LIMIT 1`).get(binding.id, intent.manifestId, intent.payloadHash) as {
        id: string; state: string; delivered: number; native_id: string | null;
      } | undefined;
    if (!receipt) continue;
    const reference = `threaded-backend-request:${receipt.id}`;
    context.recordDeliveryOutcome(binding, { intentId: intent.id,
      status: receipt.state === 'complete' && receipt.delivered ? 'delivered' : 'unknown',
      evidence: { key: reference, reference, nativeId: receipt.native_id } });
    repaired++;
  }
  return { contextRepaired: repaired, requestUsageRepaired, processStopsRepaired };
}

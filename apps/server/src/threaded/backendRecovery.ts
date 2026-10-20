import type Database from 'better-sqlite3';
import type { ThreadedBinding } from '@agent-gand/shared';
import type { ThreadedAuthority } from './contracts.ts';
import { createThreadedContext } from './context.ts';
import { createThreadedBackendEvidence, verifyThreadedBackendDelivery } from './backends/evidence.ts';

/** Run after lifecycle has revoked interrupted epochs. No transport, process or executor is loaded. */
export function recoverThreadedBackendFacts(db: Database.Database, authority: ThreadedAuthority): { contextRepaired: number } {
  const evidence = createThreadedBackendEvidence(db);
  const context = createThreadedContext(db, { authority,
    verifyDeliveryEvidence: (binding, manifest, _intent, outcome) => verifyThreadedBackendDelivery(db, binding, manifest, outcome) });
  const interrupted = db.prepare(`SELECT r.id FROM threaded_backend_requests r JOIN threaded_attempts a
    ON a.id=r.attempt_id WHERE r.state='sending' AND a.execution_stage='unknown'`).all() as Array<{ id: string }>;
  for (const row of interrupted) evidence.unknown(row.id);
  let repaired = 0;
  for (const intent of context.listPendingSends()) {
    const row = db.prepare('SELECT * FROM threaded_execution_bindings WHERE id=?').get(intent.bindingId) as
      Record<string, string | number> | undefined;
    if (!row) continue;
    const binding: ThreadedBinding = { schemaVersion: 1, origin: 'threaded_invocation_attempt', id: String(row.id),
      ownerId: String(row.owner_id), threadId: String(row.thread_id), agentId: String(row.agent_id),
      invocationId: String(row.invocation_id), runId: String(row.run_id), attemptId: String(row.attempt_id),
      authorityEpoch: Number(row.authority_epoch), claimId: String(row.claim_id), generation: Number(row.generation),
      fencingToken: String(row.fencing_token) };
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
  return { contextRepaired: repaired };
}

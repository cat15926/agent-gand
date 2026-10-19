import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ResourceClaimRecord, ResourceEvidence } from './types.ts';

// Only the actual provider promise can mark this receipt settled. Abort/timeout of
// its caller is deliberately insufficient; these receipts disappear on restart.
const providerReceipts = new Map<string, { runId: string; agentId: string; callId: string; settled: boolean }>();
export function beginLegacyProviderEvidence(runId: string, agentId: string, callId: string) {
  const reference = `legacy-provider:${randomUUID()}`;
  providerReceipts.set(reference, { runId, agentId, callId, settled: false });
  return { reference, settle() { const receipt = providerReceipts.get(reference); if (receipt) receipt.settled = true; },
    forget() { providerReceipts.delete(reference); } };
}

/** No credential or model data is read when checking a native execution fence. */
export function legacyNativeQuiescent(db: Database.Database, executionId: string, runId: string, agentId: string): boolean {
  const row = db.prepare('SELECT run_id,agent_id,record FROM external_agent_executions WHERE id=?').get(executionId) as
    { run_id: string; agent_id: string; record: string } | undefined;
  if (!row || row.run_id !== runId || row.agent_id !== agentId) return false;
  const record = JSON.parse(row.record);
  if (record.recovery?.state === 'attention') return false;
  if (db.prepare("SELECT 1 FROM external_native_processes WHERE execution_id=? AND status='active'").get(executionId)) return false;
  if (!record.progress?.nativeInvokedAt) return true;
  return record.recovery?.state === 'quiesced' || record.processOwnership === 'guardian-v1'
    && !!db.prepare("SELECT 1 FROM external_native_processes WHERE execution_id=? AND status='stopped'").get(executionId);
}

/** Pure verifier used by the shared coordinator; references alone grant nothing. */
export function verifyLegacyResourceEvidence(db: Database.Database, claim: ResourceClaimRecord, evidence: ResourceEvidence): boolean {
  if (claim.request.mode !== 'legacy') return false;
  if (evidence.reference?.startsWith('legacy-provider:')) {
    const receipt = providerReceipts.get(evidence.reference);
    return !!receipt?.settled && receipt.runId === claim.identity.runId && receipt.agentId === claim.identity.agentId
      && receipt.callId === claim.request.operationId && evidence.reason === 'process_exited' && evidence.sideEffects === 'reconciled';
  }
  if (evidence.reference?.startsWith('legacy-native:')) {
    const executionId = evidence.reference.slice('legacy-native:'.length);
    return claim.request.legacyExecutionId === executionId
      && legacyNativeQuiescent(db, executionId, claim.identity.runId, claim.identity.agentId)
      && evidence.sideEffects === 'reconciled';
  }
  // Preparation reservations own no provider request. Their children must have
  // released first (the coordinator independently enforces this at release).
  return evidence.reference === 'legacy-preparation' && claim.request.capacity === false
    && evidence.reason === 'not_started' && evidence.sideEffects === 'none';
}

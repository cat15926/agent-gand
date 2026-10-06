import type { RunOrchestrationSnapshot } from '@agent-gand/shared';
import { get, run } from '../db/database.ts';

export function getRunOrchestrationSnapshot(runId: string): RunOrchestrationSnapshot | null {
  const row = get<{ snapshot: string }>('SELECT snapshot FROM orchestration_requests WHERE run_id=?', runId);
  return row ? JSON.parse(row.snapshot) as RunOrchestrationSnapshot : null;
}

export function getSubmissionSnapshot(scope: string, clientRequestId: string | null): RunOrchestrationSnapshot | null {
  if (!clientRequestId) return null;
  const row = get<{ snapshot: string }>('SELECT snapshot FROM orchestration_requests WHERE idempotency_scope=? AND client_request_id=?', scope, clientRequestId);
  return row ? JSON.parse(row.snapshot) as RunOrchestrationSnapshot : null;
}

export function saveSubmissionSnapshot(scope: string, snapshot: RunOrchestrationSnapshot): void {
  run(`INSERT INTO orchestration_requests (id,schema_version,idempotency_scope,client_request_id,conversation_id,run_id,submission_digest,snapshot,created_at)
    VALUES (?,1,?,?,?,?,?,?,?)`, snapshot.requestId, scope, snapshot.request.clientRequestId, snapshot.conversationId, snapshot.runId, snapshot.submissionDigest, JSON.stringify(snapshot), snapshot.createdAt);
}

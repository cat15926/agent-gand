import { randomUUID } from 'node:crypto';
import type {
  RuntimeCompletionEvaluation, RuntimeCompletionInput, RuntimeCompletionSubject, RuntimeRunContract,
} from '@agent-gand/shared';
import { all, get, run } from '../db/database.ts';
import { resolveEvidence, runtimeEvidenceBundleVersion, validateEvidenceBundle } from './evidence.ts';
import { normalizeRuntimeControlAction } from './controlAction.ts';
import { requiredSuccessorObligationsSatisfied } from './obligations.ts';

interface SubjectRow {
  id: string; subject_key: string; status: RuntimeCompletionSubject['status'];
  custody_state: string; holder_agent_id: string | null; pending_holder_agent_id: string | null; generation: number;
}
interface OutputRow { id: string; output: string | null; control_action: string | null; kind: string; agent_id: string; }
interface CandidateOutputRow { id: string; attempt_id: string; summary: string; evidence_refs: string; evidence_bundle_id: string | null; agent_id: string; }
interface PartialOutputRow { subject_key: string | null; dispatch_id: string; output: string; agent_id: string; }
interface CapsuleRow { payload: string; }

export interface CompletionSnapshot {
  input: RuntimeCompletionInput;
  reportParts: Array<{ subjectKey: string; agentId: string; output: string }>;
  /**
   * Only used by the explicit partial_user_accepted disposition. Normal completion must never
   * promote these unaccepted attempt outputs into the final report.
   */
  partialReportParts: Array<{ subjectKey: string; agentId: string; output: string }>;
}

export function isCompletionEngineRun(runId: string): boolean {
  const contractRow = get<{ payload: string }>('SELECT payload FROM runtime_contracts WHERE run_id=?', runId);
  if (!contractRow) return false;
  try { return (JSON.parse(contractRow.payload) as RuntimeRunContract).features?.completionEngine === true; }
  catch { return false; }
}

export function loadCompletionSnapshot(runId: string): CompletionSnapshot | null {
  const contractRow = get<{ payload: string }>('SELECT payload FROM runtime_contracts WHERE run_id=?', runId);
  if (!contractRow) return null;
  const contract = JSON.parse(contractRow.payload) as RuntimeRunContract;
  const candidateOwned = contract.features?.completionCandidateVersion === 1;
  const rows = all<SubjectRow>(`SELECT s.id,s.subject_key,s.status,c.state custody_state,c.holder_agent_id,
    c.pending_holder_agent_id,c.generation FROM runtime_subjects s
    JOIN runtime_custody c ON c.subject_id=s.id WHERE s.run_id=? ORDER BY s.created_at,s.rowid`, runId);
  const reportParts: CompletionSnapshot['reportParts'] = [];
  const subjects = rows.map((row): RuntimeCompletionSubject => {
    const acceptedCandidate = candidateOwned ? get<CandidateOutputRow>(`SELECT id,attempt_id,summary,evidence_refs,evidence_bundle_id,agent_id
      FROM runtime_completion_candidates WHERE subject_id=? AND status='accepted' ORDER BY decided_at DESC,rowid DESC LIMIT 1`, row.id) : undefined;
    const outputs = candidateOwned ? [] : all<OutputRow>(`SELECT a.id,a.output,a.control_action,d.kind,a.agent_id FROM collaboration_attempts a
      JOIN collaboration_dispatches d ON d.id=a.dispatch_id
      JOIN runtime_dispatch_subjects m ON m.dispatch_id=d.id
      WHERE m.subject_id=? AND a.status='completed' ORDER BY a.ended_at DESC,a.rowid DESC`, row.id);
    const legacyOutput = outputs.find((item) => {
      if (!item.output?.trim()) return false;
      if (row.subject_key.startsWith('consult:')) return true;
      if (!item.control_action) return false;
      try {
        const normalized = normalizeRuntimeControlAction(JSON.parse(item.control_action));
        return normalized.ok && (normalized.action.type === 'complete' || normalized.action.type === 'answer_candidate');
      }
      catch { return false; }
    });
    const finalOutput = acceptedCandidate?.summary.trim() || legacyOutput?.output?.trim() || '';
    const finalAgentId = acceptedCandidate?.agent_id ?? legacyOutput?.agent_id;
    if (finalOutput && finalAgentId && contract.requiredSubjectKeys.includes(row.subject_key)) {
      reportParts.push({ subjectKey: row.subject_key, agentId: finalAgentId, output: finalOutput });
    }
    const capsules = all<CapsuleRow>(`SELECT hc.payload FROM runtime_handoff_capsules hc
      JOIN runtime_dispatch_subjects m ON m.dispatch_id=hc.dispatch_id
      WHERE m.subject_id=? AND hc.version=(SELECT MAX(version) FROM runtime_handoff_capsules WHERE dispatch_id=hc.dispatch_id)`, row.id);
    const candidateEvidence = acceptedCandidate
      ? JSON.parse(acceptedCandidate.evidence_refs) as Parameters<typeof resolveEvidence>[1][] : [];
    const bundledEvidence = runtimeEvidenceBundleVersion(runId) === 1;
    const outputEvidenceValid = candidateOwned
      ? Boolean(acceptedCandidate && finalOutput && (bundledEvidence
        ? acceptedCandidate.evidence_bundle_id && validateEvidenceBundle(acceptedCandidate.evidence_bundle_id, runId).valid
        : candidateEvidence.length > 0 && candidateEvidence.every((ref) => resolveEvidence(runId, ref).trusted)))
      : Boolean(legacyOutput && resolveEvidence(runId, { kind: 'attempt_output', id: legacyOutput.id }).trusted);
    const capsuleEvidenceValid = capsules.every((capsule) => {
      try {
        const value = JSON.parse(capsule.payload) as { evidenceRefs?: Parameters<typeof resolveEvidence>[1][]; evidenceBundleId?: string };
        if (bundledEvidence) return Boolean(value.evidenceBundleId && validateEvidenceBundle(value.evidenceBundleId, runId).valid);
        return (value.evidenceRefs ?? []).every((ref) => resolveEvidence(runId, ref).trusted);
      } catch { return false; }
    });
    return {
      key: row.subject_key, required: contract.requiredSubjectKeys.includes(row.subject_key), status: row.status,
      custodyState: row.custody_state, holderAgentId: row.holder_agent_id,
      pendingHolderAgentId: row.pending_holder_agent_id, generation: row.generation,
      hasOutput: finalOutput.length > 0, evidenceValid: outputEvidenceValid && capsuleEvidenceValid,
    };
  });
  const dispatches = all<{ id: string; status: RuntimeCompletionInput['dispatches'][number]['status']; error: string | null }>(
    'SELECT id,status,error FROM collaboration_dispatches WHERE run_id=? ORDER BY created_at,rowid', runId);
  const pendingDecisions = get<{ n: number }>("SELECT COUNT(*) n FROM collaboration_user_decisions WHERE run_id=? AND status='pending'", runId)?.n ?? 0;
  const batchStatuses = all<{ status: string }>('SELECT status FROM collaboration_batches WHERE run_id=?', runId).map((item) => item.status);
  const partialReportParts = candidateOwned
    ? [...new Map(all<PartialOutputRow>(`SELECT s.subject_key,a.dispatch_id,a.output,a.agent_id
        FROM collaboration_attempts a
        LEFT JOIN runtime_dispatch_subjects m ON m.dispatch_id=a.dispatch_id
        LEFT JOIN runtime_subjects s ON s.id=m.subject_id
        WHERE a.run_id=? AND a.status='completed' AND TRIM(COALESCE(a.output,''))<>''
        ORDER BY a.ended_at ASC,a.rowid ASC`, runId)
      .map((item) => [item.subject_key ?? `dispatch:${item.dispatch_id}`, {
        subjectKey: item.subject_key ?? `dispatch:${item.dispatch_id}`,
        agentId: item.agent_id,
        output: item.output.trim(),
      }] as const)).values()]
    : reportParts;
  const hasAnyOutput = candidateOwned
    ? reportParts.length > 0 || partialReportParts.length > 0
      || Boolean(get("SELECT 1 FROM messages WHERE run_id=? AND kind='agent' AND TRIM(body)<>'' LIMIT 1", runId))
    : Boolean(get('SELECT 1 FROM collaboration_attempts WHERE run_id=? AND status=\'completed\' AND TRIM(COALESCE(output,\'\'))<>\'\' LIMIT 1', runId)
      ?? get("SELECT 1 FROM messages WHERE run_id=? AND kind='agent' AND TRIM(body)<>'' LIMIT 1", runId));
  return { input: { contract, subjects, dispatches, pendingDecisions, batchStatuses, hasAnyOutput,
    dependenciesSatisfied: true, requiredArtifactsSatisfied: true, reviewAccepted: true, protocolTerminal: true,
    successorObligationsSatisfied: requiredSuccessorObligationsSatisfied(runId, rows.map((row) => row.id)) },
  reportParts, partialReportParts };
}

export function recordCompletionEvaluation(runId: string, evaluation: RuntimeCompletionEvaluation, input: RuntimeCompletionInput): void {
  const last = get<{ seq: number; status: string; reasons: string; disposition: string }>(
    'SELECT seq,status,reasons,disposition FROM runtime_completion_evaluations WHERE run_id=? ORDER BY seq DESC LIMIT 1', runId);
  const reasons = JSON.stringify(evaluation.reasons);
  const disposition = evaluation.status === 'accepted' ? evaluation.disposition : input.disposition ?? 'normal';
  if (last?.status === evaluation.status && last.reasons === reasons && last.disposition === disposition) return;
  run(`INSERT INTO runtime_completion_evaluations (id,run_id,seq,status,reasons,disposition,snapshot,created_at)
    VALUES (?,?,?,?,?,?,?,?)`, randomUUID(), runId, (last?.seq ?? 0) + 1, evaluation.status,
    reasons, disposition, JSON.stringify(input), new Date().toISOString());
}

export function listCompletionEvaluations(runId: string): Array<{
  seq: number; status: string; reasons: string[]; disposition: string; createdAt: string;
}> {
  return all<{ seq: number; status: string; reasons: string; disposition: string; created_at: string }>(
    'SELECT seq,status,reasons,disposition,created_at FROM runtime_completion_evaluations WHERE run_id=? ORDER BY seq', runId)
    .map((row) => ({ seq: row.seq, status: row.status, reasons: JSON.parse(row.reasons) as string[],
      disposition: row.disposition, createdAt: row.created_at }));
}

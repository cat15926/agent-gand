import { randomUUID } from 'node:crypto';
import type {
  RuntimeCompletionEvaluation, RuntimeCompletionInput, RuntimeCompletionSubject, RuntimeRunContract,
} from '@agent-gand/shared';
import { all, get, run } from '../db/database.ts';
import { resolveEvidence } from './evidence.ts';

interface SubjectRow {
  id: string; subject_key: string; status: RuntimeCompletionSubject['status'];
  custody_state: string; holder_agent_id: string | null; pending_holder_agent_id: string | null; generation: number;
}
interface OutputRow { output: string | null; control_action: string | null; kind: string; agent_id: string; }
interface CapsuleRow { payload: string; }

export interface CompletionSnapshot {
  input: RuntimeCompletionInput;
  reportParts: Array<{ subjectKey: string; agentId: string; output: string }>;
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
  const rows = all<SubjectRow>(`SELECT s.id,s.subject_key,s.status,c.state custody_state,c.holder_agent_id,
    c.pending_holder_agent_id,c.generation FROM runtime_subjects s
    JOIN runtime_custody c ON c.subject_id=s.id WHERE s.run_id=? ORDER BY s.created_at,s.rowid`, runId);
  const reportParts: CompletionSnapshot['reportParts'] = [];
  const subjects = rows.map((row): RuntimeCompletionSubject => {
    const outputs = all<OutputRow>(`SELECT a.output,a.control_action,d.kind,a.agent_id FROM collaboration_attempts a
      JOIN collaboration_dispatches d ON d.id=a.dispatch_id
      JOIN runtime_dispatch_subjects m ON m.dispatch_id=d.id
      WHERE m.subject_id=? AND a.status='completed' ORDER BY a.ended_at DESC,a.rowid DESC`, row.id);
    const finalOutput = outputs.find((item) => {
      if (!item.output?.trim()) return false;
      if (row.subject_key.startsWith('consult:')) return true;
      if (!item.control_action) return false;
      try { return ['finish', 'implicit_complete'].includes((JSON.parse(item.control_action) as { type?: string }).type ?? ''); }
      catch { return false; }
    });
    if (finalOutput && contract.requiredSubjectKeys.includes(row.subject_key)) {
      reportParts.push({ subjectKey: row.subject_key, agentId: finalOutput.agent_id, output: finalOutput.output!.trim() });
    }
    const capsules = all<CapsuleRow>(`SELECT hc.payload FROM runtime_handoff_capsules hc
      JOIN runtime_dispatch_subjects m ON m.dispatch_id=hc.dispatch_id
      WHERE m.subject_id=? AND hc.version=(SELECT MAX(version) FROM runtime_handoff_capsules WHERE dispatch_id=hc.dispatch_id)`, row.id);
    const evidenceValid = capsules.every((capsule) => {
      try {
        const refs = (JSON.parse(capsule.payload) as { evidenceRefs?: Parameters<typeof resolveEvidence>[1][] }).evidenceRefs ?? [];
        return refs.every((ref) => resolveEvidence(runId, ref).trusted);
      } catch { return false; }
    });
    return {
      key: row.subject_key, required: contract.requiredSubjectKeys.includes(row.subject_key), status: row.status,
      custodyState: row.custody_state, holderAgentId: row.holder_agent_id,
      pendingHolderAgentId: row.pending_holder_agent_id, generation: row.generation,
      hasOutput: Boolean(finalOutput), evidenceValid,
    };
  });
  const dispatches = all<{ id: string; status: RuntimeCompletionInput['dispatches'][number]['status']; error: string | null }>(
    'SELECT id,status,error FROM collaboration_dispatches WHERE run_id=? ORDER BY created_at,rowid', runId);
  const pendingDecisions = get<{ n: number }>("SELECT COUNT(*) n FROM collaboration_user_decisions WHERE run_id=? AND status='pending'", runId)?.n ?? 0;
  const batchStatuses = all<{ status: string }>('SELECT status FROM collaboration_batches WHERE run_id=?', runId).map((item) => item.status);
  const hasAnyOutput = Boolean(get('SELECT 1 FROM collaboration_attempts WHERE run_id=? AND status=\'completed\' AND TRIM(COALESCE(output,\'\'))<>\'\' LIMIT 1', runId)
    ?? get("SELECT 1 FROM messages WHERE run_id=? AND kind='agent' AND TRIM(body)<>'' LIMIT 1", runId));
  return { input: { contract, subjects, dispatches, pendingDecisions, batchStatuses, hasAnyOutput,
    dependenciesSatisfied: true, requiredArtifactsSatisfied: true, reviewAccepted: true, protocolTerminal: true }, reportParts };
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

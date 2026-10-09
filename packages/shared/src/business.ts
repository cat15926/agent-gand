import type { RuntimeEvidenceRef, RuntimeEvidenceResolution } from './runtime.ts';

/** Per-task, owner-defined acceptance. Does not change execution scheduling. */
export interface BusinessContract {
  version: 1;
  stages: BusinessStage[];
}
export interface BusinessStage {
  id: string;
  title: string;
  criteria: string[];
  deliverables: Array<{ id: string; title: string; kind: 'text' | 'file' }>;
}
export type BusinessOutcome = 'unverified' | 'in_progress' | 'awaiting_acceptance' | 'achieved' | 'not_achieved' | 'partial_accepted' | 'user_ended';
export interface BusinessReport {
  id: string;
  stageId: string;
  kind: 'receipt' | 'delivery';
  note: string;
  evidence: Array<{ deliverableId: string; resolution: RuntimeEvidenceResolution }>;
  createdAt: string;
}
export interface BusinessDecision {
  reportId: string;
  verdict: 'accept' | 'reject';
  checkedCriteria: number[];
  reason: string;
  createdAt: string;
}
export interface BusinessState {
  runId: string;
  version: number;
  contract: BusinessContract | null;
  outcome: BusinessOutcome;
  settled: boolean;
  stages: Array<{ stage: BusinessStage; status: 'pending' | 'blocked' | 'acknowledged' | 'awaiting_acceptance' | 'rejected' | 'accepted'; report: BusinessReport | null; decision: BusinessDecision | null }>;
  resolution: { outcome: 'not_achieved' | 'partial_accepted' | 'user_ended'; reason: string; createdAt: string } | null;
}
export interface BusinessEvidenceChoice { ref: RuntimeEvidenceRef; label: string; excerpt: string }
export interface BusinessAuditEntry {
  id: string; version: number; createdAt: string; action: 'report' | 'decide' | 'resolve'; stageId?: string;
  report?: BusinessReport; decision?: BusinessDecision; resolution?: BusinessState['resolution'];
}
export type BusinessCommand = { expectedVersion: number; clientRequestId: string } & (
  | { action: 'report'; stageId: string; kind: 'receipt' | 'delivery'; note: string; evidence: Array<{ deliverableId: string; ref: RuntimeEvidenceRef }> }
  | { action: 'decide'; stageId: string; reportId: string; verdict: 'accept' | 'reject'; checkedCriteria: number[]; reason: string }
  | { action: 'resolve'; outcome: 'not_achieved' | 'partial_accepted' | 'user_ended'; reason: string }
);

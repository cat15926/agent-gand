import type { RuntimeEvidenceRef, RuntimeEvidenceResolution } from './runtime.ts';
import type { ArtifactSnapshot } from './artifacts.ts';

/** Owner-defined acceptance. Stage gating is explicitly opted into per task. */
export interface BusinessContract {
  version: 1;
  executionMode?: 'stage_gated';
  stages: BusinessStage[];
}
export interface BusinessStage {
  id: string;
  title: string;
  criteria: string[];
  deliverables: Array<{ id: string; title: string; kind: 'text' | 'file' }>;
  execution?: {
    assignments: Array<{ agentId: string; objective: string }>;
    timeoutMs?: number;
    /** Total output tokens across this stage's API requests, including tool rounds. */
    maxTokens?: number;
  };
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
  stages: Array<{ stage: BusinessStage; status: 'pending' | 'blocked' | 'acknowledged' | 'awaiting_acceptance' | 'rejected' | 'accepted'; report: BusinessReport | null; decision: BusinessDecision | null;
    execution?: { status: 'pending' | 'running' | 'waiting_acceptance' | 'accepted' | 'failed'; startedAt: string | null; completedAt: string | null; canAccept: boolean; chargedTokens: number; unknownCalls: number } }>;
  resolution: { outcome: 'not_achieved' | 'partial_accepted' | 'user_ended'; reason: string; createdAt: string } | null;
  checkpoint?: { sourceRunId: string; sourceVersion: number; digest: string; acceptedStageIds: string[];
    completedWorkers: number; files: Array<{ path: string; sha256: string }>;
    archive?: {id:string;digest:string;manifest:ArtifactSnapshot};
    rework?: { sourceRunId: string; stageId: string; reportId: string; reason: string; instruction: string; rejectedWorkers: number } };
  /** A confirmed successor seals this Run's owner acceptance ledger. */
  successorRunId?: string;
}
export interface BusinessReworkInput { stageId: string; reportId: string; expectedVersion: number; instruction: string }
export interface BusinessEvidenceChoice { ref: RuntimeEvidenceRef; label: string; excerpt: string; stageId?: string }
export interface BusinessAuditEntry {
  id: string; version: number; createdAt: string; action: 'report' | 'decide' | 'resolve'; stageId?: string;
  report?: BusinessReport; decision?: BusinessDecision; resolution?: BusinessState['resolution'];
}
export type BusinessCommand = { expectedVersion: number; clientRequestId: string } & (
  | { action: 'report'; stageId: string; kind: 'receipt' | 'delivery'; note: string; evidence: Array<{ deliverableId: string; ref: RuntimeEvidenceRef }> }
  | { action: 'decide'; stageId: string; reportId: string; verdict: 'accept' | 'reject'; checkedCriteria: number[]; reason: string }
  | { action: 'resolve'; outcome: 'not_achieved' | 'partial_accepted' | 'user_ended'; reason: string }
);

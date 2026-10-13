import type { RuntimeEvidenceRef, RuntimeEvidenceResolution } from './runtime.ts';
import type { ArtifactSnapshot } from './artifacts.ts';

/** Owner-defined acceptance. Stage gating is explicitly opted into per task. */
export interface BusinessContract {
  version: 1 | 2 | 3;
  /** Immutable contract generation; v1 has generation 1. */
  revision?: number;
  executionMode?: 'stage_gated';
  stages: BusinessStage[];
}
export interface BusinessAssignment {
  agentId: string; objective: string;
  /** Missing preserves ordered dispatch; [] explicitly declares independence. */
  dependsOn?: string[];
  /** v3 only. Public inherits the Run scope; private narrows input and output together. */
  visibility?: 'public' | 'private'; audience?: string[];
}
export interface BusinessJoin extends Omit<BusinessAssignment,'dependsOn'> {
  /** Explicitly authorized inputs; execution waits for every stage member. */
  sourceAgentIds: string[];
}
export interface SchedulingPreview {
  version:1; minimumModelCalls:number; platformTransitions:number;
  stages:Array<{stageId:string;title:string;concurrency:number;waves:string[][];joinAgentId:string|null;joinSourceAgentIds:string[];tasks:Array<{agentId:string;objective:string;visibility:'public'|'private';audience:string[]}>}>;
}
export interface SchedulingState {
  runId:string;coverage:'current'|'legacy_partial';apiRequests:number;nativeInvocations:number;unknownCalls:number;waitingCalls:number;blockedCalls:number;dispatchReceipts:number;platformTransitions:number;
  steps:Array<{stepId:string;agentId:string;stageId:string|null;kind:'work'|'join';status:string;waitingReason:string|null;calls:number;waitingMs:number;visibility:'public'|'private';audience:string[]}>;
}
export interface BusinessStage {
  id: string;
  title: string;
  criteria: string[];
  deliverables: Array<{ id: string; title: string; kind: 'text' | 'file' }>;
  execution?: {
    assignments: BusinessAssignment[];
    /** v3 only, capped by the server limit. Writes stay serial. */
    concurrency?: number;
    join?: BusinessJoin;
    timeoutMs?: number;
    /** Total output tokens across this stage's API requests, including tool rounds. */
    maxTokens?: number;
    /** Inherits Run currency, pricing and unknown-cost policy. */
    maxCost?: number;
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
    access?:import('./message.ts').MessageAccess;readonly?:boolean;
    recovery?:{reviewId:string|null;fingerprint:string;unknownUsage:number;runUnknownTokens:number;stageUnknownTokens:Array<{stageId:string;tokens:number}>};
    costBudget?: import('./cost.ts').CostBudgetState;
    impact?: BusinessChangeImpact;
    rework?: { sourceRunId: string; stageId: string; reportId: string; reason: string; instruction: string; rejectedWorkers: number } };
  /** A confirmed successor seals this Run's owner acceptance ledger. */
  successorRunId?: string;
}
export interface BusinessReworkInput { stageId: string; reportId: string; expectedVersion: number; instruction: string; selectedAgentIds?: string[] }
export interface BusinessRevisionInput { expectedVersion: number; contract: BusinessContract; instruction: string }
export interface BusinessChangeImpact {
  kind: 'rework' | 'contract_revision';
  fromRevision: number; toRevision: number;
  retained: Array<{ stageId: string; agentId: string; objective: string }>;
  redo: Array<{ stageId: string; agentId: string; objective: string }>;
  reacceptStageIds: string[];
  invalidatedDeliverables: Array<{ stageId: string; deliverableId: string; title: string }>;
  reasons: string[];
}
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

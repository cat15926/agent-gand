import type { ArtifactSnapshot } from './artifacts.ts';
import type { MessageAccess } from './message.ts';
export interface RecoveryStep {
  stepId:string; stageId:string; agentId:string; attemptId:string;
  state:'completed'|'not_executed'|'unknown'; reason:string; canConfirmNotExecuted:boolean;
}
export interface RecoveryInspection {
  runId:string; fingerprint:string; scope:MessageAccess; readonly:boolean; requiresReview:boolean;
  steps:RecoveryStep[]; tools:Array<{id:string;name:string;status:string;replayPolicy:string}>;
  unknownUsage:number; snapshot:ArtifactSnapshot; acceptedArchiveIds:string[]; reviewId:string|null;
  costBudget?: import('./cost.ts').CostBudgetState;
}
export interface RecoveryReviewInput {
  fingerprint:string; clientRequestId:string; reason:string; externalEffectsChecked:boolean;
  steps:Array<{stepId:string;verdict:'completed'|'not_executed';reason:string;output?:string}>;
}

export interface RecoveryReview { id:string; runId:string; fingerprint:string; input:RecoveryReviewInput; createdAt:string }

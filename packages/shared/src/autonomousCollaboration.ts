import type { MessageAccess } from './message.ts';
import type { ScopedSourceRef } from './scopedCollaboration.ts';
import type { CostPolicy } from './cost.ts';

/** AC1 freezes authority and budgets; v4 execution is reserved for AC2. */
export interface AutonomousCollaborationContractV1 {
  version: 1;
  capabilityPackage: 'autonomous-collaboration-v1';
  boundaryVersion: 2;
  policyId: string;
  policyRevision: 1;
  policySha256: string;
  rootRunId: string;
  budgetRunId: string;
  /** Absent on immutable AC1 roots. Only AC2-aware workers may execute this package. */
  delegationVersion?: 1;
  /** AC3 result intake, exact emission and necessary decisions; absent on AC2 roots. */
  deliveryVersion?: 1;
  /** AC4 ordinary entry and versioned same-task instructions. */
  entryVersion?:1;
}

export type AutonomousActionName = 'delegate' | 'aggregate' | 'emit' | 'request_user' | 'complete';
export interface AutonomousInputV1 {
  source: ScopedSourceRef;
  /** Forwarding a reference does not grant the coordinator permission to read it. */
  readers: string[];
}
export interface AutonomousTaskPolicyV1 {
  version: 1;
  id: string;
  revision: 1;
  admissionSha256: string;
  runId: string;
  conversationId: string;
  coordinatorId: string;
  participantIds: string[];
  rootSource: ScopedSourceRef;
  rootAccess: MessageAccess;
  outputAccess: MessageAccess;
  inputs: AutonomousInputV1[];
  members: Array<{agentId:string;roleVersion:number;model:string;driver:string;allowedTools:string[]}>;
  budget: {
    maxOutputTokens: number;
    maxTokensPerCall: number;
    maxConcurrency: number;
    maxDispatches: number;
    maxDepth: number;
    deadlineAt: string;
    firstResponseTimeoutMs: number;
    idleTimeoutMs: number;
  };
  costPolicy: CostPolicy;
  /** AC1 grants no declassification or external-effect authority. */
  disclosure: 'within_source_access';
  createdAt: string;
}

export interface AutonomousTaskGrantV1 {
  version: 1;
  id: string;
  runId: string;
  policyId: string;
  parentGrantId: string | null;
  subjectId: string;
  agentId: string;
  participantIds: string[];
  /** Authority ceiling, never an instruction to inject every input into a model. */
  inputs: AutonomousInputV1[];
  allowedTools: string[];
  /** Tools the task may assign to eligible descendants, distinct from this actor's own tools. */
  delegableTools: string[];
  actions: AutonomousActionName[];
  outputAccess: MessageAccess;
  depth: number;
  expiresAt: string;
  createdAt: string;
}
export interface AutonomousGrantBinding {
  runId: string;
  grantId: string;
  attemptId: string;
}
export type AutonomousTaskErrorCode = 'AUTONOMOUS_CONTRACT_INVALID' | 'AUTONOMOUS_POLICY_DRIFT'
  | 'AUTONOMOUS_AUTHORITY_INVALID' | 'AUTONOMOUS_ACCESS_DENIED' | 'AUTONOMOUS_GRANT_REVOKED'
  | 'AUTONOMOUS_TASK_EXPIRED' | 'AUTONOMOUS_LIMIT_EXCEEDED' | 'AUTONOMOUS_EXECUTOR_UNAVAILABLE'
  | 'AUTONOMOUS_GRAPH_INVALID' | 'AUTONOMOUS_DEPENDENCIES_UNSATISFIED' | 'AUTONOMOUS_EXPLICIT_ACTION_REQUIRED';

/** Model-authored task intent. All authority and source fingerprints are server-bound. */
export interface AutonomousDelegateIntentV1 {
  commandKey: string;
  items: Array<{
    key: string; agentId: string; objective: string; inputIds: string[];
    dependsOn: string[]; participantIds: string[]; allowedTools: string[];
    delegableTools: string[]; outputAudience?: string[];
  }>;
}
export interface AutonomousAggregateIntentV1 {
  commandKey:string;key:string;agentId:string;objective:string;resultKeys:string[];allowedTools:string[];
}
export interface AutonomousEmitIntentV1 {
  commandKey:string;kind:'update'|'final';format:'text'|'result_bundle'|'task_status_v1';
  text?:string;resultKeys?:string[];access:MessageAccess;
}
export interface AutonomousQuestionIntentV1 {
  commandKey:string;questions:Array<{key:string;question:string;requiredFor:string}>;
}
export interface AutonomousDecisionPreview {
  id:string;runId:string;kind:'release'|'intake';fingerprint:string;status:string;
  body:string;access:MessageAccess;reason:string;expiresAt:string;
}

/** Ordinary AC4 task entry; old orchestration entryVersion=1 remains explicit/manual. */
export interface AutonomousTaskInput {
  entryVersion:2;goal:string;clientRequestId:string;conversationId?:string;roomTitle?:string;agentIds?:string[];
  coordinatorId?:string;participantIds?:string[];visibility?:'public'|'private';audience?:string[];replyTo?:string;
  constraints?:import('./orchestration.ts').OrchestrationConstraints;
  attachments?:import('./orchestration.ts').OrchestrationPreviewInput['attachments'];
}
export interface AutonomousTaskView {
  coordinatorId:string;participantIds:string[];instructionRevision:number;entry:boolean;
  budget:{maxOutputTokens:number;chargedOutputTokens:number;deadlineAt:string};
  works:Array<{id:string;key:string;agentId:string;objective:string;state:string;dependsOn:string[];resultMessageId:string|null}>;
}
export interface AutonomousEntryOptions {
  available:boolean;mode:'closed'|'preview'|'execute';supportedDrivers:string[];maxOutputTokens:number;
}

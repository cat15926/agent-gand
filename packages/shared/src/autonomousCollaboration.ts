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
  | 'AUTONOMOUS_TASK_EXPIRED' | 'AUTONOMOUS_LIMIT_EXCEEDED' | 'AUTONOMOUS_EXECUTOR_UNAVAILABLE';

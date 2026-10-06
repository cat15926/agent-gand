import type { AgentCapability, PermissionMode } from './agent.ts';
import type { CoordinationProtocolId } from './coordination.ts';
import type { ExternalDriverId } from './execution.ts';
import type { RunMode } from './run.ts';

export const ORCHESTRATION_SCHEMA_VERSION = 1 as const;
export const ORCHESTRATION_STRATEGIES = ['auto', 'parallel', 'serial'] as const;
export const ORCHESTRATION_WORKFLOWS = ['routine', 'analysis_summary', 'development_review', 'supervisor_decomposition', 'bounded_debate'] as const;
export type OrchestrationStrategy = typeof ORCHESTRATION_STRATEGIES[number];
export type OrchestrationWorkflow = typeof ORCHESTRATION_WORKFLOWS[number];
export type OrchestrationSource = 'unified_preview' | 'room_create' | 'conversation_message' | 'direct_run' | 'coordination_preview' | 'followup_preview';

export interface OrchestrationConstraints {
  readonly?: boolean;
  /** A hard ceiling, never silently changed to an estimate. */
  maxTokens?: number;
  deadlineMs?: number;
  rounds?: number;
}

/** Preview is configuration-only in O1. No execution API is implied by this input. */
export interface OrchestrationPreviewInput {
  goal: string;
  conversationId?: string;
  agentIds?: string[];
  recipientIds?: string[];
  strategy?: OrchestrationStrategy;
  workflow?: OrchestrationWorkflow;
  workspace?: string | null;
  supervisorId?: string | null;
  defaultReviewerId?: string | null;
  aggregatorId?: string | null;
  replyTo?: string | null;
  taskId?: string | null;
  clientRequestId?: string;
  constraints?: OrchestrationConstraints;
  wholeTeam?: boolean;
}

export interface OrchestrationRequest {
  schemaVersion: 1;
  source: OrchestrationSource;
  conversationId: string | null;
  membersVersion: number | null;
  goal: string;
  agentIds: string[];
  recipientIds: string[];
  strategy: OrchestrationStrategy;
  workflow: OrchestrationWorkflow;
  workspace: string | null;
  supervisorId: string | null;
  defaultReviewerId: string | null;
  aggregatorId: string | null;
  replyTo: string | null;
  taskId: string | null;
  clientRequestId: string | null;
  wholeTeam: boolean;
  constraints: OrchestrationConstraints;
  legacy: {
    mode: RunMode;
    coordinationDraftId: string | null;
    requestedProtocol: CoordinationProtocolId | null;
    followupRouting: 'room_mode' | null;
  };
}

export interface OrchestrationAgentCapability {
  id: string;
  name: string;
  version: number;
  definitionDigest: string;
  enabled: boolean;
  model: string;
  capabilities: AgentCapability[];
  driver: 'builtin-llm' | ExternalDriverId;
  permissionMode: PermissionMode;
  platformTools: string[];
  /** Configured native exemptions/allowlist; readonly drivers also supply fixed read tools. */
  nativeTools: string[];
  deniedTools: string[];
  supports: { control: boolean; resume: boolean; nativeWrite: boolean; hardTokenLimit: boolean; coordinationSteps: boolean };
  legacyModes: RunMode[];
  account: {
    id: string | null;
    version: number | null;
    configVersion: number | null;
    credentialVersion: number | null;
    identityGeneration: number | null;
    configuration: 'configured' | 'unchecked' | 'missing' | 'unavailable';
    modelTest: 'untested' | 'passed' | 'failed' | 'stale';
    compatible: boolean;
  };
}

export interface OrchestrationCapabilitySnapshot {
  schemaVersion: 1;
  agents: OrchestrationAgentCapability[];
  workspace: { name: string | null; kind: 'per_run' | 'named' | 'external'; registrationDigest: string | null };
  driverDetection: 'not_performed';
  testedModel: false;
  maximumTargets: number;
}

export interface OrchestrationIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  agentId?: string;
  requiredStage?: 'O2' | 'O3' | 'O4';
}

export interface OrchestrationDecision {
  schemaVersion: 1;
  resolverVersion: 'o1-rules-v1';
  templateVersion: 'o1-templates-v1';
  effectiveStrategy: 'single' | 'parallel' | 'serial';
  workflow: OrchestrationWorkflow;
  protocol: CoordinationProtocolId;
  targetIds: string[];
  targetSource: 'explicit' | 'mention' | 'reply' | 'whole_team' | 'automatic';
  reason: string;
  requiresConfirmation: boolean;
  issues: OrchestrationIssue[];
  /** O1 decisions are comparisons, never execution authority. */
  comparisonOnly: true;
}

export interface OrchestrationPreview {
  request: OrchestrationRequest;
  capabilities: OrchestrationCapabilitySnapshot;
  decision: OrchestrationDecision;
  fingerprint: string;
  comparisonOnly: true;
  testedModel: false;
  dispatchCreated: false;
}

export interface RunOrchestrationSnapshot extends OrchestrationPreview {
  schemaVersion: 1;
  requestId: string;
  runId: string;
  conversationId: string;
  createdAt: string;
  submissionDigest: string;
  executionAuthority: 'legacy';
  /** Actual admitted legacy settings; a new room may receive a generated workspace. */
  legacyExecution: {
    mode: RunMode;
    agentIds: string[];
    workspace: string | null;
    supervisorId: string | null;
    defaultReviewerId: string | null;
    coordinationPlanId: string | null;
  };
}

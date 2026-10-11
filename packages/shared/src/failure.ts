import type { ExecutionFailureDetails, ExternalExecutionProgress, ExternalTimeoutPolicy } from './execution.ts';
import type { RunRecoveryAssessment, RunStatus } from './run.ts';
import type { RuntimeActionCommandKind } from './runtime.ts';

export interface RunFailureNode {
  id: string;
  kind: 'dispatch' | 'step' | 'task' | 'execution' | 'tool' | 'span' | 'secondary' | 'terminal';
  role: 'failure' | 'affected' | 'cancelled' | 'unknown' | 'secondary' | 'control_interruption' | 'terminal';
  /** A failed earlier attempt can remain in the audit without being the current trigger. */
  resolved: boolean;
  message: string;
  code: string | null;
  agentId: string | null;
  occurredAt: string;
  refs: { dispatchId?: string; stepId?: string; planId?: string; revision?: number; taskId?: string;
    attemptId?: string; executionId?: string; spanId?: string; subjectId?: string };
  details?: ExecutionFailureDetails;
  providerDiagnostic?: { httpStatus: number; requestId?: string };
  control?: { state: 'committed' | 'candidate_only'; kind?: RuntimeActionCommandKind; commandId?: string };
  progress?: ExternalExecutionProgress;
  timeoutPolicy?: ExternalTimeoutPolicy;
}

export interface RunFailureLink {
  from: string;
  to: string;
  /** Same-attempt and span-parent links establish association, not a tool failure's causal responsibility. */
  relation: 'same_attempt' | 'span_parent' | 'depends_on' | 'secondary_to' | 'failed_at_terminal' | 'terminal_cancel';
  evidence: 'binding' | 'plan' | 'ledger' | 'terminal_snapshot' | 'abort_reason';
}

export interface RunFailureReport {
  version: 1;
  runId: string;
  status: RunStatus;
  nodes: RunFailureNode[];
  links: RunFailureLink[];
  primaryNodeIds: string[];
  /** Only the room owner receives recovery details; private failures are filtered for Agent observers. */
  recovery: RunRecoveryAssessment | null;
  truncated: boolean;
}

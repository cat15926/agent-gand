/**
 * WebSocket 实时事件协议（P0-6）
 * server → web 单向推送；data 结构即各领域对象
 */

import type { AgentDefinition } from './agent.ts';
import type { ExternalAgentExecution, NativeAgentEvent } from './execution.ts';
import type { Message } from './message.ts';
import type { Task } from './task.ts';
import type { TaskAttempt } from './task.ts';
import type { TaskReview } from './review.ts';
import type { Run, RunEvent, UsageSummary } from './run.ts';
import type { ApprovalRequest } from './approval.ts';
import type { Conversation } from './conversation.ts';
import type { CollaborationAttempt, CollaborationBatch, CollaborationDispatch, CollaborationUserDecision } from './collaboration.ts';
import type { CoordinationStepState } from './coordination.ts';
import type {
  RuntimeCompletionCandidate,
  RuntimeActionCommandRecord,
  RuntimeDurableHold,
  RuntimeHoldRecoveryAudit,
  RuntimeEvidenceBundle,
  RuntimeRouteGuardEvent,
  RuntimeShadowComparison,
  RuntimeSuccessorObligation,
  RuntimeWakeEvent,
} from './runtime.ts';

export type ServerEvent =
  | { type: 'hello'; agents: AgentDefinition[]; runs: number }
  | { type: 'agent.updated'; agent: AgentDefinition }
  | { type: 'message'; message: Message }
  | { type: 'conversation.updated'; conversation: Conversation }
  | { type: 'task.updated'; task: Task }
  | { type: 'task.attempt.updated'; attempt: TaskAttempt }
  | { type: 'review.updated'; review: TaskReview }
  | { type: 'scheduler.updated'; runId: string; active: number; queued: number }
  | { type: 'collaboration.dispatch.updated'; dispatch: CollaborationDispatch }
  | { type: 'collaboration.attempt.updated'; attempt: CollaborationAttempt }
  | { type: 'collaboration.batch.updated'; batch: CollaborationBatch }
  | { type: 'collaboration.decision.updated'; decision: CollaborationUserDecision }
  | { type: 'runtime.completion_candidate.updated'; candidate: RuntimeCompletionCandidate }
  | { type: 'runtime.action_command.committed'; command: RuntimeActionCommandRecord }
  | { type: 'runtime.evidence_bundle.updated'; bundle: RuntimeEvidenceBundle }
  | { type: 'runtime.route_guard.updated'; event: RuntimeRouteGuardEvent }
  | { type: 'runtime.shadow_comparison.recorded'; comparison: RuntimeShadowComparison }
  | { type: 'runtime.hold.updated'; hold: RuntimeDurableHold }
  | { type: 'runtime.hold_recovery.recorded'; audit: RuntimeHoldRecoveryAudit }
  | { type: 'runtime.wake_event.recorded'; wakeEvent: RuntimeWakeEvent }
  | { type: 'runtime.successor_obligation.updated'; obligation: RuntimeSuccessorObligation }
  | { type: 'collaboration.scheduler.updated'; conversationId: string; runIds: string[]; activeAgentIds: string[]; queued: number; blocked: number }
  | { type: 'coordination.step.updated'; step: CoordinationStepState }
  | { type: 'run.updated'; run: Run }
  | { type: 'run.event'; event: RunEvent }
  | { type: 'llm.delta'; runId: string; spanId: string; text: string; agentId?: string; taskId?: string; attemptId?: string; displayKind?: 'message' | 'review_protocol' }
  | { type: 'llm.snapshot'; runId: string; spanId: string; text: string; displayKind?: 'message' | 'review_protocol' }
  | { type: 'execution.updated'; execution: ExternalAgentExecution }
  | { type: 'execution.native'; runId: string; executionId: string; event: NativeAgentEvent }
  | { type: 'approval.updated'; approval: ApprovalRequest }
  | { type: 'usage'; usage: UsageSummary };

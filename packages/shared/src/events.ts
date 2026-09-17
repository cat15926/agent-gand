/**
 * WebSocket 实时事件协议（P0-6）
 * server → web 单向推送；data 结构即各领域对象
 */

import type { AgentDefinition } from './agent.ts';
import type { Message } from './message.ts';
import type { Task } from './task.ts';
import type { TaskAttempt } from './task.ts';
import type { TaskReview } from './review.ts';
import type { Run, RunEvent, UsageSummary } from './run.ts';
import type { ApprovalRequest } from './approval.ts';
import type { Conversation } from './conversation.ts';
import type { CollaborationAttempt, CollaborationBatch, CollaborationDispatch, CollaborationUserDecision } from './collaboration.ts';

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
  | { type: 'collaboration.scheduler.updated'; conversationId: string; runIds: string[]; activeAgentIds: string[]; queued: number; blocked: number }
  | { type: 'run.updated'; run: Run }
  | { type: 'run.event'; event: RunEvent }
  | { type: 'llm.delta'; runId: string; spanId: string; text: string; agentId?: string; taskId?: string; attemptId?: string; displayKind?: 'message' | 'review_protocol' }
  | { type: 'approval.updated'; approval: ApprovalRequest }
  | { type: 'usage'; usage: UsageSummary };

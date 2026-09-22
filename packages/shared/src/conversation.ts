import type { RunMode, RunStatus } from './run.ts';

export interface Conversation {
  id: string;
  title: string;
  mode: RunMode;
  agentIds: string[];
  supervisorId: string | null;
  defaultReviewerId: string | null;
  membersVersion: number;
  workspace: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  latestRunId: string | null;
  latestRunStatus: RunStatus | null;
  latestMessage: string | null;
  runCount: number;
}

export type ConversationMessageStatus = 'received' | 'queued' | 'processing' | 'responded' | 'failed';

export interface SendConversationMessageInput {
  body: string;
  recipientIds?: string[];
  replyTo?: string | null;
  taskId?: string | null;
  clientMessageId: string;
  /** 用户确认追问推荐卡后，仅本轮使用该 Plan，不改变房间模式。 */
  coordinationDraftId?: string;
  /** 明确拒绝追问建议时按房间原有模式调度；不改变之后的默认路由。 */
  followupRouting?: 'room_mode';
  /** 本轮必须使用覆盖房间所有成员的协调计划。 */
  wholeTeam?: boolean;
}

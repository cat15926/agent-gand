import type { RunMode, RunStatus } from './run.ts';

export interface Conversation {
  id: string;
  title: string;
  mode: RunMode;
  agentIds: string[];
  supervisorId: string | null;
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
}

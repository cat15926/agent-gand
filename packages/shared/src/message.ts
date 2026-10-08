/**
 * 消息与收件箱模型（P0-3）
 * from/to 取 agent id，或保留名 'user' / 'system' / 'all'（广播）
 */

export type MessageKind = 'user' | 'agent' | 'system' | 'tool';

export type MessageVisibility = 'public' | 'private';
export interface MessageAccess { visibility: MessageVisibility; audience: string[]; }

export type AgentMessageType =
  | 'assignment'
  | 'result'
  | 'review_request'
  | 'review_result'
  | 'revision_request'
  | 'handoff'
  | 'collaboration_result'
  | 'collaboration_contribution'
  | 'collaboration_handoff'
  | 'collaboration_question'
  | 'collaboration_wait_user'
  | 'collaboration_routing'
  | 'collaboration_task_proposal'
  | 'informational';

export interface Message {
  id: string;
  runId: string;
  conversationId: string;
  /** 聊天室内稳定递增序号，用于重连排序与去重。 */
  seq: number;
  from: string;
  to: string;
  kind: MessageKind;
  body: string;
  /** 接收者用于调度；可见性独立声明。历史缺失字段按公开消息解释。 */
  visibility?: MessageVisibility;
  audience?: string[];
  /** 附加信息：工具名、span 引用等 */
  meta?: Record<string, unknown> | null;
  taskId: string | null;
  replyTo: string | null;
  messageType: AgentMessageType;
  payload: Record<string, unknown> | null;
  deliveryStatus?: 'received' | 'queued' | 'processing' | 'responded' | 'failed' | null;
  clientMessageId?: string | null;
  createdAt: string; // ISO
}

/** 当前单用户房间所有者可审计全部消息；Agent 只能读取授权内容。 */
export function isMessageVisibleTo(message: Pick<Message, 'visibility' | 'audience'>, viewerId: string): boolean {
  return viewerId === 'user' || message.visibility !== 'private' || (message.audience ?? []).includes(viewerId);
}

/** 同一成员的其他私密任务不能污染当前公开或更宽范围的任务。 */
export function isMessageWithinScope(message: Pick<Message, 'visibility' | 'audience'>, scope: MessageAccess): boolean {
  return message.visibility !== 'private' || scope.visibility === 'private'
    && scope.audience.every(id => id === 'user' || (message.audience ?? []).includes(id));
}

/** 聚合和派生结果不得扩大私密来源的可见范围。 */
export function intersectMessageAccess(messages: Array<Pick<Message, 'visibility' | 'audience'>>): MessageAccess {
  const privateMessages = messages.filter(message => message.visibility === 'private');
  if (!privateMessages.length) return { visibility: 'public', audience: [] };
  const audience = [...new Set(['user', ...(privateMessages[0]?.audience ?? [])])]
    .filter(id => id === 'user' || privateMessages.every(message => message.audience?.includes(id)));
  return { visibility: 'private', audience };
}

/** 阅读接口使用稳定序号游标，不影响执行器读取完整上下文。 */
export interface MessageReference { id: string; runId: string; seq: number; from: string; body: string; }
export interface ConversationHistoryPage {
  messages: Message[];
  references: MessageReference[];
  oldestSeq: number | null;
  newestSeq: number | null;
  headSeq: number;
  total: number;
  hasOlder: boolean;
  hasNewer: boolean;
}
export interface MessageSearchMatch extends MessageReference {
  messageType: AgentMessageType;
  createdAt: string;
}
export interface ConversationMessageSearch { matches: MessageSearchMatch[]; total: number; nextAfter: number | null; }

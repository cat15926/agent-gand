/**
 * 消息与收件箱模型（P0-3）
 * from/to 取 agent id，或保留名 'user' / 'system' / 'all'（广播）
 */

export type MessageKind = 'user' | 'agent' | 'system' | 'tool';

export type AgentMessageType =
  | 'assignment'
  | 'result'
  | 'review_request'
  | 'review_result'
  | 'revision_request'
  | 'handoff'
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

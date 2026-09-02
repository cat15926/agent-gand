/**
 * 消息与收件箱模型（P0-3）
 * from/to 取 agent id，或保留名 'user' / 'system' / 'all'（广播）
 */

export type MessageKind = 'user' | 'agent' | 'system' | 'tool';

export interface Message {
  id: string;
  runId: string;
  from: string;
  to: string;
  kind: MessageKind;
  body: string;
  /** 附加信息：工具名、span 引用等 */
  meta?: Record<string, unknown> | null;
  createdAt: string; // ISO
}

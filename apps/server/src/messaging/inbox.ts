/**
 * 收件箱（规格 §4.2 messaging/inbox.ts）
 * post：消息落库 + 广播 message 事件；listByRun：按运行取消息流
 */
import type { AgentMessageType, Message, MessageKind } from '@agent-gand/shared';
import { randomUUID } from 'node:crypto';
import { all, get, run, tx } from '../db/database.ts';
import { emit } from './bus.ts';

interface MessageRow {
  id: string;
  run_id: string;
  conversation_id: string;
  seq: number;
  from_agent: string;
  to_agent: string;
  kind: string;
  body: string;
  meta: string | null;
  task_id: string | null;
  reply_to: string | null;
  message_type: string;
  payload: string | null;
  delivery_status: string | null;
  client_message_id: string | null;
  created_at: string;
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    runId: row.run_id,
    conversationId: row.conversation_id,
    seq: row.seq,
    from: row.from_agent,
    to: row.to_agent,
    kind: row.kind as MessageKind,
    body: row.body,
    meta: row.meta === null ? null : (JSON.parse(row.meta) as Record<string, unknown>),
    taskId: row.task_id,
    replyTo: row.reply_to,
    messageType: row.message_type as AgentMessageType,
    payload: row.payload === null ? null : (JSON.parse(row.payload) as Record<string, unknown>),
    deliveryStatus: row.delivery_status as Message['deliveryStatus'],
    clientMessageId: row.client_message_id,
    createdAt: row.created_at,
  };
}

export interface PostMessageInput {
  runId: string;
  from: string; // agent id | 'user' | 'system'
  to: string; // agent id | 'user' | 'system' | 'all'
  kind: MessageKind;
  body: string;
  meta?: Record<string, unknown> | null;
  taskId?: string | null;
  replyTo?: string | null;
  messageType?: AgentMessageType;
  payload?: Record<string, unknown> | null;
  deliveryStatus?: Message['deliveryStatus'];
  clientMessageId?: string | null;
}

export function post(input: PostMessageInput): Message {
  return tx(() => {
  const runInfo = get<{ conversation_id: string }>('SELECT conversation_id FROM runs WHERE id = ?', input.runId);
  if (!runInfo?.conversation_id) throw new Error(`run 没有关联聊天室: ${input.runId}`);
  if (input.clientMessageId) {
    const existing = get<MessageRow>('SELECT * FROM messages WHERE conversation_id = ? AND client_message_id = ?', runInfo.conversation_id, input.clientMessageId);
    if (existing) {
      if (input.deliveryStatus && existing.delivery_status !== input.deliveryStatus) {
        run('UPDATE messages SET delivery_status = ? WHERE id = ?', input.deliveryStatus, existing.id);
        existing.delivery_status = input.deliveryStatus;
        emit({ type: 'message', message: rowToMessage(existing) });
      }
      return rowToMessage(existing);
    }
  }
  const seq = get<{ n: number }>('SELECT COALESCE(MAX(seq), 0) + 1 n FROM messages WHERE conversation_id = ?', runInfo.conversation_id)?.n ?? 1;
  const message: Message = {
    id: randomUUID(),
    runId: input.runId,
    conversationId: runInfo.conversation_id,
    seq,
    from: input.from,
    to: input.to,
    kind: input.kind,
    body: input.body,
    meta: input.meta ?? null,
    taskId: input.taskId ?? null,
    replyTo: input.replyTo ?? null,
    messageType: input.messageType ?? 'informational',
    payload: input.payload ?? null,
    deliveryStatus: input.deliveryStatus ?? null,
    clientMessageId: input.clientMessageId ?? null,
    createdAt: new Date().toISOString(),
  };
  run(
    `INSERT INTO messages (
       id, run_id, conversation_id, seq, from_agent, to_agent, kind, body, meta,
       task_id, reply_to, message_type, payload, delivery_status, client_message_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    message.id,
    message.runId,
    message.conversationId,
    message.seq,
    message.from,
    message.to,
    message.kind,
    message.body,
    message.meta === null ? null : JSON.stringify(message.meta),
    message.taskId,
    message.replyTo,
    message.messageType,
    message.payload === null ? null : JSON.stringify(message.payload),
    message.deliveryStatus,
    message.clientMessageId,
    message.createdAt,
  );
  emit({ type: 'message', message });
  return message;
  });
}

export function listByRun(runId: string): Message[] {
  return all<MessageRow>(
    'SELECT * FROM messages WHERE run_id = ? ORDER BY created_at ASC, rowid ASC',
    runId,
  ).map(rowToMessage);
}

export function listByConversation(conversationId: string): Message[] {
  return all<MessageRow>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC', conversationId).map(rowToMessage);
}

export function updateRunUserMessageStatus(runId: string, deliveryStatus: NonNullable<Message['deliveryStatus']>): void {
  run("UPDATE messages SET delivery_status = ? WHERE run_id = ? AND kind = 'user'", deliveryStatus, runId);
  const rows = all<MessageRow>("SELECT * FROM messages WHERE run_id = ? AND kind = 'user'", runId);
  for (const row of rows) emit({ type: 'message', message: rowToMessage(row) });
}

export interface ListAgentMessagesOptions {
  taskId?: string;
  messageType?: AgentMessageType;
}

/** Agent 收件箱：同时包含点对点消息和 all 广播。 */
export function listForAgent(
  runId: string,
  agentId: string,
  options: ListAgentMessagesOptions = {},
): Message[] {
  const where = ["run_id = ?", "(to_agent = ? OR to_agent = 'all')"];
  const params: unknown[] = [runId, agentId];
  if (options.taskId) {
    where.push('task_id = ?');
    params.push(options.taskId);
  }
  if (options.messageType) {
    where.push('message_type = ?');
    params.push(options.messageType);
  }
  return all<MessageRow>(
    `SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY created_at ASC, rowid ASC`,
    ...params,
  ).map(rowToMessage);
}

export function listForTask(taskId: string): Message[] {
  return all<MessageRow>(
    'SELECT * FROM messages WHERE task_id = ? ORDER BY created_at ASC, rowid ASC',
    taskId,
  ).map(rowToMessage);
}

export function listMessages(input: {
  runId: string;
  agentId?: string;
  taskId?: string;
  messageType?: AgentMessageType;
}): Message[] {
  const where = ['run_id = ?'];
  const params: unknown[] = [input.runId];
  if (input.agentId) {
    where.push('(from_agent = ? OR to_agent = ?)');
    params.push(input.agentId, input.agentId);
  }
  if (input.taskId) {
    where.push('task_id = ?');
    params.push(input.taskId);
  }
  if (input.messageType) {
    where.push('message_type = ?');
    params.push(input.messageType);
  }
  return all<MessageRow>(
    `SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY created_at ASC, rowid ASC`,
    ...params,
  ).map(rowToMessage);
}

/** 语义化别名：调度器通过它产生可审计的 Agent 点对点通信。 */
export const sendAgentMessage = post;

/** 编排过程中的系统提示（权限拒绝、审批结果等）走收件箱留痕 */
export function postSystem(runId: string, to: string, body: string): Message {
  return post({ runId, from: 'system', to, kind: 'system', body });
}

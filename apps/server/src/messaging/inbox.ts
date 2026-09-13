/**
 * 收件箱（规格 §4.2 messaging/inbox.ts）
 * post：消息落库 + 广播 message 事件；listByRun：按运行取消息流
 */
import type { AgentMessageType, Message, MessageKind } from '@agent-gand/shared';
import { randomUUID } from 'node:crypto';
import { all, run } from '../db/database.ts';
import { emit } from './bus.ts';

interface MessageRow {
  id: string;
  run_id: string;
  from_agent: string;
  to_agent: string;
  kind: string;
  body: string;
  meta: string | null;
  task_id: string | null;
  reply_to: string | null;
  message_type: string;
  payload: string | null;
  created_at: string;
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    runId: row.run_id,
    from: row.from_agent,
    to: row.to_agent,
    kind: row.kind as MessageKind,
    body: row.body,
    meta: row.meta === null ? null : (JSON.parse(row.meta) as Record<string, unknown>),
    taskId: row.task_id,
    replyTo: row.reply_to,
    messageType: row.message_type as AgentMessageType,
    payload: row.payload === null ? null : (JSON.parse(row.payload) as Record<string, unknown>),
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
}

export function post(input: PostMessageInput): Message {
  const message: Message = {
    id: randomUUID(),
    runId: input.runId,
    from: input.from,
    to: input.to,
    kind: input.kind,
    body: input.body,
    meta: input.meta ?? null,
    taskId: input.taskId ?? null,
    replyTo: input.replyTo ?? null,
    messageType: input.messageType ?? 'informational',
    payload: input.payload ?? null,
    createdAt: new Date().toISOString(),
  };
  run(
    `INSERT INTO messages (
       id, run_id, from_agent, to_agent, kind, body, meta,
       task_id, reply_to, message_type, payload, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    message.id,
    message.runId,
    message.from,
    message.to,
    message.kind,
    message.body,
    message.meta === null ? null : JSON.stringify(message.meta),
    message.taskId,
    message.replyTo,
    message.messageType,
    message.payload === null ? null : JSON.stringify(message.payload),
    message.createdAt,
  );
  emit({ type: 'message', message });
  return message;
}

export function listByRun(runId: string): Message[] {
  return all<MessageRow>(
    'SELECT * FROM messages WHERE run_id = ? ORDER BY created_at ASC, rowid ASC',
    runId,
  ).map(rowToMessage);
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

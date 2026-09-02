/**
 * 收件箱（规格 §4.2 messaging/inbox.ts）
 * post：消息落库 + 广播 message 事件；listByRun：按运行取消息流
 */
import type { Message, MessageKind } from '@agent-gand/shared';
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
    createdAt: new Date().toISOString(),
  };
  run(
    `INSERT INTO messages (id, run_id, from_agent, to_agent, kind, body, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    message.id,
    message.runId,
    message.from,
    message.to,
    message.kind,
    message.body,
    message.meta === null ? null : JSON.stringify(message.meta),
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

/** 编排过程中的系统提示（权限拒绝、审批结果等）走收件箱留痕 */
export function postSystem(runId: string, to: string, body: string): Message {
  return post({ runId, from: 'system', to, kind: 'system', body });
}

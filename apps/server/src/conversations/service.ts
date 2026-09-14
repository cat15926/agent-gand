import type { Conversation, RunMode, RunStatus } from '@agent-gand/shared';
import { randomUUID } from 'node:crypto';
import { all, get, run, tx } from '../db/database.ts';
import { emit } from '../messaging/bus.ts';

interface ConversationRow {
  id: string;
  title: string;
  mode: string;
  agent_ids: string;
  supervisor_id: string | null;
  workspace: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  latest_run_id: string | null;
  latest_run_status: string | null;
  latest_message: string | null;
  run_count: number;
}

const SELECT_CONVERSATIONS = `
  SELECT c.*,
    (SELECT r.id FROM runs r WHERE r.conversation_id = c.id ORDER BY r.turn_no DESC LIMIT 1) latest_run_id,
    (SELECT r.status FROM runs r WHERE r.conversation_id = c.id ORDER BY r.turn_no DESC LIMIT 1) latest_run_status,
    (SELECT m.body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.seq DESC LIMIT 1) latest_message,
    (SELECT COUNT(*) FROM runs r WHERE r.conversation_id = c.id) run_count
  FROM conversations c`;

function fromRow(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode as RunMode,
    agentIds: JSON.parse(row.agent_ids) as string[],
    supervisorId: row.supervisor_id,
    workspace: row.workspace,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    latestRunId: row.latest_run_id,
    latestRunStatus: row.latest_run_status as RunStatus | null,
    latestMessage: row.latest_message,
    runCount: row.run_count,
  };
}

export function getConversation(id: string): Conversation | undefined {
  const row = get<ConversationRow>(`${SELECT_CONVERSATIONS} WHERE c.id = ?`, id);
  return row ? fromRow(row) : undefined;
}

export function listConversations(): Conversation[] {
  return all<ConversationRow>(`${SELECT_CONVERSATIONS} WHERE c.archived_at IS NULL ORDER BY c.updated_at DESC`).map(fromRow);
}

export function createConversation(input: {
  title: string;
  mode: RunMode;
  agentIds: string[];
  supervisorId: string | null;
  workspace: string | null;
  stableWorkspace?: boolean;
}): Conversation {
  const id = randomUUID();
  const now = new Date().toISOString();
  const workspace = input.workspace ?? (input.stableWorkspace ? `room-${id.slice(0, 8)}` : null);
  run(
    `INSERT INTO conversations (id, title, mode, agent_ids, supervisor_id, workspace, created_at, updated_at, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    id, input.title.slice(0, 80), input.mode, JSON.stringify(input.agentIds), input.supervisorId, workspace, now, now,
  );
  const conversation = getConversation(id)!;
  emit({ type: 'conversation.updated', conversation });
  return conversation;
}

export function touchConversation(id: string): void {
  run('UPDATE conversations SET updated_at = ? WHERE id = ?', new Date().toISOString(), id);
  const conversation = getConversation(id);
  if (conversation) emit({ type: 'conversation.updated', conversation });
}

export function renameConversation(id: string, title: string): Conversation | null {
  const value = title.trim();
  if (value.length === 0 || value.length > 80) return null;
  run('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?', value, new Date().toISOString(), id);
  const conversation = getConversation(id) ?? null;
  if (conversation) emit({ type: 'conversation.updated', conversation });
  return conversation;
}

export function archiveConversation(id: string): Conversation | null {
  run('UPDATE conversations SET archived_at = ?, updated_at = ? WHERE id = ?', new Date().toISOString(), new Date().toISOString(), id);
  const conversation = getConversation(id) ?? null;
  if (conversation) emit({ type: 'conversation.updated', conversation });
  return conversation;
}

/** 旧 Run 一对一回填房间；消息按原始顺序获得房间 seq。 */
export function backfillConversations(): void {
  tx(() => {
    const legacy = all<{
      id: string; goal: string; mode: string; agent_ids: string; supervisor_id: string | null;
      workspace: string | null; title: string | null; deleted_at: string | null; created_at: string; finished_at: string | null;
    }>('SELECT id, goal, mode, agent_ids, supervisor_id, workspace, title, deleted_at, created_at, finished_at FROM runs WHERE conversation_id IS NULL');
    for (const item of legacy) {
      const conversationId = randomUUID();
      run(
        `INSERT INTO conversations (id, title, mode, agent_ids, supervisor_id, workspace, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        conversationId, item.title ?? item.goal.slice(0, 24), item.mode, item.agent_ids, item.supervisor_id,
        item.workspace, item.created_at, item.finished_at ?? item.created_at, item.deleted_at,
      );
      run('UPDATE runs SET conversation_id = ?, turn_no = 1 WHERE id = ?', conversationId, item.id);
      const messages = all<{ id: string }>('SELECT id FROM messages WHERE run_id = ? ORDER BY created_at, rowid', item.id);
      messages.forEach((message, index) => {
        run('UPDATE messages SET conversation_id = ?, seq = ? WHERE id = ?', conversationId, index + 1, message.id);
      });
    }
    run(`UPDATE conversations SET archived_at = COALESCE(archived_at,
      (SELECT MAX(r.deleted_at) FROM runs r WHERE r.conversation_id = conversations.id))
      WHERE NOT EXISTS (SELECT 1 FROM runs r WHERE r.conversation_id = conversations.id AND r.deleted_at IS NULL)`);
  });
}

export function nextTurnNo(conversationId: string): number {
  return (get<{ n: number }>('SELECT COALESCE(MAX(turn_no), 0) + 1 n FROM runs WHERE conversation_id = ?', conversationId)?.n ?? 1);
}

export function conversationHistory(conversationId: string, beforeTurn: number, maxMessages = 12): string {
  const rows = all<{ from_agent: string; to_agent: string; body: string }>(
    `SELECT m.from_agent, m.to_agent, m.body FROM messages m
     JOIN runs r ON r.id = m.run_id
     WHERE r.conversation_id = ? AND r.turn_no < ? AND m.kind IN ('user', 'agent')
     ORDER BY m.seq DESC LIMIT ?`,
    conversationId, beforeTurn, maxMessages,
  ).reverse();
  if (rows.length === 0) return '';
  const transcript = rows.map((item) => `[${item.from_agent} → ${item.to_agent}] ${item.body.slice(0, 2_000)}`).join('\n\n');
  return transcript.slice(-16_000);
}

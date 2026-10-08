import { intersectMessageAccess, isMessageVisibleTo, type MessageAccess } from '@agent-gand/shared';
import { all, get } from '../db/database.ts';

const publicAccess = (): MessageAccess => ({ visibility: 'public', audience: [] });
export function unboundRunAccess(runId: string): MessageAccess {
  return get("SELECT 1 FROM messages WHERE run_id=? AND visibility='private' LIMIT 1", runId)
    ? { visibility: 'private', audience: ['user'] } : publicAccess();
}
function access(row: { visibility?: string; audience?: string } | undefined): MessageAccess {
  if (row?.visibility !== 'private') return publicAccess();
  try { return { visibility: 'private', audience: JSON.parse(row.audience ?? '[]') as string[] }; }
  catch { return { visibility: 'private', audience: ['user'] }; }
}

export function messageAccess(id: string): MessageAccess {
  const row = get<{ visibility: string; audience: string }>('SELECT visibility,audience FROM messages WHERE id=?', id);
  return row ? access(row) : { visibility: 'private', audience: ['user'] };
}

export function attemptAccess(id: string): MessageAccess {
  const context = get<{ visibility: string; audience: string }>(
    'SELECT visibility,audience FROM runtime_context_assemblies WHERE attempt_id=?', id);
  if (context) return access(context);
  const source = get<{ source_message_id: string }>(`SELECT d.source_message_id FROM collaboration_attempts a
    JOIN collaboration_dispatches d ON d.id=a.dispatch_id WHERE a.id=?`, id);
  return source ? messageAccess(source.source_message_id) : publicAccess();
}

export function eventAccess(id: string): MessageAccess {
  let current: string | null = id;
  let runId: string | undefined;
  for (let depth = 0; current && depth < 32; depth++) {
    const row: { run_id: string; parent_id: string | null; attributes: string } | undefined = get('SELECT run_id,parent_id,attributes FROM run_events WHERE id=?', current);
    if (!row) break;
    runId = row.run_id;
    const attributes = JSON.parse(row.attributes) as Record<string, unknown>;
    if (typeof attributes['collaboration.attempt.id'] === 'string') {
      const attempt = get<{ id: string }>('SELECT id FROM collaboration_attempts WHERE id=? AND run_id=?', attributes['collaboration.attempt.id'], row.run_id);
      return attempt ? attemptAccess(attempt.id) : { visibility: 'private', audience: ['user'] };
    }
    if (typeof attributes['execution.id'] === 'string') {
      const execution = get<{ attempt_id: string | null }>(
        "SELECT json_extract(record,'$.attemptId') attempt_id FROM external_agent_executions WHERE id=? AND run_id=?", attributes['execution.id'], row.run_id);
      if (execution?.attempt_id) return attemptAccess(execution.attempt_id);
    }
    if (typeof attributes['collaboration.dispatch.id'] === 'string') {
      // Historical Spans without an Attempt binding cannot be declassified by a later retry.
      const attempts = all<{ id: string }>('SELECT id FROM collaboration_attempts WHERE dispatch_id=? AND run_id=?', attributes['collaboration.dispatch.id'], row.run_id);
      if (attempts.length) return intersectMessageAccess(attempts.map(attempt => attemptAccess(attempt.id)));
    }
    current = row.parent_id;
  }
  // 未绑定来源的审计输出不能在含私密信息的 Run 中被当作公开证据。
  return runId ? unboundRunAccess(runId) : publicAccess();
}

export function assertMessageAccess(policy: MessageAccess, viewerId: string, subject = '内容'): void {
  if (!isMessageVisibleTo(policy, viewerId)) throw new Error(`${subject}不在当前成员的可见范围内`);
}

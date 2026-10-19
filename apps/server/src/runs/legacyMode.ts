import { isLegacyRunMode, type LegacyRunMode } from '@agent-gand/shared';
import { get } from '../db/database.ts';

/** Legacy lifecycle code must never infer authority from an unfamiliar mode. */
export function assertLegacyMode(mode: unknown): asserts mode is LegacyRunMode {
  if (!isLegacyRunMode(mode)) throw Object.assign(new Error('此运行模式必须通过专用生命周期入口操作'), {
    status: 409, code: 'LEGACY_MODE_REQUIRED',
  });
}

/** Also fence inconsistent or partially written records; mode alone is not authority. */
export const legacyRunIdsSql = `SELECT r.id FROM runs r
  WHERE r.mode IN ('pipeline','supervisor','collaboration')
    AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id=r.conversation_id
      AND c.mode NOT IN ('pipeline','supervisor','collaboration'))
    AND NOT EXISTS (SELECT 1 FROM threaded_threads t WHERE t.conversation_id=r.conversation_id)
    AND NOT EXISTS (SELECT 1 FROM threaded_run_bindings b WHERE b.run_id=r.id)`;

export function isLegacyRun(runId: string): boolean {
  return !!get(`${legacyRunIdsSql} AND r.id=?`, runId);
}

/** Missing records retain each caller's existing not-found behavior. */
export function assertLegacyRun(runId: string): void {
  const row = get<{ mode: string }>('SELECT mode FROM runs WHERE id=?', runId);
  if (row && !isLegacyRun(runId)) assertLegacyMode(undefined);
}

export function assertLegacyConversation(conversationId: string): void {
  const row = get<{ mode: string }>('SELECT mode FROM conversations WHERE id=?', conversationId);
  if (row) assertLegacyMode(row.mode);
  if (get('SELECT 1 FROM threaded_threads WHERE conversation_id=?', conversationId)) assertLegacyMode(undefined);
}

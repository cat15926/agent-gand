import type { RoomPreferences } from './conversation.ts';
import type { RunMode } from './run.ts';

export const ROOM_PREFERENCES_VERSION = 1 as const;

export function isRoomPreferences(value: unknown): value is RoomPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string,unknown>, constraints = item.constraints;
  if (!['auto','parallel','serial'].includes(String(item.strategy)) || !['routine','analysis_summary','development_review','supervisor_decomposition','bounded_debate'].includes(String(item.workflow))
    || !constraints || typeof constraints !== 'object' || Array.isArray(constraints)) return false;
  if (['supervisorId','defaultReviewerId','aggregatorId'].some(k => item[k] !== null && typeof item[k] !== 'string')) return false;
  for (const [key,entry] of Object.entries(constraints)) {
    if (key === 'readonly') { if (typeof entry !== 'boolean') return false; }
    else if (!['rounds','maxTokens','deadlineMs'].includes(key) || typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 1
      || entry > (key === 'rounds' ? 10 : key === 'deadlineMs' ? 86400000 : 1000000)) return false;
  }
  return true;
}

/** Shared mapping for persisted rooms and browser drafts. Never replan an existing Run. */
export function legacyRoomPreferences(mode: RunMode | 'auto', supervisorId: string | null = null,
  defaultReviewerId: string | null = null): RoomPreferences {
  return { strategy: mode === 'pipeline' ? 'serial' : 'auto',
    workflow: mode === 'supervisor' ? 'supervisor_decomposition' : 'routine', constraints: {},
    supervisorId, defaultReviewerId, aggregatorId: null };
}

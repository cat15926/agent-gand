import type { RunMode } from '@agent-gand/shared';
export interface RoomDraft { goal: string; selected: string[]; initialTargets: string[]; mode: 'auto' | RunMode; supervisorId: string; defaultReviewerId: string; workspace: string }
const key = 'gand:room-draft:v1';
export function readRoomDraft(): RoomDraft | null {
  try {
    const draft = JSON.parse(sessionStorage.getItem(key) ?? 'null') as RoomDraft | null;
    if (!draft || typeof draft.goal !== 'string' || !Array.isArray(draft.selected) || !draft.selected.every((id) => typeof id === 'string')
      || !Array.isArray(draft.initialTargets) || !draft.initialTargets.every((id) => typeof id === 'string')
      || ![draft.supervisorId, draft.defaultReviewerId, draft.workspace].every((value) => typeof value === 'string')
      || !['auto', 'pipeline', 'supervisor', 'collaboration'].includes(draft.mode)) return null;
    return { goal: draft.goal, selected: draft.selected, initialTargets: draft.initialTargets, mode: draft.mode,
      supervisorId: draft.supervisorId, defaultReviewerId: draft.defaultReviewerId, workspace: draft.workspace };
  } catch { return null; }
}
export function writeRoomDraft(draft: RoomDraft): void { try { sessionStorage.setItem(key, JSON.stringify(draft)); } catch { /* The live composer remains usable. */ } }
export function clearRoomDraft(): void { try { sessionStorage.removeItem(key); } catch { /* Do not fail a successfully created room because browser storage is unavailable. */ } }
export function addRoleToRoomDraft(id: string): void {
  const draft = readRoomDraft() ?? { goal: '', selected: [], initialTargets: [], mode: 'auto', supervisorId: '', defaultReviewerId: '', workspace: '' };
  writeRoomDraft({ ...draft, selected: [...new Set([...draft.selected, id])] });
}

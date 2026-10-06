import { ORCHESTRATION_STRATEGIES, ORCHESTRATION_WORKFLOWS, legacyRoomPreferences, type RoomPreferences, type RunMode } from '@agent-gand/shared';
export interface RoomDraft extends RoomPreferences {
  version: 2; goal: string; selected: string[]; initialTargets: string[]; workspace: string; title: string;
  legacyMode?: 'auto' | RunMode; recoveryNotice?: string;
}
const key = 'gand:room-draft:v2';
const oldKey = 'gand:room-draft:v1';
export const emptyPreferences = (): RoomPreferences => ({ strategy: 'auto', workflow: 'routine', constraints: {}, supervisorId: null, defaultReviewerId: null, aggregatorId: null });
function preserveRecovery(raw: string): boolean { try { sessionStorage.setItem('gand:room-draft:recovery',raw); return true; } catch { return false; } }
const strings = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string'))] : [];
export function readRoomDraft(): RoomDraft | null {
  try {
    const current = sessionStorage.getItem(key); const raw = current ?? sessionStorage.getItem(oldKey);
    if (!raw) return null;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(raw); } catch {
      const preserved = preserveRecovery(raw);
      return { ...emptyPreferences(), version: 2, goal: '', selected: [], initialTargets: [], workspace: '', title: '', recoveryNotice: preserved ? '草稿格式损坏，原始内容已保留；可复制恢复内容后继续编辑。' : '草稿格式损坏，浏览器无法保存恢复副本。' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
    const previousMode = parsed.legacyMode ?? parsed.mode;
    const legacyMode = ['auto','pipeline','supervisor','collaboration'].includes(String(previousMode)) ? previousMode as 'auto' | RunMode : undefined;
    const damaged = typeof parsed.goal !== 'string' || !Array.isArray(parsed.selected) || parsed.selected.some((v: unknown) => typeof v !== 'string') || !Array.isArray(parsed.initialTargets) || parsed.initialTargets.some((v: unknown) => typeof v !== 'string') || typeof parsed.workspace !== 'string' || Boolean(current && (parsed.version !== 2 || !ORCHESTRATION_STRATEGIES.includes(parsed.strategy as RoomPreferences['strategy']) || !ORCHESTRATION_WORKFLOWS.includes(parsed.workflow as RoomPreferences['workflow'])));
    const preserved = damaged ? preserveRecovery(raw) : false;
    const constraints = parsed.constraints && typeof parsed.constraints === 'object' ? parsed.constraints as Record<string, unknown> : {};
    const result: RoomDraft = { ...emptyPreferences(), version: 2, goal: typeof parsed.goal === 'string' ? parsed.goal : '', selected: strings(parsed.selected), initialTargets: strings(parsed.initialTargets),
      title: typeof parsed.title === 'string' ? parsed.title : '', workspace: typeof parsed.workspace === 'string' ? parsed.workspace : '',
      strategy: ORCHESTRATION_STRATEGIES.includes(parsed.strategy as RoomPreferences['strategy']) ? parsed.strategy as RoomPreferences['strategy'] : legacyRoomPreferences(legacyMode ?? 'auto').strategy,
      workflow: ORCHESTRATION_WORKFLOWS.includes(parsed.workflow as RoomPreferences['workflow']) ? parsed.workflow as RoomPreferences['workflow'] : legacyRoomPreferences(legacyMode ?? 'auto').workflow,
      supervisorId: typeof parsed.supervisorId === 'string' ? parsed.supervisorId : null,
      defaultReviewerId: typeof parsed.defaultReviewerId === 'string' ? parsed.defaultReviewerId : null,
      aggregatorId: typeof parsed.aggregatorId === 'string' ? parsed.aggregatorId : null,
      constraints: { ...(typeof constraints.readonly === 'boolean' ? { readonly: constraints.readonly } : {}),
        ...Object.fromEntries(['rounds','maxTokens','deadlineMs'].filter(k => typeof constraints[k] === 'number' && Number.isSafeInteger(constraints[k]) && (constraints[k] as number) > 0).map(k => [k,constraints[k]])) },
      ...(legacyMode ? { legacyMode } : {}),
      ...(damaged ? { recoveryNotice: `草稿部分字段损坏，已恢复可识别的目标、团队和工作区；${preserved ? '原始内容已保留。' : '浏览器无法保存恢复副本。'}` } : !current ? { recoveryNotice: `已升级旧草稿，保留目标、成员与工作区；原偏好“${legacyMode ?? 'auto'}”已映射为本轮策略和工作流。` } : {}) };
    return result;
  } catch { return { ...emptyPreferences(), version: 2, goal: '', selected: [], initialTargets: [], workspace: '', title: '', recoveryNotice: '浏览器草稿存储不可用，当前输入仍可使用。' }; }
}
export function writeRoomDraft(draft: RoomDraft): void { try { sessionStorage.setItem(key, JSON.stringify(draft)); } catch { /* Live input remains usable. */ } }
export function clearRoomDraft(): void { try { sessionStorage.removeItem(key); sessionStorage.removeItem(oldKey); } catch { /* A completed request stays completed. */ } }
export function addRoleToRoomDraft(id: string): void {
  const draft = readRoomDraft() ?? { ...emptyPreferences(), version: 2 as const, goal: '', selected: [], initialTargets: [], workspace: '', title: '' };
  writeRoomDraft({ ...draft, selected: [...new Set([...draft.selected, id])] });
}
export function recoveryDraftText(): string { try { return sessionStorage.getItem('gand:room-draft:recovery') ?? ''; } catch { return ''; } }

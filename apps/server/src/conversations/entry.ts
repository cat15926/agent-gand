import type { RoomPreferences } from '@agent-gand/shared';
import { objectInput, normalizeOrchestrationRequest, OrchestrationError, stringIds } from '../orchestration/normalize.ts';
import { orchestrationCapabilities } from '../orchestration/capabilities.ts';
import { createConversation } from './service.ts';
import { tx } from '../db/database.ts';

export function validateRoomPreferences(value: unknown, agentIds: string[]): RoomPreferences {
  const raw = objectInput(value);
  if (Object.keys(raw).some(k => !['strategy','workflow','constraints','supervisorId','defaultReviewerId','aggregatorId'].includes(k))) throw new OrchestrationError(400,'INVALID_PREFERENCES','默认偏好包含未知字段');
  const normalized = normalizeOrchestrationRequest({ ...raw, goal: '保存房间默认偏好', agentIds } as Parameters<typeof normalizeOrchestrationRequest>[0], 'unified_preview');
  for (const id of [normalized.supervisorId, normalized.defaultReviewerId, normalized.aggregatorId]) {
    if (id && !agentIds.includes(id)) throw new OrchestrationError(400,'TARGET_OUTSIDE_TEAM','默认角色必须属于房间团队');
  }
  if ((normalized.constraints.rounds ?? 1) > 10) throw new OrchestrationError(400,'INVALID_PREFERENCES','辩论轮数最多 10 轮');
  return { strategy: normalized.strategy, workflow: normalized.workflow, constraints: normalized.constraints,
    supervisorId: normalized.supervisorId, defaultReviewerId: normalized.defaultReviewerId, aggregatorId: normalized.aggregatorId };
}

/** No Run, model, driver, reservation or workspace mutation on empty room creation. */
export function createEmptyRoom(value: unknown) {
  const raw = objectInput(value);
  if (Object.keys(raw).some(k => !['title','agentIds','workspace','preferences'].includes(k))) throw new OrchestrationError(400,'UNKNOWN_FIELD','空房间请求包含未知字段');
  if (typeof raw.title !== 'string' || !raw.title.trim() || raw.title.trim().length > 80) throw new OrchestrationError(400,'INVALID_TITLE','房间名称必填且长度不超过 80');
  const agentIds = stringIds(raw.agentIds, 'agentIds', true);
  const preferences = validateRoomPreferences(raw.preferences ?? {}, agentIds);
  if (raw.workspace != null && typeof raw.workspace !== 'string') throw new OrchestrationError(400,'INVALID_WORKSPACE','工作区无效');
  const workspace = raw.workspace as string | null | undefined;
  orchestrationCapabilities(agentIds, workspace || null);
  return tx(() => createConversation({ title: (raw.title as string).trim(), mode: 'collaboration', agentIds,
    workspace: workspace || null, stableWorkspace: !workspace, supervisorId: preferences.supervisorId,
    defaultReviewerId: preferences.defaultReviewerId, preferences }));
}

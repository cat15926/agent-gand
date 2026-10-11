import { createHash, randomUUID } from 'node:crypto';
import { managedPath } from './path.ts';
export { managedPath } from './path.ts';
import { isMessageVisibleTo, isMessageWithinScope, type MessageAccess } from '@agent-gand/shared';
import { all, get, run, tx } from '../db/database.ts';
import { attemptAccess, runSourceAccess } from '../messaging/access.ts';
import { sealManagedContent, openManagedContent } from '../accounts/credentials.ts';
import { OrchestrationError } from '../orchestration/errors.ts';
import type { ToolContext } from '../tools/types.ts';

export interface ManagedArtifact extends MessageAccess {
  id: string; conversationId: string; runId: string; taskId: string | null; attemptId: string | null;
  stageId: string | null; acceptanceVersion: number | null; path: string; version: number;
  sha256: string; size: number; mimeType: string; createdBy: string; createdAt: string; releasedFrom: string | null;
  restoredFrom?: {snapshotId:string;artifactId:string};
}
interface Row { id: string; conversation_id: string; run_id: string; path: string; version: number; record: string; content: string }
const fail = (code: string, message: string): never => { throw new OrchestrationError(409, code, message); };
function metadata(row: Row): ManagedArtifact {
  const item = JSON.parse(row.record) as ManagedArtifact;
  if (item.id !== row.id || item.conversationId !== row.conversation_id || item.runId !== row.run_id || item.path !== row.path || item.version !== row.version) fail('ARTIFACT_CORRUPTED','文件元数据绑定校验失败');
  const bytes = openManagedContent(row.content,row.record);
  if (bytes.length !== item.size || createHash('sha256').update(bytes).digest('hex') !== item.sha256) fail('ARTIFACT_CORRUPTED','文件内容或权限校验失败');
  return item;
}
export function artifactContext(ctx: ToolContext): { conversationId: string; access: MessageAccess } {
  const room = get<{ conversation_id: string }>('SELECT conversation_id FROM runs WHERE id=?', ctx.runId);
  // Legacy standalone tools have no room binding and cannot see managed artifacts.
  if (!room?.conversation_id) {
    if (ctx.attemptId) fail('ARTIFACT_RUN_MISSING', '文件来源任务不存在');
    return { conversationId: '', access: { visibility: 'public', audience: [] } };
  }
  if (ctx.attemptId) {
    const owner = get<{ run_id: string; agent_id: string }>('SELECT run_id,agent_id FROM collaboration_attempts WHERE id=?', ctx.attemptId)
      ?? get<{ run_id: string; agent_id: string }>(`SELECT a.run_id,json_extract(s.value,'$.agentId') agent_id FROM coordination_step_attempts a JOIN coordination_plan_revisions p ON p.plan_id=a.plan_id AND p.revision=a.revision, json_each(p.payload,'$.plan.steps') s WHERE a.id=? AND json_extract(s.value,'$.id')=a.step_id`, ctx.attemptId)
      ?? get<{ run_id: string; agent_id: string }>('SELECT run_id,agent_id FROM task_attempts WHERE id=?', ctx.attemptId);
    if (!owner || owner.run_id !== ctx.runId || owner.agent_id !== ctx.agentId) fail('ARTIFACT_ATTEMPT_INVALID', '文件访问缺少有效执行绑定');
  }
  const access = ctx.attemptId ? attemptAccess(ctx.attemptId) : runSourceAccess(ctx.runId);
  if (!isMessageVisibleTo(access, ctx.agentId)) fail('ARTIFACT_ACCESS_DENIED', '文件不在当前授权范围内');
  return { conversationId: room!.conversation_id, access };
}
function allowed(item: ManagedArtifact, viewerId: string, scope?: MessageAccess): boolean {
  return isMessageVisibleTo(item, viewerId) && (!scope || isMessageWithinScope(item, scope));
}
export function listManagedArtifacts(conversationId: string, viewerId = 'user', scope?: MessageAccess): ManagedArtifact[] {
  return all<Row>('SELECT * FROM managed_artifact_versions WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC', conversationId)
    .map(metadata).filter(item => allowed(item, viewerId, scope));
}
export function getManagedArtifact(id: string, viewerId = 'user', scope?: MessageAccess): ManagedArtifact {
  const row = get<Row>('SELECT * FROM managed_artifact_versions WHERE id=?', id);
  if (!row || !allowed(metadata(row), viewerId, scope)) fail('ARTIFACT_ACCESS_DENIED', '文件不存在或不在当前授权范围内');
  return metadata(row!);
}
export function readManagedArtifact(id: string, viewerId = 'user', scope?: MessageAccess): Buffer {
  const item = getManagedArtifact(id, viewerId, scope);
  const row = get<Row>('SELECT * FROM managed_artifact_versions WHERE id=?', id)!;
  // Authenticated metadata detects ACL/hash/provenance tampering before content is returned.
  const content = openManagedContent(row.content, row.record);
  if (content.length !== item.size || createHash('sha256').update(content).digest('hex') !== item.sha256) fail('ARTIFACT_CORRUPTED', '文件内容或权限校验失败');
  return content;
}
/** Return null only for a genuinely unmanaged path; an unauthorized known path never falls through. */
export function findManagedArtifact(ctx: ToolContext, rel: string): ManagedArtifact | null {
  const { conversationId, access } = artifactContext(ctx);
  const rows = all<Row>('SELECT * FROM managed_artifact_versions WHERE conversation_id=? AND path=? ORDER BY version DESC', conversationId, rel);
  if (!rows.length) return null;
  const item = rows.map(metadata).find(item => allowed(item, ctx.agentId, access));
  if (!item) fail('ARTIFACT_ACCESS_DENIED', '文件不存在或不在当前授权范围内');
  return item!;
}
export function createManagedArtifact(input: { runId: string; path: string; content: Buffer; access: MessageAccess;
  createdBy: string; attemptId?: string; stageId?: string; mimeType?: string; releasedFrom?: string; restoredFrom?:ManagedArtifact['restoredFrom'] }): ManagedArtifact {
  return tx(() => {
    const source = get<{ conversation_id: string }>('SELECT conversation_id FROM runs WHERE id=?', input.runId);
    if (!source) fail('ARTIFACT_RUN_MISSING', '文件来源任务不存在');
    const rel = managedPath(input.path);
    if (input.content.length > 256 * 1024) fail('ARTIFACT_TOO_LARGE', '单个受控文件最多 256 KiB');
    const members = get<{ agent_ids: string }>('SELECT agent_ids FROM conversations WHERE id=?', source!.conversation_id);
    const audience = input.access.visibility === 'private' ? [...new Set(['user', ...input.access.audience])].sort() : [];
    if (audience.some(id => id !== 'user' && !JSON.parse(members?.agent_ids ?? '[]').includes(id))) fail('ARTIFACT_AUDIENCE_INVALID', '文件获准成员必须属于当前房间');
    const attempt = input.attemptId ? get<{ task_id: string | null }>('SELECT task_id FROM task_attempts WHERE id=?', input.attemptId) : undefined;
    const step = input.attemptId ? get<{ stage_id: string | null }>(`SELECT json_extract(s.value,'$.metadata.businessStageId') stage_id FROM coordination_step_attempts a JOIN coordination_plan_revisions p ON p.plan_id=a.plan_id AND p.revision=a.revision, json_each(p.payload,'$.plan.steps') s WHERE a.id=? AND json_extract(s.value,'$.id')=a.step_id`, input.attemptId) : undefined;
    const item: ManagedArtifact = { id: randomUUID(), conversationId: source!.conversation_id, runId: input.runId,
      taskId: attempt?.task_id ?? null, attemptId: input.attemptId ?? null, stageId: input.stageId ?? step?.stage_id ?? null,
      acceptanceVersion: get<{ version: number }>('SELECT MAX(version) version FROM business_acceptance_events WHERE run_id=?', input.runId)?.version ?? null,
      path: rel, version: (get<{ n: number }>('SELECT MAX(version) n FROM managed_artifact_versions WHERE conversation_id=? AND path=?', source!.conversation_id, rel)?.n ?? 0) + 1,
      visibility: input.access.visibility, audience, sha256: createHash('sha256').update(input.content).digest('hex'), size: input.content.length,
      mimeType: input.mimeType ?? 'text/plain', createdBy: input.createdBy, createdAt: new Date().toISOString(), releasedFrom: input.releasedFrom ?? null,
      ...(input.restoredFrom?{restoredFrom:input.restoredFrom}:{}) };
    const record = JSON.stringify(item);
    run('INSERT INTO managed_artifact_versions(id,conversation_id,run_id,path,version,record,content,created_at) VALUES(?,?,?,?,?,?,?,?)',
      item.id, item.conversationId, item.runId, item.path, item.version, record, sealManagedContent(input.content, record), item.createdAt);
    return item;
  });
}
export function writePrivateArtifact(ctx: ToolContext, rel: string, content: string): ManagedArtifact | null {
  const { access } = artifactContext(ctx);
  if (access.visibility !== 'private') return null;
  return createManagedArtifact({ runId: ctx.runId, path: rel, content: Buffer.from(content), access, createdBy: ctx.agentId, attemptId: ctx.attemptId });
}
/** Owner-only publication creates a new immutable version; models have no authorization tool. */
export function releaseManagedArtifact(id: string, input: { expectedVersion: number; visibility: 'public' | 'private'; audience: string[]; reason: string }, owner: string): ManagedArtifact {
  return tx(() => {
    const source = getManagedArtifact(id);
    const latest = get<{ n: number }>('SELECT MAX(version) n FROM managed_artifact_versions WHERE conversation_id=? AND path=?', source.conversationId, source.path)?.n;
    if (source.version !== input.expectedVersion || latest !== source.version) fail('ARTIFACT_STALE', '文件版本已变化，请刷新后重新确认');
    if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500 || !['public','private'].includes(input.visibility) || !Array.isArray(input.audience) || input.audience.length > 32 || input.audience.some(id => typeof id !== 'string' || !id || id.length > 100) || input.visibility === 'public' && input.audience.length > 0) fail('ARTIFACT_RELEASE_INVALID', '扩大授权需要明确范围与原因');
    if (source.visibility === 'public' || input.visibility === 'private' && source.audience.some(id => id !== 'user' && !input.audience.includes(id))) fail('ARTIFACT_RELEASE_INVALID', '该入口仅用于明确扩大授权；旧文件版本的权限保持冻结');
    const item = createManagedArtifact({ runId: source.runId, path: source.path, content: readManagedArtifact(source.id), access: input,
      createdBy: 'user', attemptId: source.attemptId ?? undefined, stageId: source.stageId ?? undefined, mimeType: source.mimeType, releasedFrom: source.id });
    run('INSERT INTO artifact_authorization_audits(id,source_id,released_id,owner,reason,created_at) VALUES(?,?,?,?,?,?)', randomUUID(), source.id, item.id, owner, input.reason.trim(), item.createdAt);
    return item;
  });
}

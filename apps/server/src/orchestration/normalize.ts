import { managedPath } from '../artifacts/path.ts';
import { createHash } from 'node:crypto';
import { normalizeBusinessContract } from './businessContract.ts';
import { normalizeCostPolicy } from './costPolicy.ts';
import {
  ORCHESTRATION_STRATEGIES, ORCHESTRATION_WORKFLOWS,
  type Conversation, type CoordinationProtocolId, type OrchestrationConstraints,
  type OrchestrationPreviewInput, type OrchestrationRequest, type OrchestrationSource, type OrchestrationWorkflow, type RunMode,
} from '@agent-gand/shared';

import { OrchestrationError } from './errors.ts';
export { OrchestrationError } from './errors.ts';

export function stableDigest(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)])) : item;
  return createHash('sha256').update(JSON.stringify(sort(value))).digest('hex');
}

export function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OrchestrationError(400, 'INVALID_REQUEST', '请求必须是对象');
  return value as Record<string, unknown>;
}

export function stringIds(value: unknown, name: string, required = false): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || (required && !value.length) || value.length > 32 || value.some(id => typeof id !== 'string' || !id.trim() || id.length > 100)) throw new OrchestrationError(400, 'INVALID_MEMBERS', `${name} 必须是${required ? '非空' : ''}字符串数组，最多 32 个`);
  if (new Set(value).size !== value.length) throw new OrchestrationError(400, 'DUPLICATE_MEMBERS', `${name} 不能包含重复成员`);
  return [...value] as string[];
}

function optionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 100) throw new OrchestrationError(400, 'INVALID_FIELD', `${field} 无效`);
  return value;
}

export function workflowForProtocol(protocol: CoordinationProtocolId | null): OrchestrationWorkflow {
  if (protocol === 'review_revision') return 'development_review';
  if (protocol === 'supervisor_aggregation') return 'analysis_summary';
  if (protocol === 'supervisor_dag') return 'supervisor_decomposition';
  if (protocol === 'debate') return 'bounded_debate';
  return 'routine';
}

export function normalizeOrchestrationRequest(input: OrchestrationPreviewInput, source: OrchestrationSource, context: {
  conversation?: Conversation;
  mode?: RunMode;
  requestedProtocol?: CoordinationProtocolId | null;
  coordinationDraftId?: string | null;
  followupRouting?: 'room_mode' | null;
} = {}): OrchestrationRequest {
  if (typeof input.goal !== 'string' || !input.goal.trim()) throw new OrchestrationError(400, 'MISSING_GOAL', 'goal 必填');
  const room = context.conversation;
  if (input.conversationId && room && input.conversationId !== room.id) throw new OrchestrationError(409, 'ROOM_MISMATCH', '聊天室已改变');
  const suppliedTeam = input.agentIds === undefined ? undefined : stringIds(input.agentIds, 'agentIds', true);
  if (room && suppliedTeam && JSON.stringify(suppliedTeam) !== JSON.stringify(room.agentIds)) throw new OrchestrationError(409, 'TEAM_CHANGED', '团队与当前聊天室不一致，请先更新聊天室成员');
  const agentIds = stringIds(room?.agentIds ?? suppliedTeam, 'agentIds', true);
  const recipientIds = stringIds(input.recipientIds, 'recipientIds');
  if (recipientIds.some(id => !agentIds.includes(id))) throw new OrchestrationError(400, 'TARGET_OUTSIDE_TEAM', 'recipientIds 必须全部属于当前团队');
  if (input.visibility !== undefined && !['public','private'].includes(input.visibility)) throw new OrchestrationError(400, 'INVALID_VISIBILITY', 'visibility 必须为 public 或 private');
  const audience = stringIds(input.audience, 'audience').filter(id => id !== 'user');
  if (audience.some(id => !agentIds.includes(id))) throw new OrchestrationError(400, 'AUDIENCE_OUTSIDE_TEAM', '获准成员必须属于当前团队');
  if (input.visibility !== 'private' && audience.length) throw new OrchestrationError(400, 'PUBLIC_AUDIENCE_CONFLICT', '公开任务不能携带私密授权范围');
  if (input.visibility === 'private' && !audience.length) throw new OrchestrationError(400, 'PRIVATE_AUDIENCE_REQUIRED', '请选择至少一位获准成员');
  const mode = context.mode ?? room?.mode ?? 'collaboration';
  if (!['pipeline', 'supervisor', 'collaboration'].includes(mode)) throw new OrchestrationError(400, 'INVALID_MODE', 'mode 必须是 pipeline|supervisor|collaboration');
  const protocol = context.requestedProtocol ?? null;
  const strategy = input.strategy ?? (protocol === 'parallel_fanout' || protocol === 'supervisor_aggregation' ? 'parallel' : protocol === 'sequential_pipeline' || mode === 'pipeline' ? 'serial' : 'auto');
  const workflow = input.workflow ?? (protocol ? workflowForProtocol(protocol) : mode === 'supervisor' ? 'supervisor_decomposition' : 'routine');
  if (!ORCHESTRATION_STRATEGIES.includes(strategy)) throw new OrchestrationError(400, 'INVALID_STRATEGY', 'strategy 不受支持');
  if (!ORCHESTRATION_WORKFLOWS.includes(workflow)) throw new OrchestrationError(400, 'INVALID_WORKFLOW', 'workflow 不受支持');
  const workspace = input.workspace === undefined ? room?.workspace ?? null : input.workspace;
  if (workspace !== null && typeof workspace !== 'string') throw new OrchestrationError(400, 'INVALID_WORKSPACE', 'workspace 无效');
  if (room && input.workspace !== undefined && (workspace || null) !== room.workspace) throw new OrchestrationError(409, 'WORKSPACE_CHANGED', 'workspace 与当前聊天室不一致');
  const clientRequestId = optionalId(input.clientRequestId, 'clientRequestId');
  if (clientRequestId && clientRequestId.length < 8) throw new OrchestrationError(400, 'INVALID_IDEMPOTENCY_KEY', 'clientRequestId 长度必须为 8～100');
  if (input.wholeTeam !== undefined && typeof input.wholeTeam !== 'boolean') throw new OrchestrationError(400, 'INVALID_FIELD', 'wholeTeam 无效');
  const constraints: OrchestrationConstraints = {};
  if (input.constraints !== undefined) {
    const raw = objectInput(input.constraints);
    if (Object.keys(raw).some(key => !['readonly', 'maxTokens', 'costPolicy', 'deadlineMs', 'rounds', 'firstResponseTimeoutMs', 'idleTimeoutMs'].includes(key))) throw new OrchestrationError(400, 'INVALID_CONSTRAINT', 'constraints 包含未知限制');
    if (raw.costPolicy !== undefined) constraints.costPolicy = normalizeCostPolicy(raw.costPolicy);
    if (raw.readonly !== undefined) { if (typeof raw.readonly !== 'boolean') throw new OrchestrationError(400, 'INVALID_CONSTRAINT', 'readonly 必须为布尔值'); constraints.readonly = raw.readonly; }
    for (const key of ['maxTokens', 'deadlineMs', 'rounds', 'firstResponseTimeoutMs', 'idleTimeoutMs'] as const) if (raw[key] !== undefined) {
      const value = raw[key];
      const maximum = key === 'rounds' ? 20 : key === 'maxTokens' ? 1_000_000 : 86_400_000;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new OrchestrationError(400, 'INVALID_CONSTRAINT', `${key} 必须为 1～${maximum} 的整数`);
      constraints[key] = value;
    }
  }
  const businessContract = input.businessContract != null ? normalizeBusinessContract(input.businessContract) : null;
  if (businessContract?.stages.some(s => s.execution?.maxCost !== undefined) && !constraints.costPolicy) throw new OrchestrationError(400, 'COST_POLICY_REQUIRED', '阶段费用上限需先设置本轮费用政策，币种和未知费用政策统一继承');
  if (constraints.costPolicy?.prices.some(p => !agentIds.includes(p.agentId))) throw new OrchestrationError(400, 'INVALID_COST_POLICY', '价格成员必须属于本轮团队');
  let attachments: OrchestrationRequest['attachments'];
  if (input.attachments !== undefined) {
    if (!Array.isArray(input.attachments) || input.attachments.length > 4) throw new OrchestrationError(400,'INVALID_ATTACHMENTS','每轮最多 4 个附件');
    attachments = input.attachments.map(file => {
      if (!file || Object.keys(file).some(key => !['path','contentBase64','mimeType'].includes(key)) || typeof file.path !== 'string' || typeof file.contentBase64 !== 'string' || file.contentBase64.length > 350000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentBase64)) throw new OrchestrationError(400,'INVALID_ATTACHMENTS','附件需要合法路径与 Base64 内容');
      const bytes = Buffer.from(file.contentBase64,'base64');
      if (bytes.length > 256 * 1024 || file.mimeType !== undefined && (typeof file.mimeType !== 'string' || file.mimeType.length > 100)) throw new OrchestrationError(400,'INVALID_ATTACHMENTS','附件最多 256 KiB，类型最多 100 字符');
      return { path: managedPath(file.path), sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, mimeType: file.mimeType ?? 'application/octet-stream' };
    });
    if (new Set(attachments.map(file => file.path)).size !== attachments.length) throw new OrchestrationError(400,'INVALID_ATTACHMENTS','本轮附件路径不能重复');
  }
  return {
    ...(attachments?.length ? { attachments } : {}),
    schemaVersion: 1, source, conversationId: room?.id ?? optionalId(input.conversationId, 'conversationId'), membersVersion: room?.membersVersion ?? null,
    goal: input.goal.trim(), agentIds, recipientIds, ...(input.visibility !== undefined ? { visibility: input.visibility, audience: input.visibility === 'private' ? ['user', ...audience].sort() : [] } : {}), strategy, workflow, workspace: workspace || null,
    supervisorId: optionalId(input.supervisorId !== undefined ? input.supervisorId : room?.supervisorId, 'supervisorId'),
    defaultReviewerId: optionalId(input.defaultReviewerId !== undefined ? input.defaultReviewerId : room?.defaultReviewerId, 'defaultReviewerId'),
    aggregatorId: optionalId(input.aggregatorId, 'aggregatorId'), replyTo: optionalId(input.replyTo, 'replyTo'), taskId: optionalId(input.taskId, 'taskId'),
    clientRequestId, wholeTeam: input.wholeTeam === true, constraints,
    ...(businessContract ? { businessContract } : {}),
    legacy: { mode, coordinationDraftId: context.coordinationDraftId ?? null, requestedProtocol: protocol, followupRouting: context.followupRouting ?? null },
  };
}

/** Routing source and request IDs do not change the semantic preview. */
export function semanticRequest(request: OrchestrationRequest): Omit<OrchestrationRequest, 'source' | 'clientRequestId'> {
  const { source: _source, clientRequestId: _key, ...semantic } = request;
  return semantic;
}

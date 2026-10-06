import { createHash } from 'node:crypto';
import {
  ORCHESTRATION_STRATEGIES, ORCHESTRATION_WORKFLOWS,
  type Conversation, type CoordinationProtocolId, type OrchestrationConstraints,
  type OrchestrationPreviewInput, type OrchestrationRequest, type OrchestrationSource, type OrchestrationWorkflow, type RunMode,
} from '@agent-gand/shared';

export class OrchestrationError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

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
    if (Object.keys(raw).some(key => !['readonly', 'maxTokens', 'deadlineMs', 'rounds'].includes(key))) throw new OrchestrationError(400, 'INVALID_CONSTRAINT', 'constraints 包含未知限制');
    if (raw.readonly !== undefined) { if (typeof raw.readonly !== 'boolean') throw new OrchestrationError(400, 'INVALID_CONSTRAINT', 'readonly 必须为布尔值'); constraints.readonly = raw.readonly; }
    for (const key of ['maxTokens', 'deadlineMs', 'rounds'] as const) if (raw[key] !== undefined) {
      const value = raw[key];
      const maximum = key === 'rounds' ? 20 : key === 'deadlineMs' ? 86_400_000 : 1_000_000;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new OrchestrationError(400, 'INVALID_CONSTRAINT', `${key} 必须为 1～${maximum} 的整数`);
      constraints[key] = value;
    }
  }
  return {
    schemaVersion: 1, source, conversationId: room?.id ?? optionalId(input.conversationId, 'conversationId'), membersVersion: room?.membersVersion ?? null,
    goal: input.goal.trim(), agentIds, recipientIds, strategy, workflow, workspace: workspace || null,
    supervisorId: optionalId(input.supervisorId !== undefined ? input.supervisorId : room?.supervisorId, 'supervisorId'),
    defaultReviewerId: optionalId(input.defaultReviewerId !== undefined ? input.defaultReviewerId : room?.defaultReviewerId, 'defaultReviewerId'),
    aggregatorId: optionalId(input.aggregatorId, 'aggregatorId'), replyTo: optionalId(input.replyTo, 'replyTo'), taskId: optionalId(input.taskId, 'taskId'),
    clientRequestId, wholeTeam: input.wholeTeam === true, constraints,
    legacy: { mode, coordinationDraftId: context.coordinationDraftId ?? null, requestedProtocol: protocol, followupRouting: context.followupRouting ?? null },
  };
}

/** Routing source and request IDs do not change the semantic preview. */
export function semanticRequest(request: OrchestrationRequest): Omit<OrchestrationRequest, 'source' | 'clientRequestId'> {
  const { source: _source, clientRequestId: _key, ...semantic } = request;
  return semantic;
}

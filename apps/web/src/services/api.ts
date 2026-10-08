/**
 * REST 客户端：对应 server §4.3 的 API 表（dev 经 vite proxy）
 */
import type {
  OrchestrationPreview, OrchestrationPreviewInput, RunOrchestrationSnapshot, RoomPreferences,
  AgentDefinition,
  AgentInput,
  AgentSaveInput,
  AgentPreflight,
  AgentOptions,
  ExternalWorkspaceBinding,
  ApprovalDecision,
  ApprovalRequest,
  Message,
  ConversationHistoryPage, ConversationMessageSearch,
  Run,
  RunRecoveryAssessment,
  RunEvent,
  Task,
  TaskAttempt,
  TaskReview,
  UsageSummary,
  Conversation,
  SendConversationMessageInput,
  McpStatus,
  CollaborationAttempt,
  CollaborationBatch,
  CollaborationBudgetSnapshot,
  CollaborationDispatch,
  CollaborationUserDecision,
  RuntimeCompletionCandidate,
  RuntimeDurableHold,
  RuntimeHoldRecoveryAudit,
  RuntimeEvidenceBundle,
  RuntimeRouteGuardEvent,
  RuntimeResponsibilitySnapshot,
  RuntimeActionCommandRecord,
  RuntimeShadowComparison,
  RuntimeRunTerminalRecord,
  RuntimeSuccessorObligation,
  RuntimeWakeEvent,
  CapabilitySnapshot,
  CoordinationEvent,
  CoordinationPlan,
  CoordinationPlanRevision,
  CoordinationProtocolId,
  CoordinationPreview,
  CoordinationPreviewInput,
  FollowupPreview,
  CoordinationStepAttempt,
  CoordinationStepState,
  ResolveCollaborationDecision,
  RunMode,
  RunObservability,
  RunObservabilitySummary,
  SpanDetail,
} from '@agent-gand/shared';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    // 仅在有 body 时声明 json：Fastify 对"带 content-type 空 body"的 DELETE 返回 500
    // （v0.8 删除按钮"不可用"的根因；同修外部工作区解除注册等同型调用）
    headers: init?.body != null ? { 'content-type': 'application/json' } : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = ''; let errorCode: string | undefined; let fieldErrors: Record<string, string> = {};
    try { const parsed = JSON.parse(text) as { error?: unknown; code?: string; fieldErrors?: Record<string, string> }; detail = String(parsed.error ?? ''); errorCode = parsed.code; fieldErrors = parsed.fieldErrors ?? {}; } catch { detail = text.slice(0, 200); }
    throw new ApiError(detail || `${init?.method ?? 'GET'} ${path} → ${res.status}`, res.status, fieldErrors, errorCode);
  }
  return JSON.parse(text) as T;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public fieldErrors: Record<string, string>, public code?: string) { super(message); }
}

export interface RunDetail {
  run: Run;
  agents: AgentDefinition[];
  events: RunEvent[];
  tasks: Task[];
  messages: Message[];
  approvals: ApprovalRequest[];
  attempts: TaskAttempt[];
  reviews: TaskReview[];
}

export interface ConversationDetail {
  conversation: Conversation;
  runs: Run[];
  messages: Message[];
}

export interface CoordinationRunDetail {
  plan: CoordinationPlan;
  steps: CoordinationStepState[];
  attempts: CoordinationStepAttempt[];
  events: CoordinationEvent[];
  completionCandidates?: RuntimeCompletionCandidate[];
  successorObligations?: RuntimeSuccessorObligation[];
  evidenceBundles?: RuntimeEvidenceBundle[];
  routeGuardEvents?: RuntimeRouteGuardEvent[];
  durableHolds?: RuntimeDurableHold[];
  wakeEvents?: RuntimeWakeEvent[];
  holdRecoveryAudits?: RuntimeHoldRecoveryAudit[];
  responsibilitySnapshots?: RuntimeResponsibilitySnapshot[];
  actionCommands?: RuntimeActionCommandRecord[];
  shadowComparisons?: RuntimeShadowComparison[];
  terminal?: RuntimeRunTerminalRecord | null;
}

export const getConversations = () => request<Conversation[]>('/api/conversations');
export interface OrchestrationAdmission { entryMode: 'execute' | 'preview' | 'closed'; legacyEntryEnabled: boolean; enabledWorkflows: RoomPreferences['workflow'][]; enabledDrivers: string[]; existingRunsContinue: true }
export const getOrchestrationOptions = () => request<{ admission: OrchestrationAdmission }>('/api/orchestration/options');
export interface MemberReservation { runId: string; agentId: string; attemptId: string | null; status: string; position: number }
export interface TaskState { runId: string; revisedGoal: string | null; revisionBlockedReason: string | null; snapshot: RunOrchestrationSnapshot | null; planStatus: string | null; revision: number | null; pauseRequested: boolean; paused: boolean; attention: boolean; reason: string | null; reservations: MemberReservation[]; recovery?: RunRecoveryAssessment }
export const previewOrchestration = (input: OrchestrationPreviewInput) => request<OrchestrationPreview>('/api/orchestration/preview', { method: 'POST', body: JSON.stringify(input) });
export const createEmptyRoom = (input: { title: string; agentIds: string[]; workspace: string | null; preferences: RoomPreferences }) => request<{ conversation: Conversation }>('/api/conversations/empty', { method: 'POST', body: JSON.stringify(input) });
export const submitTask = (input: OrchestrationPreviewInput & { entryVersion: 1; previewId?: string; orchestrationFingerprint?: string; roomTitle?: string; roomPreferences?: RoomPreferences }) => request<{ conversation: Conversation; run: Run }>(input.conversationId ? `/api/conversations/${encodeURIComponent(input.conversationId)}/requests` : '/api/conversations', { method: 'POST', body: JSON.stringify(input) });
export const saveRoomPreferences = (id: string, preferences: RoomPreferences, expectedMembersVersion: number) => request<Conversation>(`/api/conversations/${encodeURIComponent(id)}/preferences`, { method: 'PATCH', body: JSON.stringify({ preferences, expectedMembersVersion }) });
export const getRunOrchestration = (id: string) => request<{ snapshot: RunOrchestrationSnapshot | null }>(`/api/runs/${encodeURIComponent(id)}/orchestration`);
export async function getTaskStates(id: string, runIds?: string[]) {
  if (!runIds) return request<{ tasks: TaskState[] }>(`/api/conversations/${encodeURIComponent(id)}/task-state`);
  const pages = await Promise.all(runChunks(runIds).map(ids => request<{tasks:TaskState[]}>(`/api/conversations/${encodeURIComponent(id)}/task-state?runIds=${encodeURIComponent(ids.join(','))}`)));
  return { tasks: pages.flatMap(page => page.tasks) };
}
function runChunks(ids: string[]): string[][] { return Array.from({length:Math.ceil(ids.length/100)},(_,i) => ids.slice(i*100,(i+1)*100)); }
export const getMemberReservations = () => request<{ reservations: MemberReservation[] }>('/api/orchestration/members');
export const runAction = (id: string, action: 'pause' | 'resume' | 'cancel') => request<Run>(`/api/runs/${encodeURIComponent(id)}/actions`, { method: 'POST', body: JSON.stringify({ action }) });
export interface ContinuationPreview { assessment: RunRecoveryAssessment; preview: OrchestrationPreview; checkpoint: { pendingObjective: string; confirmedOutputs: Array<{ attemptId: string; agentId: string; excerpt: string; truncated: boolean }> } }
export const previewRunContinuation = (id: string) => request<ContinuationPreview>(`/api/runs/${encodeURIComponent(id)}/continuation-preview`, { method: 'POST' });
export const continueRun = (id: string, preview: OrchestrationPreview) => request<{ run: Run; deduplicated: boolean }>(`/api/runs/${encodeURIComponent(id)}/continuations`, { method: 'POST', body: JSON.stringify({ previewId: preview.previewId, orchestrationFingerprint: preview.fingerprint }) });
export const reviseTaskPlan = (id: string, preview: OrchestrationPreview, instruction: string) => request<{ plan: CoordinationPlan }>(`/api/runs/${encodeURIComponent(id)}/orchestration/revisions`, { method: 'POST', body: JSON.stringify({ previewId: preview.previewId, orchestrationFingerprint: preview.fingerprint, instruction }) });
export function createConversation(input: { goal: string; mode?: RunMode; agentIds: string[]; recipientIds?: string[]; supervisorId?: string; defaultReviewerId?: string; workspace?: string; coordinationDraftId?: string }): Promise<{ run: Run; conversation: Conversation; plan?: CoordinationPlan | null }> {
  return request('/api/conversations', { method: 'POST', body: JSON.stringify(input) });
}
export const previewCoordination = (input: CoordinationPreviewInput) => request<CoordinationPreview>('/api/coordination/preview', { method: 'POST', body: JSON.stringify(input) });
export const getCapabilitySnapshot = (id: string) => request<CapabilitySnapshot>(`/api/coordination/capability-snapshots/${encodeURIComponent(id)}`);
export const getCoordinationPlan = (id: string) => request<CoordinationPlan>(`/api/coordination/plans/${encodeURIComponent(id)}`);
export const getCoordinationPlanRevisions = (id: string) => request<CoordinationPlanRevision[]>(`/api/coordination/plans/${encodeURIComponent(id)}/revisions`);
export const getCoordinationDraftEvents = (id: string) => request<CoordinationEvent[]>(`/api/coordination/drafts/${encodeURIComponent(id)}/events`);
export const getRunCoordinationPlan = (runId: string) => request<CoordinationPlan>(`/api/runs/${encodeURIComponent(runId)}/coordination-plan`);
export const getRunCoordination = (runId: string) => request<CoordinationRunDetail>(`/api/runs/${encodeURIComponent(runId)}/coordination`);
export const resumeCoordinationRun = (runId: string) => request<Run>(`/api/runs/${encodeURIComponent(runId)}/coordination/resume`, { method: 'POST' });
export const pauseCoordinationRun = (runId: string) => request<Run>(`/api/runs/${encodeURIComponent(runId)}/coordination/pause`, { method: 'POST' });
export const reviseCoordinationRun = (runId: string, instruction: string, requestedProtocol?: CoordinationProtocolId) => request<{ plan: CoordinationPlan; draft: CoordinationPreview['draft'] }>(`/api/runs/${encodeURIComponent(runId)}/coordination/revisions`, { method: 'POST', body: JSON.stringify({ instruction, ...(requestedProtocol ? { requestedProtocol } : {}) }) });
export const cancelCoordinationRun = (runId: string) => request<Run>(`/api/runs/${encodeURIComponent(runId)}/coordination/cancel`, { method: 'POST' });
export const getConversation = (id: string, includeMessages = true) => request<ConversationDetail>(`/api/conversations/${encodeURIComponent(id)}?includeMessages=${includeMessages}`);
export const getConversationHistory = (id: string, cursor: { before?: number; after?: number; around?: string } = {}) => request<ConversationHistoryPage>(`/api/conversations/${encodeURIComponent(id)}/history?${new URLSearchParams(Object.entries(cursor).map(([key,value]) => [key,String(value)]))}`);
export const searchConversationMessages = (id: string, query: { q?: string; after?: number; scope?: 'results' }, signal?: AbortSignal) => request<ConversationMessageSearch>(`/api/conversations/${encodeURIComponent(id)}/history/search?${new URLSearchParams(Object.entries(query).map(([key,value]) => [key,String(value)]))}`, { signal });
export const previewFollowup = (id: string, input: { body: string; recipientIds?: string[]; replyTo?: string | null; wholeTeam?: boolean }) => request<FollowupPreview>(`/api/conversations/${encodeURIComponent(id)}/followup-preview`, { method: 'POST', body: JSON.stringify(input) });
export const renameConversation = (id: string, title: string) =>
  request<Conversation>(`/api/conversations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ title }) });
export const archiveConversation = (id: string) =>
  request<Conversation>(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const sendConversationMessage = (id: string, input: SendConversationMessageInput) =>
  request<{ run: Run; message: Message }>(`/api/conversations/${encodeURIComponent(id)}/messages`, {
    method: 'POST', body: JSON.stringify(input),
  });
export interface CollaborationRunDetail {
  run?: Run;
  dispatches: CollaborationDispatch[];
  attempts: CollaborationAttempt[];
  batches: CollaborationBatch[];
  decisions: CollaborationUserDecision[];
  completionCandidates: RuntimeCompletionCandidate[];
  successorObligations: RuntimeSuccessorObligation[];
  evidenceBundles: RuntimeEvidenceBundle[];
  routeGuardEvents: RuntimeRouteGuardEvent[];
  durableHolds: RuntimeDurableHold[];
  wakeEvents: RuntimeWakeEvent[];
  holdRecoveryAudits: RuntimeHoldRecoveryAudit[];
  responsibilitySnapshots: RuntimeResponsibilitySnapshot[];
  actionCommands: RuntimeActionCommandRecord[];
  shadowComparisons: RuntimeShadowComparison[];
  terminal?: RuntimeRunTerminalRecord | null;
  budget: CollaborationBudgetSnapshot;
  activeAgents?: Array<{ agentId: string; dispatchId: string; startedAt: string }>;
}
export async function getConversationCollaboration(id: string, runIds?: string[]) {
  if (!runIds) return request<{ runs: CollaborationRunDetail[] }>(`/api/conversations/${encodeURIComponent(id)}/collaboration`);
  const pages = await Promise.all(runChunks(runIds).map(ids => request<{runs:CollaborationRunDetail[]}>(`/api/conversations/${encodeURIComponent(id)}/collaboration?runIds=${encodeURIComponent(ids.join(','))}`)));
  return { runs: pages.flatMap(page => page.runs) };
}
export const getRunCollaboration = (id: string) => request<CollaborationRunDetail>(`/api/runs/${encodeURIComponent(id)}/collaboration`);
export const getRunResponsibility = (id: string) => request<{ snapshots: RuntimeResponsibilitySnapshot[] }>(`/api/runs/${encodeURIComponent(id)}/responsibility`);
export const resolveCollaborationDecision = (id: string, input: ResolveCollaborationDecision) => request<{ decision: CollaborationUserDecision; linkedRun: Run | null }>(`/api/collaboration/decisions/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify(input) });
export const cancelCollaborationDispatch = (id: string) => request<CollaborationDispatch>(`/api/collaboration/dispatches/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
export const stopCollaborationAgent = (agentId: string, conversationId: string, runId: string) => request<{ cancelled: number }>(`/api/collaboration/agents/${encodeURIComponent(agentId)}/stop`, { method: 'POST', body: JSON.stringify({ conversationId, runId }) });
export const stopCollaborationRun = (runId: string) => request<Run>(`/api/collaboration/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' });
export const stopPipelineRun = (runId: string) => request<Run>(`/api/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' });
export const getExternalExecutions = (runId: string) => request<import('@agent-gand/shared').ExternalAgentExecution[]>(`/api/runs/${encodeURIComponent(runId)}/executions`);

export const getAgents = (includeDisabled = false) => request<AgentDefinition[]>(`/api/agents${includeDisabled ? '?includeDisabled=1' : ''}`);
export async function uploadAgentAvatar(file: File): Promise<{ avatar: string }> {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取头像文件失败'));
    reader.onload = () => resolve(String(reader.result ?? '').split(',', 2)[1] ?? '');
    reader.readAsDataURL(file);
  });
  return request('/api/agent-avatars', { method: 'POST', body: JSON.stringify({ mimeType: file.type, data }) });
}
export const getAgentOptions = () => request<AgentOptions>('/api/agent-options');
export const getMcpStatus = () => request<McpStatus>('/api/tools/mcp/status');
export const refreshMcpTools = () => request<McpStatus>('/api/tools/mcp/refresh', { method: 'POST' });
export const preflightAgent = (input: AgentInput) => request<AgentPreflight>('/api/agents/preflight', { method: 'POST', body: JSON.stringify(input) });
export const createAgent = (input: AgentSaveInput) => request<AgentDefinition>('/api/agents', { method: 'POST', body: JSON.stringify(input) });
export const updateAgent = (id: string, input: AgentSaveInput, expectedVersion: number) => request<AgentDefinition>(`/api/agents/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ ...input, expectedVersion }) });
export const setAgentEnabled = (id: string, enabled: boolean, expectedVersion: number) => request<AgentDefinition>(`/api/agents/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: JSON.stringify({ enabled, expectedVersion }) });
/** §13.3 列表过滤（默认排除软删） */
export const getRuns = (params?: { includeDeleted?: boolean; q?: string; status?: string }) => {
  const sp = new URLSearchParams();
  if (params?.includeDeleted) sp.set('includeDeleted', '1');
  if (params?.q) sp.set('q', params.q);
  if (params?.status) sp.set('status', params.status);
  const qs = sp.toString();
  return request<Run[]>(`/api/runs${qs ? `?${qs}` : ''}`);
};
/** §13.2 会话改题（非空 ≤80） */
export const renameRun = (id: string, title: string) =>
  request<Run>(`/api/runs/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ title }) });
/** §13.3 软删（幂等；物理零删除） */
export const softDeleteRun = (id: string) =>
  request<Run>(`/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const getRun = (id: string, includeMessages = true) => request<RunDetail>(`/api/runs/${encodeURIComponent(id)}?includeMessages=${includeMessages}`);
export const getRunWorkspace = (id: string) => request<ExternalWorkspaceBinding | null>(`/api/runs/${encodeURIComponent(id)}/workspace`);
export const getRunObservability = (id: string) => request<RunObservability>(`/api/runs/${encodeURIComponent(id)}/observability`);
export const getRunObservabilitySummary = (id: string) => request<RunObservabilitySummary>(`/api/runs/${encodeURIComponent(id)}/observability?payload=summary`);
export const getSpanDetail = (runId: string, spanId: string) => request<SpanDetail>(`/api/runs/${encodeURIComponent(runId)}/spans/${encodeURIComponent(spanId)}`);
export const getTasks = (runId?: string) =>
  request<Task[]>(runId ? `/api/tasks?runId=${encodeURIComponent(runId)}` : '/api/tasks');
export const getTask = (taskId: string) => request<Task>(`/api/tasks/${encodeURIComponent(taskId)}`);
export const getTaskAttempts = (taskId: string) =>
  request<TaskAttempt[]>(`/api/tasks/${encodeURIComponent(taskId)}/attempts`);
export const getTaskReviews = (taskId: string) =>
  request<TaskReview[]>(`/api/tasks/${encodeURIComponent(taskId)}/reviews`);
export const retryTask = (taskId: string) =>
  request<Task>(`/api/tasks/${encodeURIComponent(taskId)}/retry`, { method: 'POST' });
export const cancelTask = (taskId: string) =>
  request<Task>(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' });
export const getMessages = (runId: string, filters?: { agentId?: string; taskId?: string; messageType?: string }) => {
  const sp = new URLSearchParams({ runId });
  if (filters?.agentId) sp.set('agentId', filters.agentId);
  if (filters?.taskId) sp.set('taskId', filters.taskId);
  if (filters?.messageType) sp.set('messageType', filters.messageType);
  return request<Message[]>(`/api/messages?${sp.toString()}`);
};
export const getApprovals = (status = 'pending') =>
  request<ApprovalRequest[]>(`/api/approvals?status=${status}`);
export const getUsage = () => request<UsageSummary[]>('/api/usage');

export function createTask(input: { title: string; body?: string; createdBy: string }): Promise<Task> {
  return request('/api/tasks', { method: 'POST', body: JSON.stringify(input) });
}

export function claimTask(taskId: string, agentId: string): Promise<Task> {
  return request(`/api/tasks/${taskId}/claim`, { method: 'POST', body: JSON.stringify({ agentId }) });
}

export function completeTask(taskId: string, agentId: string): Promise<Task> {
  return request(`/api/tasks/${taskId}/complete`, { method: 'POST', body: JSON.stringify({ agentId }) });
}

/** 内部工作区卡片元数据（§11.1，GET /api/workspaces） */
export interface WorkspaceMeta {
  name: string;
  modifiedAt: string;
  fileCount: number;
  runCount: number;
  lastGoal: string | null;
}

/** 外部注册工作区（§11.2） */
export interface ExternalWorkspaceInfo {
  id: string;
  label: string;
  absPath: string;
  /** 信任目录：fs.write 免逐次审批（仍受 plan 子目录隔离约束） */
  trusted: boolean;
  createdAt: string;
}

export const getWorkspaces = () => request<WorkspaceMeta[]>('/api/workspaces');
export const getExternalWorkspaces = () =>
  request<ExternalWorkspaceInfo[]>('/api/workspaces/external');
export const suggestWorkspaceName = (goal?: string) =>
  request<{ name: string }>(`/api/workspaces/suggest${goal ? `?goal=${encodeURIComponent(goal)}` : ''}`);
export const renameWorkspace = (name: string, to: string) =>
  request<WorkspaceMeta>(`/api/workspaces/${encodeURIComponent(name)}/rename`, {
    method: 'POST',
    body: JSON.stringify({ to }),
  });
export const duplicateWorkspace = (name: string) =>
  request<WorkspaceMeta>(`/api/workspaces/${encodeURIComponent(name)}/duplicate`, { method: 'POST' });
export const deleteWorkspace = (name: string) =>
  request<{ archivedAs: string }>(`/api/workspaces/${encodeURIComponent(name)}/delete`, {
    method: 'POST',
    body: JSON.stringify({ confirm: true }),
  });
export const registerExternal = (path: string, label?: string, trusted?: boolean) =>
  request<ExternalWorkspaceInfo>('/api/workspaces/register', {
    method: 'POST',
    body: JSON.stringify({ path, label, trusted }),
  });
/** 信任开关：开启后该外部目录内写入免逐次审批 */
export const setExternalTrusted = (id: string, trusted: boolean) =>
  request<ExternalWorkspaceInfo>(`/api/workspaces/register/${encodeURIComponent(id)}/trust`, {
    method: 'POST',
    body: JSON.stringify({ trusted }),
  });
export const unregisterExternal = (id: string) =>
  request<{ ok: boolean }>(`/api/workspaces/register/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const browseFs = (path?: string) =>
  request<{ current: string; dirs: Array<{ name: string; path: string }> }>(
    `/api/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`,
  );
/** §12.1 浏览器内新建文件夹（用户操作语义，同 Finder；不经 agent 权限体系） */
export const mkdirFs = (parentPath: string, name: string) =>
  request<{ path: string }>('/api/fs/mkdir', {
    method: 'POST',
    body: JSON.stringify({ parentPath, name }),
  });
/** §12.3 在 Finder 中显示（仅已注册外部工作区） */
export const revealExternal = (id: string) =>
  request<{ ok: true; path: string }>(`/api/workspaces/${encodeURIComponent(id)}/reveal`, { method: 'POST' });
/** §12.3 外部工作区 label 编辑 */
export const updateExternalLabel = (id: string, label: string) =>
  request<ExternalWorkspaceInfo>(`/api/workspaces/register/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ label }),
  });

export function startRun(input: {
  goal: string;
  mode: RunMode;
  agentIds: string[];
  supervisorId?: string;
  /** 命名工作区（§10.2）：缺省 = 每次 run 专属目录 */
  workspace?: string;
}): Promise<{ run: Run; conversation: Conversation }> {
  return request('/api/runs', { method: 'POST', body: JSON.stringify(input) });
}

export function decideApproval(
  approvalId: string,
  input: { decision: ApprovalDecision; editedInput?: string; by?: string },
): Promise<ApprovalRequest> {
  return request(`/api/approvals/${approvalId}/decide`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

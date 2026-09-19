/**
 * REST 客户端：对应 server §4.3 的 API 表（dev 经 vite proxy）
 */
import type {
  AgentDefinition,
  AgentInput,
  AgentOptions,
  ApprovalDecision,
  ApprovalRequest,
  Message,
  Run,
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
  CapabilitySnapshot,
  CoordinationEvent,
  CoordinationPlan,
  CoordinationPlanRevision,
  CoordinationPreview,
  CoordinationPreviewInput,
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
    let detail = ''; let fieldErrors: Record<string, string> = {};
    try { const parsed = JSON.parse(text) as { error?: unknown; fieldErrors?: Record<string, string> }; detail = String(parsed.error ?? ''); fieldErrors = parsed.fieldErrors ?? {}; } catch { detail = text.slice(0, 200); }
    throw new ApiError(detail || `${init?.method ?? 'GET'} ${path} → ${res.status}`, res.status, fieldErrors);
  }
  return JSON.parse(text) as T;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public fieldErrors: Record<string, string>) { super(message); }
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
}

export const getConversations = () => request<Conversation[]>('/api/conversations');
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
export const cancelCoordinationRun = (runId: string) => request<Run>(`/api/runs/${encodeURIComponent(runId)}/coordination/cancel`, { method: 'POST' });
export const getConversation = (id: string) => request<ConversationDetail>(`/api/conversations/${encodeURIComponent(id)}`);
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
  budget: CollaborationBudgetSnapshot;
  activeAgents?: Array<{ agentId: string; dispatchId: string; startedAt: string }>;
}
export const getConversationCollaboration = (id: string) => request<{ runs: CollaborationRunDetail[] }>(`/api/conversations/${encodeURIComponent(id)}/collaboration`);
export const getRunCollaboration = (id: string) => request<CollaborationRunDetail>(`/api/runs/${encodeURIComponent(id)}/collaboration`);
export const resolveCollaborationDecision = (id: string, input: ResolveCollaborationDecision) => request<{ decision: CollaborationUserDecision; linkedRun: Run | null }>(`/api/collaboration/decisions/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify(input) });
export const cancelCollaborationDispatch = (id: string) => request<CollaborationDispatch>(`/api/collaboration/dispatches/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
export const stopCollaborationAgent = (agentId: string, conversationId: string) => request<{ cancelled: number }>(`/api/collaboration/agents/${encodeURIComponent(agentId)}/stop`, { method: 'POST', body: JSON.stringify({ conversationId }) });
export const stopCollaborationRun = (runId: string) => request<Run>(`/api/collaboration/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' });

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
export const createAgent = (input: AgentInput) => request<AgentDefinition>('/api/agents', { method: 'POST', body: JSON.stringify(input) });
export const updateAgent = (id: string, input: AgentInput, expectedVersion: number) => request<AgentDefinition>(`/api/agents/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ ...input, expectedVersion }) });
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
export const getRun = (id: string) => request<RunDetail>(`/api/runs/${id}`);
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
export const registerExternal = (path: string, label?: string) =>
  request<ExternalWorkspaceInfo>('/api/workspaces/register', {
    method: 'POST',
    body: JSON.stringify({ path, label }),
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

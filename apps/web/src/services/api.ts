/**
 * REST 客户端：对应 server §4.3 的 API 表（dev 经 vite proxy）
 */
import type {
  AgentDefinition,
  ApprovalDecision,
  ApprovalRequest,
  Message,
  Run,
  RunEvent,
  Task,
  UsageSummary,
} from '@agent-gand/shared';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export interface RunDetail {
  run: Run;
  events: RunEvent[];
  tasks: Task[];
  messages: Message[];
  approvals: ApprovalRequest[];
}

export const getAgents = () => request<AgentDefinition[]>('/api/agents');
export const getRuns = () => request<Run[]>('/api/runs');
export const getRun = (id: string) => request<RunDetail>(`/api/runs/${id}`);
export const getTasks = (runId?: string) =>
  request<Task[]>(runId ? `/api/tasks?runId=${encodeURIComponent(runId)}` : '/api/tasks');
export const getMessages = (runId: string) =>
  request<Message[]>(`/api/messages?runId=${encodeURIComponent(runId)}`);
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

export function startRun(input: {
  goal: string;
  mode: 'pipeline' | 'supervisor';
  agentIds: string[];
  /** 命名工作区（§10.2）：缺省 = 每次 run 专属目录 */
  workspace?: string;
}): Promise<{ run: Run }> {
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

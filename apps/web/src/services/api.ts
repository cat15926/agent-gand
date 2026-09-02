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

export function startRun(input: {
  goal: string;
  mode: 'pipeline' | 'supervisor';
  agentIds: string[];
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

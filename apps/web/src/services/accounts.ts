import type { AccountBackend, AccountCheck, AccountInput, NativeAccountInput, AccountLoginOperation, AccountTestResult, AccountListResponse, AccountReferences, AccountView } from '@agent-gand/shared';
import { ApiError } from './apiError';

let csrfToken: string | null = null;
let sessionPromise: Promise<void> | null = null;
let adminToken: string | null = null;
async function decode<T>(response: Response): Promise<T> {
  const data = await response.json() as T & { error?: string; fieldErrors?: Record<string, string>; code?: string };
  if (!response.ok) throw new ApiError(data.error ?? '账户请求失败', response.status, data.fieldErrors ?? {}, data.code);
  return data;
}
export async function getAccountAccess(): Promise<{ mode: 'local' | 'token'; available: boolean }> {
  return decode(await fetch('/api/accounts/access', { credentials: 'same-origin' }));
}
export function connectAccounts(token?: string): Promise<void> {
  if (token !== undefined) { adminToken = token; csrfToken = null; }
  if (sessionPromise) return sessionPromise;
  const pending = (async () => {
    const result = await decode<{ csrfToken: string }>(await fetch('/api/accounts/session', {
      method: 'POST', credentials: 'same-origin', headers: { 'x-gand-bootstrap': '1', ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}) },
    }));
    csrfToken = result.csrfToken;
  })();
  sessionPromise = pending;
  return pending.finally(() => { if (sessionPromise === pending) sessionPromise = null; });
}
export async function managementRequest<T>(path: string, method = 'GET', body?: unknown, retried = false): Promise<T> {
  if (!csrfToken) await connectAccounts();
  const response = await fetch(path, { method, credentials: 'same-origin',
    headers: { 'x-gand-csrf': csrfToken!, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (response.status === 401 && !retried) { csrfToken = null; await connectAccounts(); return managementRequest(path, method, body, true); }
  return decode<T>(response);
}
const request = managementRequest;
export const getAccounts = (includeArchived = false) => request<AccountListResponse>(`/api/accounts${includeArchived ? '?includeArchived=1' : ''}`);
export const createAccount = (input: AccountInput | NativeAccountInput) => request<AccountView>('/api/accounts', 'POST', input);
export const updateAccount = (id: string, input: Partial<Omit<AccountInput, 'apiKey' | 'provider'>> & { expectedVersion: number; enabled?: boolean }) => request<AccountView>(`/api/accounts/${encodeURIComponent(id)}`, 'PATCH', input);
export const replaceAccountKey = (id: string, apiKey: string, expectedVersion: number) => request<AccountView>(`/api/accounts/${encodeURIComponent(id)}/credentials`, 'POST', { apiKey, expectedVersion });
export const clearAccountKey = (id: string, expectedVersion: number) => request<AccountView>(`/api/accounts/${encodeURIComponent(id)}/credentials`, 'DELETE', { expectedVersion });
export const checkAccount = (id: string) => request<AccountCheck>(`/api/accounts/${encodeURIComponent(id)}/check`, 'POST');
export const getAccountReferences = (id: string) => request<AccountReferences>(`/api/accounts/${encodeURIComponent(id)}/references`);
export const deleteAccount = (id: string, expectedVersion: number) => request<{ archived: boolean }>(`/api/accounts/${encodeURIComponent(id)}`, 'DELETE', { expectedVersion });
export async function disconnectAccounts(): Promise<void> {
  try { await request('/api/accounts/session', 'DELETE'); } finally { csrfToken = null; adminToken = null; }
}

export const pendingLogin = (id: string) => request<AccountLoginOperation | null>(`/api/accounts/${encodeURIComponent(id)}/login`);
export const startLogin = (id: string, expectedVersion: number) => request<AccountLoginOperation>(`/api/accounts/${encodeURIComponent(id)}/login`, 'POST', { expectedVersion });
export const getLogin = (id: string) => request<AccountLoginOperation>(`/api/accounts/logins/${encodeURIComponent(id)}`);
export const cancelLogin = (id: string) => request<AccountLoginOperation>(`/api/accounts/logins/${encodeURIComponent(id)}`, 'DELETE');
export const checkLogin = (id: string) => request<AccountLoginOperation>(`/api/accounts/logins/${encodeURIComponent(id)}/check`, 'POST');
export const testAccount = (id: string, backend: AccountBackend, model: string, expectedVersion: number) => request<AccountTestResult>(`/api/accounts/${encodeURIComponent(id)}/test`, 'POST', { backend, model, expectedVersion });
export const revokeAccount = (id: string, expectedVersion: number) => request<{ cancelledRunIds: string[] }>(`/api/accounts/${encodeURIComponent(id)}/revoke`, 'POST', { expectedVersion });

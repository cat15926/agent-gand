import { randomUUID } from 'node:crypto';

export class AcceptanceError extends Error {
  constructor(code, status = null) { super(code); this.code = code; this.status = status; }
}

/** No credentials, supplier bodies, goals or model output enter acceptance reports. */
export function httpClient(baseUrl) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new AcceptanceError('INVALID_SERVER_URL');
  return async (endpoint, payload, method = payload === undefined ? 'GET' : 'POST') => {
    let response;
    try {
      response = await fetch(new URL(endpoint, base), { method, redirect: 'error', headers: { 'content-type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(15_000) });
    } catch { throw new AcceptanceError('SERVICE_UNREACHABLE_OR_REQUEST_RESULT_UNKNOWN'); }
    let data;
    try { data = await response.json(); } catch { throw new AcceptanceError('INVALID_SERVICE_RESPONSE', response.status); }
    if (!response.ok) throw new AcceptanceError(typeof data.code === 'string' && /^[A-Z0-9_]+$/.test(data.code) ? data.code : 'HTTP_REQUEST_REJECTED', response.status);
    return data;
  };
}

export async function waitUntil(read, label, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new AcceptanceError('TIMEOUT_' + label);
}

export async function submitConfirmedTask(request, body, onCreated = async () => {}, onPrepared = async () => {}) {
  const preview = await request('/api/orchestration/preview', body);
  const errors = preview.decision.issues.filter(issue => issue.severity === 'error');
  if (errors.length) throw new AcceptanceError(errors[0].code);
  if (!preview.previewId || preview.comparisonOnly) throw new AcceptanceError('EXECUTION_PREVIEW_REQUIRED');
  const payload = { ...body, entryVersion: 1, clientRequestId: 'o7-' + randomUUID(), previewId: preview.previewId, orchestrationFingerprint: preview.fingerprint };
  const endpoint = body.conversationId ? `/api/conversations/${encodeURIComponent(body.conversationId)}/requests` : '/api/conversations';
  await onPrepared({ conversationId: body.conversationId ?? null, clientRequestId: payload.clientRequestId });
  const submitted = await request(endpoint, payload);
  await onCreated({ runId: submitted.run.id, conversationId: submitted.conversation.id, clientRequestId: payload.clientRequestId });
  const repeated = await request(endpoint, payload);
  if (repeated.run.id !== submitted.run.id) throw new AcceptanceError('IDEMPOTENCY_BROKEN');
  return { ...submitted, preview, clientRequestId: payload.clientRequestId };
}

/** Same HTTP path for fixture and real runs; fixture results never count as supplier passes. */
export async function backendSmoke(request, { agentId, driver, timeoutMs = 120_000, onCreated = async () => {} }) {
  const result = { driver, agentId, status: 'not_run', runId: null, conversationId: null, clientRequestId: null, errorCode: null };
  let created;
  try {
    const agent = (await request('/api/agents')).find(item => item.id === agentId);
    if (!agent || agent.enabled === false || agent.execution?.driver !== driver || !agent.accountRef || agent.accountRef.startsWith('legacy-')) throw new AcceptanceError('MANAGED_AGENT_REQUIRED');
    const available = (await request('/api/execution/drivers')).find(item => item.id === driver);
    if (!available?.available) throw new AcceptanceError(available?.errorCode ?? 'DRIVER_UNAVAILABLE');
    const room = await request('/api/conversations/empty', { title: `O7 ${driver} 最小验收`, agentIds: [agentId], workspace: null,
      preferences: { strategy: 'auto', workflow: 'routine', constraints: { readonly: true } } });
    result.conversationId = room.conversation.id;
    created = await submitConfirmedTask(request, { conversationId: room.conversation.id, recipientIds: [agentId], strategy: 'auto', workflow: 'routine',
      goal: 'Read-only verification: state that 2 + 2 = 4 and explain it in one sentence, at most 40 words. This is the entire deliverable. Do not read files, use ordinary tools, delegate, or request approval. If the platform requires agent.complete, call it once with this answer as the summary.',
      constraints: { readonly: true, deadlineMs: timeoutMs } }, async ids => { Object.assign(result, ids); await onCreated({ ...result, status: 'running' }); },
    async ids => { Object.assign(result, ids); await onCreated({ ...result, status: 'submitting' }); });
    const detail = await waitUntil(async () => {
      const value = await request(`/api/runs/${created.run.id}`);
      return ['completed', 'failed', 'cancelled', 'waiting_for_user', 'awaiting_approval'].includes(value.run.status) ? value : null;
    }, 'BACKEND_TASK', timeoutMs + 5000);
    const [{ snapshot }, executions] = await Promise.all([request(`/api/runs/${created.run.id}/orchestration`), request(`/api/runs/${created.run.id}/executions`)]);
    const binding = detail.accountBindings.find(item => item.agentId === agentId && item.backend === driver);
    const native = executions.filter(item => item.agentId === agentId);
    result.runStatus = detail.run.status;
    result.executionCount = native.length;
    result.executionStatuses = native.map(item => item.status);
    result.errorCode = native.find(item => item.errorCode)?.errorCode ?? null;
    result.model = binding?.model ?? null;
    result.accountId = binding?.accountId ?? null;
    result.configVersion = binding?.configVersion ?? null;
    result.hasExecutionBinding = native.some(item => item.executionBinding?.runId === created.run.id && item.executionBinding.agentId === agentId);
    result.outputCharacters = native.reduce((n, item) => n + (item.content?.trim().length ?? 0), 0);
    if (detail.run.status === 'completed' && binding && snapshot?.executionAuthority === 'orchestration' && snapshot.execution.readonly
      && native.length && native.every(item => item.status === 'completed' && item.permissionMode === 'readonly' && item.executionBinding?.runId === created.run.id)
      && result.outputCharacters > 0) result.status = 'passed';
    else {
      result.status = ['waiting_for_user', 'awaiting_approval'].includes(detail.run.status) ? 'requires_user_action' : 'failed';
      result.errorCode ??= 'TASK_OR_BINDING_NOT_COMPLETED';
    }
  } catch (error) {
    result.status = 'failed';
    result.errorCode = error instanceof AcceptanceError ? error.code : 'ACCEPTANCE_CHECK_FAILED';
    if (error instanceof AcceptanceError && error.status) result.httpStatus = error.status;
  }
  if (result.status !== 'passed' && result.runId) {
    try { await request(`/api/runs/${result.runId}/actions`, { action: 'cancel' }); result.stopRequested = true; }
    catch { result.stopRequested = false; }
  }
  return result;
}

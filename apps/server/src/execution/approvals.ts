import { createHash } from 'node:crypto';
import type { ExternalAgentExecution } from '@agent-gand/shared';
import { all } from '../db/database.ts';
import { createApproval, expireApproval, waitForDecision } from '../hitl/approvals.ts';
import { diagnostic } from './errors.ts';
import { executionAuthorized } from './authority.ts';

export function expireExecutionApprovals(executionId: string): void {
  for (const row of all<{ approval_id: string }>(`SELECT n.approval_id FROM external_agent_approvals n JOIN approvals a ON a.id=n.approval_id WHERE n.execution_id=? AND a.status='pending'`, executionId)) expireApproval(row.approval_id);
}

/** Authority comes from the invocation closure, never model-supplied run/agent IDs. */
export function nativeApprovalGate(execution: ExternalAgentExecution, signal: AbortSignal): (requestId: string, tool: string, input: unknown, reason?: string) => Promise<boolean> {
  const pending = new Map<string, { hash: string; result: Promise<boolean> }>();
  const valid = () => !signal.aborted && executionAuthorized(execution);
  const abort = () => expireExecutionApprovals(execution.id);
  signal.addEventListener('abort', abort, { once: true });
  return (requestId, tool, input, reason) => {
    if (!valid() || !requestId || requestId.length > 256) return Promise.resolve(false);
    const payload = JSON.stringify(input);
    if (payload.length > 128 * 1024) return Promise.resolve(false);
    const hash = createHash('sha256').update(tool + payload).digest('hex');
    const previous = pending.get(requestId);
    if (previous) return previous.hash === hash ? previous.result : Promise.resolve(false);
    const result = (async () => {
      const approval = createApproval({ runId: execution.runId, agentId: execution.agentId, toolName: `native:${execution.driver}:${tool}`,
        input: diagnostic(payload, 128 * 1024), reason: diagnostic(reason ?? '外部 Agent 请求执行原生操作；批准仅适用于本次操作'),
        idempotencyKey: `native:${execution.id}:${requestId}`,
        attemptId: execution.attemptId ?? undefined,
        native: { executionId: execution.id, driver: execution.driver, requestId, attemptId: execution.attemptId ?? null, editable: false } });
      const decision = await waitForDecision(approval.id);
      return valid() && decision.status === 'approved';
    })();
    pending.set(requestId, { hash, result }); return result;
  };
}

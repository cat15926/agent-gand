import type { AgentTurnOptions } from '../orchestration/agentStep.ts';
import type { ExecutionFailureDetails } from '@agent-gand/shared';
import { AccountError } from '../accounts/errors.ts';
import { workspaceRootDir } from '../tools/builtin/index.ts';
import { createExecution, findExecution, updateExecution } from './store.ts';
import { diagnostic, ExecutionError } from './errors.ts';
import { get } from '../db/database.ts';

/** Pre-launch failures still need a durable execution identity; never overwrite an existing scope. */
export function recordExternalPreparationFailure(opts: AgentTurnOptions, error: unknown,
  step: NonNullable<ExecutionFailureDetails['initializationStep']> = 'workspace', ownsAdmission = false): ExecutionError {
  const source = opts.executionSignal?.aborted && opts.executionSignal.reason instanceof ExecutionError ? opts.executionSignal.reason : error;
  const accountFailure = source instanceof AccountError;
  const failure = source instanceof ExecutionError ? source : new ExecutionError(accountFailure ? 'auth_required' : 'protocol_error', diagnostic(source instanceof Error ? source.message : String(source)));
  if (opts.agent.execution?.kind !== 'external') return failure;
  const scopeId = opts.executionScopeId ?? `agent:${opts.agent.id}`;
  if (findExecution(opts.run.id, opts.agent.id, scopeId)) return failure;
  // A rejected duplicate can race the owner's workspace preparation before createExecution().
  // It must not create a failed record that poisons that still-running owner.
  if (!ownsAdmission && get("SELECT 1 FROM execution_member_tickets WHERE ticket_key=? AND status='active'",
    `${opts.run.id}:${opts.agent.id}:${scopeId}`)) return failure;
  let cwd = '';
  try { cwd = workspaceRootDir({ runId: opts.run.id, workspace: opts.run.workspace, workspaceScope: opts.workspaceScope, workspaceRoot: opts.nativeWorkspaceRoot ?? opts.workspaceRoot }); } catch { /* No usable path was resolved; no process was launched. */ }
  const binding = opts.executionBinding;
  const matchingBinding = binding?.runId === opts.run.id && binding.agentId === opts.agent.id && binding.attemptId === opts.attemptId ? binding : undefined;
  const details: ExecutionFailureDetails = { ...failure.details, phase: failure.details?.phase ?? 'initialization',
    ...(failure.details?.phase && failure.details.phase !== 'initialization' ? {} : { initializationStep: accountFailure ? 'account' : step }) };
  failure.details = details;
  const record = createExecution({ runId: opts.run.id, agentId: opts.agent.id, scopeId, driver: opts.agent.execution.driver, agentVersion: opts.agent.version, cwd });
  updateExecution(record.id, { status: failure.code === 'cancelled' ? 'cancelled' : 'failed', attemptId: opts.attemptId ?? null,
    executionBinding: matchingBinding, permissionMode: opts.agent.permissionMode, errorCode: failure.code, error: diagnostic(failure.message),
    failureDetails: details, progress: opts.admissionTiming ?? {}, finishedAt: new Date().toISOString() });
  return failure;
}

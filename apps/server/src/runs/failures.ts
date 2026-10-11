import { isMessageVisibleTo, type MessageAccess, type RunFailureNode, type RunFailureReport, type RunFailureLink } from '@agent-gand/shared';
import { get } from '../db/database.ts';
import { getRun, listEvents } from './trace.ts';
import { listExecutions } from '../execution/store.ts';
import { diagnostic } from '../execution/errors.ts';
import { attemptAccess, eventAccess, messageAccess, unboundRunAccess } from '../messaging/access.ts';
import { listAttempts, listDispatches } from '../collaboration/store.ts';
import { getRunCoordinationPlan, listCoordinationStepAttempts, listCoordinationStepStates } from '../coordination/store.ts';
import { listTasks } from '../messaging/tasks.ts';
import { listAttempts as taskAttempts } from '../tasks/attempts.ts';
import { listToolExecutions } from '../tools/executions.ts';
import { getRunTerminal } from '../runtime/terminal.ts';
import { assessRunRecovery } from '../runtime/recovery.ts';
import { listRuntimeActionCommands } from '../runtime/actionCommands.ts';

type Scope = RunFailureNode & { policy: MessageAccess; dependencies: string[] };
const problematic = (status: string) => ['failed', 'blocked', 'cancelled', 'interrupted'].includes(status);
const safe = (text: string | null | undefined) => diagnostic(text ?? '', 2000);

/** Read-only projection of persisted ledgers. No model, recovery action, or new diagnostic writes. */
export function runFailureReport(runId: string, viewerId = 'user'): RunFailureReport {
  const source = getRun(runId);
  if (!source) throw Object.assign(new Error('Run 不存在'), { status: 404 });
  const ownerPolicy = unboundRunAccess(runId);
  const events = listEvents(runId);
  const boundary = events.find(event => event.name === 'failure:terminal_boundary' && event.attributes['failure.version'] === 1);
  const openScopes = new Set(Array.isArray(boundary?.attributes['failure.open_scopes']) ? boundary.attributes['failure.open_scopes'].filter((id): id is string => typeof id === 'string') : []);
  const scopes = new Map<string, Scope>(), attemptScopes = new Map<string, string>();
  const nodes = new Map<string, RunFailureNode>(), links: RunFailureLink[] = [];
  const visible = (policy: MessageAccess) => isMessageVisibleTo(policy, viewerId);
  const attemptPolicy = (id?: string): MessageAccess => id && (get('SELECT 1 FROM runtime_context_assemblies WHERE attempt_id=? AND run_id=?', id, runId)
    || get('SELECT 1 FROM collaboration_attempts WHERE id=? AND run_id=?', id, runId)) ? attemptAccess(id) : ownerPolicy;
  const add = (node: RunFailureNode, policy: MessageAccess) => { if (visible(policy)) nodes.set(node.id, node); };
  const link = (from: string, to: string, relation: RunFailureLink['relation'], evidence: RunFailureLink['evidence']) => {
    if (from !== to && nodes.has(from) && nodes.has(to) && !links.some(item => item.from === from && item.to === to && item.relation === relation)) links.push({ from, to, relation, evidence });
  };
  const attempts = listAttempts(runId);
  for (const dispatch of listDispatches(runId)) {
    const current = attempts.filter(item => item.dispatchId === dispatch.id).at(-1);
    const id = `dispatch:${dispatch.id}`;
    scopes.set(id, { id, kind: 'dispatch', role: dispatch.status === 'cancelled' ? 'cancelled' : 'failure',
      resolved: !['failed', 'blocked'].includes(dispatch.status), message: safe(dispatch.error), code: null,
      occurredAt: dispatch.finishedAt ?? current?.endedAt ?? dispatch.createdAt, agentId: dispatch.targetAgentId,
      refs: { dispatchId: dispatch.id, ...(current ? { attemptId: current.id } : {}) },
      policy: current ? attemptPolicy(current.id) : messageAccess(dispatch.sourceMessageId), dependencies: [] });
    for (const item of attempts.filter(item => item.dispatchId === dispatch.id)) attemptScopes.set(item.id, id);
    if (problematic(dispatch.status)) add(scopes.get(id)!, scopes.get(id)!.policy);
  }
  const plan = getRunCoordinationPlan(runId);
  if (plan && plan.executionAdapter !== 'collaboration') {
    const states = listCoordinationStepStates(plan.id), stepAttempts = listCoordinationStepAttempts(plan.id);
    for (const step of plan.steps) {
      const state = states.find(item => item.stepId === step.id), current = stepAttempts.filter(item => item.stepId === step.id && item.revision === plan.revision).at(-1);
      const id = `step:${plan.id}:${plan.revision}:${step.id}`;
      const scope: Scope = { id, kind: 'step', role: 'failure',
        resolved: state?.status !== 'failed', message: safe(state?.error), code: null,
        occurredAt: current?.endedAt ?? state?.updatedAt ?? plan.createdAt, agentId: step.agentId ?? null,
        refs: { planId: plan.id, revision: plan.revision, stepId: step.id, ...(current ? { attemptId: current.id } : {}) },
        policy: attemptPolicy(current?.id), dependencies: step.dependsOn.map(dep => `step:${plan.id}:${plan.revision}:${dep}`) };
      scopes.set(id, scope);
      for (const item of stepAttempts.filter(item => item.stepId === step.id && item.revision === plan.revision)) attemptScopes.set(item.id, id);
      if (state && problematic(state.status)) add(scope, scope.policy);
    }
  }
  for (const task of listTasks(runId)) {
    const history = taskAttempts(task.id), current = history.at(-1), id = `task:${task.id}`;
    const scope: Scope = { id, kind: 'task', role: task.status === 'cancelled' ? 'cancelled' : 'failure', resolved: task.status !== 'failed',
      message: safe(task.lastError), code: null, occurredAt: current?.endedAt ?? task.updatedAt, agentId: current?.agentId ?? task.assignee,
      refs: { taskId: task.id, ...(current ? { attemptId: current.id } : {}) }, policy: attemptPolicy(current?.id), dependencies: task.blockedBy.map(id => `task:${id}`) };
    scopes.set(id, scope); history.forEach(item => attemptScopes.set(item.id, id));
    if (problematic(task.status)) add(scope, scope.policy);
  }
  for (const scope of scopes.values()) if (nodes.has(scope.id) && scope.role === 'failure' && openScopes.has(scope.id)) {
    scope.role = 'affected'; scope.resolved = true;
    scope.message = '终态提交时该事项仍未完成，随后进入关闭状态；现有证据不能将其认定为原始故障。';
  }
  // Only persisted dependencies imply blocked downstream work; an unrelated sibling is not assigned blame.
  for (let round = 0; round < scopes.size; round++) {
    let changed = false;
    for (const scope of scopes.values()) {
      if (!scope.resolved || nodes.has(scope.id) || !scope.dependencies.some(id => nodes.get(id)?.role === 'failure' || nodes.get(id)?.role === 'affected')) continue;
      const successful = scope.kind === 'step'
        ? get("SELECT 1 FROM coordination_step_states WHERE plan_id=? AND revision=? AND step_id=? AND status='completed'", scope.refs.planId, scope.refs.revision, scope.refs.stepId)
        : get("SELECT 1 FROM tasks WHERE id=? AND status='completed'", scope.refs.taskId);
      if (successful) continue;
      add({ ...scope, role: 'affected', resolved: false, message: '前置事项失败，当前事项未能继续执行。' }, scope.policy);
      if (nodes.has(scope.id)) changed = true;
    }
    if (!changed) break;
  }
  for (const scope of scopes.values()) for (const dependency of scope.dependencies) link(dependency, scope.id, 'depends_on', 'plan');

  const executions = listExecutions(runId);
  for (const execution of executions) {
    if (!problematic(execution.status) && !execution.failureDetails?.secondary?.length) continue;
    const scope = execution.attemptId ? scopes.get(attemptScopes.get(execution.attemptId) ?? '') : undefined;
    const isCurrent = scope && scope.refs.attemptId === execution.attemptId;
    const id = `execution:${execution.id}`;
    const role = execution.status === 'cancelled' ? 'cancelled' : execution.status === 'interrupted' ? 'unknown' : execution.status === 'completed' ? 'secondary' : 'failure';
    const policy = attemptPolicy(execution.attemptId ?? undefined);
    // Do not return cwd, prompts, session contents, tool arguments, or model reasoning in this projection.
    const raw = execution.failureDetails;
    const details: RunFailureNode['details'] = raw ? { phase: raw.phase, timeoutKind: raw.timeoutKind, limitMs: raw.limitMs,
      initializationStep: raw.initializationStep, ...(raw.stderr ? { stderr: safe(raw.stderr) } : {}),
      ...(raw.secondary ? { secondary: raw.secondary.slice(0, 20).map(item => ({ step: item.step, message: safe(item.message) })) } : {}),
      ...(raw.cause?.kind === 'run_terminal' && raw.cause.id === runId ? { cause: raw.cause } : {}) } : undefined;
    add({ id, kind: 'execution', role, resolved: scope ? !isCurrent || scope.resolved : source.status !== 'failed',
      message: safe(execution.error), code: execution.errorCode, occurredAt: execution.finishedAt ?? execution.startedAt, agentId: execution.agentId,
      refs: { ...(isCurrent ? scope.refs : {}), executionId: execution.id, ...(execution.attemptId ? { attemptId: execution.attemptId } : {}),
        ...(execution.runtimeBinding ? { subjectId: execution.runtimeBinding.subjectId } : {}) }, details,
      progress: execution.progress, timeoutPolicy: execution.timeoutPolicy }, policy);
    if (isCurrent) link(id, scope.id, 'same_attempt', 'binding');
    for (const [index, secondary] of (execution.failureDetails?.secondary ?? []).entries()) {
      const child = `${id}:secondary:${index}`;
      add({ id: child, kind: 'secondary', role: 'secondary', resolved: true, message: safe(secondary.message), code: secondary.step,
        occurredAt: execution.finishedAt ?? execution.startedAt, agentId: execution.agentId, refs: { executionId: execution.id } }, policy);
      link(id, child, 'secondary_to', 'ledger');
    }
  }
  for (const tool of listToolExecutions(runId)) {
    if (!problematic(tool.status) && tool.status !== 'needs_attention') continue;
    const scope = tool.attemptId ? scopes.get(attemptScopes.get(tool.attemptId) ?? '') : undefined;
    const id = `tool:${tool.id}`;
    add({ id, kind: 'tool', role: tool.status === 'needs_attention' || tool.replayPolicy === 'manual' ? 'unknown' : 'secondary',
      resolved: tool.replayPolicy !== 'manual' && scope?.resolved === true, message: safe(tool.error) || '工具结果尚未确认', code: tool.status,
      occurredAt: tool.endedAt ?? tool.startedAt, agentId: tool.agentId,
      refs: { ...(tool.attemptId ? { attemptId: tool.attemptId } : {}), ...(tool.spanId ? { spanId: tool.spanId } : {}), ...(tool.taskId ? { taskId: tool.taskId } : {}) } }, attemptPolicy(tool.attemptId ?? undefined));
    if (scope?.refs.attemptId === tool.attemptId) link(id, scope.id, 'same_attempt', 'ledger');
  }

  const commands = listRuntimeActionCommands(runId);
  const eventScopes = new Map<string, Scope | undefined>(), eventAttempts = new Map<string, string>();
  const scopeOfEvent = (eventId: string): Scope | undefined => {
    if (eventScopes.has(eventId)) return eventScopes.get(eventId);
    let event = events.find(item => item.id === eventId);
    const visited = new Set<string>();
    while (event && !visited.has(event.id)) {
      visited.add(event.id);
      const attrs = event.attributes;
      const attemptId = attrs['collaboration.attempt.id'] ?? attrs['coordination.attempt.id'] ?? attrs['task.attempt.id'];
      const executionId = attrs['execution.id'];
      const execution = typeof executionId === 'string' ? executions.find(item => item.id === executionId) : undefined;
      const bound = typeof attemptId === 'string' ? attemptId : execution?.attemptId;
      if (bound) { const scope = scopes.get(attemptScopes.get(bound) ?? ''); eventScopes.set(eventId, scope); eventAttempts.set(eventId, bound); return scope; }
      event = events.find(item => item.id === event?.parentId);
    }
    eventScopes.set(eventId, undefined); return undefined;
  };
  for (const event of events) {
    const outcome = event.attributes['tool.outcome'];
    if (event.status !== 'error' && outcome !== 'control_interruption') continue;
    const scope = scopeOfEvent(event.id), executionId = event.attributes['execution.id'];
    const executionNode = typeof executionId === 'string' ? nodes.get(`execution:${executionId}`) : undefined;
    const isModelFailure = event.spanKind === 'llm' && !executionNode && !!scope;
    const command = outcome === 'control_interruption' ? commands.find(item => item.attemptId && item.attemptId === eventAttempts.get(event.id)) : undefined;
    const attrs = event.attributes;
    const timeoutKind = attrs['execution.timeout_kind'], phase = attrs['execution.failure_phase'];
    const requestId = attrs['llm.request_id'], httpStatus = attrs['llm.http_status'];
    const at = (key: string) => typeof attrs[key] === 'string' && Number.isFinite(Date.parse(attrs[key] as string)) ? attrs[key] as string : undefined;
    const details: RunFailureNode['details'] = {
      ...(['total', 'first_response', 'idle'].includes(String(timeoutKind)) ? { timeoutKind: timeoutKind as 'total' | 'first_response' | 'idle' } : {}),
      ...(['queue', 'initialization', 'before_session', 'before_first_activity', 'after_activity', 'deadline'].includes(String(phase)) ? { phase: phase as NonNullable<RunFailureNode['details']>['phase'] } : {}),
      ...(typeof attrs['execution.limit_ms'] === 'number' && attrs['execution.limit_ms'] > 0 ? { limitMs: attrs['execution.limit_ms'] } : {}),
    };
    let policy: MessageAccess;
    try { policy = eventAccess(event.id); } catch { policy = { visibility: 'private', audience: ['user'] }; }
    const id = `span:${event.id}`;
    add({ id, kind: 'span', role: outcome === 'control_interruption' ? 'control_interruption' : outcome === 'missing_terminal' ? 'unknown' : isModelFailure ? 'failure' : 'secondary',
      resolved: scope ? scope.resolved || scope.refs.attemptId !== eventAttempts.get(event.id) : source.status !== 'failed',
      message: safe(event.output) || safe(event.name), code: String(outcome ?? event.attributes['execution.error_code'] ?? event.attributes['execution.timeout_kind'] ?? 'span_error'),
      occurredAt: event.endedAt ?? event.startedAt, agentId: typeof event.attributes['agent.id'] === 'string' ? event.attributes['agent.id'] : scope?.agentId ?? null,
      refs: { ...(scope?.refs ?? {}), ...(eventAttempts.has(event.id) ? { attemptId: eventAttempts.get(event.id) } : {}), spanId: event.id,
        ...(typeof executionId === 'string' && executions.some(item => item.id === executionId) ? { executionId } : {}) },
      ...(outcome === 'control_interruption' ? { control: command ? { state: 'committed' as const, kind: command.kind, commandId: command.id } : { state: 'candidate_only' as const } } : {}),
      ...(Object.keys(details).length ? { details } : {}),
      ...(at('execution.first_response_at') || at('execution.last_activity_at') ? { progress: { firstResponseAt: at('execution.first_response_at'), lastActivityAt: at('execution.last_activity_at') } } : {}),
      ...(typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus < 600 ? { providerDiagnostic: { httpStatus,
        ...(typeof requestId === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(requestId) && safe(requestId) === requestId ? { requestId } : {}) } } : {}) }, policy);
    if (scope && scope.refs.attemptId === eventAttempts.get(event.id)) link(id, scope.id, 'same_attempt', 'binding');
    if (executionNode) link(executionNode.id, id, 'same_attempt', 'binding');
  }
  for (const event of events) if (event.parentId) link(`span:${event.id}`, `span:${event.parentId}`, 'span_parent', 'binding');

  const terminal = getRunTerminal(runId);
  if (source.status === 'failed' || source.status === 'cancelled') {
    const terminalId = `terminal:${runId}`;
    add({ id: terminalId, kind: 'terminal', role: 'terminal', resolved: false,
      message: terminal ? `任务终态：${terminal.status}；${terminal.reasonCodes.join('、')}` : `任务终态：${source.status}；历史记录没有明确失败因果快照`,
      code: terminal?.source ?? 'legacy_unattributed', agentId: null, occurredAt: terminal?.committedAt ?? source.finishedAt ?? source.createdAt, refs: {} }, ownerPolicy);
    const failures = boundary?.attributes['failure.failed_scopes'];
    if (Array.isArray(failures)) for (const id of failures) if (typeof id === 'string') link(id, terminalId, 'failed_at_terminal', 'terminal_snapshot');
    for (const execution of executions) if (execution.failureDetails?.cause?.kind === 'run_terminal' && execution.failureDetails.cause.id === runId) {
      link(terminalId, `execution:${execution.id}`, 'terminal_cancel', 'abort_reason');
    }
  }

  if (source.status === 'completed' || source.status === 'cancelled') for (const node of nodes.values()) if (node.role === 'failure') node.resolved = true;
  const candidates = [...nodes.values()].filter(node => node.role === 'failure' && !node.resolved);
  const primary = candidates.filter(node => !candidates.some(other => other.id !== node.id && links.some(edge => edge.from === other.id && edge.to === node.id && edge.relation === 'same_attempt')));
  const ordered = [...nodes.values()].sort((a, b) => Number(primary.includes(b)) - Number(primary.includes(a)) || a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  const selected = ordered.slice(0, 400), selectedIds = new Set(selected.map(node => node.id));
  // Strip internal ACL/dependency metadata from scope nodes; filtering occurs before any count or link is returned.
  const clean = selected.map(node => { const { policy: _policy, dependencies: _dependencies, ...value } = node as Scope; return value; });
  return { version: 1, runId, status: source.status, nodes: clean, links: links.filter(edge => selectedIds.has(edge.from) && selectedIds.has(edge.to)),
    primaryNodeIds: primary.map(node => node.id).filter(id => selectedIds.has(id)), recovery: viewerId === 'user' ? assessRunRecovery(runId) : null, truncated: ordered.length > selected.length };
}

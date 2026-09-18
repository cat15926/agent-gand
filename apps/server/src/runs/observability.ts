/** 统一观测协议聚合：RunGraph（编排拓扑）与 TraceTree（调用层级）。 */
import {
  OBSERVABILITY_PROTOCOL_VERSION,
  type RunGraph,
  type RunGraphEdge,
  type RunGraphNode,
  type RunObservability,
  type RunObservabilitySummary,
  type SpanSummary,
  type TraceTreeSummary,
  type TraceTreeSummaryNode,
  type TraceTree,
  type TraceTreeNode,
  type TrajectoryGroup,
} from '@agent-gand/shared';
import { listApprovals } from '../hitl/approvals.ts';
import { listTasks } from '../messaging/tasks.ts';
import { getEvent, getRun, listEvents, listRunAgentSnapshots } from './trace.ts';

function nodeId(kind: RunGraphNode['kind'], id: string): string {
  return `${kind}:${id}`;
}

function edge(from: string, to: string, kind: RunGraphEdge['kind'], label: string | null = null): RunGraphEdge {
  return { id: `${kind}:${from}:${to}`, from, to, kind, label };
}

export function buildRunGraph(runId: string): RunGraph | null {
  const run = getRun(runId);
  if (!run) return null;
  const agents = listRunAgentSnapshots(runId);
  const tasks = listTasks(runId);
  const approvals = listApprovals().filter((item) => item.runId === runId);
  const rootId = nodeId('run', run.id);
  const nodes: RunGraphNode[] = [{
    id: rootId, kind: 'run', entityId: run.id, label: run.title ?? run.goal,
    status: run.status, attributes: { 'run.id': run.id, 'run.mode': run.mode },
  }];
  const edges: RunGraphEdge[] = [];

  for (const agent of agents) {
    const id = nodeId('agent', agent.id);
    const role = run.mode === 'pipeline' ? 'pipeline'
      : agent.id === run.supervisorId ? 'supervisor'
        : run.mode === 'collaboration' ? 'collaborator' : 'worker';
    nodes.push({ id, kind: 'agent', entityId: agent.id, label: agent.name, status: agent.enabled ? 'enabled' : 'disabled', attributes: {
      'run.id': run.id, 'run.mode': run.mode, 'agent.id': agent.id, 'agent.role': role,
    } });
    edges.push(edge(rootId, id, 'contains'));
  }

  if (run.supervisorId) {
    for (const agent of agents) {
      if (agent.id !== run.supervisorId) {
        edges.push(edge(nodeId('agent', run.supervisorId), nodeId('agent', agent.id), 'coordinates'));
      }
    }
  }

  if (run.mode === 'pipeline') {
    for (let index = 1; index < run.agentIds.length; index += 1) {
      edges.push(edge(nodeId('agent', run.agentIds[index - 1]!), nodeId('agent', run.agentIds[index]!), 'next'));
    }
  }

  for (const task of tasks) {
    const id = nodeId('task', task.id);
    nodes.push({ id, kind: 'task', entityId: task.id, label: task.title, status: task.status, attributes: {
      'run.id': run.id, 'run.mode': run.mode, 'task.id': task.id, 'task.attempt.no': task.attempt,
    } });
    edges.push(edge(run.supervisorId ? nodeId('agent', run.supervisorId) : rootId, id, 'creates'));
    if (task.assignee) edges.push(edge(id, nodeId('agent', task.assignee), 'assigned_to'));
    if (task.reviewerId) edges.push(edge(id, nodeId('agent', task.reviewerId), 'reviewed_by'));
    for (const blockerId of task.blockedBy) edges.push(edge(id, nodeId('task', blockerId), 'depends_on'));
  }

  for (const approval of approvals) {
    const id = nodeId('approval', approval.id);
    nodes.push({ id, kind: 'approval', entityId: approval.id, label: approval.toolName, status: approval.status, attributes: {
      'run.id': run.id, 'run.mode': run.mode, 'agent.id': approval.agentId,
      'approval.id': approval.id, 'tool.name': approval.toolName,
    } });
    edges.push(edge(rootId, id, 'contains'));
  }

  return { protocolVersion: OBSERVABILITY_PROTOCOL_VERSION, runId, mode: run.mode, nodes, edges };
}

function durationMs(startedAt: string, endedAt: string | null): number | null {
  if (!endedAt) return null;
  return Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime());
}

function childCoveredMs(node: TraceTreeNode): number {
  if (!node.span.endedAt) return 0;
  const start = new Date(node.span.startedAt).getTime();
  const end = new Date(node.span.endedAt).getTime();
  const intervals = node.children
    .filter((child) => child.span.endedAt)
    .map((child) => [Math.max(start, new Date(child.span.startedAt).getTime()), Math.min(end, new Date(child.span.endedAt!).getTime())] as const)
    .filter(([left, right]) => right > left)
    .sort((a, b) => a[0] - b[0]);
  let covered = 0; let left = 0; let right = 0;
  for (const interval of intervals) {
    if (right === 0 || interval[0] > right) { covered += right - left; [left, right] = interval; }
    else right = Math.max(right, interval[1]);
  }
  return covered + (right - left);
}

export function buildTraceTree(runId: string): TraceTree {
  const spans = listEvents(runId);
  const byId = new Map<string, TraceTreeNode>(spans.map((span) => [span.id, {
    span, children: [], depth: 0, durationMs: durationMs(span.startedAt, span.endedAt), selfDurationMs: null, orphaned: false,
  }]));
  const roots: TraceTreeNode[] = [];

  const hasCycle = (spanId: string, parentId: string): boolean => {
    const seen = new Set([spanId]);
    let cursor: string | null = parentId;
    while (cursor) {
      if (seen.has(cursor)) return true;
      seen.add(cursor);
      cursor = byId.get(cursor)?.span.parentId ?? null;
    }
    return false;
  };

  for (const node of byId.values()) {
    const parentId = node.span.parentId;
    const parent = parentId ? byId.get(parentId) : undefined;
    if (!parentId) roots.push(node);
    else if (!parent || hasCycle(node.span.id, parentId)) { node.orphaned = true; roots.push(node); }
    else parent.children.push(node);
  }

  let maxDepth = 0;
  const decorate = (node: TraceTreeNode, depth: number): void => {
    node.depth = depth;
    maxDepth = Math.max(maxDepth, depth);
    node.children.sort((a, b) => a.span.startedAt.localeCompare(b.span.startedAt));
    for (const child of node.children) decorate(child, depth + 1);
    node.selfDurationMs = node.durationMs === null ? null : Math.max(0, node.durationMs - childCoveredMs(node));
  };
  roots.sort((a, b) => a.span.startedAt.localeCompare(b.span.startedAt));
  for (const root of roots) decorate(root, 0);
  return { protocolVersion: OBSERVABILITY_PROTOCOL_VERSION, runId, roots, totalSpans: spans.length, maxDepth };
}

function collectSpanIds(node: TraceTreeNode): string[] {
  return [node.span.id, ...node.children.flatMap(collectSpanIds)];
}

function groupStatus(nodes: TraceTreeNode[]): string {
  const statuses = nodes.map((node) => node.span.status);
  return statuses.includes('error') ? 'error' : statuses.includes('running') ? 'running' : 'ok';
}

function flattenTrace(nodes: TraceTreeNode[]): TraceTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenTrace(node.children)]);
}

type GroupSemantics = {
  agentId?: string;
  taskId?: string;
  attemptId?: string;
  dispatchId?: string;
  phase?: string;
};

function parseLegacyInput(input: string | null): Record<string, unknown> {
  if (!input) return {};
  try {
    const value: unknown = JSON.parse(input);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function groupSemantics(node: TraceTreeNode, taskIds: string[]): GroupSemantics {
  const attributes = node.span.attributes;
  const legacyInput = parseLegacyInput(node.span.input);
  const legacyName = node.span.name.match(/[（(](task|review):([\w-]{4,})\s+attempt:(\d+)[）)]/u);
  const taskPrefix = legacyName?.[2];
  const inferredTaskId = taskPrefix ? taskIds.find((id) => id.startsWith(taskPrefix)) : undefined;
  const dispatchId = typeof attributes['collaboration.dispatch.id'] === 'string'
    ? attributes['collaboration.dispatch.id']
    : typeof legacyInput.dispatchId === 'string' ? legacyInput.dispatchId : undefined;
  return {
    ...(typeof attributes['agent.id'] === 'string' ? { agentId: attributes['agent.id'] } : {}),
    ...(typeof attributes['task.id'] === 'string' ? { taskId: attributes['task.id'] } : inferredTaskId ? { taskId: inferredTaskId } : {}),
    ...(typeof attributes['task.attempt.id'] === 'string' ? { attemptId: attributes['task.attempt.id'] } : {}),
    ...(dispatchId ? { dispatchId } : {}),
    ...(typeof attributes['orchestration.phase'] === 'string'
      ? { phase: attributes['orchestration.phase'] }
      : legacyName?.[1] === 'review' ? { phase: 'task.review' } : {}),
  };
}

export function buildTrajectoryGroups(runId: string, trace: TraceTree): TrajectoryGroup[] {
  const owner = getRun(runId);
  if (!owner) return [];
  const nodes = flattenTrace(trace.roots);
  const tasks = new Map(listTasks(runId).map((task) => [task.id, task]));
  const semantics = new Map(nodes.map((node) => [node.span.id, groupSemantics(node, [...tasks.keys()])]));
  const anchors = nodes.filter((node) => {
    if (node.span.spanKind !== 'agent') return false;
    const semantic = semantics.get(node.span.id)!;
    if (owner.mode === 'pipeline') return node.span.parentId === null;
    if (owner.mode === 'supervisor') return Boolean(semantic.taskId);
    return Boolean(semantic.dispatchId);
  });
  const claimed = new Set<string>();
  const groups = anchors.map((node): TrajectoryGroup => {
    const spanIds = collectSpanIds(node);
    spanIds.forEach((id) => claimed.add(id));
    const { agentId, taskId, attemptId, dispatchId, phase } = semantics.get(node.span.id)!;
    const kind = owner.mode === 'pipeline' ? 'pipeline_step'
      : owner.mode === 'collaboration' ? 'dispatch'
        : phase === 'task.review' ? 'review_attempt' : 'task_attempt';
    const task = taskId ? tasks.get(taskId) : undefined;
    const label = owner.mode === 'pipeline' ? `${agentId ?? node.span.name} · 流水线步骤`
      : owner.mode === 'collaboration' ? `${agentId ?? node.span.name} · Dispatch ${dispatchId?.slice(0, 8) ?? ''}`
        : `${task?.title ?? taskId?.slice(0, 8) ?? '任务'} · ${kind === 'review_attempt' ? '审查' : '执行'}`;
    return { id: `group:${node.span.id}`, kind, label, status: node.span.status, spanIds,
      ...(agentId ? { agentId } : {}), ...(taskId ? { taskId } : {}),
      ...(attemptId ? { attemptId } : {}), ...(dispatchId ? { dispatchId } : {}) };
  });
  const unclaimed = nodes.filter((node) => !claimed.has(node.span.id));
  if (unclaimed.length > 0) groups.unshift({
    id: `group:${runId}:system`, kind: 'system', label: '编排与系统事件', status: groupStatus(unclaimed),
    spanIds: unclaimed.map((node) => node.span.id),
  });
  return groups;
}

function preview(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/\s+/gu, ' ').trim().slice(0, 180) || null;
}

function summarizeSpan(node: TraceTreeNode): SpanSummary {
  const { input, output, ...span } = node.span;
  return {
    ...span,
    hasInput: input !== null && input.length > 0,
    hasOutput: output !== null && output.length > 0,
    inputBytes: input === null ? 0 : Buffer.byteLength(input),
    outputBytes: output === null ? 0 : Buffer.byteLength(output),
    inputPreview: preview(input),
    outputPreview: preview(output),
  };
}

function summarizeNode(node: TraceTreeNode): TraceTreeSummaryNode {
  return {
    span: summarizeSpan(node),
    children: node.children.map(summarizeNode),
    depth: node.depth,
    durationMs: node.durationMs,
    selfDurationMs: node.selfDurationMs,
    orphaned: node.orphaned,
  };
}

function summarizeTrace(trace: TraceTree): TraceTreeSummary {
  return { ...trace, roots: trace.roots.map(summarizeNode) };
}

export function getRunObservability(runId: string): RunObservability | null {
  const graph = buildRunGraph(runId);
  if (!graph) return null;
  const trace = buildTraceTree(runId);
  return { protocolVersion: OBSERVABILITY_PROTOCOL_VERSION, graph, trace, groups: buildTrajectoryGroups(runId, trace) };
}

export function getRunObservabilitySummary(runId: string): RunObservabilitySummary | null {
  const full = getRunObservability(runId);
  if (!full) return null;
  return { protocolVersion: full.protocolVersion, graph: full.graph, trace: summarizeTrace(full.trace), groups: full.groups };
}

export function getSpanDetail(runId: string, spanId: string) {
  return getEvent(runId, spanId) ?? null;
}

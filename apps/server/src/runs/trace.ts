/**
 * 运行与观测（规格 §4.2 runs/trace.ts）
 * createRun/startSpan/endSpan/finishRun；usage 按 run 汇总（SUM tokens/cost + llm/tool 调用数）
 */
import type {
  ApprovalRequest,
  Message,
  Run,
  RunEvent,
  RunMode,
  RunStatus,
  SpanKind,
  SpanStatus,
  Task,
  UsageSummary,
} from '@agent-gand/shared';
import { randomUUID } from 'node:crypto';
import { all, get, run } from '../db/database.ts';
import { emit } from '../messaging/bus.ts';
import { listApprovals } from '../hitl/approvals.ts';
import { listByRun } from '../messaging/inbox.ts';
import { listTasks } from '../messaging/tasks.ts';

interface RunRow {
  id: string;
  goal: string;
  mode: string;
  status: string;
  agent_ids: string;
  workspace: string | null;
  title: string | null;
  deleted_at: string | null;
  created_at: string;
  finished_at: string | null;
}

interface RunEventRow {
  id: string;
  run_id: string;
  parent_id: string | null;
  span_kind: string;
  name: string;
  input: string | null;
  output: string | null;
  status: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  started_at: string;
  ended_at: string | null;
}

function rowToRun(row: RunRow): Run {
  return {
    id: row.id,
    goal: row.goal,
    mode: row.mode as RunMode,
    status: row.status as RunStatus,
    agentIds: JSON.parse(row.agent_ids) as string[],
    workspace: row.workspace ?? null,
    title: row.title ?? null,
    deletedAt: row.deleted_at ?? null,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function rowToRunEvent(row: RunEventRow): RunEvent {
  return {
    id: row.id,
    runId: row.run_id,
    parentId: row.parent_id,
    spanKind: row.span_kind as SpanKind,
    name: row.name,
    input: row.input,
    output: row.output,
    status: row.status as SpanStatus,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costUsd: row.cost_usd,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

/** workspace：命名工作区（§10.2，校验后的值）；null = runId 专属目录 */
export function createRun(
  goal: string,
  mode: RunMode,
  agentIds: string[],
  workspace: string | null = null,
): Run {
  const record: Run = {
    id: randomUUID(),
    goal,
    mode,
    status: 'pending',
    agentIds,
    workspace,
    title: goal.slice(0, 24), // §13.2 缺省标题：目标前 24 字
    deletedAt: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };
  run(
    `INSERT INTO runs (id, goal, mode, status, agent_ids, workspace, title, created_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    record.id,
    record.goal,
    record.mode,
    record.status,
    JSON.stringify(record.agentIds),
    record.workspace,
    record.title,
    record.createdAt,
  );
  emit({ type: 'run.updated', run: record });
  return record;
}

export function getRun(id: string): Run | undefined {
  const row = get<RunRow>('SELECT * FROM runs WHERE id = ?', id);
  return row ? rowToRun(row) : undefined;
}

/** §13.3 列表过滤：默认排除软删；includeDeleted=1 含软删；q 模糊匹配标题与目标；status 精确 */
export function listRuns(opts: { includeDeleted?: boolean; q?: string; status?: string } = {}): Run[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.includeDeleted !== true) where.push('deleted_at IS NULL');
  if (opts.q && opts.q.length > 0) {
    where.push('(title LIKE ? OR goal LIKE ?)');
    params.push(`%${opts.q}%`, `%${opts.q}%`);
  }
  if (opts.status && opts.status.length > 0) {
    where.push('status = ?');
    params.push(opts.status);
  }
  const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
  return all<RunRow>(`SELECT * FROM runs${clause} ORDER BY created_at DESC`, ...params).map(rowToRun);
}

/** §13.2 会话改题（非空 ≤80）；run 不存在 → 返回 null（路由映射 404） */
export function renameRun(id: string, title: string): Run | null {
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return null; // 长度非法（路由已先校验，双保险）
  run('UPDATE runs SET title = ? WHERE id = ?', trimmed, id);
  return getRun(id) ?? null;
}

/** §13.3 软删（幂等：重复删仍 200）；物理零删除——DB 行保留、沙箱产物不动 */
export function softDeleteRun(id: string): Run | null {
  run('UPDATE runs SET deleted_at = ? WHERE id = ?', new Date().toISOString(), id);
  return getRun(id) ?? null;
}

export function countRuns(): number {
  const row = get<{ n: number }>('SELECT COUNT(*) AS n FROM runs');
  return row?.n ?? 0;
}

/** 状态流转（含 awaiting_approval ↔ running 往返），每次广播 run.updated */
export function setRunStatus(runId: string, status: RunStatus): void {
  run('UPDATE runs SET status = ? WHERE id = ?', status, runId);
  const runRow = get<RunRow>('SELECT * FROM runs WHERE id = ?', runId);
  if (runRow) emit({ type: 'run.updated', run: rowToRun(runRow) });
}

export interface StartSpanInput {
  parentId?: string | null;
  spanKind: SpanKind;
  name: string;
  input?: string | null;
}

export function startSpan(runId: string, input: StartSpanInput): RunEvent {
  const event: RunEvent = {
    id: randomUUID(),
    runId,
    parentId: input.parentId ?? null,
    spanKind: input.spanKind,
    name: input.name,
    input: input.input ?? null,
    output: null,
    status: 'running',
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    startedAt: new Date().toISOString(),
    endedAt: null,
  };
  run(
    `INSERT INTO run_events (id, run_id, parent_id, span_kind, name, input, output, status, tokens_in, tokens_out, cost_usd, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0, 0, 0, ?, NULL)`,
    event.id,
    event.runId,
    event.parentId,
    event.spanKind,
    event.name,
    event.input,
    event.status,
    event.startedAt,
  );
  emit({ type: 'run.event', event });
  return event;
}

export interface EndSpanInput {
  output?: string | null;
  status?: SpanStatus; // 缺省 ok
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
}

export function endSpan(span: RunEvent, input: EndSpanInput = {}): RunEvent {
  const ended: RunEvent = {
    ...span,
    output: input.output ?? null,
    status: input.status ?? 'ok',
    tokensIn: input.tokensIn ?? 0,
    tokensOut: input.tokensOut ?? 0,
    costUsd: input.costUsd ?? 0,
    endedAt: new Date().toISOString(),
  };
  run(
    `UPDATE run_events
     SET output = ?, status = ?, tokens_in = ?, tokens_out = ?, cost_usd = ?, ended_at = ?
     WHERE id = ?`,
    ended.output,
    ended.status,
    ended.tokensIn,
    ended.tokensOut,
    ended.costUsd,
    ended.endedAt,
    ended.id,
  );
  emit({ type: 'run.event', event: ended });
  // llm/tool span 结束后推送该 run 的最新用量
  if (ended.spanKind === 'llm' || ended.spanKind === 'tool') {
    const usage = usageForRun(ended.runId);
    if (usage) emit({ type: 'usage', usage });
  }
  return ended;
}

export function finishRun(runId: string, status: 'completed' | 'failed'): void {
  run('UPDATE runs SET status = ?, finished_at = ? WHERE id = ?', status, new Date().toISOString(), runId);
  const row = get<RunRow>('SELECT * FROM runs WHERE id = ?', runId);
  if (row) emit({ type: 'run.updated', run: rowToRun(row) });
}

export function listEvents(runId: string): RunEvent[] {
  return all<RunEventRow>(
    'SELECT * FROM run_events WHERE run_id = ? ORDER BY started_at ASC, rowid ASC',
    runId,
  ).map(rowToRunEvent);
}

interface UsageRow {
  run_id: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  llm_calls: number;
  tool_calls: number;
}

function rowToUsage(row: UsageRow): UsageSummary {
  return {
    runId: row.run_id,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costUsd: row.cost_usd,
    llmCalls: row.llm_calls,
    toolCalls: row.tool_calls,
  };
}

const USAGE_SQL = `
  SELECT run_id,
         SUM(tokens_in)  AS tokens_in,
         SUM(tokens_out) AS tokens_out,
         SUM(cost_usd)   AS cost_usd,
         SUM(CASE WHEN span_kind = 'llm'  THEN 1 ELSE 0 END) AS llm_calls,
         SUM(CASE WHEN span_kind = 'tool' THEN 1 ELSE 0 END) AS tool_calls
  FROM run_events
  WHERE status = 'ok'`;

export function usageForRun(runId: string): UsageSummary | null {
  const row = get<UsageRow>(`${USAGE_SQL} AND run_id = ? GROUP BY run_id`, runId);
  return row ? rowToUsage(row) : null;
}

export function usageSummary(): UsageSummary[] {
  return all<UsageRow>(`${USAGE_SQL} GROUP BY run_id ORDER BY run_id`).map(rowToUsage);
}

export interface RunDetail {
  run: Run;
  events: RunEvent[];
  tasks: Task[];
  messages: Message[];
  approvals: ApprovalRequest[];
}

/** GET /api/runs/:id 聚合视图 */
export function runDetail(id: string): RunDetail | null {
  const run = getRun(id);
  if (!run) return null;
  return {
    run,
    events: listEvents(id),
    tasks: listTasks(id),
    messages: listByRun(id),
    approvals: listApprovals().filter((a) => a.runId === id),
  };
}

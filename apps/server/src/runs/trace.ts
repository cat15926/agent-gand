/**
 * 运行与观测（规格 §4.2 runs/trace.ts）
 * createRun/startSpan/endSpan/finishRun；usage 按 run 汇总（SUM tokens/cost + llm/tool 调用数）
 */
import type {
  AgentDefinition,
  ApprovalRequest,
  Message,
  Run,
  RunEvent,
  RunMode,
  RunStatus,
  SpanAttributes,
  SpanAttributeValue,
  SpanKind,
  SpanStatus,
  Task,
  TaskAttempt,
  TaskReview,
  UsageSummary,
} from '@agent-gand/shared';
import { randomUUID } from 'node:crypto';
import { all, get, run, tx } from '../db/database.ts';
import { getAnyAgent } from '../agents/registry.ts';
import { emit } from '../messaging/bus.ts';
import { listApprovals } from '../hitl/approvals.ts';
import { listByRun } from '../messaging/inbox.ts';
import { listTasks } from '../messaging/tasks.ts';
import { listAttempts } from '../tasks/attempts.ts';
import { listReviews } from '../tasks/reviews.ts';

interface RunRow {
  id: string;
  conversation_id: string;
  turn_no: number;
  goal: string;
  mode: string;
  status: string;
  agent_ids: string;
  supervisor_id: string | null;
  default_reviewer_id: string | null;
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
  attributes: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  started_at: string;
  first_token_at: string | null;
  ended_at: string | null;
}

function legacySpanAttributes(row: RunEventRow): SpanAttributes {
  const attributes: SpanAttributes = { 'observability.version': 1, 'run.id': row.run_id };
  const separator = row.name.indexOf(':');
  const value = separator >= 0 ? row.name.slice(separator + 1).split(/[（(]/u)[0]?.trim() : '';
  if (row.span_kind === 'agent' && value) attributes['agent.id'] = value;
  if (row.span_kind === 'llm' && value) attributes['llm.model'] = value;
  if (row.span_kind === 'tool' && value) attributes['tool.name'] = value;
  return attributes;
}

function parseSpanAttributes(row: RunEventRow): SpanAttributes {
  try {
    const parsed = JSON.parse(row.attributes || '{}') as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...legacySpanAttributes(row), ...(parsed as SpanAttributes) };
    }
  } catch { /* 旧库中的损坏属性按兼容规则回退，不影响 trace 查询。 */ }
  return legacySpanAttributes(row);
}

function rowToRun(row: RunRow): Run {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnNo: row.turn_no,
    goal: row.goal,
    mode: row.mode as RunMode,
    status: row.status as RunStatus,
    agentIds: JSON.parse(row.agent_ids) as string[],
    supervisorId: row.supervisor_id ?? null,
    defaultReviewerId: row.default_reviewer_id ?? null,
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
    attributes: parseSpanAttributes(row),
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costUsd: row.cost_usd,
    startedAt: row.started_at,
    firstTokenAt: row.first_token_at ?? null,
    endedAt: row.ended_at,
  };
}

/** workspace：命名工作区（§10.2，校验后的值）；null = runId 专属目录 */
export function createRun(
  goal: string,
  mode: RunMode,
  agentIds: string[],
  workspace: string | null = null,
  supervisorId: string | null = null,
  conversationId = '',
  turnNo = 1,
  defaultReviewerId: string | null = null,
): Run {
  const record: Run = {
    id: randomUUID(),
    conversationId,
    turnNo,
    goal,
    mode,
    status: 'pending',
    agentIds,
    supervisorId,
    defaultReviewerId,
    workspace,
    title: goal.slice(0, 24), // §13.2 缺省标题：目标前 24 字
    deletedAt: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };
  tx(() => {
    const agents = record.agentIds.map((id) => {
      const agent = getAnyAgent(id);
      if (!agent?.enabled) throw new Error(`Agent 不存在或已停用: ${id}`);
      return agent;
    });
    run(
      `INSERT INTO runs (id,conversation_id,turn_no,goal,mode,status,agent_ids,supervisor_id,default_reviewer_id,workspace,title,created_at,finished_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
      record.id, record.conversationId, record.turnNo, record.goal, record.mode, record.status,
      JSON.stringify(record.agentIds), record.supervisorId, record.defaultReviewerId, record.workspace, record.title, record.createdAt,
    );
    for (const agent of agents) run(
      'INSERT INTO run_agent_snapshots (run_id,agent_id,version,definition,created_at) VALUES (?,?,?,?,?)',
      record.id, agent.id, agent.version, JSON.stringify(agent), record.createdAt,
    );
  });
  emit({ type: 'run.updated', run: record });
  return record;
}

export function listRunAgentSnapshots(runId: string): AgentDefinition[] {
  return all<{ definition: string }>('SELECT definition FROM run_agent_snapshots WHERE run_id=? ORDER BY rowid', runId)
    .map((row) => JSON.parse(row.definition) as AgentDefinition);
}

/** 升级旧库时以迁移时的角色版本补齐历史 Run；之后所有新 Run 都在创建事务内写快照。 */
export function backfillRunAgentSnapshots(): void {
  const rows = all<{ id: string; agent_ids: string; created_at: string }>(
    `SELECT r.id,r.agent_ids,r.created_at FROM runs r
     WHERE NOT EXISTS (SELECT 1 FROM run_agent_snapshots s WHERE s.run_id=r.id)`,
  );
  tx(() => {
    for (const item of rows) {
      for (const id of JSON.parse(item.agent_ids) as string[]) {
        const agent = getAnyAgent(id); if (!agent) continue;
        run('INSERT OR IGNORE INTO run_agent_snapshots (run_id,agent_id,version,definition,created_at) VALUES (?,?,?,?,?)', item.id, id, agent.version, JSON.stringify(agent), item.created_at);
      }
    }
  });
}

export function listRunsByConversation(conversationId: string): Run[] {
  return all<RunRow>('SELECT * FROM runs WHERE conversation_id = ? ORDER BY turn_no ASC', conversationId).map(rowToRun);
}

export function listPendingRunsByConversation(conversationId: string): Run[] {
  return all<RunRow>("SELECT * FROM runs WHERE conversation_id = ? AND status = 'pending' ORDER BY turn_no ASC", conversationId).map(rowToRun);
}

export function getRun(id: string): Run | undefined {
  const row = get<RunRow>('SELECT * FROM runs WHERE id = ?', id);
  return row ? rowToRun(row) : undefined;
}

/** §13.3 列表过滤：默认排除软删；includeDeleted=1 含软删；q 模糊匹配标题与目标；status 精确。
 *  q 做 LIKE 字面转义（\→\\、%→\%、_→\_ + ESCAPE '\'）：'%'/'_' 按字面命中而非通配（inspector 终验返工） */
export function listRuns(opts: { includeDeleted?: boolean; q?: string; status?: string } = {}): Run[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.includeDeleted !== true) where.push('deleted_at IS NULL');
  if (opts.q && opts.q.length > 0) {
    const literal = `%${opts.q.replace(/([\\%_])/g, '\\$1')}%`;
    // TS 双引号串里 '\\' 的值是单个反斜杠 → SQL ESCAPE 得到单字符（ESCAPE 要求恰好一个字符）
    where.push("(title LIKE ? ESCAPE '\\' OR goal LIKE ? ESCAPE '\\')");
    params.push(literal, literal);
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
  if (status === 'running') run('UPDATE runs SET status = ?, finished_at = NULL WHERE id = ?', status, runId);
  else run('UPDATE runs SET status = ? WHERE id = ?', status, runId);
  const runRow = get<RunRow>('SELECT * FROM runs WHERE id = ?', runId);
  if (runRow) emit({ type: 'run.updated', run: rowToRun(runRow) });
}

export interface StartSpanInput {
  parentId?: string | null;
  spanKind: SpanKind;
  name: string;
  input?: string | null;
  attributes?: SpanAttributes;
}

const INHERITED_ATTRIBUTE_KEYS = [
  'agent.id', 'agent.role', 'task.id', 'task.attempt.id', 'task.attempt.no',
  'collaboration.dispatch.id', 'collaboration.batch.id',
  'coordination.plan.id', 'coordination.step.id', 'coordination.attempt.id', 'coordination.attempt.no',
] as const;

function inheritedSpanAttributes(parentId: string | null | undefined): SpanAttributes {
  if (!parentId) return {};
  const parent = get<RunEventRow>('SELECT * FROM run_events WHERE id = ?', parentId);
  if (!parent) return {};
  const source = parseSpanAttributes(parent);
  const inherited: SpanAttributes = {};
  for (const key of INHERITED_ATTRIBUTE_KEYS) {
    const value = source[key];
    if (value !== undefined) (inherited as Record<string, SpanAttributeValue | undefined>)[key] = value;
  }
  return inherited;
}

export function startSpan(runId: string, input: StartSpanInput): RunEvent {
  const owner = getRun(runId);
  const attributes: SpanAttributes = {
    ...inheritedSpanAttributes(input.parentId),
    ...input.attributes,
    'observability.version': 1,
    'run.id': runId,
    ...(owner ? { 'run.mode': owner.mode } : {}),
  };
  const event: RunEvent = {
    id: randomUUID(),
    runId,
    parentId: input.parentId ?? null,
    spanKind: input.spanKind,
    name: input.name,
    input: input.input ?? null,
    output: null,
    status: 'running',
    attributes,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    startedAt: new Date().toISOString(),
    firstTokenAt: null,
    endedAt: null,
  };
  run(
    `INSERT INTO run_events (id, run_id, parent_id, span_kind, name, input, output, status, attributes, tokens_in, tokens_out, cost_usd, started_at, first_token_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, 0, 0, ?, NULL, NULL)`,
    event.id,
    event.runId,
    event.parentId,
    event.spanKind,
    event.name,
    event.input,
    event.status,
    JSON.stringify(event.attributes),
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
  /** 结束时补充的结果属性（如 stop_reason），与开始属性合并。 */
  attributes?: SpanAttributes;
}

export function endSpan(span: RunEvent, input: EndSpanInput = {}): RunEvent {
  const persistedTiming = get<{ first_token_at: string | null }>('SELECT first_token_at FROM run_events WHERE id = ?', span.id);
  const ended: RunEvent = {
    ...span,
    output: input.output ?? null,
    status: input.status ?? 'ok',
    attributes: { ...span.attributes, ...input.attributes },
    tokensIn: input.tokensIn ?? 0,
    tokensOut: input.tokensOut ?? 0,
    costUsd: input.costUsd ?? 0,
    firstTokenAt: persistedTiming?.first_token_at ?? span.firstTokenAt,
    endedAt: new Date().toISOString(),
  };
  run(
    `UPDATE run_events
     SET output = ?, status = ?, attributes = ?, tokens_in = ?, tokens_out = ?, cost_usd = ?, ended_at = ?
     WHERE id = ?`,
    ended.output,
    ended.status,
    JSON.stringify(ended.attributes),
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

/** 首个 LLM 正文增量只记录一次；同时广播更新，让活动轨迹可以展示 TTFT。 */
export function markSpanFirstToken(spanId: string): RunEvent | undefined {
  const at = new Date().toISOString();
  const changed = run('UPDATE run_events SET first_token_at = ? WHERE id = ? AND first_token_at IS NULL', at, spanId);
  const row = get<RunEventRow>('SELECT * FROM run_events WHERE id = ?', spanId);
  if (!row) return undefined;
  const event = rowToRunEvent(row);
  if (changed > 0) emit({ type: 'run.event', event });
  return event;
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

export function getEvent(runId: string, spanId: string): RunEvent | undefined {
  const row = get<RunEventRow>('SELECT * FROM run_events WHERE run_id = ? AND id = ?', runId, spanId);
  return row ? rowToRunEvent(row) : undefined;
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
  agents: AgentDefinition[];
  events: RunEvent[];
  tasks: Task[];
  messages: Message[];
  approvals: ApprovalRequest[];
  attempts: TaskAttempt[];
  reviews: TaskReview[];
}

/** GET /api/runs/:id 聚合视图 */
export function runDetail(id: string): RunDetail | null {
  const run = getRun(id);
  if (!run) return null;
  const tasks = listTasks(id);
  return {
    run,
    agents: listRunAgentSnapshots(id),
    events: listEvents(id),
    tasks,
    messages: listByRun(id),
    approvals: listApprovals().filter((a) => a.runId === id),
    attempts: tasks.flatMap((task) => listAttempts(task.id)),
    reviews: tasks.flatMap((task) => listReviews(task.id)),
  };
}

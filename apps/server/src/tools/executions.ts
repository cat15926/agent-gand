import { createHash, randomUUID } from 'node:crypto';
import type { ToolExecution, ToolReplayPolicy } from '@agent-gand/shared';
import { all, get, run, tx } from '../db/database.ts';

interface Row {
  id: string; run_id: string; agent_id: string; task_id: string | null; attempt_id: string | null;
  tool_name: string; idempotency_key: string; input: string; replay_policy: ToolReplayPolicy;
  status: ToolExecution['status']; output: string | null; error: string | null;
  span_id: string | null; created_at: string; started_at: string; ended_at: string | null;
}
const map = (row: Row): ToolExecution => ({
  id: row.id, runId: row.run_id, agentId: row.agent_id, taskId: row.task_id,
  attemptId: row.attempt_id, toolName: row.tool_name, idempotencyKey: row.idempotency_key,
  input: row.input, replayPolicy: row.replay_policy, status: row.status, output: row.output,
  error: row.error, spanId: row.span_id, createdAt: row.created_at,
  startedAt: row.started_at, endedAt: row.ended_at,
});

export function toolExecutionKey(parts: { runId: string; scope: string; round: number; index: number; toolName: string; input: string }): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function listToolExecutions(runId: string): ToolExecution[] {
  return all<Row>('SELECT * FROM tool_executions WHERE run_id=? ORDER BY created_at,rowid', runId).map(map);
}

/** 恢复以结构化账本为准，不从 Tool Span 的成功文本推测副作用。 */
export function reconcileInterruptedToolExecutions(attemptId: string): { needsAttention: boolean; found: boolean; reasons: string[] } {
  return tx(() => {
    const rows = all<Row>('SELECT * FROM tool_executions WHERE attempt_id=? ORDER BY created_at,rowid', attemptId);
    const reasons: string[] = [];
    const now = new Date().toISOString();
    for (const row of rows) {
      if (row.status === 'completed' || row.status === 'interrupted') continue;
      if (row.status === 'needs_attention' || (row.replay_policy === 'manual' && (row.status === 'running' || row.status === 'failed'))) {
        reasons.push(`${row.tool_name}:${row.id}`);
        run("UPDATE tool_executions SET status='needs_attention',error=?,ended_at=? WHERE id=?",
          '执行结果或副作用不确定，禁止自动重放', now, row.id);
      } else if (row.status === 'running') {
        run("UPDATE tool_executions SET status='interrupted',error=?,ended_at=? WHERE id=?",
          '所属 Attempt 中断；允许按 replay_policy 重试', now, row.id);
      }
    }
    return { needsAttention: reasons.length > 0, found: rows.length > 0, reasons };
  });
}

export async function executeToolOnce(input: {
  runId: string; agentId: string; taskId?: string; attemptId?: string; toolName: string;
  input: string; idempotencyKey: string; replayPolicy: ToolReplayPolicy; spanId: string;
  execute: () => Promise<string>;
}): Promise<{ output: string; replayed: boolean }> {
  const claimed = tx(() => {
    const existing = get<Row>('SELECT * FROM tool_executions WHERE idempotency_key=?', input.idempotencyKey);
    if (existing) {
      if (existing.run_id !== input.runId || existing.agent_id !== input.agentId || existing.tool_name !== input.toolName
        || existing.input !== input.input || existing.replay_policy !== input.replayPolicy) {
        throw new Error(`工具执行幂等键冲突：${input.toolName}`);
      }
      if (existing.status === 'completed') return { id: existing.id, cached: existing.output ?? '' };
      if (existing.status === 'running') throw new Error(`工具 ${input.toolName} 已在执行，不能并发重放`);
      if (existing.status === 'needs_attention' || (existing.replay_policy === 'manual' && (existing.status === 'failed' || existing.status === 'interrupted'))) {
        throw new Error(`工具 ${input.toolName} 的执行结果或副作用不确定，需要人工处理`);
      }
      run("UPDATE tool_executions SET status='running',attempt_id=?,error=NULL,span_id=?,started_at=?,ended_at=NULL WHERE id=?",
        input.attemptId ?? null, input.spanId, new Date().toISOString(), existing.id);
      return { id: existing.id, cached: null };
    }
    const id = randomUUID(); const now = new Date().toISOString();
    run(`INSERT INTO tool_executions (id,run_id,agent_id,task_id,attempt_id,tool_name,idempotency_key,input,replay_policy,status,span_id,created_at,started_at)
      VALUES (?,?,?,?,?,?,?,?,?,'running',?,?,?)`, id, input.runId, input.agentId, input.taskId ?? null,
      input.attemptId ?? null, input.toolName, input.idempotencyKey, input.input, input.replayPolicy, input.spanId, now, now);
    return { id, cached: null };
  });
  if (claimed.cached !== null) return { output: claimed.cached, replayed: true };
  try {
    const output = await input.execute();
    const changed = run("UPDATE tool_executions SET status='completed',output=?,error=NULL,ended_at=? WHERE id=? AND status='running' AND attempt_id IS ? AND span_id=?",
      output, new Date().toISOString(), claimed.id, input.attemptId ?? null, input.spanId);
    if (changed === 0) throw new Error(`工具 ${input.toolName} 的执行归属已失效，迟到结果已丢弃`);
    return { output, replayed: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    run("UPDATE tool_executions SET status='failed',error=?,ended_at=? WHERE id=? AND status='running' AND attempt_id IS ? AND span_id=?",
      message, new Date().toISOString(), claimed.id, input.attemptId ?? null, input.spanId);
    throw error;
  }
}

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { ExternalAgentExecution } from '@agent-gand/shared';
import { all, get, run } from '../db/database.ts';
import { emit } from '../messaging/bus.ts';

export function getExecution(id: string): ExternalAgentExecution | null {
  const row = get<{ record: string }>('SELECT record FROM external_agent_executions WHERE id=?', id);
  return row ? JSON.parse(row.record) as ExternalAgentExecution : null;
}
export function findExecution(runId: string, agentId: string, scopeId: string): ExternalAgentExecution | null {
  const row = get<{ record: string }>('SELECT record FROM external_agent_executions WHERE run_id=? AND agent_id=? AND scope_id=?', runId, agentId, scopeId);
  return row ? JSON.parse(row.record) as ExternalAgentExecution : null;
}
export function listExecutions(runId: string): ExternalAgentExecution[] {
  return all<{ record: string }>('SELECT record FROM external_agent_executions WHERE run_id=? ORDER BY rowid', runId).map((row) => JSON.parse(row.record) as ExternalAgentExecution);
}
export function createExecution(input: Pick<ExternalAgentExecution, 'runId' | 'agentId' | 'scopeId' | 'driver' | 'agentVersion' | 'cwd'>): ExternalAgentExecution {
  const record: ExternalAgentExecution = { ...input, id: randomUUID(), host: hostname(), status: 'running', sessionId: null, driverVersion: null,
    errorCode: null, error: null, content: '', tokensIn: null, tokensOut: null, costUsd: null, startedAt: new Date().toISOString(), finishedAt: null, processOwnership: 'guardian-v1' };
  run('INSERT INTO external_agent_executions (id,run_id,agent_id,scope_id,status,record) VALUES (?,?,?,?,?,?)', record.id, record.runId, record.agentId, record.scopeId, record.status, JSON.stringify(record));
  emit({ type: 'execution.updated', execution: record });
  return record;
}
export function updateExecution(id: string, patch: Partial<ExternalAgentExecution>): ExternalAgentExecution {
  const previous = getExecution(id);
  if (!previous) throw new Error(`Execution 不存在：${id}`);
  if (previous.status !== 'running') return previous;
  const record = { ...previous, ...patch };
  run('UPDATE external_agent_executions SET status=?,record=? WHERE id=? AND status=\'running\'', record.status, JSON.stringify(record), id);
  emit({ type: 'execution.updated', execution: record });
  return record;
}

/** Native sessions are never automatically replayed after host restart. */
export function interruptStaleExecutions(): void {
  for (const row of all<{ id: string }>("SELECT id FROM external_agent_executions WHERE status='running'")) updateExecution(row.id, {
    status: 'interrupted', errorCode: 'interrupted', error: '服务重启，原生执行状态不确定；检查实际变更后再创建新运行，不自动重放', finishedAt: new Date().toISOString(),
  });
  // Decisions from an old native process can never authorize a new invocation.
  run(`UPDATE approvals SET status='expired',decided_by='system:restart',decided_at=? WHERE status='pending' AND id IN (SELECT approval_id FROM external_agent_approvals)`, new Date().toISOString());
}

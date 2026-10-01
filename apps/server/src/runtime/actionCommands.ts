import { randomUUID } from 'node:crypto';
import type { RuntimeActionCommandKind, RuntimeActionCommandRecord } from '@agent-gand/shared';
import { afterCommit, all, get, run, tx } from '../db/database.ts';
import { emit } from '../messaging/bus.ts';

interface CommandRow {
  id: string;
  run_id: string;
  kind: RuntimeActionCommandKind;
  command_key: string;
  attempt_id: string | null;
  dispatch_id: string | null;
  result: string;
  created_at: string;
  committed_at: string;
}

export interface RuntimeActionCommandInput<T> {
  runId: string;
  commandKey: string;
  attemptId?: string | null;
  dispatchId?: string | null;
  execute: () => T;
}

export interface RuntimeActionCommandResult<T> {
  committed: boolean;
  command: RuntimeActionCommandRecord;
  result: T;
}

function toCommand(row: CommandRow): RuntimeActionCommandRecord {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    commandKey: row.command_key,
    attemptId: row.attempt_id,
    dispatchId: row.dispatch_id,
    result: JSON.parse(row.result) as unknown,
    createdAt: row.created_at,
    committedAt: row.committed_at,
  };
}

function assertSameCommand<T>(row: CommandRow, kind: RuntimeActionCommandKind,
  input: RuntimeActionCommandInput<T>): RuntimeActionCommandResult<T> {
  if (row.run_id !== input.runId || row.kind !== kind
    || row.attempt_id !== (input.attemptId ?? null) || row.dispatch_id !== (input.dispatchId ?? null)) {
    throw new Error(`Runtime 动作命令幂等键冲突：${input.commandKey}`);
  }
  const command = toCommand(row);
  return { committed: false, command, result: command.result as T };
}

function commitAction<T>(kind: RuntimeActionCommandKind,
  input: RuntimeActionCommandInput<T>): RuntimeActionCommandResult<T> {
  if (!input.commandKey.trim()) throw new Error('Runtime 动作命令缺少 commandKey');
  return tx(() => {
    const existing = get<CommandRow>('SELECT * FROM runtime_action_commands WHERE command_key=?', input.commandKey);
    if (existing) return assertSameCommand(existing, kind, input);
    const runRow = get<{ status: string }>('SELECT status FROM runs WHERE id=?', input.runId);
    if (!runRow) throw new Error(`Runtime 动作命令的 Run 不存在：${input.runId}`);
    if (['completed', 'failed', 'cancelled'].includes(runRow.status)) {
      throw new Error(`Runtime 动作命令不能提交到终态 Run：${runRow.status}`);
    }
    const result = input.execute();
    const encoded = JSON.stringify(result ?? null);
    const now = new Date().toISOString();
    const id = randomUUID();
    run(`INSERT INTO runtime_action_commands
      (id,run_id,kind,command_key,attempt_id,dispatch_id,result,created_at,committed_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, id, input.runId, kind, input.commandKey,
    input.attemptId ?? null, input.dispatchId ?? null, encoded, now, now);
    const command = toCommand(get<CommandRow>('SELECT * FROM runtime_action_commands WHERE id=?', id)!);
    afterCommit(() => emit({ type: 'runtime.action_command.committed', command }));
    return { committed: true, command, result };
  });
}

export const commitCompleteActionCommand = <T>(input: RuntimeActionCommandInput<T>) => commitAction('complete', input);
export const commitWakeActionCommand = <T>(input: RuntimeActionCommandInput<T>) => commitAction('wake', input);
export const commitHoldActionCommand = <T>(input: RuntimeActionCommandInput<T>) => commitAction('hold', input);
export const commitHandoffActionCommand = <T>(input: RuntimeActionCommandInput<T>) => commitAction('handoff', input);
export const commitConsultAllActionCommand = <T>(input: RuntimeActionCommandInput<T>) => commitAction('consult_all', input);

export function getRuntimeActionCommand(commandKey: string): RuntimeActionCommandRecord | null {
  const row = get<CommandRow>('SELECT * FROM runtime_action_commands WHERE command_key=?', commandKey);
  return row ? toCommand(row) : null;
}

export function listRuntimeActionCommands(runId: string): RuntimeActionCommandRecord[] {
  return all<CommandRow>('SELECT * FROM runtime_action_commands WHERE run_id=? ORDER BY committed_at,rowid', runId)
    .map(toCommand);
}

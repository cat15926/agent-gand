import { createHash, randomUUID } from 'node:crypto';
import type { RuntimeActionCommandKind, RuntimeActionCommandRecord } from '@agent-gand/shared';
import { afterCommit, all, get, run, tx } from '../db/database.ts';
import { loadRuntimeContract } from './runPolicy.ts';
import { commitScopedOutput, ScopedCollaborationError, type ScopedAttemptBinding } from './scopedCollaboration.ts';
import type { MessageAccess } from '@agent-gand/shared';
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
  boundary_fingerprint: string | null;
}

export interface RuntimeActionCommandInput<T> {
  runId: string;
  commandKey: string;
  attemptId?: string | null;
  dispatchId?: string | null;
  scope?: ScopedAttemptBinding & { ledgerRevision: number; outputAccess: MessageAccess };
  /** Server-only status projection; no model text may be published through this command. */
  projection?: { batchId: string; planFingerprint: string };
  intentFingerprint?: string;
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
    || row.attempt_id !== (input.attemptId ?? null) || row.dispatch_id !== (input.dispatchId ?? null)
    || (row.boundary_fingerprint ?? null) !== boundaryFingerprint(input)) {
    throw new Error(`Runtime 动作命令幂等键冲突：${input.commandKey}`);
  }
  const command = toCommand(row);
  return { committed: false, command, result: command.result as T };
}

function boundaryFingerprint<T>(input: RuntimeActionCommandInput<T>): string | null {
  const s = input.scope;
  if (input.projection) return createHash('sha256').update(JSON.stringify(['scoped-return-v1',input.runId,input.projection.batchId,input.projection.planFingerprint])).digest('hex');
  return s ? createHash('sha256').update(JSON.stringify([s.runId, s.scopeId, s.attemptId, s.agentId,
    s.ledgerRevision, s.outputAccess.visibility, [...s.outputAccess.audience].sort(),
    ...(input.intentFingerprint ? [input.intentFingerprint] : [])])).digest('hex') : null;
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
    const scoped = loadRuntimeContract(input.runId)?.features?.scopedCollaboration;
    const projection = input.projection;
    if (projection && (kind !== 'wake' || input.scope || input.attemptId || input.dispatchId
      || scoped?.deliveryVersion !== 1 || !get(`SELECT 1 FROM scoped_delivery_plans p
        JOIN scoped_delivery_batches s ON s.run_id=p.run_id JOIN collaboration_batches b ON b.id=s.batch_id
        WHERE p.run_id=? AND p.fingerprint=? AND b.id=? AND b.result_dispatch_id IS NULL AND b.status<>'cancelled'
        AND NOT EXISTS (SELECT 1 FROM collaboration_dispatches d WHERE d.batch_id=b.id AND d.kind='fanout' AND d.status IN ('queued','running'))`,
        input.runId,projection.planFingerprint,projection.batchId))) throw new ScopedCollaborationError('SCOPE_BINDING_INVALID');
    if (scoped && !projection && (!input.scope || input.scope.runId !== input.runId || input.scope.attemptId !== input.attemptId
      || !get('SELECT 1 FROM collaboration_attempts WHERE id=? AND dispatch_id=?', input.attemptId, input.dispatchId))) {
      throw new ScopedCollaborationError('SCOPE_BINDING_INVALID');
    }
    if (!scoped && input.scope) throw new ScopedCollaborationError('SCOPE_BINDING_INVALID');
    const result = input.scope ? commitScopedOutput(input.scope, input.execute) : input.execute();
    const encoded = JSON.stringify(result ?? null);
    const now = new Date().toISOString();
    const id = randomUUID();
    run(`INSERT INTO runtime_action_commands
      (id,run_id,kind,command_key,attempt_id,dispatch_id,result,created_at,committed_at,boundary_fingerprint)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, id, input.runId, kind, input.commandKey,
    input.attemptId ?? null, input.dispatchId ?? null, encoded, now, now, boundaryFingerprint(input));
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
export const commitConsultAnyActionCommand = <T>(input: RuntimeActionCommandInput<T>) => commitAction('consult_any', input);

export function getRuntimeActionCommand(commandKey: string): RuntimeActionCommandRecord | null {
  const row = get<CommandRow>('SELECT * FROM runtime_action_commands WHERE command_key=?', commandKey);
  return row ? toCommand(row) : null;
}

export function listRuntimeActionCommands(runId: string): RuntimeActionCommandRecord[] {
  return all<CommandRow>('SELECT * FROM runtime_action_commands WHERE run_id=? ORDER BY committed_at,rowid', runId)
    .map(toCommand);
}

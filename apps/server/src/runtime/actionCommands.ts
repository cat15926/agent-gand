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
  releaseWake?: { holdId: string; claimToken: string };
  /** AC2 status-only wake; authority comes from the persisted round and waiting generation. */
  autonomousWake?: {roundId:string;generation:number};
  autonomousPauseWake?:{pointId:string;generation:number};
  autonomousDecisionWake?: {decisionId:string;generation:number};
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
  if(input.autonomousPauseWake)return createHash('sha256').update(JSON.stringify(['autonomous-pause-wake-v1',input.runId,input.autonomousPauseWake.pointId,input.autonomousPauseWake.generation])).digest('hex');
  if(input.autonomousDecisionWake)return createHash('sha256').update(JSON.stringify(['autonomous-decision-wake-v1',input.runId,input.autonomousDecisionWake.decisionId,input.autonomousDecisionWake.generation])).digest('hex');
  if(input.autonomousWake)return createHash('sha256').update(JSON.stringify(['autonomous-wake-v1',input.runId,input.autonomousWake.roundId,input.autonomousWake.generation])).digest('hex');
  if (input.releaseWake) return createHash('sha256').update(JSON.stringify(['release-wake-v1',input.runId,input.releaseWake.holdId])).digest('hex');
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
    const features=loadRuntimeContract(input.runId)?.features;
    const scoped = features?.scopedCollaboration;
    const autonomous=features?.autonomousCollaboration?.delegationVersion===1;
    if(input.autonomousPauseWake&&(!autonomous||features?.autonomousCollaboration?.entryVersion!==1||kind!=='wake'||input.scope||input.autonomousWake||input.autonomousDecisionWake||input.projection||input.releaseWake||input.attemptId||input.dispatchId||!get(`SELECT 1 FROM autonomous_pause_points p JOIN autonomous_work_items w ON w.id=p.work_id JOIN autonomous_task_grants g ON g.id=w.grant_id JOIN runtime_custody c ON c.subject_id=g.subject_id WHERE p.id=? AND p.run_id=? AND p.generation=? AND c.state='waiting' AND c.generation=p.generation`,input.autonomousPauseWake.pointId,input.runId,input.autonomousPauseWake.generation)))throw new ScopedCollaborationError('SCOPE_BINDING_INVALID');
    if(input.autonomousDecisionWake&&(!autonomous||features?.autonomousCollaboration?.deliveryVersion!==1||kind!=='wake'||input.scope||input.autonomousWake||input.projection||input.releaseWake||input.attemptId||input.dispatchId||!get(`SELECT 1 FROM autonomous_decision_proposals p JOIN autonomous_decision_resolutions r ON r.decision_id=p.id
      JOIN autonomous_work_items w ON w.id=p.work_id JOIN autonomous_task_grants g ON g.id=w.grant_id JOIN runtime_custody c ON c.subject_id=g.subject_id
      WHERE p.id=? AND p.run_id=? AND p.generation=? AND c.state='waiting' AND c.generation=p.generation`,input.autonomousDecisionWake.decisionId,input.runId,input.autonomousDecisionWake.generation)))throw new ScopedCollaborationError('SCOPE_BINDING_INVALID');
    if(input.autonomousWake&&(!autonomous||kind!=='wake'||input.scope||input.attemptId||input.dispatchId||input.projection||input.releaseWake||!get(`SELECT 1 FROM autonomous_delegation_rounds r
      JOIN autonomous_work_items w ON w.id=r.parent_work_id JOIN autonomous_task_grants g ON g.id=w.grant_id
      JOIN runtime_custody c ON c.subject_id=g.subject_id JOIN runs task ON task.id=r.run_id
      WHERE r.id=? AND r.run_id=? AND r.generation=? AND c.generation=r.generation AND c.state='waiting' AND task.status='running'
        AND NOT EXISTS(SELECT 1 FROM json_each(r.work_ids) item JOIN autonomous_work_items child ON child.id=item.value
          JOIN autonomous_task_grants cg ON cg.id=child.grant_id JOIN runtime_subjects s ON s.id=cg.subject_id WHERE s.status IN ('active','waiting'))`,input.autonomousWake.roundId,input.runId,input.autonomousWake.generation)))throw new ScopedCollaborationError('SCOPE_BINDING_INVALID');
    const projection = input.projection;
    if (projection && (kind !== 'wake' || input.scope || input.attemptId || input.dispatchId
      || scoped?.deliveryVersion !== 1 || !get(`SELECT 1 FROM scoped_delivery_plans p
        JOIN scoped_delivery_batches s ON s.run_id=p.run_id JOIN collaboration_batches b ON b.id=s.batch_id
        WHERE p.run_id=? AND p.fingerprint=? AND b.id=? AND b.result_dispatch_id IS NULL AND b.status<>'cancelled'
        AND NOT EXISTS (SELECT 1 FROM collaboration_dispatches d WHERE d.batch_id=b.id AND d.kind='fanout' AND d.status IN ('queued','running'))`,
        input.runId,projection.planFingerprint,projection.batchId))) throw new ScopedCollaborationError('SCOPE_BINDING_INVALID');
    if(input.releaseWake && (kind!=='wake'||projection||input.scope||scoped?.releaseVersion!==1||!get(`SELECT 1 FROM runtime_holds h JOIN information_release_records r ON r.run_id=h.run_id WHERE h.id=? AND h.run_id=? AND h.status='claimed' AND h.claim_token=? AND h.claim_expires_at>? AND h.source_attempt_id=? AND h.source_dispatch_id=? AND json_extract(h.condition,'$.receiverId')='information-release-v1' AND json_extract(h.condition,'$.correlationId')=h.run_id`,input.releaseWake.holdId,input.runId,input.releaseWake.claimToken,new Date().toISOString(),input.attemptId,input.dispatchId))) throw new ScopedCollaborationError('SCOPE_BINDING_INVALID');
    if (scoped && !projection && !input.releaseWake && (!input.scope || input.scope.runId !== input.runId || input.scope.attemptId !== input.attemptId
      || !get('SELECT 1 FROM collaboration_attempts WHERE id=? AND dispatch_id=?', input.attemptId, input.dispatchId))) {
      throw new ScopedCollaborationError('SCOPE_BINDING_INVALID');
    }
    if(autonomous&&!input.autonomousWake&&!input.autonomousDecisionWake&&!input.autonomousPauseWake&&(!input.scope||input.projection||input.releaseWake||input.scope.runId!==input.runId||input.scope.attemptId!==input.attemptId||!get('SELECT 1 FROM collaboration_attempts WHERE id=? AND dispatch_id=?',input.attemptId,input.dispatchId)))throw new ScopedCollaborationError('SCOPE_BINDING_INVALID');
    if (!scoped && !autonomous && (input.scope||input.autonomousWake||input.autonomousDecisionWake||input.autonomousPauseWake)) throw new ScopedCollaborationError('SCOPE_BINDING_INVALID');
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
export const commitEmitActionCommand = <T>(input: RuntimeActionCommandInput<T>) => commitAction('emit', input);
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

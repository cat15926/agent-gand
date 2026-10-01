import type {
  Message,
  Run,
  RunTerminalDisposition,
  RuntimeCompletionEvaluation,
  RuntimeCompletionInput,
  RuntimeRunTerminalRecord,
} from '@agent-gand/shared';
import { afterCommit, get, run, tx } from '../db/database.ts';
import { emit } from '../messaging/bus.ts';
import { post, updateRunUserMessageStatus, type PostMessageInput } from '../messaging/inbox.ts';
import { getRun } from '../runs/trace.ts';
import { cancelDurableHolds } from './holds.ts';
import { cancelRunObligations } from './obligations.ts';
import { recordCompletionEvaluation } from './completionStore.ts';

type TerminalStatus = 'completed' | 'failed' | 'cancelled';

interface TerminalRow {
  run_id: string;
  status: TerminalStatus;
  disposition: RunTerminalDisposition;
  completion_evaluation_seq: number | null;
  report_message_id: string | null;
  reason_codes: string;
  source: string;
  committed_at: string;
}

export interface RuntimeTerminalPreparation {
  completion?: {
    input: RuntimeCompletionInput;
    evaluation: RuntimeCompletionEvaluation;
  };
  report?: Omit<PostMessageInput, 'runId'>;
  reasonCodes?: string[];
}

export interface CommitRunTerminalInput {
  runId: string;
  status: TerminalStatus;
  disposition: RunTerminalDisposition;
  source: string;
  /** 在 BEGIN IMMEDIATE 内重新读取最终快照并生成 Evaluation/报告。 */
  prepare?: () => RuntimeTerminalPreparation;
  /** Stop/Adapter 可在同一事务中关闭执行载体；不得执行网络或模型调用。 */
  closeExecution?: () => void;
  userMessageStatus?: NonNullable<Message['deliveryStatus']>;
}

export interface CommitRunTerminalResult {
  committed: boolean;
  run: Run;
  terminal: RuntimeRunTerminalRecord;
}

function toTerminal(row: TerminalRow): RuntimeRunTerminalRecord {
  return {
    runId: row.run_id,
    status: row.status,
    disposition: row.disposition,
    completionEvaluationSeq: row.completion_evaluation_seq,
    reportMessageId: row.report_message_id,
    reasonCodes: JSON.parse(row.reason_codes) as string[],
    source: row.source,
    committedAt: row.committed_at,
  };
}

function validDisposition(status: TerminalStatus, disposition: RunTerminalDisposition): boolean {
  if (status === 'completed') return ['accepted', 'authorized_partial', 'delegated'].includes(disposition);
  if (status === 'failed') return disposition === 'failed';
  return disposition === 'cancelled';
}

function existingResult(runId: string): CommitRunTerminalResult | null {
  const current = getRun(runId);
  if (!current) throw new Error(`Run 不存在：${runId}`);
  const stored = get<TerminalRow>('SELECT * FROM runtime_run_terminals WHERE run_id=?', runId);
  if (stored) return { committed: false, run: current, terminal: toTerminal(stored) };
  if (current.status !== 'completed' && current.status !== 'failed' && current.status !== 'cancelled') return null;
  const disposition = current.terminalDisposition
    ?? (current.status === 'completed' ? 'accepted' : current.status);
  return { committed: false, run: current, terminal: {
    runId, status: current.status, disposition,
    completionEvaluationSeq: null, reportMessageId: null, reasonCodes: [],
    source: 'legacy_compat', committedAt: current.finishedAt ?? current.createdAt,
  } };
}

/**
 * Run 唯一终局提交边界。BEGIN IMMEDIATE 串行化竞争者，CAS 决定赢家；
 * Completion Evaluation、报告、Run 终态和 Runtime 关闭动作随事务一起提交或回滚。
 */
export function commitRunTerminal(input: CommitRunTerminalInput): CommitRunTerminalResult {
  if (!validDisposition(input.status, input.disposition)) {
    throw new Error(`终态 ${input.status} 与 disposition ${input.disposition} 不一致`);
  }
  return tx(() => {
    const existing = existingResult(input.runId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const changed = run(`UPDATE runs SET status=?,terminal_disposition=?,finished_at=?
      WHERE id=? AND status NOT IN ('completed','failed','cancelled')`,
    input.status, input.disposition, now, input.runId);
    if (changed === 0) return existingResult(input.runId)!;

    input.closeExecution?.();
    const prepared = input.prepare?.() ?? {};
    if (input.status === 'completed') {
      if (!prepared.completion || prepared.completion.evaluation.status !== 'accepted') {
        throw new Error('completed 终态必须携带事务内重新判定的 accepted Completion Evaluation');
      }
      const expected = prepared.completion.evaluation.disposition === 'partial_user_accepted' ? 'authorized_partial'
        : prepared.completion.evaluation.disposition === 'delegated' ? 'delegated' : 'accepted';
      if (expected !== input.disposition) throw new Error(`Completion disposition 不一致：${expected} != ${input.disposition}`);
    }
    let evaluationSeq: number | null = null;
    if (prepared.completion) {
      recordCompletionEvaluation(input.runId, prepared.completion.evaluation, prepared.completion.input);
      evaluationSeq = get<{ seq: number }>(
        'SELECT seq FROM runtime_completion_evaluations WHERE run_id=? ORDER BY seq DESC LIMIT 1', input.runId)?.seq ?? null;
    }
    cancelDurableHolds(input.runId, `run_terminal:${input.status}`);
    cancelRunObligations(input.runId, `run-terminal:${input.runId}:${input.status}`);

    const report = prepared.report ? post({ ...prepared.report, runId: input.runId }) : null;
    if (input.userMessageStatus) updateRunUserMessageStatus(input.runId, input.userMessageStatus);
    const reasonCodes = prepared.reasonCodes ?? (prepared.completion?.evaluation.reasons ?? []);
    run(`INSERT INTO runtime_run_terminals
      (run_id,status,disposition,completion_evaluation_seq,report_message_id,reason_codes,source,committed_at)
      VALUES (?,?,?,?,?,?,?,?)`, input.runId, input.status, input.disposition, evaluationSeq,
    report?.id ?? null, JSON.stringify(reasonCodes), input.source, now);
    const terminal = toTerminal(get<TerminalRow>('SELECT * FROM runtime_run_terminals WHERE run_id=?', input.runId)!);
    const committedRun = getRun(input.runId)!;
    afterCommit(() => emit({ type: 'run.updated', run: committedRun }));
    return { committed: true, run: committedRun, terminal };
  });
}

export function getRunTerminal(runId: string): RuntimeRunTerminalRecord | null {
  const row = get<TerminalRow>('SELECT * FROM runtime_run_terminals WHERE run_id=?', runId);
  return row ? toTerminal(row) : null;
}

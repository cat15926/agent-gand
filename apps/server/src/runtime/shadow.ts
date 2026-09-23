import { randomUUID } from 'node:crypto';
import type { CollaborationControlAction, RuntimeRunContract, RuntimeSubjectSeed, RuntimeSubjectStatus } from '@agent-gand/shared';
import { all, get, run, tx } from '../db/database.ts';
import { evaluateRequiredSubjects } from './subjectContract.ts';

type CustodyState = 'unassigned' | 'owned' | 'transferring' | 'waiting' | 'completed' | 'failed' | 'cancelled';
interface CustodyRow {
  subject_id: string; state: CustodyState; holder_agent_id: string | null;
  pending_holder_agent_id: string | null; generation: number; version: number;
}
interface SubjectRow { id: string; run_id: string; subject_key: string; kind: string; status: RuntimeSubjectStatus; }
interface EventRow { source_event_id: string; kind: string; holder_agent_id: string | null; pending_holder_agent_id: string | null; generation: number; payload: string; }
interface DispatchSubjectRow { subject_id: string; expected_generation: number | null; }

export class CustodyConflictError extends Error {}

export function replayCustodyEvents(events: EventRow[]): Pick<CustodyRow, 'state' | 'holder_agent_id' | 'pending_holder_agent_id' | 'generation' | 'version'> {
  const projection: Pick<CustodyRow, 'state' | 'holder_agent_id' | 'pending_holder_agent_id' | 'generation' | 'version'> = {
    state: 'unassigned', holder_agent_id: null, pending_holder_agent_id: null, generation: 0, version: 0,
  };
  for (const event of events) {
    if (event.generation !== projection.generation + 1) throw new Error(`事件代际不连续：${event.source_event_id}`);
    const payload = JSON.parse(event.payload) as { state?: CustodyState };
    if (!payload.state || !['unassigned', 'owned', 'transferring', 'waiting', 'completed', 'failed', 'cancelled'].includes(payload.state)) {
      throw new Error(`事件状态无效：${event.source_event_id}`);
    }
    projection.state = payload.state;
    projection.holder_agent_id = event.holder_agent_id;
    projection.pending_holder_agent_id = event.pending_holder_agent_id;
    projection.generation = event.generation;
    projection.version++;
  }
  return projection;
}

/** Shadow 记录绝不能改变 legacy 执行结果；差异保留在日志和投影中供审计。 */
export function safelyObserve(label: string, observe: () => void): void {
  try { observe(); } catch (error) { console.warn(`[runtime-shadow] ${label}: ${error instanceof Error ? error.message : String(error)}`); }
}

function insertSubject(seed: RuntimeSubjectSeed, parentSubjectId: string | null = null): string {
  const existing = get<SubjectRow>('SELECT * FROM runtime_subjects WHERE run_id=? AND subject_key=?', seed.runId, seed.key);
  if (existing) return existing.id;
  const id = randomUUID(); const now = new Date().toISOString();
  run(`INSERT INTO runtime_subjects (id,run_id,subject_key,kind,parent_subject_id,status,objective,created_at,updated_at)
    VALUES (?,?,?,?,?,'active',?,?,?)`, id, seed.runId, seed.key, seed.kind, parentSubjectId, seed.objective, now, now);
  run("INSERT INTO runtime_custody (subject_id,state,holder_agent_id,pending_holder_agent_id,generation,version,updated_at) VALUES (?,'unassigned',NULL,NULL,0,0,?)", id, now);
  return id;
}

function linkDispatch(dispatchId: string, subjectId: string, expectedGeneration: number | null = null): void {
  const existing = get<DispatchSubjectRow>('SELECT subject_id,expected_generation FROM runtime_dispatch_subjects WHERE dispatch_id=?', dispatchId);
  if (existing) {
    if (existing.subject_id !== subjectId || (expectedGeneration !== null && existing.expected_generation !== expectedGeneration)) {
      throw new Error(`Dispatch ${dispatchId} 的 Subject 或交接代际冲突`);
    }
    return;
  }
  run('INSERT INTO runtime_dispatch_subjects (dispatch_id,subject_id,expected_generation) VALUES (?,?,?)', dispatchId, subjectId, expectedGeneration);
}

function subjectForDispatch(dispatchId: string): SubjectRow | undefined {
  return get<SubjectRow>(`SELECT s.* FROM runtime_subjects s JOIN runtime_dispatch_subjects m ON m.subject_id=s.id WHERE m.dispatch_id=?`, dispatchId);
}

function transition(subject: SubjectRow, sourceEventId: string, kind: string, state: CustodyState, holder: string | null, pending: string | null, payload: Record<string, unknown> = {}): number {
  const existing = get<{ subject_id: string; generation: number }>('SELECT subject_id,generation FROM runtime_custody_events WHERE source_event_id=?', sourceEventId);
  if (existing) {
    if (existing.subject_id !== subject.id) throw new Error(`事件 ${sourceEventId} 的 Subject 冲突`);
    return existing.generation;
  }
  const current = get<CustodyRow>('SELECT * FROM runtime_custody WHERE subject_id=?', subject.id);
  if (!current) throw new Error(`Subject ${subject.id} 缺少 Custody Projection`);
  const generation = current.generation + 1; const now = new Date().toISOString();
  run(`INSERT INTO runtime_custody_events (id,run_id,subject_id,source_event_id,kind,holder_agent_id,pending_holder_agent_id,generation,payload,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, randomUUID(), subject.run_id, subject.id, sourceEventId, kind, holder, pending, generation, JSON.stringify({ state, ...payload }), now);
  run(`UPDATE runtime_custody SET state=?,holder_agent_id=?,pending_holder_agent_id=?,generation=?,version=version+1,updated_at=? WHERE subject_id=?`,
    state, holder, pending, generation, now, subject.id);
  if (state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'waiting') {
    run('UPDATE runtime_subjects SET status=?,updated_at=? WHERE id=?', state, now, subject.id);
  }
  return generation;
}

export function observeAdmission(contract: RuntimeRunContract, subjects: RuntimeSubjectSeed[], initialDispatchIds: string[]): void {
  if (subjects.length !== initialDispatchIds.length) throw new Error('Subject 与初始 Dispatch 数量不一致');
  tx(() => {
    run('INSERT OR IGNORE INTO runtime_contracts (run_id,version,payload,created_at) VALUES (?,?,?,?)', contract.runId, contract.version, JSON.stringify(contract), new Date().toISOString());
    subjects.forEach((subject, index) => linkDispatch(initialDispatchIds[index]!, insertSubject(subject)));
  });
}

export function observeClaim(dispatchId: string, attemptId: string, agentId: string): void {
  tx(() => {
    const subject = subjectForDispatch(dispatchId); if (!subject) return;
    const link = get<DispatchSubjectRow>('SELECT subject_id,expected_generation FROM runtime_dispatch_subjects WHERE dispatch_id=?', dispatchId);
    const custody = get<CustodyRow>('SELECT * FROM runtime_custody WHERE subject_id=?', subject.id);
    if (!custody) throw new Error(`Subject ${subject.id} 缺少 Custody Projection`);
    if (custody.state === 'owned' && custody.holder_agent_id === agentId) return;
    if (link?.expected_generation !== null && link?.expected_generation !== undefined && custody.generation !== link.expected_generation) {
      throw new CustodyConflictError(`Dispatch ${dispatchId} 的交接代际已过期`);
    }
    if (custody.state === 'transferring' && custody.pending_holder_agent_id !== agentId) throw new CustodyConflictError('接球目标与待交接目标不一致');
    if (custody.state !== 'unassigned' && custody.state !== 'transferring' && custody.state !== 'waiting') {
      throw new CustodyConflictError(`Subject 已处于 ${custody.state}，不能再次接球`);
    }
    transition(subject, `claim:${attemptId}`, 'custody.acquired', 'owned', agentId, null, { dispatchId, attemptId });
  });
}

export function observeAction(input: { dispatchId: string; attemptId: string; agentId: string; action: CollaborationControlAction; childDispatchIds: string[]; batchId: string | null }): void {
  tx(() => {
    const subject = subjectForDispatch(input.dispatchId); if (!subject) return;
    const custody = get<CustodyRow>('SELECT * FROM runtime_custody WHERE subject_id=?', subject.id);
    if (!custody) return;
    if (input.action.type === 'handoff') {
      const alreadyRequested = Boolean(get('SELECT id FROM runtime_custody_events WHERE source_event_id=?', `action:${input.attemptId}`));
      if (!alreadyRequested && (custody.state !== 'owned' || custody.holder_agent_id !== input.agentId)) throw new Error('交接发起者不是当前责任持有者');
      const generation = transition(subject, `action:${input.attemptId}`, 'custody.transfer_requested', 'transferring', input.agentId, input.action.targetAgentId,
        { childDispatchIds: input.childDispatchIds });
      for (const id of input.childDispatchIds) linkDispatch(id, subject.id, generation);
    } else if (input.action.type === 'ask_many') {
      input.childDispatchIds.forEach((dispatchId, index) => {
        const target = input.action.type === 'ask_many' ? input.action.targetAgentIds[index]! : '';
        const child = insertSubject({ key: `consult:${input.batchId}:${target}`, runId: subject.run_id, kind: 'consultation',
          parentKey: subject.subject_key, objective: input.action.type === 'ask_many' ? input.action.question : '', initialHolderAgentId: target }, subject.id);
        linkDispatch(dispatchId, child);
      });
    } else if (input.action.type === 'finish' || input.action.type === 'implicit_complete') {
      transition(subject, `action:${input.attemptId}`, 'custody.completed', 'completed', input.agentId, null);
    } else if (input.action.type === 'wait_user' || input.action.type === 'propose_task') {
      transition(subject, `action:${input.attemptId}`, 'custody.waiting', 'waiting', input.agentId, null);
    }
  });
}

export function observeAggregateLink(sourceDispatchId: string, aggregateDispatchId: string): void {
  tx(() => {
    const subject = subjectForDispatch(sourceDispatchId);
    if (subject) linkDispatch(aggregateDispatchId, subject.id);
  });
}

export function observeTechnicalBlock(dispatchId: string, attemptId: string, agentId: string): void {
  tx(() => {
    const subject = subjectForDispatch(dispatchId); if (!subject) return;
    transition(subject, `blocked:${attemptId}`, 'custody.failed', 'failed', agentId, null);
  });
}

export function observeTerminalInterruption(dispatchId: string, attemptId: string, agentId: string): void {
  tx(() => {
    const subject = subjectForDispatch(dispatchId); if (!subject) return;
    const custody = get<CustodyRow>('SELECT * FROM runtime_custody WHERE subject_id=?', subject.id);
    if (!custody || custody.state !== 'owned' || custody.holder_agent_id !== agentId) return;
    transition(subject, `interrupted:${attemptId}`, 'custody.failed', 'failed', agentId, null);
  });
}

export function observeCancellation(dispatchId: string, sourceId: string): void {
  tx(() => {
    const subject = subjectForDispatch(dispatchId); if (!subject) return;
    const custody = get<CustodyRow>('SELECT * FROM runtime_custody WHERE subject_id=?', subject.id);
    if (!custody || custody.state === 'completed' || custody.state === 'cancelled') return;
    transition(subject, `cancel:${sourceId}:${subject.id}`, 'custody.cancelled', 'cancelled', custody.holder_agent_id, null);
  });
}

export function auditShadowRun(runId: string): string[] {
  const issues: string[] = [];
  const subjects = all<SubjectRow>('SELECT * FROM runtime_subjects WHERE run_id=?', runId);
  for (const subject of subjects) {
    const projection = get<CustodyRow>('SELECT * FROM runtime_custody WHERE subject_id=?', subject.id);
    const events = all<EventRow>('SELECT * FROM runtime_custody_events WHERE subject_id=? ORDER BY rowid', subject.id);
    if (!projection) { issues.push(`${subject.subject_key}: missing_projection`); continue; }
    try {
      const replayed = replayCustodyEvents(events);
      if (replayed.state !== projection.state || replayed.generation !== projection.generation || replayed.version !== projection.version
        || replayed.holder_agent_id !== projection.holder_agent_id || replayed.pending_holder_agent_id !== projection.pending_holder_agent_id) {
        issues.push(`${subject.subject_key}: projection_mismatch`);
      }
    } catch (error) { issues.push(`${subject.subject_key}: replay_error:${error instanceof Error ? error.message : String(error)}`); }
    if (projection.state === 'owned' && !projection.holder_agent_id) issues.push(`${subject.subject_key}: orphaned_owned`);
    if (projection.state === 'transferring' && (!projection.holder_agent_id || !projection.pending_holder_agent_id)) issues.push(`${subject.subject_key}: invalid_transfer`);
  }
  const contract = get<{ payload: string }>('SELECT payload FROM runtime_contracts WHERE run_id=?', runId);
  const legacyRun = get<{ status: string }>('SELECT status FROM runs WHERE id=?', runId);
  if (contract && legacyRun?.status === 'completed') {
    const evaluation = evaluateRequiredSubjects(JSON.parse(contract.payload), new Map(subjects.map((subject) => [subject.subject_key, subject.status])));
    if (evaluation.status !== 'completed') issues.push(`run:${runId}: completion_disagreement:${evaluation.status}`);
  }
  return issues;
}

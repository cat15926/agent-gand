import { randomUUID } from 'node:crypto';
import type { Run, RuntimeRunContract, TaskAttempt } from '@agent-gand/shared';
import { all, get, run, tx } from '../db/database.ts';
import { getTask } from '../messaging/tasks.ts';
import { loadRuntimeContract, executionPolicyForProfile } from './runPolicy.ts';
import { loadResponsibilitySnapshot } from './responsibilitySnapshot.ts';
import { evaluateExitGuard } from './exitGuard.ts';
import { submitCompletionCandidateForSubject } from './subjectCompletion.ts';
import { loadCompletionSnapshot } from './completionStore.ts';
import { evaluateCompletion } from './completion.ts';
import { commitRunTerminal } from './terminal.ts';

export function taskAdapterEnabled(runId: string): boolean {
  return loadRuntimeContract(runId)?.features?.orchestrationAdapter === 1;
}

/** Called before the first invocation; never changes an already admitted Runtime profile. */
export function admitTaskAdapter(item: Run): void {
  tx(() => {
    const existing = loadRuntimeContract(item.id);
    if (existing) {
      if (!existing.features?.orchestrationAdapter) throw new Error('该 Run 已有其他执行契约，不能改为旧入口适配器');
      return;
    }
    const contract: RuntimeRunContract = { version: 1, runtimeRevision: 1, runId: item.id,
      objective: item.goal, participantIds: item.agentIds, requiredSubjectKeys: [],
      completionPolicy: 'all_required', partialFailurePolicy: 'needs_attention',
      executionPolicy: executionPolicyForProfile('execute', { implicitAnswerPolicy: 'explicit_only' }),
      features: { orchestrationAdapter: 1, completionEngine: true, controlActionVersion: 2,
        exitGuard: { version: 1, maxCorrections: 0, correctionMaxTokens: 512 },
        completionCandidateVersion: 1, successorObligationVersion: 1, evidenceBundleVersion: 1,
        contextContributorVersion: 1, durableHoldVersion: 2 } };
    run('INSERT INTO runtime_contracts(run_id,version,payload,created_at) VALUES (?,1,?,?)', item.id,
      JSON.stringify(contract), new Date().toISOString());
  });
}

export function admitTaskSubject(taskId: string, kind: 'work' | 'review'): string | null {
  const task = getTask(taskId);
  if (!task?.runId || !taskAdapterEnabled(task.runId)) return null;
  return tx(() => {
    const existing = get<{ subject_id: string }>('SELECT subject_id FROM runtime_task_subjects WHERE task_id=? AND kind=?', taskId, kind);
    if (existing) return existing.subject_id;
    const id = randomUUID(); const now = new Date().toISOString(); const key = `task:${taskId}:${kind}`;
    run(`INSERT INTO runtime_subjects(id,run_id,subject_key,kind,status,objective,created_at,updated_at)
      VALUES (?,?,?,?,'active',?,?,?)`, id, task.runId, key, kind === 'review' ? 'review' : 'root',
    `${task.title} (${kind})`, now, now);
    run("INSERT INTO runtime_custody(subject_id,state,generation,version,updated_at) VALUES (?,'unassigned',0,0,?)", id, now);
    run('INSERT INTO runtime_task_subjects(task_id,kind,subject_id) VALUES (?,?,?)', taskId, kind, id);
    const contract = loadRuntimeContract(task.runId!)!;
    contract.requiredSubjectKeys.push(key);
    // Subject admission extends the graph, not the frozen execution policy. Bindings reference its revision.
    contract.runtimeRevision = (contract.runtimeRevision ?? 1) + 1;
    run('UPDATE runtime_contracts SET payload=? WHERE run_id=?', JSON.stringify(contract), task.runId);
    run('INSERT INTO runtime_contract_revisions(run_id,runtime_revision,payload,created_at) VALUES (?,?,?,?)',
      task.runId, contract.runtimeRevision, JSON.stringify(contract), now);
    return id;
  });
}

export function claimTaskResponsibility(attempt: TaskAttempt): void {
  const subject = admitTaskSubject(attempt.taskId, attempt.kind); if (!subject) return;
  tx(() => {
    const current = get<{ state: string; generation: number }>('SELECT state,generation FROM runtime_custody WHERE subject_id=?', subject)!;
    if (current.state === 'owned') throw new Error('Task Subject 已有有效执行者');
    const generation = current.generation + 1; const now = new Date().toISOString();
    run(`INSERT INTO runtime_custody_events(id,run_id,subject_id,source_event_id,kind,holder_agent_id,generation,payload,created_at)
      VALUES (?,?,?,?,'custody.acquired',?,?,?,?)`, randomUUID(), attempt.runId, subject,
    `task:claim:${attempt.id}`, attempt.agentId, generation, JSON.stringify({ attemptId: attempt.id }), now);
    run("UPDATE runtime_custody SET state='owned',holder_agent_id=?,pending_holder_agent_id=NULL,generation=?,version=version+1,updated_at=? WHERE subject_id=?",
      attempt.agentId, generation, now, subject);
    run("UPDATE runtime_subjects SET status='active',updated_at=? WHERE id=?", now, subject);
  });
}

export function finishTaskResponsibility(attempt: TaskAttempt, output: string | null, failed: boolean): void {
  if (!taskAdapterEnabled(attempt.runId)) return;
  const snapshot = loadResponsibilitySnapshot({ runId: attempt.runId, attemptId: attempt.id });
  if (!snapshot) throw new Error('任务执行缺少 Runtime 责任');
  if (snapshot.custody.state !== 'owned' || snapshot.attempt?.generation !== snapshot.custody.generation
    || snapshot.custody.holderAgentId !== attempt.agentId) throw new Error('任务结果已失去当前责任代际');
  let reviewAccepted = true;
  if (!failed && attempt.kind === 'review') {
    try { reviewAccepted = JSON.parse(output ?? '').verdict === 'PASS'; } catch { reviewAccepted = false; }
  }
  if (!failed && reviewAccepted) {
    const text = output?.trim() ?? '';
    const action = { version: 2 as const, type: 'complete' as const };
    const guard = evaluateExitGuard({ stopReason: text ? 'normal' : 'empty', action, output: text,
      hasActiveCustody: true, holderMatches: true, completionBlockers: snapshot.completionBlockers,
      allowImplicitAnswer: false, protocolRequiresExplicit: true, evidenceCount: text ? 1 : 0,
      correctionAttempt: 0, correctionBudgetAvailable: false,
      policy: loadRuntimeContract(attempt.runId)!.features!.exitGuard! });
    const result = submitCompletionCandidateForSubject({ runId: attempt.runId, attemptId: attempt.id,
      agentId: attempt.agentId, action, summary: text, evidenceRefs: [{ kind: 'attempt_output', id: attempt.id }],
      exitGuard: guard, idempotencyKey: `task-completion:${attempt.id}`, retryAllowed: false }, {
      subjectId: snapshot.subjectId, subjectKey: snapshot.subjectKey, subjectStatus: snapshot.subjectStatus,
      custodyState: snapshot.custody.state, holderAgentId: snapshot.custody.holderAgentId, pendingHolderAgentId: null,
      currentGeneration: snapshot.custody.generation, attemptGeneration: snapshot.attempt!.generation,
      attemptStatus: 'running', attemptAgentId: attempt.agentId, attemptError: null,
      leaseValid: snapshot.attempt!.leaseValid, openSuccessorObligations: snapshot.requiredObligations.filter(o => o.status !== 'satisfied').length,
      durableHoldOpen: snapshot.openHoldIds.length > 0,
      dependenciesSatisfied: (getTask(attempt.taskId)?.blockedBy ?? []).every(id => getTask(id)?.status === 'completed'),
      requiredArtifactsSatisfied: true, reviewAccepted, protocolTerminal: true,
    });
    if (result.evaluation.status !== 'accepted') throw new Error(`任务完成候选未被接受：${result.evaluation.reasons.join(',')}`);
  }
  const state = failed || !reviewAccepted ? 'waiting' : 'completed';
  const now = new Date().toISOString();
  run(`INSERT INTO runtime_custody_events(id,run_id,subject_id,source_event_id,kind,holder_agent_id,generation,payload,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, randomUUID(), attempt.runId, snapshot.subjectId, `task:finish:${attempt.id}`,
  `custody.${state}`, attempt.agentId, snapshot.custody.generation, JSON.stringify({ attemptId: attempt.id }), now);
  run('UPDATE runtime_custody SET state=?,version=version+1,updated_at=? WHERE subject_id=?', state, now, snapshot.subjectId);
  run('UPDATE runtime_subjects SET status=?,updated_at=? WHERE id=?', state, now, snapshot.subjectId);
}

export function closeTaskAdapter(runId: string, status: 'failed' | 'cancelled'): void {
  const now = new Date().toISOString();
  run("UPDATE task_attempts SET status='failed',error=?,lease_owner=NULL,lease_expires_at=NULL,ended_at=? WHERE run_id=? AND status='running'", status, now, runId);
  run("UPDATE tasks SET status=?,last_error=?,updated_at=? WHERE run_id=? AND status NOT IN ('completed','failed','cancelled')", status, status, now, runId);
  run("UPDATE runtime_custody SET state=?,generation=generation+1,version=version+1,updated_at=? WHERE subject_id IN (SELECT id FROM runtime_subjects WHERE run_id=?) AND state NOT IN ('completed','failed','cancelled')", status, now, runId);
  run("UPDATE runtime_subjects SET status=?,updated_at=? WHERE run_id=? AND status NOT IN ('completed','failed','cancelled')", status, now, runId);
}

export function finishAdapterRun(runId: string, status: 'completed' | 'failed' | 'cancelled', source = 'orchestration_adapter') {
  return commitRunTerminal({ runId, status, disposition: status === 'completed' ? 'accepted' : status, source,
    userMessageStatus: status === 'completed' ? 'responded' : 'failed',
    closeExecution: status === 'completed' ? undefined : () => closeTaskAdapter(runId, status),
    prepare: () => {
      if (status !== 'completed') return { reasonCodes: [status === 'cancelled' ? 'USER_STOPPED' : 'ADAPTER_FAILED'] };
      const snapshot = loadCompletionSnapshot(runId); if (!snapshot) throw new Error('完成缺少 Runtime 契约');
      if (!snapshot.input.contract.requiredSubjectKeys.length) throw new Error('完成契约没有必需工作项');
      return { completion: { input: snapshot.input, evaluation: evaluateCompletion(snapshot.input) } };
    } });
}

export function isAdapterTurnTask(taskId: string): boolean {
  return Boolean(get('SELECT task_id FROM orchestration_turn_tasks WHERE task_id=?', taskId));
}

export function reopenInterruptedTaskResponsibilities(): void {
  for (const row of all<{ subject_id: string }>(`SELECT m.subject_id FROM runtime_task_subjects m
    JOIN runtime_custody c ON c.subject_id=m.subject_id WHERE c.state='owned'
    AND NOT EXISTS (SELECT 1 FROM task_attempts a WHERE a.task_id=m.task_id AND a.kind=m.kind AND a.status='running')`)) {
    run("UPDATE runtime_custody SET state='waiting',generation=generation+1,version=version+1 WHERE subject_id=?", row.subject_id);
    run("UPDATE runtime_subjects SET status='waiting' WHERE id=?", row.subject_id);
  }
}

import { all, get, run, tx } from '../db/database.ts';
import { getRun } from '../runs/trace.ts';
import { acquireDurableLease } from './leases.ts';
import { hostOwner, ownerAlive } from './host.ts';
import { ExecutionError } from './errors.ts';

interface Ticket { seq: number; ticket_key: string; status: string; run_id: string; agent_id: string; owner: string | null; host: string; pid: number; identity: string }
const availabilityListeners = new Set<(agentId: string) => void>();
export function onMemberAvailable(listener: (agentId: string) => void): void { availabilityListeners.add(listener); }

export function reserveMember(runId: string, agentId: string, scope: string): void {
  run(`INSERT OR IGNORE INTO execution_member_tickets(ticket_key,run_id,agent_id,status,created_at)
    VALUES (?,?,?,'waiting',?)`, `${runId}:${agentId}:${scope}`, runId, agentId, new Date().toISOString());
}

/** A FIFO resource reservation referencing the scheduler's attempt, never claiming another attempt. */
export async function enterMember(input: { runId: string; agentId: string; attemptId?: string; scope: string;
  signal: AbortSignal; authorized: () => boolean }): Promise<(status?: 'done' | 'waiting') => void> {
  const key = `${input.runId}:${input.agentId}:${input.scope}`;
  tx(() => {
    const existing = get<Ticket>('SELECT * FROM execution_member_tickets WHERE ticket_key=?', key);
    if (existing?.status === 'active') throw new ExecutionError('interrupted', '该成员调用已开始，不能重复派发');
    if (existing?.status === 'interrupted') throw new ExecutionError('interrupted', '旧调用结果未知，需核对后创建新任务');
    if (existing?.status === 'done') throw new ExecutionError('interrupted', '调用已结束但没有可恢复的结果，不能重复调用');
    run(`INSERT INTO execution_member_tickets(ticket_key,run_id,agent_id,attempt_id,status,created_at)
      VALUES (?,?,?,?,'waiting',?) ON CONFLICT(ticket_key) DO UPDATE SET attempt_id=excluded.attempt_id,
      status='waiting',owner=NULL,started_at=NULL,finished_at=NULL`, key, input.runId, input.agentId,
    input.attemptId ?? null, new Date().toISOString());
  });
  for (;;) {
    if (input.signal.aborted || !input.authorized()) {
      run("UPDATE execution_member_tickets SET status='cancelled',finished_at=? WHERE ticket_key=? AND status='waiting'",
        new Date().toISOString(), key);
      throw new ExecutionError('cancelled', '排队任务已停止或失去执行权限');
    }
    const acquired = tx(() => {
      // Terminal queued tasks never block the next member request.
      run(`UPDATE execution_member_tickets SET status='cancelled' WHERE agent_id=? AND status='waiting'
        AND run_id IN (SELECT id FROM runs WHERE status IN ('completed','failed','cancelled'))`, input.agentId);
      run(`UPDATE execution_member_tickets SET status='cancelled' WHERE agent_id=? AND status='waiting'
        AND EXISTS (SELECT 1 FROM collaboration_dispatches d WHERE ticket_key=d.run_id || ':' || d.target_agent_id || ':collaboration:' || d.id
          AND d.status NOT IN ('queued','running'))`, input.agentId);
      const first = get<{ ticket_key: string }>(`SELECT ticket_key FROM execution_member_tickets t JOIN runs r ON r.id=t.run_id
        WHERE agent_id=? AND t.status IN ('waiting','active') AND (t.status='active' OR r.status!='waiting_for_user') ORDER BY seq LIMIT 1`, input.agentId);
      if (first?.ticket_key !== key) return null;
      let release: () => void;
      try { release = acquireDurableLease(`member:${input.agentId}`, key, false); }
      catch (error) { if (error instanceof ExecutionError && error.code === 'policy_rejected') return null; throw error; }
      run(`UPDATE execution_member_tickets SET status='active',owner=?,host=?,pid=?,identity=?,started_at=?
        WHERE ticket_key=? AND status='waiting'`, hostOwner.owner, hostOwner.host, hostOwner.pid, hostOwner.identity,
      new Date().toISOString(), key);
      return release;
    });
    if (acquired) return (status = 'done') => {
      run("UPDATE execution_member_tickets SET status=?,finished_at=? WHERE ticket_key=? AND status='active' AND owner=?",
        status, status === 'done' ? new Date().toISOString() : null, key, hostOwner.owner);
      acquired();
      for (const listener of availabilityListeners) listener(input.agentId);
    };
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export function memberQueue(runId?: string) {
  return all<{ runId: string; agentId: string; attemptId: string | null; status: string; position: number }>(`
    SELECT run_id runId,agent_id agentId,attempt_id attemptId,status,
      (SELECT COUNT(*) FROM execution_member_tickets q WHERE q.agent_id=t.agent_id AND q.seq<t.seq
        AND q.status IN ('waiting','active') AND EXISTS
          (SELECT 1 FROM runs r WHERE r.id=q.run_id AND
            (q.status='active' OR r.status IN ('pending','running','awaiting_approval')))) position
    FROM execution_member_tickets t WHERE status IN ('waiting','active','interrupted') ${runId ? 'AND run_id=?' : ''}
    ORDER BY seq`, ...(runId ? [runId] : []));
}

/** Unknown started calls are fenced; queued reservations keep their FIFO sequence. */
export function recoverMemberAdmissions(): void {
  for (const item of all<Ticket>("SELECT * FROM execution_member_tickets WHERE status='active'")) {
    if (item.owner && ownerAlive(item)) continue;
    const source = get<{ attempt_id: string | null }>('SELECT attempt_id FROM execution_member_tickets WHERE seq=?',item.seq);
    if (source?.attempt_id) {
      // The member ticket proves this attempt's process is gone. Let the existing lease
      // recovery interrupt it now instead of delaying a known approval boundary for 5 min.
      run("UPDATE collaboration_attempts SET lease_expires_at=? WHERE id=? AND status='running'",new Date().toISOString(),source.attempt_id);
    }
    const scope = item.ticket_key.slice(`${item.run_id}:${item.agent_id}:`.length);
    const persisted = get("SELECT id FROM run_checkpoints WHERE run_id=? AND kind='agent_turn' AND phase='completed' AND json_extract(state,'$.executionScopeId')=?", item.run_id, scope);
    if (persisted) { run("UPDATE execution_member_tickets SET status='done' WHERE seq=?", item.seq); continue; }
    // A builtin response already persisted its tool calls and is waiting for approval.
    // Recover gates with the same logical keys; never resend that model request. A native
    // approval or an uncertain manual tool remains fenced and cannot use this exception.
    const approvalBoundary = get(`SELECT a.id FROM approvals a JOIN run_checkpoints p ON p.id=a.checkpoint_id
      JOIN runs r ON r.id=a.run_id JOIN run_agent_snapshots s ON s.run_id=r.id AND s.agent_id=a.agent_id
      WHERE a.run_id=? AND a.agent_id=? AND a.status='pending' AND r.status='awaiting_approval'
        AND COALESCE(json_extract(s.definition,'$.execution.kind'),'builtin')!='external'
        AND json_extract(p.state,'$.executionScopeId')=?
        AND NOT EXISTS (SELECT 1 FROM external_agent_approvals n WHERE n.approval_id=a.id)
        AND NOT EXISTS (SELECT 1 FROM tool_executions t WHERE t.run_id=r.id
          AND (t.status IN ('running','needs_attention') OR t.replay_policy='manual' AND t.status IN ('failed','interrupted')))
        AND EXISTS (SELECT 1 FROM run_checkpoints c WHERE c.id=(SELECT id FROM run_checkpoints WHERE run_id=r.id AND kind='agent_turn' ORDER BY seq DESC LIMIT 1)
          AND c.phase='tool_calls_ready' AND json_extract(c.state,'$.executionScopeId')=?)`,item.run_id,item.agent_id,scope,scope);
    if (approvalBoundary) {
      run("UPDATE execution_member_tickets SET status='waiting',owner=NULL,host=NULL,pid=NULL,identity=NULL,started_at=NULL WHERE seq=?",item.seq);
      continue;
    }
    const current = getRun(item.run_id);
    run("UPDATE execution_member_tickets SET status='interrupted' WHERE seq=?", item.seq);
    if (current && !['completed','failed','cancelled'].includes(current.status)) {
      run(`INSERT INTO orchestration_run_controls(run_id,recovery_attention,reason) VALUES (?,1,?)
        ON CONFLICT(run_id) DO UPDATE SET recovery_attention=1,reason=excluded.reason`, item.run_id,
      '调用已开始但结果未确认，禁止自动重放；请核对工作区并创建新任务');
      run("UPDATE runs SET status='waiting_for_user' WHERE id=?", item.run_id);
    }
  }
}

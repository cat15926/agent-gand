import { all, run } from '../db/database.ts';
import { getExecution, updateExecution, interruptStaleExecutions } from './store.ts';
import { quiesceNativeProcesses, ownerAlive } from './host.ts';
import { captureEvidence } from './evidence.ts';

/** Recovery never launches a model or repeats a native operation. */
export async function recoverExternalExecutions(): Promise<void> {
  const rows = all<{ id: string }>("SELECT id FROM external_agent_executions WHERE status='running' OR id IN (SELECT execution_id FROM external_native_processes WHERE status='active')");
  for (const { id } of rows) {
    const execution = getExecution(id); if (!execution) continue;
    const quiesced = execution.processOwnership === 'guardian-v1' && await quiesceNativeProcesses(id);
    const after = await captureEvidence(execution.cwd);
    const recovery = { state: quiesced ? 'quiesced' as const : 'attention' as const, reason: quiesced ? '旧原生进程已收敛；保留实际变更，未重放执行' : '旧进程身份或存活状态无法验证，保留工作区占用', recoveredAt: new Date().toISOString() };
    const evidence = { head: after.head, beforeDiff: execution.evidence?.beforeDiff ?? '', afterDiff: after.diff, truncated: after.truncated || !execution.evidence, commands: execution.evidence?.commands ?? [] };
    if (execution.status === 'running') updateExecution(id, { status: 'interrupted', errorCode: 'interrupted', error: recovery.reason, evidence, recovery, finishedAt: recovery.recoveredAt });
    else run('UPDATE external_agent_executions SET record=? WHERE id=?', JSON.stringify({ ...execution, evidence, recovery }), id);
    if (quiesced) run('DELETE FROM external_workspace_leases WHERE holder=?', id);
  }
  for (const lease of all<{ resource: string; holder: string; host: string; pid: number; identity: string }>('SELECT * FROM external_workspace_leases')) {
    if (!ownerAlive(lease) && getExecution(lease.holder)?.recovery?.state !== 'attention' && !all("SELECT token FROM external_native_processes WHERE execution_id=? AND status='active'", lease.holder).length) run('DELETE FROM external_workspace_leases WHERE resource=? AND holder=?', lease.resource, lease.holder);
  }
  run("UPDATE external_agent_sessions SET status='invalid' WHERE status='inflight'");
  interruptStaleExecutions();
}

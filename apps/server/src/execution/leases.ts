import { all, get, run, tx } from '../db/database.ts';
import { hostOwner, ownerAlive } from './host.ts';
import { ExecutionError } from './errors.ts';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';

interface Lease { holder: string; readonly: number; owner: string; host: string; pid: number; identity: string }
/** Durable resource fencing. Expiry alone never authorizes overlap with a live owner. */
export function acquireDurableLease(resource: string, holder: string, readonly: boolean): () => void {
  const workspacePath = resource.startsWith('workspace:') ? resource.slice('workspace:'.length) : undefined;
  if (workspacePath) {
    let canonical: string;
    try { canonical = realpathSync(workspacePath); } catch { canonical = path.resolve(workspacePath); }
    resource = `workspace:${canonical}`;
  }
  const leaseOwner = `${hostOwner.owner}:${randomUUID()}`;
  tx(() => {
    if (resource.startsWith('member:') && get("SELECT id FROM external_agent_executions WHERE agent_id=? AND json_extract(record,'$.recovery.state')='attention'", resource.slice('member:'.length))) throw new ExecutionError('interrupted', '此成员仍有无法验证的旧原生进程，需先收敛恢复围栏');
    if (resource.startsWith('workspace:') && get("SELECT id FROM external_agent_executions WHERE json_extract(record,'$.cwd')=? AND json_extract(record,'$.recovery.state')='attention'", resource.slice('workspace:'.length))) throw new ExecutionError('interrupted', '此工作区存在无法验证的旧进程，需先人工核对并解除恢复围栏');
    const sharedKey = resource.startsWith('member:') ? `agent:${resource.slice('member:'.length)}`
      : resource.startsWith('native-session:') ? `session:${resource}` : resource;
    const claims = workspacePath ? all<{ access: string; resource_key: string }>(`SELECT i.access,i.resource_key FROM execution_resource_claim_items i
      JOIN execution_resource_claims c ON c.id=i.claim_id WHERE i.kind='workspace' AND c.state<>'released'`)
      .filter(claim => {
        const a = resource.slice('workspace:'.length), b = claim.resource_key.slice('workspace:'.length);
        return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
      }) : all<{ access: string }>(`SELECT i.access FROM execution_resource_claim_items i
      JOIN execution_resource_claims c ON c.id=i.claim_id WHERE i.resource_key=? AND c.state<>'released'`, sharedKey);
    if (claims.some(claim => !(readonly && claim.access === 'read'))) throw new ExecutionError('policy_rejected', '资源由持续协作或旧模式的持久占用持有');
    const leases = all<Lease>('SELECT * FROM external_workspace_leases WHERE resource=?', resource);
    for (const lease of leases) {
      const processes = get<{ n: number }>("SELECT COUNT(*) n FROM external_native_processes WHERE execution_id=? AND status='active'", lease.holder)?.n ?? 0;
      const attention = get("SELECT id FROM external_agent_executions WHERE id=? AND json_extract(record,'$.recovery.state')='attention'", lease.holder);
      if (!ownerAlive(lease) && !processes && !attention) run('DELETE FROM external_workspace_leases WHERE resource=? AND holder=?', resource, lease.holder);
      else if (lease.holder === holder || !readonly || !lease.readonly) throw new ExecutionError('policy_rejected', '工作区或会话正由另一执行持有，需先收敛旧执行');
    }
    run('INSERT OR REPLACE INTO external_workspace_leases (resource,holder,owner,host,pid,identity,readonly,expires_at) VALUES (?,?,?,?,?,?,?,?)', resource, holder, leaseOwner, hostOwner.host, hostOwner.pid, hostOwner.identity, readonly ? 1 : 0, new Date(Date.now() + 10000).toISOString());
  });
  const timer = setInterval(() => { run('UPDATE external_workspace_leases SET expires_at=? WHERE resource=? AND holder=? AND owner=?', new Date(Date.now() + 10000).toISOString(), resource, holder, leaseOwner); }, 2000);
  timer.unref();
  return () => {
    clearInterval(timer);
    if (get("SELECT 1 FROM external_native_processes WHERE execution_id=? AND status='active'", holder)
      || get("SELECT 1 FROM external_agent_executions WHERE id=? AND json_extract(record,'$.recovery.state')='attention'", holder)) return;
    run('DELETE FROM external_workspace_leases WHERE resource=? AND holder=? AND owner=?', resource, holder, leaseOwner);
  };
}
export async function waitForDurableLease(resource: string, holder: string, readonly: boolean, signal: AbortSignal): Promise<() => void> {
  for (;;) {
    if (signal.aborted) throw signal.reason instanceof ExecutionError ? signal.reason : new ExecutionError('cancelled', '等待持久占用时执行已停止');
    try { return acquireDurableLease(resource, holder, readonly); }
    catch (error) { if (!(error instanceof ExecutionError) || error.code !== 'policy_rejected') throw error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { all, get, run, tx } from '../db/database.ts';
import { ExecutionError } from './errors.ts';
import type { ProcessRegistration } from './ownedProcess.ts';

export const hostOwner = { owner: randomUUID(), host: hostname(), pid: process.pid, identity: processIdentity(process.pid) ?? '' };
export function processIdentity(pid: number): string | null {
  try {
    const status = execFileSync('ps', ['-p', String(pid), '-o', 'stat=', '-o', 'lstart='], { encoding: 'utf8', timeout: 1000 }).trim();
    if (!status || status.startsWith('Z')) return null;
    return status.replace(/^\S+\s+/, '');
  } catch { return null; }
}
export function ownerAlive(owner: { host: string; pid: number; identity: string }): boolean {
  return owner.host !== hostname() || processIdentity(owner.pid) === owner.identity;
}
/** One active application server per SQLite database. A live old owner is never stolen. */
export function claimRuntimeHost(): void {
  if (!hostOwner.identity) throw new ExecutionError('policy_rejected', '无法验证服务进程身份');
  tx(() => {
    const old = get<typeof hostOwner>('SELECT * FROM external_runtime_host WHERE id=1');
    if (old && old.owner !== hostOwner.owner && ownerAlive(old)) throw new ExecutionError('policy_rejected', '此数据库已有活动服务进程，请关闭旧服务后再启动');
    run('INSERT OR REPLACE INTO external_runtime_host (id,owner,host,pid,identity,updated_at) VALUES (1,?,?,?,?,?)', hostOwner.owner, hostOwner.host, hostOwner.pid, hostOwner.identity, new Date().toISOString());
  });
}
export function releaseRuntimeHost(): void { run('DELETE FROM external_runtime_host WHERE id=1 AND owner=?', hostOwner.owner); }
export function registerNativeProcess(executionId: string, owner: ProcessRegistration): void {
  run('INSERT INTO external_native_processes (token,execution_id,host,pid,status,created_at) VALUES (?,?,?,?,?,?)', owner.token, executionId, hostname(), owner.pid, 'active', new Date().toISOString());
}
export function markNativeProcessStopped(token: string): void { run("UPDATE external_native_processes SET status='stopped' WHERE token=?", token); }

function groupAlive(group: number): boolean | null {
  try {
    return execFileSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8', timeout: 1000 }).split('\n').some((line) => {
      const [id, status] = line.trim().split(/\s+/); return Number(id) === group && !!status && !status.startsWith('Z');
    });
  } catch { return null; }
}

/** Token is an ownership nonce in the guardian argv, never a model/API credential. */
export async function quiesceNativeProcesses(executionId: string): Promise<boolean> {
  const rows = all<{ token: string; host: string; pid: number }>("SELECT * FROM external_native_processes WHERE execution_id=? AND status='active'", executionId);
  let safe = true;
  for (const row of rows) {
    if (row.host !== hostname()) { safe = false; continue; }
    let command = '';
    try { command = execFileSync('ps', ['-p', String(row.pid), '-o', 'command='], { encoding: 'utf8', timeout: 1000 }); } catch {}
    const guardianAlive = processIdentity(row.pid) !== null;
    if (guardianAlive && (!command.includes('/execution/guardian.mjs') || !command.includes(row.token))) { safe = false; continue; }
    if (guardianAlive) {
      try { process.kill(-row.pid, 'SIGTERM'); } catch {}
      const end = Date.now() + 1000;
      while (groupAlive(row.pid) === true && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 30));
      if (groupAlive(row.pid) === true) { try { process.kill(-row.pid, 'SIGKILL'); } catch {} }
      const killedAt = Date.now();
      while (groupAlive(row.pid) === true && Date.now() - killedAt < 1000) await new Promise((resolve) => setTimeout(resolve, 30));
      if (groupAlive(row.pid) !== false) { safe = false; continue; }
    } else {
      // A missing guardian with surviving group members is unverifiable: retain the fence.
      if (groupAlive(row.pid) !== false) { safe = false; continue; }
    }
    markNativeProcessStopped(row.token);
  }
  return safe;
}

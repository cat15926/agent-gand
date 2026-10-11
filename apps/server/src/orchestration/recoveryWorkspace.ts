import { existsSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { get, run } from '../db/database.ts';
import { getRun } from '../runs/trace.ts';
import { workspaceRootDir } from '../tools/builtin/index.ts';
import { getRunCoordinationPlan } from '../coordination/store.ts';
import { readSnapshotFile, safeDirectory, snapshotFail, snapshotHash, snapshotPath, SNAPSHOT_LIMITS } from '../artifacts/snapshotFiles.ts';
import { snapshotGit } from '../artifacts/snapshotGit.ts';

/** Exact live workspace digest at owned step boundaries; no file mutation or model calls. */
function digest(runId:string):string {
  const source=getRun(runId)!,root=workspaceRootDir({runId,workspace:source.workspace,workspaceScope:getRunCoordinationPlan(runId)?.id.slice(0,8)});
  if(lstatSync(root).isSymbolicLink())snapshotFail('CHECKPOINT_PATH_UNSAFE','恢复根目录不能是链接');
  const canonical=realpathSync(root);safeDirectory(canonical); const files:Array<unknown>=[];let count=0;
  const walk=(dir:string,prefix='')=>{for(const name of readdirSync(dir).sort()) {
    if(name==='.git')continue;
    if(++count>SNAPSHOT_LIMITS.maxFiles)snapshotFail('RECOVERY_SCAN_LIMIT','恢复工作区超过校验限制');
    const rel=prefix+name;try{snapshotPath(rel);}catch{continue;}
    const stat=lstatSync(path.join(dir,name));
    if(stat.isDirectory()&&!stat.isSymbolicLink())walk(path.join(dir,name),rel+'/');
    else{const file=readSnapshotFile(canonical,rel)!;files.push([rel,snapshotHash(file.bytes),file.sourceMode]);}
  }};walk(canonical);
  if(existsSync(path.join(canonical,'.git')))safeDirectory(path.join(canonical,'.git'));
  let head:string|null=null;try{head=snapshotGit(canonical,['rev-parse','HEAD']).toString().trim();}catch{}
  return snapshotHash(JSON.stringify({head,files}));
}
export function recordRecoveryWorkspace(runId:string):void {
  if(!get("SELECT 1 FROM business_run_checkpoints WHERE run_id=? AND json_extract(manifest,'$.encryptedCheckpointVersion')=3",runId))return;
  run('INSERT INTO business_write_workspace_states(run_id,digest,updated_at) VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET digest=excluded.digest,updated_at=excluded.updated_at',runId,digest(runId),new Date().toISOString());
}
export function assertRecoveryWorkspace(runId:string):void {
  const row=get<{digest:string}>('SELECT digest FROM business_write_workspace_states WHERE run_id=?',runId);
  if(!row||row.digest!==digest(runId))snapshotFail('CHECKPOINT_FILE_CHANGED','恢复任务工作区在步骤边界后发生变化，请核对后建立新关联任务，禁止覆盖');
}

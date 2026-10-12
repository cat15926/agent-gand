import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ArtifactSnapshot, BusinessContract, BusinessDecision, BusinessReport, MessageAccess } from '@agent-gand/shared';
import { isMessageWithinScope } from '@agent-gand/shared';
import { runSourceAccess, attemptAccess } from '../messaging/access.ts';
import { openManagedContent, sealManagedContent } from '../accounts/credentials.ts';
import { recordRecoveryWorkspace, assertRecoveryWorkspace } from './recoveryWorkspace.ts';
import { get, run } from '../db/database.ts';
import { config } from '../config.ts';
import { OrchestrationError } from './normalize.ts';
import { importSnapshotArtifacts, materializeArtifactSnapshot, readArtifactSnapshot, saveArtifactSnapshot, snapshotDigest, type SnapshotPackage } from '../artifacts/snapshots.ts';

export interface BusinessCheckpoint {
  version: 1 | 2 | 3 | 4; sourceRunId: string; sourceVersion: number; contract: BusinessContract | null;
  graph?: { sourceEngine:'collaboration'|'coordination'|'pipeline'|'supervisor'; steps:import('@agent-gand/shared').CoordinationPlanStep[]; protocols:import('@agent-gand/shared').CoordinationProtocolSelection[]; terminalSteps:string[] };
  access?:MessageAccess; readonly?:boolean;
  acceptedArchives?:Array<{id:string;digest:string}>;
  recovery?:{reviewId:string|null;fingerprint:string;unknownUsage:number;runUnknownTokens:number;stageUnknownTokens:Array<{stageId:string;tokens:number}>};
  accepted: Array<{ stageId: string; report: BusinessReport; decision: BusinessDecision }>;
  outputs: Array<{ attemptId: string; sourceRunId: string; stageId: string; stepId: string; agentId: string; objective: string; output: string; sha256: string;access?:MessageAccess;origin?:'member'|'owner_reconciled' }>;
  files: Array<{ sourceRunId: string; path: string; workspaceScope?: string; sha256: string; base64?: string }>;
  archive?: { id: string; digest: string; manifest: ArtifactSnapshot };
  runTokens: number; stageTokens: Array<{ stageId: string; charged: number }>;
  costs?: import('./costBudget.ts').CostReservationRow[];
  costBudget?: import('@agent-gand/shared').CostBudgetState;
  impact?: import('@agent-gand/shared').BusinessChangeImpact;
  revision?: { contract: BusinessContract; instruction: string };
  /** Rejected outputs are audit/context only, never a completed-worker or acceptance whitelist. */
  rework?: { sourceRunId: string; sourceStatus: string; stageId: string; report: BusinessReport; decision: BusinessDecision;
    instruction: string; rejectedOutputs: BusinessCheckpoint['outputs'] };
}
// Preview packages are transient. Persisted checkpoint rows contain references and metadata, never file bytes.
const pendingArchives = new WeakMap<BusinessCheckpoint,SnapshotPackage>();
export function attachCheckpointArchive(checkpoint:BusinessCheckpoint,item:SnapshotPackage):void {
  checkpoint.archive={id:item.manifest.id,digest:snapshotDigest(item.manifest),manifest:item.manifest};
  pendingArchives.set(checkpoint,item);
}
export const checkpointDigest = (checkpoint: BusinessCheckpoint): string => createHash('sha256').update(JSON.stringify(checkpoint)).digest('hex');
export function readBusinessCheckpoint(runId: string): BusinessCheckpoint | null {
  const row = get<{ manifest: string; digest: string }>('SELECT manifest,digest FROM business_run_checkpoints WHERE run_id=?', runId);
  const expected = get<{ digest: string | null }>("SELECT json_extract(snapshot,'$.businessCheckpointDigest') digest FROM orchestration_requests WHERE run_id=?", runId)?.digest;
  if (!row && !expected) return null;
  if (!row || !expected || row.digest !== expected) throw new OrchestrationError(409, 'CHECKPOINT_CORRUPT', '续跑检查点校验失败，禁止执行');
  const envelope=JSON.parse(row.manifest);
  const encrypted=[3,4].includes(envelope.encryptedCheckpointVersion);
  const plaintext=encrypted?openManagedContent(envelope.content,`business-checkpoint-v${envelope.encryptedCheckpointVersion}:${runId}:${row.digest}`).toString():row.manifest;
  if(createHash('sha256').update(plaintext).digest('hex')!==row.digest)throw new OrchestrationError(409,'CHECKPOINT_CORRUPT','检查点摘要无效');
  const checkpoint=JSON.parse(plaintext) as BusinessCheckpoint;
  if (checkpoint.version>=3&&envelope.encryptedCheckpointVersion!==checkpoint.version)throw new OrchestrationError(409,'CHECKPOINT_CORRUPT','新版本检查点必须加密保存');
  if (![1,2,3,4].includes(checkpoint.version) || checkpoint.version>=2 && !checkpoint.archive || checkpoint.version===4&&(!checkpoint.graph||checkpoint.contract!==null||checkpoint.readonly!==true||checkpoint.access?.visibility!=='public')) throw new OrchestrationError(409,'CHECKPOINT_CORRUPT','检查点版本或归档缺失/不兼容');
  if(checkpoint.archive && (snapshotDigest(readArtifactSnapshot(checkpoint.archive.id).manifest)!==checkpoint.archive.digest || snapshotDigest(checkpoint.archive.manifest)!==checkpoint.archive.digest)) throw new OrchestrationError(409,'CHECKPOINT_CORRUPT','检查点产物摘要不一致');
  for(const archive of checkpoint.acceptedArchives??[])if(snapshotDigest(readArtifactSnapshot(archive.id).manifest)!==archive.digest)throw new OrchestrationError(409,'CHECKPOINT_CORRUPT','原验收产物摘要不一致');
  if(checkpoint.version>=3 && (!checkpoint.access||JSON.stringify(runSourceAccess(runId))!==JSON.stringify(checkpoint.access)
    ||[...checkpoint.outputs,...(checkpoint.rework?.rejectedOutputs??[])].some(o=>!isMessageWithinScope(attemptAccess(o.attemptId),checkpoint.access!)||!isMessageWithinScope(o.access??{visibility:'public',audience:[]},checkpoint.access!))))throw new OrchestrationError(409,'PRIVATE_CHECKPOINT_UNSUPPORTED','检查点授权或来源范围已变化');
  return checkpoint;
}
export function checkpointOutput(runId: string, attemptId: string) {
  return readBusinessCheckpoint(runId)?.outputs.find(item => item.attemptId === attemptId);
}
export function saveBusinessCheckpoint(runId: string, checkpoint: BusinessCheckpoint): void {
  if(checkpoint.archive) {
    const item=pendingArchives.get(checkpoint)??readArtifactSnapshot(checkpoint.archive.id);
    saveArtifactSnapshot(item,'checkpoint',runId);
    importSnapshotArtifacts(runId,item,checkpoint.access);
  }
  for(const archive of checkpoint.acceptedArchives??[])saveArtifactSnapshot(readArtifactSnapshot(archive.id),'checkpoint',runId);
  const manifest=JSON.stringify(checkpoint),digest=checkpointDigest(checkpoint);
  run('INSERT INTO business_run_checkpoints(run_id,source_run_id,manifest,digest,created_at) VALUES (?,?,?,?,?)',
    runId, checkpoint.sourceRunId, checkpoint.version>=3?JSON.stringify({encryptedCheckpointVersion:checkpoint.version,content:sealManagedContent(Buffer.from(manifest),`business-checkpoint-v${checkpoint.version}:${runId}:${digest}`)}):manifest,digest,new Date().toISOString());
}
export function checkpointSummary(checkpoint: BusinessCheckpoint) {
  return { sourceRunId: checkpoint.sourceRunId, sourceVersion: checkpoint.sourceVersion, digest: checkpointDigest(checkpoint),
    acceptedStageIds: checkpoint.accepted.map(item => item.stageId), completedWorkers: checkpoint.outputs.length,
    files: checkpoint.files.map(({ path, sha256 }) => ({ path, sha256 })),
    ...(checkpoint.costBudget ? { costBudget: checkpoint.costBudget } : {}),
    ...(checkpoint.impact ? { impact: checkpoint.impact } : {}),
    ...(checkpoint.archive ? {archive:{id:checkpoint.archive.id,digest:checkpoint.archive.digest,manifest:checkpoint.archive.manifest}}:{}),
    ...(checkpoint.version>=3?{access:checkpoint.access,readonly:checkpoint.readonly,recovery:checkpoint.recovery}:{}),
    ...(checkpoint.rework ? { rework: { sourceRunId: checkpoint.rework.sourceRunId, stageId: checkpoint.rework.stageId,
      reportId: checkpoint.rework.report.id, reason: checkpoint.rework.decision.reason, instruction: checkpoint.rework.instruction,
      rejectedWorkers: checkpoint.rework.rejectedOutputs.length } } : {}) };
}
export function safeCheckpointPath(file: string): boolean {
  const parts = file.split('/');
  return Boolean(file) && !path.isAbsolute(file) && !file.includes('\\') && !file.includes('\0')
    && !['shared', 'archive'].includes(parts[0]!) && parts.every(p => p && p !== '.' && p !== '..' && !['.git','.claude','.codex','.agents'].includes(p.toLowerCase()));
}
/** Only archived, confirmed files enter the new workspace. Repeated starts never overwrite drift. */
export function materializeBusinessCheckpoint(runId: string): void {
  const checkpoint = readBusinessCheckpoint(runId); if (!checkpoint) return;
  const owner = get<{ workspace: string | null }>('SELECT workspace FROM runs WHERE id=?', runId);
  if (!owner || owner.workspace !== null) throw new OrchestrationError(409, 'CHECKPOINT_WORKSPACE_CONFLICT', '续跑须使用新的 Run 独立工作区');
  mkdirSync(config.sandboxDir, { recursive: true });
  const runs = path.join(realpathSync(config.sandboxDir), 'runs');
  if (!existsSync(runs)) mkdirSync(runs);
  const root = path.join(runs, runId);
  if(checkpoint.archive) {
    // Once this write Run owns the restored directory, subsequent stages may legitimately change it.
    // Never overwrite those changes or re-materialize the original baseline on resume.
    const binding=get<{snapshot_id:string;digest:string;path:string}>('SELECT * FROM artifact_snapshot_restores WHERE owner_id=?',root);
    if(checkpoint.version===3&&checkpoint.readonly===false&&binding&&get('SELECT 1 FROM coordination_step_attempts WHERE run_id=? LIMIT 1',runId)) {
      if(binding.snapshot_id!==checkpoint.archive.id||binding.digest!==checkpoint.archive.digest||binding.path!==root||lstatSync(root).isSymbolicLink()||realpathSync(root)!==root)throw new OrchestrationError(409,'CHECKPOINT_WORKSPACE_CONFLICT','写入工作区恢复绑定已变化');
      assertRecoveryWorkspace(runId);
      return;
    }
    materializeArtifactSnapshot(checkpoint.archive.id,root);
    if(checkpoint.version===3)recordRecoveryWorkspace(runId);
    return;
  }
  if (!existsSync(root)) mkdirSync(root);
  if (lstatSync(runs).isSymbolicLink() || lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) throw new OrchestrationError(409, 'CHECKPOINT_PATH_UNSAFE', '续跑工作区路径包含链接');
  for (const file of checkpoint.files) {
    if (!safeCheckpointPath(file.path)) throw new OrchestrationError(409, 'CHECKPOINT_PATH_UNSAFE', '归档文件路径无效');
    const bytes = Buffer.from(file.base64 ?? '', 'base64');
    if (bytes.length > 32768 || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new OrchestrationError(409, 'CHECKPOINT_CORRUPT', '归档文件哈希无效');
    let parent = root;
    for (const part of file.path.split('/').slice(0, -1)) {
      parent = path.join(parent, part); if (!existsSync(parent)) mkdirSync(parent);
      if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) throw new OrchestrationError(409, 'CHECKPOINT_PATH_UNSAFE', '归档目标包含链接或非目录');
    }
    const target = path.join(root, file.path);
    if (existsSync(target) || (() => { try { lstatSync(target); return true; } catch { return false; } })()) {
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || createHash('sha256').update(readFileSync(target)).digest('hex') !== file.sha256) throw new OrchestrationError(409, 'CHECKPOINT_FILE_CHANGED', '续跑工作区文件已变化，禁止覆盖或继续');
    } else {
      const fd = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
    }
  }
}

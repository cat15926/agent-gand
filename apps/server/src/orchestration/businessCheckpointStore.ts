import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BusinessContract, BusinessDecision, BusinessReport } from '@agent-gand/shared';
import { get, run } from '../db/database.ts';
import { config } from '../config.ts';
import { OrchestrationError } from './normalize.ts';

export interface BusinessCheckpoint {
  version: 1; sourceRunId: string; sourceVersion: number; contract: BusinessContract;
  accepted: Array<{ stageId: string; report: BusinessReport; decision: BusinessDecision }>;
  outputs: Array<{ attemptId: string; sourceRunId: string; stageId: string; stepId: string; agentId: string; objective: string; output: string; sha256: string }>;
  files: Array<{ sourceRunId: string; path: string; workspaceScope?: string; sha256: string; base64: string }>;
  runTokens: number; stageTokens: Array<{ stageId: string; charged: number }>;
  /** Rejected outputs are audit/context only, never a completed-worker or acceptance whitelist. */
  rework?: { sourceRunId: string; sourceStatus: string; stageId: string; report: BusinessReport; decision: BusinessDecision;
    instruction: string; rejectedOutputs: BusinessCheckpoint['outputs'] };
}
export const checkpointDigest = (checkpoint: BusinessCheckpoint): string => createHash('sha256').update(JSON.stringify(checkpoint)).digest('hex');
export function readBusinessCheckpoint(runId: string): BusinessCheckpoint | null {
  const row = get<{ manifest: string; digest: string }>('SELECT manifest,digest FROM business_run_checkpoints WHERE run_id=?', runId);
  const expected = get<{ digest: string | null }>("SELECT json_extract(snapshot,'$.businessCheckpointDigest') digest FROM orchestration_requests WHERE run_id=?", runId)?.digest;
  if (!row && !expected) return null;
  if (!row || !expected || row.digest !== expected || createHash('sha256').update(row.manifest).digest('hex') !== row.digest) throw new OrchestrationError(409, 'CHECKPOINT_CORRUPT', '续跑检查点校验失败，禁止执行');
  return JSON.parse(row.manifest) as BusinessCheckpoint;
}
export function checkpointOutput(runId: string, attemptId: string) {
  return readBusinessCheckpoint(runId)?.outputs.find(item => item.attemptId === attemptId);
}
export function saveBusinessCheckpoint(runId: string, checkpoint: BusinessCheckpoint): void {
  run('INSERT INTO business_run_checkpoints(run_id,source_run_id,manifest,digest,created_at) VALUES (?,?,?,?,?)',
    runId, checkpoint.sourceRunId, JSON.stringify(checkpoint), checkpointDigest(checkpoint), new Date().toISOString());
}
export function checkpointSummary(checkpoint: BusinessCheckpoint) {
  return { sourceRunId: checkpoint.sourceRunId, sourceVersion: checkpoint.sourceVersion, digest: checkpointDigest(checkpoint),
    acceptedStageIds: checkpoint.accepted.map(item => item.stageId), completedWorkers: checkpoint.outputs.length,
    files: checkpoint.files.map(({ path, sha256 }) => ({ path, sha256 })),
    ...(checkpoint.rework ? { rework: { sourceRunId: checkpoint.rework.sourceRunId, stageId: checkpoint.rework.stageId,
      reportId: checkpoint.rework.report.id, reason: checkpoint.rework.decision.reason, instruction: checkpoint.rework.instruction,
      rejectedWorkers: checkpoint.rework.rejectedOutputs.length } } : {}) };
}
export function safeCheckpointPath(file: string): boolean {
  const parts = file.split('/');
  return Boolean(file) && !path.isAbsolute(file) && !file.includes('\\') && !file.includes('\0')
    && !['shared', 'archive'].includes(parts[0]!) && parts.every(p => p && p !== '.' && p !== '..' && p.toLowerCase() !== '.git');
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
  if (!existsSync(root)) mkdirSync(root);
  if (lstatSync(runs).isSymbolicLink() || lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) throw new OrchestrationError(409, 'CHECKPOINT_PATH_UNSAFE', '续跑工作区路径包含链接');
  for (const file of checkpoint.files) {
    if (!safeCheckpointPath(file.path)) throw new OrchestrationError(409, 'CHECKPOINT_PATH_UNSAFE', '归档文件路径无效');
    const bytes = Buffer.from(file.base64, 'base64');
    if (bytes.length > 32768 || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new OrchestrationError(409, 'CHECKPOINT_CORRUPT', '归档文件哈希无效');
    let parent = root;
    for (const part of file.path.split('/').slice(0, -1)) {
      parent = path.join(parent, part); if (!existsSync(parent)) mkdirSync(parent);
      if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) throw new OrchestrationError(409, 'CHECKPOINT_PATH_UNSAFE', '归档目标包含链接或非目录');
    }
    const target = path.join(root, file.path);
    if (existsSync(target) || (() => { try { lstatSync(target); return true; } catch { return false; } })()) {
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || createHash('sha256').update(readFileSync(target)).digest('hex') !== file.sha256) throw new OrchestrationError(409, 'CHECKPOINT_FILE_CHANGED', '续跑工作区文件已变化，禁止覆盖或继续');
    } else {
      const fd = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
    }
  }
}

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type {
  RuntimeEvidenceBundle,
  RuntimeEvidenceBundleOwnerType,
  RuntimeEvidenceRef,
  RuntimeEvidenceResolution,
  RuntimeRunContract,
} from '@agent-gand/shared';
import { afterCommit, all, get, run, tx } from '../db/database.ts';
import { emit } from '../messaging/bus.ts';
import { resolveSandboxPath, workspaceRootDir } from '../tools/builtin/index.ts';

export interface ResolvedEvidence extends RuntimeEvidenceResolution {}

interface EvidenceBundleRow {
  id: string; run_id: string; subject_id: string | null; owner_type: RuntimeEvidenceBundleOwnerType;
  owner_id: string; version: number; refs: string; resolutions: string; fingerprint: string;
  status: RuntimeEvidenceBundle['status']; idempotency_key: string; created_at: string; validated_at: string;
}

const MAX_FILE_BYTES = 32_768;
const MAX_EXCERPT = 2_000;

export function redactSensitive(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, '[REDACTED PRIVATE KEY]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, '[REDACTED TOKEN]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*['"]?[^\s,'"}]{8,}/giu, '[REDACTED SECRET]');
}

function accepted(ref: RuntimeEvidenceRef, source: string, content: string | Buffer): ResolvedEvidence {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return { ref, trusted: true, source, excerpt: redactSensitive(bytes.toString('utf8')).slice(0, MAX_EXCERPT),
    contentSha256: createHash('sha256').update(bytes).digest('hex'), reason: null };
}
function rejected(ref: RuntimeEvidenceRef, reason: string): ResolvedEvidence {
  return { ref, trusted: false, source: ref.kind, excerpt: null, contentSha256: null, reason };
}

function fileBytes(runId: string, relPath: string, workspaceScope?: string): Buffer {
  const owner = get<{ workspace: string | null }>('SELECT workspace FROM runs WHERE id=?', runId);
  if (!owner) throw new Error('Run 不存在');
  if (!relPath || relPath === 'shared' || relPath.startsWith('shared/') || relPath === 'archive' || relPath.startsWith('archive/')) {
    throw new Error('共享区或历史归档不能作为 Run 文件证据');
  }
  const context = { runId, workspace: owner.workspace, workspaceScope: workspaceScope ?? null };
  const root = realpathSync(workspaceRootDir(context));
  const resolved = resolveSandboxPath(relPath, context);
  if (resolved.area !== 'run') throw new Error('文件不属于 Run 工作区');
  const actual = realpathSync(resolved.absPath);
  if (!actual.startsWith(root + path.sep)) throw new Error('文件越出 Run 工作区');
  const stat = statSync(actual);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('文件不存在、非普通文件或超过证据大小上限');
  return readFileSync(actual);
}

export function createWorkspaceFileEvidence(runId: string, relPath: string, workspaceScope?: string): RuntimeEvidenceRef {
  const bytes = fileBytes(runId, relPath, workspaceScope);
  return { kind: 'workspace_file', path: relPath, sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(workspaceScope ? { workspaceScope } : {}) };
}

export function resolveEvidence(runId: string, ref: RuntimeEvidenceRef): ResolvedEvidence {
  if (ref.kind === 'message') {
    const row = get<{ run_id: string; kind: string; body: string }>('SELECT run_id,kind,body FROM messages WHERE id=?', ref.id);
    if (!row || row.run_id !== runId) return rejected(ref, '消息不属于当前 Run');
    if (row.kind !== 'user' && row.kind !== 'agent') return rejected(ref, '系统或工具聊天摘要不是可引用的消息证据');
    return accepted(ref, `message:${ref.id}`, row.body);
  }
  if (ref.kind === 'tool_execution') {
    const row = get<{ run_id: string; status: string; output: string | null }>('SELECT run_id,status,output FROM tool_executions WHERE id=?', ref.id);
    if (!row || row.run_id !== runId || row.status !== 'completed' || row.output === null) return rejected(ref, '工具执行未完成或不属于当前 Run');
    return accepted(ref, `tool_execution:${ref.id}`, row.output);
  }
  if (ref.kind === 'attempt_output') {
    const row = get<{ run_id: string; status: string; output: string | null }>('SELECT run_id,status,output FROM collaboration_attempts WHERE id=?', ref.id);
    const coordination = row ?? get<{ run_id: string; status: string; output: string | null }>(
      'SELECT run_id,status,output FROM coordination_step_attempts WHERE id=?', ref.id);
    if (!coordination || coordination.run_id !== runId || coordination.status !== 'completed' || coordination.output === null) return rejected(ref, 'Attempt 输出未完成或不属于当前 Run');
    return accepted(ref, `attempt_output:${ref.id}`, coordination.output);
  }
  if (ref.kind === 'run_event') {
    const row = get<{ run_id: string; status: string; output: string | null }>('SELECT run_id,status,output FROM run_events WHERE id=?', ref.id);
    if (!row || row.run_id !== runId || row.status !== 'ok' || row.output === null) return rejected(ref, 'RunEvent 未完成或不属于当前 Run');
    return accepted(ref, `run_event:${ref.id}`, row.output);
  }
  try {
    if (!/^[a-f0-9]{64}$/u.test(ref.sha256)) return rejected(ref, '文件哈希无效');
    const bytes = fileBytes(runId, ref.path, ref.workspaceScope);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== ref.sha256) return rejected(ref, '文件内容已变化');
    return accepted(ref, `workspace_file:${ref.path}@${digest.slice(0, 12)}`, bytes);
  } catch (error) {
    return rejected(ref, error instanceof Error ? error.message : String(error));
  }
}

function toBundle(row: EvidenceBundleRow): RuntimeEvidenceBundle {
  return {
    id: row.id, version: 1, runId: row.run_id, subjectId: row.subject_id,
    ownerType: row.owner_type, ownerId: row.owner_id,
    refs: JSON.parse(row.refs) as RuntimeEvidenceRef[],
    resolutions: JSON.parse(row.resolutions) as RuntimeEvidenceResolution[],
    fingerprint: row.fingerprint, status: row.status, idempotencyKey: row.idempotency_key,
    createdAt: row.created_at, validatedAt: row.validated_at,
  };
}

function resolutionFingerprint(refs: RuntimeEvidenceRef[], resolutions: RuntimeEvidenceResolution[]): string {
  return createHash('sha256').update(JSON.stringify({ version: 1, refs,
    resolutions: resolutions.map((item) => ({ ref: item.ref, trusted: item.trusted, source: item.source,
      contentSha256: item.contentSha256, reason: item.reason })) })).digest('hex');
}

function resolveForBundle(runId: string, ref: RuntimeEvidenceRef, contentOverrides: Record<string, string>): ResolvedEvidence {
  if (ref.kind === 'attempt_output') {
    const override = contentOverrides[`attempt_output:${ref.id}`];
    if (override !== undefined) {
      const collaboration = get<{ run_id: string; status: string }>('SELECT run_id,status FROM collaboration_attempts WHERE id=?', ref.id);
      const coordination = collaboration ?? get<{ run_id: string; status: string }>('SELECT run_id,status FROM coordination_step_attempts WHERE id=?', ref.id);
      if (!coordination || coordination.run_id !== runId || !['running', 'completed'].includes(coordination.status)) {
        return rejected(ref, 'Attempt override 不属于当前 Run 或已失去提交权');
      }
      return accepted(ref, `attempt_output:${ref.id}`, override);
    }
  }
  return resolveEvidence(runId, ref);
}

export function runtimeEvidenceBundleVersion(runId: string): 1 | null {
  const row = get<{ payload: string }>('SELECT payload FROM runtime_contracts WHERE run_id=?', runId);
  if (!row) return null;
  try { return (JSON.parse(row.payload) as RuntimeRunContract).features?.evidenceBundleVersion === 1 ? 1 : null; }
  catch { return null; }
}

export function createEvidenceBundle(input: {
  runId: string;
  subjectId?: string | null;
  ownerType: RuntimeEvidenceBundleOwnerType;
  ownerId: string;
  refs: RuntimeEvidenceRef[];
  idempotencyKey: string;
  contentOverrides?: Record<string, string>;
}): RuntimeEvidenceBundle {
  return tx(() => {
    if (input.refs.length > 32) throw new Error('EvidenceBundle 引用数量超过上限');
    const existing = get<EvidenceBundleRow>('SELECT * FROM runtime_evidence_bundles WHERE idempotency_key=?', input.idempotencyKey);
    const encodedRefs = JSON.stringify(input.refs);
    if (existing) {
      if (existing.run_id !== input.runId || existing.subject_id !== (input.subjectId ?? null)
        || existing.owner_type !== input.ownerType || existing.owner_id !== input.ownerId || existing.refs !== encodedRefs) {
        throw new Error(`EvidenceBundle 幂等键冲突：${input.idempotencyKey}`);
      }
      return toBundle(existing);
    }
    const resolutions = input.refs.map((ref) => resolveForBundle(input.runId, ref, input.contentOverrides ?? {}));
    const fingerprint = resolutionFingerprint(input.refs, resolutions);
    const status: RuntimeEvidenceBundle['status'] = input.refs.length > 0 && resolutions.every((item) => item.trusted)
      ? 'valid' : 'invalid';
    const id = randomUUID(); const now = new Date().toISOString();
    run(`INSERT INTO runtime_evidence_bundles
      (id,run_id,subject_id,owner_type,owner_id,version,refs,resolutions,fingerprint,status,idempotency_key,created_at,validated_at)
      VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?)`, id, input.runId, input.subjectId ?? null, input.ownerType, input.ownerId,
    encodedRefs, JSON.stringify(resolutions), fingerprint, status, input.idempotencyKey, now, now);
    const bundle = toBundle(get<EvidenceBundleRow>('SELECT * FROM runtime_evidence_bundles WHERE id=?', id)!);
    afterCommit(() => emit({ type: 'runtime.evidence_bundle.updated', bundle }));
    return bundle;
  });
}

export function validateEvidenceBundle(id: string, runId?: string): {
  bundle: RuntimeEvidenceBundle | null;
  valid: boolean;
  currentResolutions: RuntimeEvidenceResolution[];
} {
  return tx(() => {
    const row = get<EvidenceBundleRow>('SELECT * FROM runtime_evidence_bundles WHERE id=?', id);
    if (!row || (runId && row.run_id !== runId)) return { bundle: null, valid: false, currentResolutions: [] };
    const refs = JSON.parse(row.refs) as RuntimeEvidenceRef[];
    const currentResolutions = refs.map((ref) => resolveEvidence(row.run_id, ref));
    const currentFingerprint = resolutionFingerprint(refs, currentResolutions);
    const unchanged = refs.length > 0 && currentResolutions.every((item) => item.trusted)
      && currentFingerprint === row.fingerprint;
    const nextStatus: RuntimeEvidenceBundle['status'] = row.status === 'valid' && !unchanged ? 'drifted' : row.status;
    const now = new Date().toISOString();
    run('UPDATE runtime_evidence_bundles SET status=?,validated_at=? WHERE id=?', nextStatus, now, row.id);
    const bundle = toBundle(get<EvidenceBundleRow>('SELECT * FROM runtime_evidence_bundles WHERE id=?', row.id)!);
    if (nextStatus !== row.status) afterCommit(() => emit({ type: 'runtime.evidence_bundle.updated', bundle }));
    return { bundle, valid: nextStatus === 'valid' && unchanged, currentResolutions };
  });
}

export function listEvidenceBundles(runId: string): RuntimeEvidenceBundle[] {
  return all<EvidenceBundleRow>('SELECT * FROM runtime_evidence_bundles WHERE run_id=? ORDER BY created_at,rowid', runId)
    .map(toBundle)
    .map((bundle) => validateEvidenceBundle(bundle.id, runId).bundle ?? bundle);
}

export function evidenceFingerprint(runId: string, refs: RuntimeEvidenceRef[]): string {
  const unique = [...new Map(refs.map((ref) => [JSON.stringify(ref), ref])).values()]
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const resolutions = unique.map((ref) => resolveEvidence(runId, ref));
  return resolutionFingerprint(unique, resolutions);
}

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeEvidenceRef } from '@agent-gand/shared';
import { get } from '../db/database.ts';
import { resolveSandboxPath, workspaceRootDir } from '../tools/builtin/index.ts';

export interface ResolvedEvidence {
  ref: RuntimeEvidenceRef;
  trusted: boolean;
  source: string;
  excerpt: string | null;
  reason: string | null;
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

function accepted(ref: RuntimeEvidenceRef, source: string, content: string): ResolvedEvidence {
  return { ref, trusted: true, source, excerpt: redactSensitive(content).slice(0, MAX_EXCERPT), reason: null };
}
function rejected(ref: RuntimeEvidenceRef, reason: string): ResolvedEvidence {
  return { ref, trusted: false, source: ref.kind, excerpt: null, reason };
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
    return accepted(ref, `workspace_file:${ref.path}@${digest.slice(0, 12)}`, bytes.toString('utf8'));
  } catch (error) {
    return rejected(ref, error instanceof Error ? error.message : String(error));
  }
}

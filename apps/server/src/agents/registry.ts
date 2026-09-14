import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AgentDefinition } from '@agent-gand/shared';
import { config } from '../config.ts';
import { all, get, run, tx } from '../db/database.ts';
import { emit } from '../messaging/bus.ts';
import { loadAgentsFromDir } from './loader.ts';
import { AgentValidationError, normalizeAgent, validateAgentInput } from './validation.ts';

interface AgentRow {
  id: string; name: string; definition: string; source: 'file' | 'db'; enabled: number;
  version: number; definition_hash: string | null; source_path: string | null; sync_error: string | null;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function rowToDefinition(row: AgentRow): AgentDefinition {
  const parsed = JSON.parse(row.definition) as AgentDefinition;
  return normalizeAgent({ ...parsed, source: row.source, enabled: row.enabled === 1, version: row.version, syncError: row.sync_error });
}
function saveVersion(def: AgentDefinition, now: string): void {
  run('INSERT OR REPLACE INTO agent_versions (agent_id,version,definition,created_at) VALUES (?,?,?,?)', def.id, def.version, JSON.stringify(def), now);
}

export function syncFromFiles(): AgentDefinition[] {
  const loaded = loadAgentsFromDir(config.agentsDir);
  const seen = new Set<string>();
  tx(() => {
    run("UPDATE agents SET sync_error=NULL WHERE source='db' AND sync_error LIKE '文件 %'");
    for (const item of loaded) {
      const def = item.definition; seen.add(def.id);
      const existing = get<AgentRow>('SELECT * FROM agents WHERE id=?', def.id);
      if (existing?.source === 'db') {
        run('UPDATE agents SET sync_error=? WHERE id=?', `文件 ${item.file} 与数据库角色 ID 冲突，已保留数据库版本`, def.id);
        continue;
      }
      const definitionHash = digest(JSON.stringify({ ...def, enabled: true, version: 0, syncError: null }));
      const sourcePath = path.join(config.agentsDir, item.file);
      if (existing?.definition_hash === definitionHash) {
        run('UPDATE agents SET source_path=?,sync_error=NULL WHERE id=?', sourcePath, def.id); continue;
      }
      const now = new Date().toISOString();
      const stored = normalizeAgent({ ...def, enabled: existing ? existing.enabled === 1 : true, version: existing ? existing.version + 1 : 1, syncError: null });
      run(`INSERT INTO agents (id,name,definition,source,enabled,version,definition_hash,source_path,sync_error,created_at,updated_at)
        VALUES (?,?,?,'file',?,?,?,?,NULL,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,definition=excluded.definition,
        version=excluded.version,definition_hash=excluded.definition_hash,source_path=excluded.source_path,sync_error=NULL,updated_at=excluded.updated_at`,
        stored.id, stored.name, JSON.stringify(stored), stored.enabled ? 1 : 0, stored.version, definitionHash, sourcePath, now, now);
      saveVersion(stored, now);
    }
    for (const row of all<AgentRow>("SELECT * FROM agents WHERE source='file'")) {
      if (!seen.has(row.id)) run("UPDATE agents SET enabled=0,sync_error='定义文件不存在',updated_at=? WHERE id=?", new Date().toISOString(), row.id);
    }
  });
  return list();
}
export function list(includeDisabled = false): AgentDefinition[] {
  return all<AgentRow>(`SELECT * FROM agents${includeDisabled ? '' : ' WHERE enabled=1'} ORDER BY id`).map(rowToDefinition);
}
export function getAgent(id: string): AgentDefinition | undefined {
  const row = get<AgentRow>('SELECT * FROM agents WHERE id=? AND enabled=1', id); return row ? rowToDefinition(row) : undefined;
}
export function getAnyAgent(id: string): AgentDefinition | undefined {
  const row = get<AgentRow>('SELECT * FROM agents WHERE id=?', id); return row ? rowToDefinition(row) : undefined;
}
export function createAgent(value: unknown): AgentDefinition {
  const input = validateAgentInput(value);
  if (getAnyAgent(input.id)) throw new AgentValidationError(409, `角色 ID 已存在: ${input.id}`, { id: '角色 ID 已存在' });
  const now = new Date().toISOString();
  const def: AgentDefinition = { ...input, source: 'db', enabled: true, version: 1, syncError: null };
  tx(() => { run(`INSERT INTO agents (id,name,definition,source,enabled,version,definition_hash,source_path,sync_error,created_at,updated_at)
    VALUES (?,?,?,'db',1,1,?,NULL,NULL,?,?)`, def.id, def.name, JSON.stringify(def), digest(JSON.stringify(input)), now, now); saveVersion(def, now); });
  emit({ type: 'agent.updated', agent: def }); return def;
}
export function updateAgent(id: string, value: unknown, expectedVersion: number): AgentDefinition {
  const current = getAnyAgent(id);
  if (!current) throw new AgentValidationError(404, `角色不存在: ${id}`);
  if (current.source === 'file') throw new AgentValidationError(403, '文件角色为只读，请复制后编辑');
  if (current.version !== expectedVersion) throw new AgentValidationError(409, '角色已被其他操作修改，请刷新后重试');
  const input = validateAgentInput({ ...(value as object), id }); const now = new Date().toISOString();
  const def: AgentDefinition = { ...input, source: 'db', enabled: current.enabled, version: current.version + 1, syncError: null };
  tx(() => { run('UPDATE agents SET name=?,definition=?,version=?,definition_hash=?,sync_error=NULL,updated_at=? WHERE id=? AND version=?', def.name, JSON.stringify(def), def.version, digest(JSON.stringify(input)), now, id, expectedVersion); saveVersion(def, now); });
  emit({ type: 'agent.updated', agent: def }); return def;
}
export function setEnabled(id: string, enabled: boolean, expectedVersion?: number): AgentDefinition {
  const current = getAnyAgent(id); if (!current) throw new AgentValidationError(404, `角色不存在: ${id}`);
  if (expectedVersion !== undefined && current.version !== expectedVersion) throw new AgentValidationError(409, '角色已被其他操作修改，请刷新后重试');
  const def: AgentDefinition = { ...current, enabled, version: current.version + 1 }; const now = new Date().toISOString();
  tx(() => { run('UPDATE agents SET enabled=?,version=?,definition=?,updated_at=? WHERE id=?', enabled ? 1 : 0, def.version, JSON.stringify(def), now, id); saveVersion(def, now); });
  emit({ type: 'agent.updated', agent: def }); return def;
}
export function count(): number { return get<{ n: number }>('SELECT COUNT(*) n FROM agents WHERE enabled=1')?.n ?? 0; }

export function listVersions(id: string): Array<{ version: number; definition: AgentDefinition; createdAt: string }> {
  return all<{ version: number; definition: string; created_at: string }>('SELECT version,definition,created_at FROM agent_versions WHERE agent_id=? ORDER BY version DESC', id)
    .map((row) => ({ version: row.version, definition: JSON.parse(row.definition) as AgentDefinition, createdAt: row.created_at }));
}

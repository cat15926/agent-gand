/**
 * agent 注册表（规格 §4.2 agents/registry.ts）
 * syncFromFiles：把 agents/*.agent.md upsert 进 agents 表（definition 存 JSON）
 */
import type { AgentDefinition } from '@agent-gand/shared';
import { config } from '../config.ts';
import { all, get, run } from '../db/database.ts';
import { loadAgentsFromDir } from './loader.ts';

interface AgentRow {
  id: string;
  name: string;
  definition: string;
  source: string;
  created_at: string;
  updated_at: string;
}

function rowToDefinition(row: AgentRow): AgentDefinition {
  return JSON.parse(row.definition) as AgentDefinition;
}

function upsert(def: AgentDefinition): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO agents (id, name, definition, source, created_at, updated_at)
     VALUES (?, ?, ?, 'file', ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       definition = excluded.definition,
       source = excluded.source,
       updated_at = excluded.updated_at`,
    def.id,
    def.name,
    JSON.stringify(def),
    now,
    now,
  );
}

/** 从 agents/ 目录同步全部定义到 DB（幂等，启动时调用） */
export function syncFromFiles(): AgentDefinition[] {
  const loaded = loadAgentsFromDir(config.agentsDir);
  for (const { definition } of loaded) upsert(definition);
  return list();
}

export function list(): AgentDefinition[] {
  return all<AgentRow>('SELECT * FROM agents ORDER BY id').map(rowToDefinition);
}

export function getAgent(id: string): AgentDefinition | undefined {
  const row = get<AgentRow>('SELECT * FROM agents WHERE id = ?', id);
  return row ? rowToDefinition(row) : undefined;
}

export function count(): number {
  const row = get<{ n: number }>('SELECT COUNT(*) AS n FROM agents');
  return row?.n ?? 0;
}

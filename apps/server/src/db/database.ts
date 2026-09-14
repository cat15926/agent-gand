/**
 * SQLite 单例（规格 §4.2 db/database.ts）
 * WAL 模式；启动即建表；导出 all/get/run 与 tx（BEGIN IMMEDIATE 事务，用于任务认领防竞态锁）
 */
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { config } from '../config.ts';

mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath, { timeout: 5000 });
db.pragma('journal_mode = WAL');

// schema.sql 与本文件同目录，tsx 下路径不变，可直接读
const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url));
db.exec(readFileSync(schemaPath, 'utf-8'));

// 轻量列迁移（§10.2）：既有库补 workspace 列（CREATE TABLE IF NOT EXISTS 不会为旧表加列）
if (!db.prepare('PRAGMA table_info(runs)').all().some((c) => (c as { name?: string }).name === 'workspace')) {
  db.exec('ALTER TABLE runs ADD COLUMN workspace TEXT');
}
// §13.2/13.3：title / deleted_at 列（同幂等模式）
{
  const cols = new Set(
    (db.prepare('PRAGMA table_info(runs)').all() as Array<{ name?: string }>).map((c) => c.name),
  );
  if (cols.has('title') !== true) db.exec('ALTER TABLE runs ADD COLUMN title TEXT');
  if (cols.has('deleted_at') !== true) db.exec('ALTER TABLE runs ADD COLUMN deleted_at TEXT');
}

/** Agent 通信与调度字段：既有 SQLite 数据库幂等升级。 */
function ensureColumns(table: string, columns: Array<{ name: string; sql: string }>): void {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>).map((c) => c.name),
  );
  for (const column of columns) {
    if (!existing.has(column.name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column.sql}`);
  }
}

ensureColumns('tasks', [
  { name: 'kind', sql: "kind TEXT NOT NULL DEFAULT 'work'" },
  { name: 'reviewer_id', sql: 'reviewer_id TEXT' },
  { name: 'acceptance_criteria', sql: "acceptance_criteria TEXT NOT NULL DEFAULT '[]'" },
  { name: 'result', sql: 'result TEXT' },
  { name: 'attempt', sql: 'attempt INTEGER NOT NULL DEFAULT 0' },
  { name: 'max_attempts', sql: 'max_attempts INTEGER NOT NULL DEFAULT 3' },
  { name: 'last_error', sql: 'last_error TEXT' },
]);
ensureColumns('messages', [
  { name: 'conversation_id', sql: 'conversation_id TEXT' },
  { name: 'seq', sql: 'seq INTEGER' },
  { name: 'task_id', sql: 'task_id TEXT' },
  { name: 'reply_to', sql: 'reply_to TEXT' },
  { name: 'message_type', sql: "message_type TEXT NOT NULL DEFAULT 'informational'" },
  { name: 'payload', sql: 'payload TEXT' },
  { name: 'delivery_status', sql: 'delivery_status TEXT' },
  { name: 'client_message_id', sql: 'client_message_id TEXT' },
]);
ensureColumns('runs', [
  { name: 'supervisor_id', sql: 'supervisor_id TEXT' },
  { name: 'conversation_id', sql: 'conversation_id TEXT' },
  { name: 'turn_no', sql: 'turn_no INTEGER NOT NULL DEFAULT 1' },
]);
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(run_id, to_agent, created_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, created_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_runs_conversation ON runs(conversation_id, turn_no)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_seq ON messages(conversation_id, seq)');
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client ON messages(conversation_id, client_message_id) WHERE client_message_id IS NOT NULL");

export function all<T>(sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function get<T>(sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function run(sql: string, ...params: unknown[]): number {
  const result = db.prepare(sql).run(...params);
  return result.changes;
}

/**
 * BEGIN IMMEDIATE 事务：进入即取写锁（跨进程也互斥）。
 * 任务 claim 等竞态敏感操作必须包裹在此事务内完成「读-判-写」。
 */
export function tx<T>(fn: () => T): T {
  if (db.inTransaction) return fn(); // 防御：已处于事务内则直接复用
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function closeDatabase(): void {
  db.close();
}

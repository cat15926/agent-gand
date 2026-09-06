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

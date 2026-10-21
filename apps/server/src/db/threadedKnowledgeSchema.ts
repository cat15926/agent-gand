import type Database from 'better-sqlite3';

/** Part of the outer T11 migration. This function never opens its own transaction. */
export function applyThreadedKnowledgeSchema(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('THREADED_MIGRATION_REQUIRES_TRANSACTION');
  db.exec(`
    CREATE TABLE IF NOT EXISTS threaded_knowledge (
      id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,thread_id TEXT NOT NULL REFERENCES threaded_threads(id),
      version INTEGER NOT NULL CHECK(version>=1),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      UNIQUE(id,owner_id,thread_id)
    );
    CREATE TABLE IF NOT EXISTS threaded_knowledge_versions (
      knowledge_id TEXT NOT NULL REFERENCES threaded_knowledge(id),version INTEGER NOT NULL,
      record TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(knowledge_id,version)
    );
    CREATE TABLE IF NOT EXISTS threaded_knowledge_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,knowledge_id TEXT NOT NULL,version INTEGER NOT NULL,
      binding_id TEXT NOT NULL REFERENCES threaded_execution_bindings(id),kind TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(knowledge_id,version) REFERENCES threaded_knowledge_versions(knowledge_id,version)
    );
    CREATE TABLE IF NOT EXISTS threaded_knowledge_operations (
      binding_id TEXT NOT NULL REFERENCES threaded_execution_bindings(id),request_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(binding_id,request_key)
    );
    CREATE TABLE IF NOT EXISTS threaded_knowledge_cursors (
      id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,thread_id TEXT NOT NULL,agent_id TEXT NOT NULL,
      authority_identity TEXT NOT NULL,cutoff INTEGER NOT NULL,last_seq INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS threaded_knowledge_scope ON threaded_knowledge(owner_id,thread_id,updated_at);
    CREATE TRIGGER IF NOT EXISTS threaded_knowledge_cas BEFORE UPDATE ON threaded_knowledge
      WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.thread_id<>OLD.thread_id
        OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1
      BEGIN SELECT RAISE(ABORT,'THREADED_KNOWLEDGE_VERSION_CONFLICT'); END;
  `);
  for (const table of ['threaded_knowledge_versions','threaded_knowledge_events','threaded_knowledge_operations','threaded_knowledge_cursors']) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'THREADED_KNOWLEDGE_FACT_IMMUTABLE'); END;`);
  }
  for (const table of ['threaded_knowledge','threaded_knowledge_versions','threaded_knowledge_events','threaded_knowledge_operations','threaded_knowledge_cursors']) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_retained BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'THREADED_KNOWLEDGE_FACT_RETAINED'); END;`);
  }
}

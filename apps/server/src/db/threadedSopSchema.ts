import type Database from 'better-sqlite3';

/** Additive v33 fragment. The migration coordinator owns the outer transaction. */
export function applyThreadedSopSchema(db:Database.Database):void {
  if(!db.inTransaction)throw new Error('THREADED_MIGRATION_REQUIRES_TRANSACTION');
  db.exec(`
    CREATE TABLE IF NOT EXISTS threaded_sops (
      id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,thread_id TEXT NOT NULL REFERENCES threaded_threads(id),
      sop_key TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>=1),record TEXT NOT NULL,
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(owner_id,thread_id,sop_key)
    );
    CREATE TABLE IF NOT EXISTS threaded_sop_versions (
      sop_id TEXT NOT NULL REFERENCES threaded_sops(id),version INTEGER NOT NULL CHECK(version>=1),
      binding_id TEXT NOT NULL REFERENCES threaded_execution_bindings(id),record TEXT NOT NULL,
      created_at INTEGER NOT NULL,PRIMARY KEY(sop_id,version)
    );
    CREATE TRIGGER IF NOT EXISTS threaded_sop_cas BEFORE UPDATE ON threaded_sops
      WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.thread_id<>OLD.thread_id
        OR NEW.sop_key<>OLD.sop_key OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1
      BEGIN SELECT RAISE(ABORT,'THREADED_SOP_CAS'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_sop_version_immutable BEFORE UPDATE ON threaded_sop_versions
      BEGIN SELECT RAISE(ABORT,'THREADED_SOP_HISTORY_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_sop_version_retained BEFORE DELETE ON threaded_sop_versions
      BEGIN SELECT RAISE(ABORT,'THREADED_SOP_HISTORY_RETAINED'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_sop_retained BEFORE DELETE ON threaded_sops
      BEGIN SELECT RAISE(ABORT,'THREADED_SOP_HISTORY_RETAINED'); END;
  `);
}

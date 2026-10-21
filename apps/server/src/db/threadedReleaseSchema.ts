import type Database from 'better-sqlite3';

/** v34 owns this fragment. Release controls never alter Thread state or execution epochs. */
export function applyThreadedReleaseSchema(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('THREADED_MIGRATION_REQUIRES_TRANSACTION');
  db.exec(`
    CREATE TABLE IF NOT EXISTS threaded_release_controls (
      owner_id TEXT PRIMARY KEY REFERENCES threaded_instances(instance_owner_id),
      version INTEGER NOT NULL CHECK(version>=1), admission_open INTEGER NOT NULL CHECK(admission_open IN (0,1)),
      dispatch_open INTEGER NOT NULL CHECK(dispatch_open IN (0,1)), updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threaded_release_changes (
      owner_id TEXT NOT NULL REFERENCES threaded_instances(instance_owner_id), request_id TEXT NOT NULL,
      request_hash TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>=1), record TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(owner_id,request_id), UNIQUE(owner_id,version)
    );
    CREATE TABLE IF NOT EXISTS threaded_release_grants (
      thread_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      control_version INTEGER NOT NULL, record TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(owner_id,request_id), UNIQUE(thread_id,owner_id),
      FOREIGN KEY(thread_id,owner_id) REFERENCES threaded_threads(id,owner_id)
    );
    CREATE TABLE IF NOT EXISTS threaded_release_roots (
      causal_root_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, home_thread_id TEXT NOT NULL,
      grant_thread_id TEXT NOT NULL, control_version INTEGER NOT NULL, record TEXT NOT NULL, created_at INTEGER NOT NULL,
      FOREIGN KEY(causal_root_id,home_thread_id,owner_id) REFERENCES threaded_messages(id,thread_id,owner_id),
      FOREIGN KEY(grant_thread_id,owner_id) REFERENCES threaded_release_grants(thread_id,owner_id)
    );
    CREATE TRIGGER IF NOT EXISTS threaded_release_control_cas BEFORE UPDATE ON threaded_release_controls
      WHEN NEW.owner_id<>OLD.owner_id OR NEW.version<>OLD.version+1
      BEGIN SELECT RAISE(ABORT,'THREADED_RELEASE_CONTROL_CAS'); END;
  `);
  for (const table of ['threaded_release_changes', 'threaded_release_grants', 'threaded_release_roots']) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'THREADED_RELEASE_FACT_IMMUTABLE'); END;`);
  }
  for (const table of ['threaded_release_controls', 'threaded_release_changes', 'threaded_release_grants', 'threaded_release_roots']) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_retained BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'THREADED_RELEASE_FACT_RETAINED'); END;`);
  }
}

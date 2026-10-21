import type Database from 'better-sqlite3';
export function applyThreadedReviewSchema(db:Database.Database){
  if(!db.inTransaction)throw new Error('THREADED_MIGRATION_REQUIRES_TRANSACTION');
  db.exec(`
    CREATE TABLE IF NOT EXISTS threaded_review_legacy_admissions (
      action_id TEXT NOT NULL REFERENCES threaded_actions(id),generation INTEGER NOT NULL,
      PRIMARY KEY(action_id,generation)
    );
    CREATE TABLE IF NOT EXISTS threaded_review_workflows (
      action_id TEXT PRIMARY KEY REFERENCES threaded_actions(id),owner_id TEXT NOT NULL,thread_id TEXT NOT NULL,
      version INTEGER NOT NULL,generation INTEGER NOT NULL,head_sha TEXT NOT NULL,record TEXT NOT NULL,updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threaded_review_versions (
      action_id TEXT NOT NULL REFERENCES threaded_review_workflows(action_id),version INTEGER NOT NULL,
      generation INTEGER NOT NULL,head_sha TEXT NOT NULL,record TEXT NOT NULL,created_at INTEGER NOT NULL,
      PRIMARY KEY(action_id,version)
    );
    CREATE TABLE IF NOT EXISTS threaded_review_reports (
      evidence_id TEXT PRIMARY KEY REFERENCES threaded_action_evidence(id),action_id TEXT NOT NULL,generation INTEGER NOT NULL,
      message_id TEXT NOT NULL REFERENCES threaded_messages(id),record TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threaded_review_revision_claims (
      id TEXT PRIMARY KEY,action_id TEXT NOT NULL,from_generation INTEGER NOT NULL,to_generation INTEGER NOT NULL,
      message_id TEXT NOT NULL REFERENCES threaded_messages(id),record TEXT NOT NULL,created_at INTEGER NOT NULL,
      UNIQUE(action_id,to_generation)
    );
    CREATE TABLE IF NOT EXISTS threaded_review_gate_checks (
      id TEXT PRIMARY KEY,action_id TEXT NOT NULL,generation INTEGER NOT NULL,workflow_version INTEGER NOT NULL,
      head_sha TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('approved','blocked','stale','unverifiable')),
      record TEXT NOT NULL,checked_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS threaded_review_gate_latest ON threaded_review_gate_checks(action_id,checked_at);
    CREATE TRIGGER IF NOT EXISTS threaded_review_cas BEFORE UPDATE ON threaded_review_workflows
      WHEN NEW.action_id<>OLD.action_id OR NEW.owner_id<>OLD.owner_id OR NEW.thread_id<>OLD.thread_id
        OR NEW.version<>OLD.version+1 OR NEW.generation<OLD.generation
      BEGIN SELECT RAISE(ABORT,'THREADED_REVIEW_CAS'); END;
  `);
  // The migration transaction freezes compatibility once; reopening must never adopt newly created Actions.
  if(!db.prepare('SELECT 1 FROM orchestration_schema_migrations WHERE version=33').get())
    db.exec("INSERT OR IGNORE INTO threaded_review_legacy_admissions SELECT id,generation FROM threaded_actions WHERE family='review'");
  for(const table of ['threaded_review_legacy_admissions','threaded_review_versions','threaded_review_reports','threaded_review_revision_claims','threaded_review_gate_checks'])
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'THREADED_REVIEW_FACT_IMMUTABLE'); END;`);
  for(const table of ['threaded_review_legacy_admissions','threaded_review_workflows','threaded_review_versions','threaded_review_reports','threaded_review_revision_claims','threaded_review_gate_checks'])
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_retained BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'THREADED_REVIEW_FACT_RETAINED'); END;`);
}

import type Database from 'better-sqlite3';

export const THREADED_HOLD_ADMISSION_MIGRATION = {
  version: 35, name: 'threaded-shared-hold-admission-v1',
  descriptor: 'shared-timer-command-hold-quota-v1;scoped-stable-source-admission-v1;retained-v31-timer-quota-forward-backfill-v1;legacy-active-command-wake-conservative-upgrade-window-v1;append-only-hold-admissions-v1',
} as const;

/** Append a common admission ledger without changing any v25-v34 schema contract. */
export function applyThreadedHoldAdmissionMigration(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('THREADED_MIGRATION_REQUIRES_TRANSACTION');
  db.exec(`
    CREATE TABLE IF NOT EXISTS threaded_hold_admissions (
      owner_id TEXT NOT NULL, thread_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      admission_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('timer','command')),
      source_id TEXT NOT NULL CHECK(length(source_id)>0), created_at INTEGER NOT NULL,
      PRIMARY KEY(owner_id,thread_id,agent_id,admission_key), UNIQUE(kind,source_id),
      CHECK(admission_key=CASE kind WHEN 'timer' THEN 'wait:'||source_id ELSE 'command:'||source_id END),
      FOREIGN KEY(thread_id,owner_id,agent_id) REFERENCES threaded_members(thread_id,owner_id,agent_id)
    );
    CREATE INDEX IF NOT EXISTS threaded_hold_admissions_window
      ON threaded_hold_admissions(owner_id,thread_id,agent_id,created_at);
    CREATE TRIGGER IF NOT EXISTS threaded_hold_admissions_source_scope BEFORE INSERT ON threaded_hold_admissions
      WHEN (NEW.kind='timer' AND NOT EXISTS(SELECT 1 FROM threaded_waits w
        WHERE w.id=NEW.source_id AND w.kind='timer' AND w.owner_id=NEW.owner_id
          AND w.thread_id=NEW.thread_id AND w.agent_id=NEW.agent_id))
        OR (NEW.kind='command' AND NOT EXISTS(SELECT 1 FROM threaded_commands c
          WHERE c.id=NEW.source_id AND c.owner_id=NEW.owner_id
            AND c.thread_id=NEW.thread_id AND c.agent_id=NEW.agent_id))
      BEGIN SELECT RAISE(ABORT,'THREADED_HOLD_ADMISSION_SCOPE_MISMATCH'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_hold_admissions_immutable BEFORE UPDATE ON threaded_hold_admissions
      BEGIN SELECT RAISE(ABORT,'THREADED_HOLD_ADMISSION_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_hold_admissions_retained BEFORE DELETE ON threaded_hold_admissions
      BEGIN SELECT RAISE(ABORT,'THREADED_HOLD_ADMISSION_RETAINED'); END;
    INSERT OR IGNORE INTO threaded_hold_admissions
      (owner_id,thread_id,agent_id,admission_key,kind,source_id,created_at)
      SELECT owner_id,thread_id,agent_id,'wait:'||wait_id,'timer',wait_id,created_at
      FROM threaded_hold_quota;
  `);
  // v34 command waits have no registration timestamp. Charge only retained active
  // waits/pending callbacks once at upgrade time, rather than inventing an old
  // timestamp or letting an old job retry acquire a second admission later.
  db.prepare(`INSERT OR IGNORE INTO threaded_hold_admissions
    (owner_id,thread_id,agent_id,admission_key,kind,source_id,created_at)
    SELECT c.owner_id,c.thread_id,c.agent_id,'command:'||c.id,'command',c.id,?
    FROM threaded_commands c JOIN threaded_command_waits w ON w.command_id=c.id
    WHERE w.state='awaiting' OR EXISTS(SELECT 1 FROM threaded_collaboration_callbacks cb
      WHERE cb.kind='command' AND cb.source_id='command:'||c.id AND cb.owner_id=c.owner_id
        AND cb.thread_id=c.thread_id AND cb.agent_id=c.agent_id AND cb.state IN ('pending','waiting'))`)
    .run(Date.now());
}

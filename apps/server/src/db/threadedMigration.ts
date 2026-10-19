import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

/** Append-only catalog entry. Keep the descriptor stable after v25 ships. */
export const THREADED_FOUNDATION_MIGRATION = {
  version: 25,
  name: 'threaded-foundation-v1',
  descriptor: 'threaded-stable-instance-owner-v1;thread-conversation-unique-v1;member-owner-version-v1;invocation-attempt-foundation-v1;run-binding-unique-v1;no-executor-no-message-wake-v1',
} as const;

/** Runs inside the orchestration migration transaction, before its version is recorded. */
export function applyThreadedFoundationMigration(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('THREADED_MIGRATION_REQUIRES_TRANSACTION');
  db.exec(`
    CREATE TABLE IF NOT EXISTS threaded_instances (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      instance_owner_id TEXT NOT NULL UNIQUE CHECK(length(instance_owner_id)>0),
      schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version=1),
      created_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS threaded_instance_identity_immutable
      BEFORE UPDATE OF singleton,instance_owner_id ON threaded_instances
      BEGIN SELECT RAISE(ABORT,'THREADED_INSTANCE_IDENTITY_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_instance_delete_forbidden
      BEFORE DELETE ON threaded_instances
      BEGIN SELECT RAISE(ABORT,'THREADED_INSTANCE_IDENTITY_IMMUTABLE'); END;

    CREATE TABLE IF NOT EXISTS threaded_threads (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id),
      owner_id TEXT NOT NULL REFERENCES threaded_instances(instance_owner_id),
      mode TEXT NOT NULL DEFAULT 'threaded' CHECK(mode='threaded'),
      schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version=1),
      policy_version INTEGER NOT NULL DEFAULT 1 CHECK(policy_version>=1),
      authority_epoch INTEGER NOT NULL DEFAULT 1 CHECK(authority_epoch>=1),
      version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
      state TEXT NOT NULL DEFAULT 'closed' CHECK(state IN ('open','paused','closed','archived')),
      title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
      client_request_id TEXT,
      request_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(id,owner_id),
      UNIQUE(owner_id,client_request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_threaded_threads_owner ON threaded_threads(owner_id,created_at,id);
    CREATE TRIGGER IF NOT EXISTS threaded_thread_conversation_insert
      BEFORE INSERT ON threaded_threads
      WHEN NOT EXISTS (SELECT 1 FROM conversations WHERE id=NEW.conversation_id AND mode='threaded')
      BEGIN SELECT RAISE(ABORT,'THREADED_CONVERSATION_MODE_MISMATCH'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_thread_identity_immutable
      BEFORE UPDATE OF id,conversation_id,owner_id,mode ON threaded_threads
      BEGIN SELECT RAISE(ABORT,'THREADED_THREAD_IDENTITY_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_conversation_mode_immutable
      BEFORE UPDATE OF id,mode ON conversations
      WHEN EXISTS (SELECT 1 FROM threaded_threads WHERE conversation_id=OLD.id)
      BEGIN SELECT RAISE(ABORT,'THREADED_CONVERSATION_MODE_IMMUTABLE'); END;

    CREATE TABLE IF NOT EXISTS threaded_members (
      thread_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version=1),
      handle TEXT NOT NULL CHECK(length(trim(handle)) BETWEEN 1 AND 80),
      role_version INTEGER NOT NULL CHECK(role_version>=1),
      account_version INTEGER CHECK(account_version>=1),
      permission_version INTEGER NOT NULL CHECK(permission_version>=1),
      version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
      status TEXT NOT NULL DEFAULT 'joined' CHECK(status IN ('joined','left')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(thread_id,agent_id),
      UNIQUE(thread_id,handle),
      UNIQUE(thread_id,owner_id,agent_id),
      FOREIGN KEY(thread_id,owner_id) REFERENCES threaded_threads(id,owner_id)
    );
    CREATE TRIGGER IF NOT EXISTS threaded_member_identity_immutable
      BEFORE UPDATE OF thread_id,owner_id,agent_id,handle ON threaded_members
      BEGIN SELECT RAISE(ABORT,'THREADED_MEMBER_IDENTITY_IMMUTABLE'); END;

    CREATE TABLE IF NOT EXISTS threaded_invocations (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version=1),
      version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
      authority_epoch INTEGER NOT NULL CHECK(authority_epoch>=1),
      causal_root_id TEXT NOT NULL CHECK(length(causal_root_id)>0),
      wake_source_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK(status IN ('queued','running','waiting','unknown','completed','failed','cancelled')),
      current_attempt_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(id,thread_id,owner_id),
      UNIQUE(id,thread_id,owner_id,agent_id),
      FOREIGN KEY(thread_id,owner_id,agent_id) REFERENCES threaded_members(thread_id,owner_id,agent_id),
      FOREIGN KEY(current_attempt_id,id) REFERENCES threaded_attempts(id,invocation_id)
        DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX IF NOT EXISTS idx_threaded_invocations_slot ON threaded_invocations(thread_id,agent_id,status,created_at);
    CREATE TABLE IF NOT EXISTS threaded_attempts (
      id TEXT PRIMARY KEY,
      invocation_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version=1),
      attempt_no INTEGER NOT NULL CHECK(attempt_no>=1),
      version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
      generation INTEGER NOT NULL CHECK(generation>=1),
      authority_epoch INTEGER NOT NULL CHECK(authority_epoch>=1),
      claim_owner TEXT,
      status TEXT NOT NULL DEFAULT 'prepared'
        CHECK(status IN ('prepared','running','waiting','unknown','completed','failed','cancelled')),
      execution_stage TEXT NOT NULL DEFAULT 'not_started'
        CHECK(execution_stage IN ('not_started','prepared','started','unknown','quiescent')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(invocation_id,attempt_no),
      UNIQUE(id,invocation_id),
      FOREIGN KEY(invocation_id,thread_id,owner_id,agent_id)
        REFERENCES threaded_invocations(id,thread_id,owner_id,agent_id)
    );
    CREATE TRIGGER IF NOT EXISTS threaded_invocation_identity_immutable
      BEFORE UPDATE OF id,thread_id,owner_id,agent_id,causal_root_id ON threaded_invocations
      BEGIN SELECT RAISE(ABORT,'THREADED_INVOCATION_IDENTITY_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_attempt_identity_immutable
      BEFORE UPDATE OF id,invocation_id,thread_id,owner_id,agent_id,attempt_no ON threaded_attempts
      BEGIN SELECT RAISE(ABORT,'THREADED_ATTEMPT_IDENTITY_IMMUTABLE'); END;

    CREATE TABLE IF NOT EXISTS threaded_run_bindings (
      invocation_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
      thread_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version=1),
      mode TEXT NOT NULL DEFAULT 'threaded' CHECK(mode='threaded'),
      origin TEXT NOT NULL DEFAULT 'threaded_invocation_attempt' CHECK(origin='threaded_invocation_attempt'),
      created_at TEXT NOT NULL,
      FOREIGN KEY(invocation_id,thread_id,owner_id) REFERENCES threaded_invocations(id,thread_id,owner_id)
    );
    CREATE TRIGGER IF NOT EXISTS threaded_run_binding_scope_insert
      BEFORE INSERT ON threaded_run_bindings
      WHEN NOT EXISTS (
        SELECT 1 FROM runs r JOIN threaded_threads t ON t.id=NEW.thread_id
        WHERE r.id=NEW.run_id AND r.mode='threaded' AND r.conversation_id=t.conversation_id
          AND t.owner_id=NEW.owner_id
      )
      BEGIN SELECT RAISE(ABORT,'THREADED_RUN_BINDING_SCOPE_MISMATCH'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_run_binding_immutable
      BEFORE UPDATE ON threaded_run_bindings
      BEGIN SELECT RAISE(ABORT,'THREADED_RUN_BINDING_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_run_binding_delete_forbidden
      BEFORE DELETE ON threaded_run_bindings
      BEGIN SELECT RAISE(ABORT,'THREADED_RUN_BINDING_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_bound_run_scope_immutable
      BEFORE UPDATE OF id,mode,conversation_id ON runs
      WHEN EXISTS (SELECT 1 FROM threaded_run_bindings WHERE run_id=OLD.id)
      BEGIN SELECT RAISE(ABORT,'THREADED_RUN_BINDING_IMMUTABLE'); END;
  `);
  db.prepare(`INSERT OR IGNORE INTO threaded_instances(singleton,instance_owner_id,schema_version,created_at)
    VALUES(1,?,1,?)`).run(randomUUID(), new Date().toISOString());
}

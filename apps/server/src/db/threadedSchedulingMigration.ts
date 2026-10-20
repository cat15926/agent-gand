import type Database from 'better-sqlite3';
import { applyThreadedBudgetSchema } from './threadedBudgetSchema.ts';

export const THREADED_SCHEDULING_MIGRATION = {
  version: 29,
  name: 'threaded-scheduling-budget-v1',
  descriptor: 'durable-wake-fifo-v1;one-wake-one-invocation-v1;owner-resume-source-authorization-revisions-v1;atomic-resource-budget-attempt-run-dispatch-v1;fenced-dispatch-recovery-v1;causal-root-budget-v1;response-terminal-outbox-atomic-v1;isolated-executor-only-v1',
} as const;

export function applyThreadedSchedulingMigration(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('THREADED_MIGRATION_REQUIRES_TRANSACTION');
  applyThreadedBudgetSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS threaded_control_epoch_receipts (
      control_request_id TEXT PRIMARY KEY REFERENCES threaded_control_requests(id),
      thread_epoch INTEGER NOT NULL CHECK(thread_epoch>=1)
    );
    CREATE TRIGGER IF NOT EXISTS threaded_control_epoch_capture
      AFTER INSERT ON threaded_control_requests BEGIN
        INSERT INTO threaded_control_epoch_receipts(control_request_id,thread_epoch)
          SELECT NEW.id,authority_epoch FROM threaded_threads WHERE id=NEW.thread_id AND owner_id=NEW.owner_id;
      END;
    CREATE TRIGGER IF NOT EXISTS threaded_control_epoch_immutable
      BEFORE UPDATE ON threaded_control_epoch_receipts BEGIN SELECT RAISE(ABORT,'THREADED_CONTROL_EPOCH_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_control_epoch_retained
      BEFORE DELETE ON threaded_control_epoch_receipts BEGIN SELECT RAISE(ABORT,'THREADED_CONTROL_EPOCH_IMMUTABLE'); END;
    CREATE TABLE IF NOT EXISTS threaded_message_control_boundaries (
      message_id TEXT PRIMARY KEY REFERENCES threaded_messages(id), control_seq INTEGER NOT NULL CHECK(control_seq>=0)
    );
    CREATE TRIGGER IF NOT EXISTS threaded_message_control_capture
      AFTER INSERT ON threaded_messages BEGIN
        INSERT INTO threaded_message_control_boundaries(message_id,control_seq)
          SELECT NEW.id,COALESCE(MAX(rowid),0) FROM threaded_control_requests
            WHERE thread_id=NEW.thread_id AND owner_id=NEW.owner_id;
      END;
    INSERT OR IGNORE INTO threaded_message_control_boundaries(message_id,control_seq)
      SELECT m.id,COALESCE((SELECT MAX(c.rowid) FROM threaded_control_requests c
        WHERE c.thread_id=m.thread_id AND c.owner_id=m.owner_id AND c.created_at<m.created_at),0)
      FROM threaded_messages m;
    CREATE TRIGGER IF NOT EXISTS threaded_message_control_boundary_immutable
      BEFORE UPDATE ON threaded_message_control_boundaries BEGIN SELECT RAISE(ABORT,'THREADED_MESSAGE_CONTROL_BOUNDARY_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_message_control_boundary_retained
      BEFORE DELETE ON threaded_message_control_boundaries BEGIN SELECT RAISE(ABORT,'THREADED_MESSAGE_CONTROL_BOUNDARY_IMMUTABLE'); END;
    CREATE TABLE IF NOT EXISTS threaded_wake_queue (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL, thread_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      wake_id TEXT NOT NULL UNIQUE, source_message_id TEXT NOT NULL,
      wave_id TEXT NOT NULL, input_max_seq INTEGER NOT NULL CHECK(input_max_seq>=1), causal_root_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','blocked','claimed','unknown','settled','cancelled')),
      reason TEXT, version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
      invocation_id TEXT UNIQUE, ticket_id TEXT REFERENCES execution_resource_tickets(id),
      prepared_attempt_id TEXT, preparation TEXT,
      authorization_version INTEGER NOT NULL DEFAULT 0 CHECK(authorization_version>=0),
      generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
      available_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(id,owner_id,thread_id,agent_id),
      FOREIGN KEY(wake_id,thread_id,owner_id) REFERENCES threaded_wakes(id,thread_id,owner_id),
      FOREIGN KEY(source_message_id,thread_id,owner_id) REFERENCES threaded_messages(id,thread_id,owner_id),
      FOREIGN KEY(invocation_id,thread_id,owner_id,agent_id) REFERENCES threaded_invocations(id,thread_id,owner_id,agent_id)
    );
    CREATE INDEX IF NOT EXISTS threaded_queue_ready ON threaded_wake_queue(state,available_at,seq);
    CREATE TRIGGER IF NOT EXISTS threaded_queue_identity_immutable
      BEFORE UPDATE OF seq,id,owner_id,thread_id,agent_id,wake_id,source_message_id,wave_id,input_max_seq,causal_root_id,created_at
      ON threaded_wake_queue BEGIN SELECT RAISE(ABORT,'THREADED_QUEUE_IDENTITY_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_queue_versions_monotonic
      BEFORE UPDATE ON threaded_wake_queue
      WHEN NEW.version<=OLD.version OR NEW.authorization_version<OLD.authorization_version OR NEW.generation<OLD.generation
        OR (OLD.invocation_id IS NOT NULL AND NEW.invocation_id IS NOT OLD.invocation_id)
      BEGIN SELECT RAISE(ABORT,'THREADED_QUEUE_VERSION_MUST_INCREASE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_queue_retained
      BEFORE DELETE ON threaded_wake_queue BEGIN SELECT RAISE(ABORT,'THREADED_QUEUE_RETAINED'); END;
    CREATE TABLE IF NOT EXISTS threaded_invocation_wakes (
      invocation_id TEXT PRIMARY KEY, wake_id TEXT NOT NULL UNIQUE, queue_id TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL, thread_id TEXT NOT NULL, agent_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
      wave_id TEXT NOT NULL, input_max_seq INTEGER NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY(invocation_id,thread_id,owner_id,agent_id) REFERENCES threaded_invocations(id,thread_id,owner_id,agent_id),
      FOREIGN KEY(queue_id,owner_id,thread_id,agent_id) REFERENCES threaded_wake_queue(id,owner_id,thread_id,agent_id),
      FOREIGN KEY(wake_id,thread_id,owner_id) REFERENCES threaded_wakes(id,thread_id,owner_id),
      FOREIGN KEY(source_message_id,thread_id,owner_id) REFERENCES threaded_messages(id,thread_id,owner_id)
    );
    CREATE TRIGGER IF NOT EXISTS threaded_invocation_wake_immutable
      BEFORE UPDATE ON threaded_invocation_wakes BEGIN SELECT RAISE(ABORT,'THREADED_INVOCATION_WAKE_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_invocation_wake_retained
      BEFORE DELETE ON threaded_invocation_wakes BEGIN SELECT RAISE(ABORT,'THREADED_INVOCATION_WAKE_IMMUTABLE'); END;
    CREATE TABLE IF NOT EXISTS threaded_wake_authorizations (
      id TEXT PRIMARY KEY, queue_id TEXT NOT NULL, owner_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      agent_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>=1), thread_epoch INTEGER NOT NULL CHECK(thread_epoch>=1),
      identity_hash TEXT NOT NULL CHECK(length(identity_hash)=64), source_acl_hash TEXT NOT NULL CHECK(length(source_acl_hash)=64),
      record TEXT NOT NULL, control_request_id TEXT REFERENCES threaded_control_requests(id), created_at TEXT NOT NULL,
      UNIQUE(queue_id,version),
      FOREIGN KEY(queue_id,owner_id,thread_id,agent_id) REFERENCES threaded_wake_queue(id,owner_id,thread_id,agent_id)
    );
    CREATE TRIGGER IF NOT EXISTS threaded_wake_authorization_immutable
      BEFORE UPDATE ON threaded_wake_authorizations BEGIN SELECT RAISE(ABORT,'THREADED_WAKE_AUTHORIZATION_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_wake_authorization_retained
      BEFORE DELETE ON threaded_wake_authorizations BEGIN SELECT RAISE(ABORT,'THREADED_WAKE_AUTHORIZATION_IMMUTABLE'); END;
    CREATE TABLE IF NOT EXISTS threaded_queue_claims (
      id TEXT PRIMARY KEY, queue_id TEXT NOT NULL, owner_id TEXT NOT NULL, thread_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation>=1), worker_id TEXT NOT NULL, owner_nonce TEXT NOT NULL, fencing_token TEXT NOT NULL,
      invocation_id TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE, binding_id TEXT NOT NULL UNIQUE,
      budget_authorization_id TEXT NOT NULL UNIQUE,
      phase TEXT NOT NULL CHECK(phase IN ('prepared','started','unknown','settled')),
      lease_expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(queue_id,generation),
      FOREIGN KEY(queue_id,owner_id,thread_id,agent_id) REFERENCES threaded_wake_queue(id,owner_id,thread_id,agent_id),
      FOREIGN KEY(binding_id,attempt_id,invocation_id,thread_id,owner_id)
        REFERENCES threaded_execution_bindings(id,attempt_id,invocation_id,thread_id,owner_id),
      FOREIGN KEY(budget_authorization_id,owner_id,thread_id,invocation_id,attempt_id)
        REFERENCES threaded_budget_requests(id,owner_id,thread_id,invocation_id,attempt_id)
    );
    CREATE TRIGGER IF NOT EXISTS threaded_queue_claim_identity_immutable
      BEFORE UPDATE OF id,queue_id,owner_id,thread_id,agent_id,generation,worker_id,owner_nonce,fencing_token,
        invocation_id,attempt_id,binding_id,budget_authorization_id,created_at ON threaded_queue_claims
      BEGIN SELECT RAISE(ABORT,'THREADED_QUEUE_CLAIM_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_queue_claim_retained
      BEFORE DELETE ON threaded_queue_claims BEGIN SELECT RAISE(ABORT,'THREADED_QUEUE_CLAIM_RETAINED'); END;
    CREATE TABLE IF NOT EXISTS threaded_queue_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, queue_id TEXT NOT NULL REFERENCES threaded_wake_queue(id),
      reason TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS threaded_queue_event_immutable
      BEFORE UPDATE ON threaded_queue_events BEGIN SELECT RAISE(ABORT,'THREADED_QUEUE_EVENT_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_queue_event_retained
      BEFORE DELETE ON threaded_queue_events BEGIN SELECT RAISE(ABORT,'THREADED_QUEUE_EVENT_IMMUTABLE'); END;
  `);
}

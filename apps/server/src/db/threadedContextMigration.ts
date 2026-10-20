import type Database from 'better-sqlite3';
import { applyThreadedSessionContextSchema } from './threadedSessionContextSchema.ts';
import { applyThreadedBackendSchema } from './threadedBackendSchema.ts';

export const THREADED_CONTEXT_MIGRATION = {
  version: 30,
  name: 'threaded-context-session-v1',
  descriptor: 'immutable-acl-wave-context-manifests-v1;whole-item-budget-deferred-ledger-v1;exact-session-delivery-intent-receipt-v1;independent-delivery-seen-mention-cursors-v1;source-authorized-session-boundaries-v1;trusted-native-anchor-compaction-v1',
} as const;

export function applyThreadedContextMigration(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('THREADED_MIGRATION_REQUIRES_TRANSACTION');
  db.exec(`
    CREATE TABLE IF NOT EXISTS threaded_context_manifests (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, thread_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL, attempt_id TEXT NOT NULL, binding_id TEXT NOT NULL,
      session_id TEXT NOT NULL, session_version INTEGER NOT NULL,
      request_key TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
      payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64), record TEXT NOT NULL,
      payload TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(binding_id,request_key), UNIQUE(id,owner_id,thread_id,agent_id),
      FOREIGN KEY(binding_id,attempt_id,invocation_id,thread_id,owner_id)
        REFERENCES threaded_execution_bindings(id,attempt_id,invocation_id,thread_id,owner_id),
      FOREIGN KEY(session_id,session_version) REFERENCES execution_resource_session_versions(session_id,version)
    );
    CREATE TABLE IF NOT EXISTS threaded_context_manifest_items (
      manifest_id TEXT NOT NULL REFERENCES threaded_context_manifests(id),
      message_id TEXT NOT NULL REFERENCES threaded_messages(id), position INTEGER NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('included','deferred_budget','denied_acl','unpublished','already_delivered')),
      record TEXT NOT NULL, PRIMARY KEY(manifest_id,message_id), UNIQUE(manifest_id,position)
    );
    CREATE TABLE IF NOT EXISTS threaded_context_send_intents (
      id TEXT PRIMARY KEY, manifest_id TEXT NOT NULL REFERENCES threaded_context_manifests(id),
      binding_id TEXT NOT NULL REFERENCES threaded_execution_bindings(id),
      session_id TEXT NOT NULL, session_version INTEGER NOT NULL,
      request_key TEXT NOT NULL, payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
      status TEXT NOT NULL CHECK(status IN ('sending','delivered','unknown','not_sent')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(binding_id,request_key),
      FOREIGN KEY(session_id,session_version) REFERENCES execution_resource_session_versions(session_id,version)
    );
    CREATE INDEX IF NOT EXISTS threaded_context_unresolved_send
      ON threaded_context_send_intents(session_id,session_version,status);
    CREATE TRIGGER IF NOT EXISTS threaded_context_intent_identity_immutable
      BEFORE UPDATE OF id,manifest_id,binding_id,session_id,session_version,request_key,payload_hash,created_at
      ON threaded_context_send_intents BEGIN SELECT RAISE(ABORT,'THREADED_CONTEXT_INTENT_IMMUTABLE'); END;
    CREATE TABLE IF NOT EXISTS threaded_context_send_receipts (
      id TEXT PRIMARY KEY, intent_id TEXT NOT NULL REFERENCES threaded_context_send_intents(id),
      evidence_key TEXT NOT NULL, outcome_hash TEXT NOT NULL CHECK(length(outcome_hash)=64),
      status TEXT NOT NULL CHECK(status IN ('delivered','unknown','not_sent')),
      record TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(intent_id,evidence_key)
    );
    CREATE TABLE IF NOT EXISTS threaded_context_deliveries (
      receipt_id TEXT NOT NULL REFERENCES threaded_context_send_receipts(id),
      manifest_id TEXT NOT NULL REFERENCES threaded_context_manifests(id),
      message_id TEXT NOT NULL REFERENCES threaded_messages(id),
      owner_id TEXT NOT NULL, thread_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL, session_version INTEGER NOT NULL,
      message_hash TEXT NOT NULL CHECK(length(message_hash)=64),
      created_at TEXT NOT NULL, PRIMARY KEY(receipt_id,message_id),
      FOREIGN KEY(session_id,session_version) REFERENCES execution_resource_session_versions(session_id,version),
      FOREIGN KEY(manifest_id,owner_id,thread_id,agent_id)
        REFERENCES threaded_context_manifests(id,owner_id,thread_id,agent_id)
    );
    CREATE INDEX IF NOT EXISTS threaded_context_delivered_set
      ON threaded_context_deliveries(session_id,session_version,message_id,message_hash);
    CREATE TABLE IF NOT EXISTS threaded_context_cursor_facts (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, thread_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('delivery','seen','mention_ack')),
      message_id TEXT NOT NULL, message_seq INTEGER NOT NULL CHECK(message_seq>=1),
      binding_id TEXT NOT NULL REFERENCES threaded_execution_bindings(id),
      request_key TEXT NOT NULL, receipt_id TEXT REFERENCES threaded_context_send_receipts(id),
      created_at TEXT NOT NULL,
      UNIQUE(binding_id,kind,request_key,message_id),
      FOREIGN KEY(message_id,thread_id,owner_id) REFERENCES threaded_messages(id,thread_id,owner_id),
      FOREIGN KEY(thread_id,owner_id,agent_id) REFERENCES threaded_members(thread_id,owner_id,agent_id)
    );
    CREATE TABLE IF NOT EXISTS threaded_context_cursors (
      owner_id TEXT NOT NULL, thread_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('delivery','seen','mention_ack')),
      max_seq INTEGER NOT NULL CHECK(max_seq>=1), updated_at TEXT NOT NULL,
      PRIMARY KEY(owner_id,thread_id,agent_id,kind),
      FOREIGN KEY(thread_id,owner_id,agent_id) REFERENCES threaded_members(thread_id,owner_id,agent_id)
    );
    CREATE TRIGGER IF NOT EXISTS threaded_context_cursor_monotonic
      BEFORE UPDATE ON threaded_context_cursors
      WHEN NEW.owner_id IS NOT OLD.owner_id OR NEW.thread_id IS NOT OLD.thread_id
        OR NEW.agent_id IS NOT OLD.agent_id OR NEW.kind IS NOT OLD.kind OR NEW.max_seq<OLD.max_seq
      BEGIN SELECT RAISE(ABORT,'THREADED_CONTEXT_CURSOR_IMMUTABLE'); END;
  `);
  for (const table of ['threaded_context_manifests', 'threaded_context_manifest_items', 'threaded_context_send_receipts',
    'threaded_context_deliveries', 'threaded_context_cursor_facts']) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'THREADED_CONTEXT_FACT_IMMUTABLE'); END;`);
  }
  for (const table of ['threaded_context_manifests', 'threaded_context_manifest_items', 'threaded_context_send_intents',
    'threaded_context_send_receipts', 'threaded_context_deliveries', 'threaded_context_cursor_facts', 'threaded_context_cursors']) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_retained BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'THREADED_CONTEXT_FACT_RETAINED'); END;`);
  }
  applyThreadedSessionContextSchema(db);
  applyThreadedBackendSchema(db);
}

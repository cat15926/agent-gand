import type Database from 'better-sqlite3';

export const THREADED_MESSAGING_MIGRATION = {
  version: 28,
  name: 'threaded-messaging-ledger-v1',
  descriptor: 'immutable-authored-message-sequence-v1;origin-scoped-idempotency-v1;owned-inline-attachment-v1;atomic-message-delivery-wake-outbox-v1;frozen-wave-input-cutoff-v1;versioned-outbox-fence-consumer-receipt-v1;explicit-source-acl-v1;no-execution-dispatch-v1',
} as const;

export function applyThreadedMessagingMigration(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('THREADED_MIGRATION_REQUIRES_TRANSACTION');
  db.exec(`
    CREATE TABLE IF NOT EXISTS threaded_message_sequences (
      thread_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, last_seq INTEGER NOT NULL CHECK(last_seq>=0),
      FOREIGN KEY(thread_id,owner_id) REFERENCES threaded_threads(id,owner_id)
    );
    CREATE TRIGGER IF NOT EXISTS threaded_message_sequence_monotonic
      BEFORE UPDATE ON threaded_message_sequences
      WHEN NEW.thread_id<>OLD.thread_id OR NEW.owner_id<>OLD.owner_id OR NEW.last_seq<=OLD.last_seq
      BEGIN SELECT RAISE(ABORT,'THREADED_MESSAGE_SEQUENCE_MUST_INCREASE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_message_sequence_retained
      BEFORE DELETE ON threaded_message_sequences BEGIN SELECT RAISE(ABORT,'THREADED_MESSAGE_SEQUENCE_RETAINED'); END;
    CREATE TABLE IF NOT EXISTS threaded_messages (
      id TEXT PRIMARY KEY CHECK(length(id)>0), owner_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK(seq>=1), schema_version INTEGER NOT NULL CHECK(schema_version=1),
      origin TEXT NOT NULL CHECK(origin IN ('user','agent_post','agent_response','system')),
      state TEXT NOT NULL CHECK(state IN ('published','draft')),
      visibility TEXT NOT NULL CHECK(visibility IN ('public','private')),
      sender_kind TEXT NOT NULL CHECK(sender_kind IN ('user','agent','system')),
      sender_agent_id TEXT REFERENCES agents(id), system_key TEXT,
      source_thread_id TEXT, source_invocation_id TEXT, source_attempt_id TEXT, source_binding_id TEXT,
      request_scope TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
      body TEXT NOT NULL, body_hash TEXT NOT NULL CHECK(length(body_hash)=64),
      targets TEXT NOT NULL, audience TEXT NOT NULL, source_refs TEXT NOT NULL,
      causal_root_id TEXT NOT NULL, wave_id TEXT, input_max_seq INTEGER NOT NULL CHECK(input_max_seq=seq),
      authority_epoch INTEGER NOT NULL CHECK(authority_epoch>=1), record TEXT NOT NULL, receipt TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(thread_id,seq), UNIQUE(id,thread_id,owner_id), UNIQUE(owner_id,origin,request_scope,request_key),
      FOREIGN KEY(thread_id,owner_id) REFERENCES threaded_threads(id,owner_id),
      FOREIGN KEY(source_binding_id,source_attempt_id,source_invocation_id,source_thread_id,owner_id)
        REFERENCES threaded_execution_bindings(id,attempt_id,invocation_id,thread_id,owner_id),
      CHECK((origin='user' AND sender_kind='user' AND sender_agent_id IS NULL AND system_key IS NULL
          AND source_thread_id IS NULL AND source_invocation_id IS NULL AND source_attempt_id IS NULL AND source_binding_id IS NULL)
        OR (origin IN ('agent_post','agent_response') AND sender_kind='agent' AND sender_agent_id IS NOT NULL AND system_key IS NULL
          AND source_thread_id IS NOT NULL AND source_invocation_id IS NOT NULL AND source_attempt_id IS NOT NULL AND source_binding_id IS NOT NULL)
        OR (origin='system' AND sender_kind='system' AND system_key IS NOT NULL AND sender_agent_id IS NULL
          AND source_thread_id IS NULL AND source_invocation_id IS NULL AND source_attempt_id IS NULL AND source_binding_id IS NULL)),
      CHECK((state='published' AND wave_id IS NOT NULL) OR (state='draft' AND wave_id IS NULL))
    );
    CREATE INDEX IF NOT EXISTS threaded_message_attempt ON threaded_messages(source_attempt_id,origin);
    CREATE TRIGGER IF NOT EXISTS threaded_message_immutable
      BEFORE UPDATE ON threaded_messages BEGIN SELECT RAISE(ABORT,'THREADED_MESSAGE_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_message_retained
      BEFORE DELETE ON threaded_messages BEGIN SELECT RAISE(ABORT,'THREADED_MESSAGE_IMMUTABLE'); END;
    CREATE TABLE IF NOT EXISTS threaded_message_attachments (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, thread_id TEXT NOT NULL, owner_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK(position>=0), name TEXT NOT NULL, media_type TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK(byte_length>=0), content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
      content BLOB NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(message_id,position), FOREIGN KEY(message_id,thread_id,owner_id) REFERENCES threaded_messages(id,thread_id,owner_id),
      CHECK(length(content)=byte_length)
    );
    CREATE TRIGGER IF NOT EXISTS threaded_message_attachment_immutable
      BEFORE UPDATE ON threaded_message_attachments BEGIN SELECT RAISE(ABORT,'THREADED_ATTACHMENT_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_message_attachment_retained
      BEFORE DELETE ON threaded_message_attachments BEGIN SELECT RAISE(ABORT,'THREADED_ATTACHMENT_IMMUTABLE'); END;
    CREATE TABLE IF NOT EXISTS threaded_deliveries (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, thread_id TEXT NOT NULL, message_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK(schema_version=1), target_agent_id TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK(purpose='message'), routing_revision INTEGER NOT NULL CHECK(routing_revision=1),
      wave_id TEXT NOT NULL, input_max_seq INTEGER NOT NULL CHECK(input_max_seq>=1), record TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(message_id,target_agent_id,purpose,routing_revision), UNIQUE(id,message_id,thread_id,owner_id,target_agent_id),
      FOREIGN KEY(message_id,thread_id,owner_id) REFERENCES threaded_messages(id,thread_id,owner_id),
      FOREIGN KEY(thread_id,owner_id,target_agent_id) REFERENCES threaded_members(thread_id,owner_id,agent_id)
    );
    CREATE TRIGGER IF NOT EXISTS threaded_delivery_immutable
      BEFORE UPDATE ON threaded_deliveries BEGIN SELECT RAISE(ABORT,'THREADED_DELIVERY_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_delivery_retained
      BEFORE DELETE ON threaded_deliveries BEGIN SELECT RAISE(ABORT,'THREADED_DELIVERY_IMMUTABLE'); END;
    CREATE TABLE IF NOT EXISTS threaded_wakes (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, thread_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
      delivery_id TEXT NOT NULL UNIQUE, schema_version INTEGER NOT NULL CHECK(schema_version=1), target_agent_id TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK(purpose='message'), routing_revision INTEGER NOT NULL CHECK(routing_revision=1),
      wave_id TEXT NOT NULL, input_max_seq INTEGER NOT NULL CHECK(input_max_seq>=1), causal_root_id TEXT NOT NULL,
      authority_epoch INTEGER NOT NULL CHECK(authority_epoch>=1), target_member_version INTEGER NOT NULL CHECK(target_member_version>=1),
      target_permission_version INTEGER NOT NULL CHECK(target_permission_version>=1),
      status TEXT NOT NULL CHECK(status IN ('pending','blocked','cancelled')), version INTEGER NOT NULL CHECK(version>=1),
      available_at TEXT NOT NULL, record TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(source_message_id,target_agent_id,purpose,routing_revision), UNIQUE(id,thread_id,owner_id),
      FOREIGN KEY(source_message_id,thread_id,owner_id) REFERENCES threaded_messages(id,thread_id,owner_id),
      FOREIGN KEY(delivery_id,source_message_id,thread_id,owner_id,target_agent_id)
        REFERENCES threaded_deliveries(id,message_id,thread_id,owner_id,target_agent_id)
    );
    CREATE INDEX IF NOT EXISTS threaded_wake_pending ON threaded_wakes(status,thread_id,target_agent_id,input_max_seq);
    CREATE TRIGGER IF NOT EXISTS threaded_wake_identity_immutable
      BEFORE UPDATE OF id,owner_id,thread_id,source_message_id,delivery_id,schema_version,target_agent_id,purpose,routing_revision,wave_id,input_max_seq,
        causal_root_id,authority_epoch,target_member_version,target_permission_version,record,created_at ON threaded_wakes
      BEGIN SELECT RAISE(ABORT,'THREADED_WAKE_IDENTITY_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_wake_retained
      BEFORE DELETE ON threaded_wakes BEGIN SELECT RAISE(ABORT,'THREADED_WAKE_RETAINED'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_wake_version_monotonic
      BEFORE UPDATE ON threaded_wakes WHEN NEW.version<=OLD.version
      BEGIN SELECT RAISE(ABORT,'THREADED_WAKE_VERSION_MUST_INCREASE'); END;
    CREATE TABLE IF NOT EXISTS threaded_outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      event_type TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version>=1), source_id TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK(source_version>=1), authority_epoch INTEGER NOT NULL CHECK(authority_epoch>=1),
      dedupe_key TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
      status TEXT NOT NULL CHECK(status IN ('pending','claimed','acked','rejected')),
      generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0), claim_owner TEXT, owner_nonce TEXT, fencing_token TEXT,
      lease_expires_at TEXT, available_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
      last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, acked_at TEXT,
      UNIQUE(owner_id,dedupe_key), UNIQUE(id,owner_id,thread_id,source_id,source_version,event_type,authority_epoch),
      FOREIGN KEY(thread_id,owner_id) REFERENCES threaded_threads(id,owner_id)
    );
    CREATE INDEX IF NOT EXISTS threaded_outbox_pending ON threaded_outbox(status,available_at,seq);
    CREATE TRIGGER IF NOT EXISTS threaded_outbox_identity_immutable
      BEFORE UPDATE OF seq,id,owner_id,thread_id,event_type,schema_version,source_id,source_version,authority_epoch,dedupe_key,request_hash,created_at ON threaded_outbox
      BEGIN SELECT RAISE(ABORT,'THREADED_OUTBOX_IDENTITY_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_outbox_generation_monotonic
      BEFORE UPDATE OF generation ON threaded_outbox WHEN NEW.generation<OLD.generation
      BEGIN SELECT RAISE(ABORT,'THREADED_OUTBOX_GENERATION_MUST_NOT_DECREASE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_outbox_retained
      BEFORE DELETE ON threaded_outbox BEGIN SELECT RAISE(ABORT,'THREADED_OUTBOX_RETAINED'); END;
    CREATE TABLE IF NOT EXISTS threaded_outbox_receipts (
      outbox_id TEXT NOT NULL, consumer_id TEXT NOT NULL, owner_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      source_id TEXT NOT NULL, source_version INTEGER NOT NULL, event_type TEXT NOT NULL, authority_epoch INTEGER NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(outbox_id,consumer_id),
      UNIQUE(owner_id,consumer_id,event_type,source_id,source_version),
      FOREIGN KEY(outbox_id,owner_id,thread_id,source_id,source_version,event_type,authority_epoch)
        REFERENCES threaded_outbox(id,owner_id,thread_id,source_id,source_version,event_type,authority_epoch)
    );
    CREATE TRIGGER IF NOT EXISTS threaded_outbox_receipt_immutable
      BEFORE UPDATE ON threaded_outbox_receipts BEGIN SELECT RAISE(ABORT,'THREADED_OUTBOX_RECEIPT_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_outbox_receipt_retained
      BEFORE DELETE ON threaded_outbox_receipts BEGIN SELECT RAISE(ABORT,'THREADED_OUTBOX_RECEIPT_IMMUTABLE'); END;
  `);
}

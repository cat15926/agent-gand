import type Database from 'better-sqlite3';

/** Part of v30. Context tables must exist before this fragment is applied. */
export function applyThreadedSessionContextSchema(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('THREADED_MIGRATION_REQUIRES_TRANSACTION');
  db.exec(`
    CREATE TABLE IF NOT EXISTS threaded_session_context_versions (
      session_id TEXT NOT NULL, session_version INTEGER NOT NULL CHECK(session_version>=1),
      owner_id TEXT NOT NULL, thread_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      backend TEXT NOT NULL CHECK(backend IN ('api','claude-sdk')),
      boundary_version INTEGER NOT NULL CHECK(boundary_version>=1),
      base_boundary TEXT NOT NULL, effective_boundary TEXT NOT NULL,
      policy_hash TEXT NOT NULL CHECK(length(policy_hash)=64), boundary_sources TEXT NOT NULL,
      reason TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(session_id,session_version),
      UNIQUE(session_id,session_version,owner_id,thread_id,agent_id),
      FOREIGN KEY(session_id,session_version) REFERENCES execution_resource_session_versions(session_id,version),
      FOREIGN KEY(thread_id,owner_id,agent_id) REFERENCES threaded_members(thread_id,owner_id,agent_id)
    );
    CREATE TABLE IF NOT EXISTS threaded_session_input_intents (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL, thread_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL, session_version INTEGER NOT NULL,
      manifest_id TEXT NOT NULL, binding_id TEXT NOT NULL,
      request_id TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
      payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64), source_message_ids TEXT NOT NULL,
      record TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(binding_id,request_id), UNIQUE(id,session_id,session_version),
      FOREIGN KEY(session_id,session_version,owner_id,thread_id,agent_id)
        REFERENCES threaded_session_context_versions(session_id,session_version,owner_id,thread_id,agent_id),
      FOREIGN KEY(manifest_id,owner_id,thread_id,agent_id)
        REFERENCES threaded_context_manifests(id,owner_id,thread_id,agent_id),
      FOREIGN KEY(binding_id) REFERENCES threaded_execution_bindings(id)
    );
    CREATE TABLE IF NOT EXISTS threaded_session_context_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL, thread_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL, session_version INTEGER NOT NULL,
      manifest_id TEXT NOT NULL, binding_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('seal','compaction')), request_id TEXT NOT NULL,
      request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
      record TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(binding_id,request_id),
      FOREIGN KEY(session_id,session_version,owner_id,thread_id,agent_id)
        REFERENCES threaded_session_context_versions(session_id,session_version,owner_id,thread_id,agent_id),
      FOREIGN KEY(manifest_id,owner_id,thread_id,agent_id)
        REFERENCES threaded_context_manifests(id,owner_id,thread_id,agent_id),
      FOREIGN KEY(binding_id) REFERENCES threaded_execution_bindings(id)
    );
    CREATE TABLE IF NOT EXISTS threaded_session_anchors (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL, thread_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL, session_version INTEGER NOT NULL,
      manifest_id TEXT NOT NULL, binding_id TEXT NOT NULL,
      request_id TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
      input_intent_seq INTEGER NOT NULL CHECK(input_intent_seq>=1),
      compaction_seq INTEGER NOT NULL CHECK(compaction_seq>=0),
      record TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(binding_id,request_id),
      FOREIGN KEY(session_id,session_version,owner_id,thread_id,agent_id)
        REFERENCES threaded_session_context_versions(session_id,session_version,owner_id,thread_id,agent_id),
      FOREIGN KEY(manifest_id,owner_id,thread_id,agent_id)
        REFERENCES threaded_context_manifests(id,owner_id,thread_id,agent_id),
      FOREIGN KEY(binding_id) REFERENCES threaded_execution_bindings(id)
    );
  `);
  for (const table of ['threaded_session_context_versions', 'threaded_session_input_intents',
    'threaded_session_context_events', 'threaded_session_anchors']) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'THREADED_SESSION_CONTEXT_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_retained BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'THREADED_SESSION_CONTEXT_RETAINED'); END;`);
  }
  for (const table of ['threaded_session_input_intents', 'threaded_session_context_events', 'threaded_session_anchors']) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_scope BEFORE INSERT ON ${table}
      WHEN NOT EXISTS (SELECT 1 FROM threaded_context_manifests m WHERE m.id=NEW.manifest_id
        AND m.binding_id=NEW.binding_id AND m.session_id=NEW.session_id AND m.session_version=NEW.session_version
        AND m.owner_id=NEW.owner_id AND m.thread_id=NEW.thread_id AND m.agent_id=NEW.agent_id)
      BEGIN SELECT RAISE(ABORT,'THREADED_SESSION_CONTEXT_SCOPE_MISMATCH'); END;`);
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS threaded_session_anchor_evidence_scope BEFORE INSERT ON threaded_session_anchors
    WHEN NOT EXISTS (SELECT 1 FROM threaded_session_input_intents i WHERE i.seq=NEW.input_intent_seq
      AND i.session_id=NEW.session_id AND i.session_version=NEW.session_version
      AND i.binding_id=NEW.binding_id AND i.manifest_id=NEW.manifest_id)
    OR (NEW.compaction_seq>0 AND NOT EXISTS (SELECT 1 FROM threaded_session_context_events e
      WHERE e.seq=NEW.compaction_seq AND e.kind='compaction'
        AND e.session_id=NEW.session_id AND e.session_version=NEW.session_version))
    BEGIN SELECT RAISE(ABORT,'THREADED_SESSION_CONTEXT_EVIDENCE_MISMATCH'); END;`);
}

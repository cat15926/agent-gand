import type Database from 'better-sqlite3';

export const THREADED_COLLABORATION_MIGRATION = {
  version: 31, name: 'threaded-collaboration-v1',
  descriptor: 'trusted-routing-policy-preview-admission-v1;durable-causal-pingpong-v1;attempt-tool-receipts-v1;multi-mention-target-first-response-settlement-outbox-v1;nonblocking-hold-tracking-decision-versioned-wait-v1',
} as const;

export function applyThreadedCollaborationMigration(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('THREADED_MIGRATION_REQUIRES_TRANSACTION');
  db.exec(`
    CREATE TABLE IF NOT EXISTS threaded_routing_policies (
      thread_id TEXT PRIMARY KEY REFERENCES threaded_threads(id), owner_id TEXT NOT NULL,
      version INTEGER NOT NULL, record TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threaded_callback_lineage (
      message_id TEXT PRIMARY KEY REFERENCES threaded_messages(id),
      parent_invocation_id TEXT NOT NULL REFERENCES threaded_invocations(id)
    );
    CREATE TRIGGER IF NOT EXISTS threaded_callback_lineage_scope BEFORE INSERT ON threaded_callback_lineage
      WHEN NOT EXISTS(SELECT 1 FROM threaded_messages m JOIN threaded_invocations i ON i.id=NEW.parent_invocation_id
        WHERE m.id=NEW.message_id AND m.owner_id=i.owner_id AND m.causal_root_id=i.causal_root_id
          AND (m.origin='system' OR (m.origin='user' AND EXISTS(SELECT 1 FROM threaded_waits w
            WHERE w.parent_invocation_id=i.id AND w.owner_id=m.owner_id AND w.thread_id=m.thread_id
              AND w.kind='decision' AND w.state='awaiting'))))
      BEGIN SELECT RAISE(ABORT,'THREADED_CALLBACK_LINEAGE_SCOPE'); END;
    CREATE TABLE IF NOT EXISTS threaded_message_routes (
      message_id TEXT PRIMARY KEY REFERENCES threaded_messages(id), owner_id TEXT NOT NULL,
      thread_id TEXT NOT NULL, kind TEXT NOT NULL, strategy TEXT NOT NULL,
      targets TEXT NOT NULL, record TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threaded_user_route_requests (
      owner_id TEXT NOT NULL, thread_id TEXT NOT NULL, request_key TEXT NOT NULL,
      request_hash TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES threaded_messages(id),
      record TEXT NOT NULL, PRIMARY KEY(owner_id,thread_id,request_key)
    );
    CREATE TABLE IF NOT EXISTS threaded_route_completions (
      source_message_id TEXT NOT NULL REFERENCES threaded_messages(id), agent_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL REFERENCES threaded_invocations(id), status TEXT NOT NULL,
      PRIMARY KEY(source_message_id,agent_id)
    );
    CREATE TABLE IF NOT EXISTS threaded_tool_receipts (
      binding_id TEXT NOT NULL REFERENCES threaded_execution_bindings(id), request_key TEXT NOT NULL,
      name TEXT NOT NULL, request_hash TEXT NOT NULL, record TEXT NOT NULL, substantive INTEGER NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY(binding_id,request_key)
    );
    CREATE TABLE IF NOT EXISTS threaded_tool_context_exposures (
      binding_id TEXT NOT NULL, request_key TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES threaded_messages(id),
      session_id TEXT NOT NULL, session_version INTEGER NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(binding_id,request_key,message_id),
      FOREIGN KEY(binding_id,request_key) REFERENCES threaded_tool_receipts(binding_id,request_key),
      FOREIGN KEY(session_id,session_version) REFERENCES execution_resource_session_versions(session_id,version)
    );
    CREATE TRIGGER IF NOT EXISTS threaded_tool_context_scope BEFORE INSERT ON threaded_tool_context_exposures
      WHEN NOT EXISTS(SELECT 1 FROM threaded_context_manifests m WHERE m.binding_id=NEW.binding_id
        AND m.session_id=NEW.session_id AND m.session_version=NEW.session_version)
      BEGIN SELECT RAISE(ABORT,'THREADED_TOOL_CONTEXT_SCOPE'); END;
    CREATE TABLE IF NOT EXISTS threaded_relay_events (
      message_id TEXT PRIMARY KEY REFERENCES threaded_messages(id), root_id TEXT NOT NULL,
      thread_id TEXT NOT NULL, reset_seq INTEGER NOT NULL, pair TEXT, streak INTEGER NOT NULL,
      warning INTEGER NOT NULL, blocked INTEGER NOT NULL, record TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threaded_consultations (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      binding_id TEXT NOT NULL REFERENCES threaded_execution_bindings(id), caller_id TEXT NOT NULL,
      parent_invocation_id TEXT NOT NULL REFERENCES threaded_invocations(id), root_id TEXT NOT NULL,
      request_key TEXT NOT NULL, request_hash TEXT NOT NULL, callback_to TEXT NOT NULL,
      deadline INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('collecting','settled')),
      version INTEGER NOT NULL, record TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(binding_id,request_key)
    );
    CREATE TABLE IF NOT EXISTS threaded_consultation_targets (
      group_id TEXT NOT NULL REFERENCES threaded_consultations(id), agent_id TEXT NOT NULL,
      question_message_id TEXT NOT NULL REFERENCES threaded_messages(id),
      response_message_id TEXT REFERENCES threaded_messages(id),
      status TEXT NOT NULL CHECK(status IN ('pending','responded','failed','cancelled','timeout')),
      PRIMARY KEY(group_id,agent_id)
    );
    CREATE TABLE IF NOT EXISTS threaded_consultation_settlements (
      group_id TEXT PRIMARY KEY REFERENCES threaded_consultations(id), kind TEXT NOT NULL,
      record TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threaded_collaboration_callbacks (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, source_id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL,
      thread_id TEXT NOT NULL, agent_id TEXT NOT NULL, parent_invocation_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','waiting','delivered','rejected','cancelled')),
      reason TEXT, record TEXT NOT NULL, message_id TEXT REFERENCES threaded_messages(id),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threaded_waits (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, thread_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      binding_id TEXT NOT NULL REFERENCES threaded_execution_bindings(id),
      parent_invocation_id TEXT NOT NULL REFERENCES threaded_invocations(id), root_id TEXT NOT NULL,
      job_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('timer','tracking','decision')),
      request_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('awaiting','settled','withdrawn','superseded')),
      version INTEGER NOT NULL, deadline INTEGER, record TEXT NOT NULL, outcome TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(owner_id,thread_id,agent_id,job_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS threaded_decision_once ON threaded_waits(owner_id,thread_id,agent_id)
      WHERE kind='decision' AND state='awaiting';
    CREATE TABLE IF NOT EXISTS threaded_hold_quota (
      wait_id TEXT PRIMARY KEY REFERENCES threaded_waits(id), owner_id TEXT NOT NULL,
      thread_id TEXT NOT NULL, agent_id TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threaded_wait_operations (
      wait_id TEXT NOT NULL REFERENCES threaded_waits(id), operation_id TEXT NOT NULL,
      request_hash TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(wait_id,operation_id)
    );
    CREATE TABLE IF NOT EXISTS threaded_decision_responses (
      message_id TEXT PRIMARY KEY REFERENCES threaded_messages(id), wait_id TEXT NOT NULL REFERENCES threaded_waits(id),
      revision INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threaded_tracking_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, source TEXT NOT NULL,
      subject TEXT NOT NULL, event_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      record TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(owner_id,source,subject,event_key)
    );
    CREATE INDEX IF NOT EXISTS threaded_tracking_subject ON threaded_tracking_events(owner_id,source,subject,seq);
    CREATE TRIGGER IF NOT EXISTS threaded_consultation_identity_immutable
      BEFORE UPDATE OF id,owner_id,thread_id,binding_id,caller_id,parent_invocation_id,root_id,request_key,request_hash,callback_to,deadline,record,created_at
      ON threaded_consultations BEGIN SELECT RAISE(ABORT,'THREADED_CONSULTATION_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_consultation_transition BEFORE UPDATE ON threaded_consultations
      WHEN OLD.state<>'collecting' OR NEW.state<>'settled' OR NEW.version<>OLD.version+1
      BEGIN SELECT RAISE(ABORT,'THREADED_CONSULTATION_TRANSITION'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_consultation_target_identity
      BEFORE UPDATE OF group_id,agent_id,question_message_id ON threaded_consultation_targets
      BEGIN SELECT RAISE(ABORT,'THREADED_CONSULTATION_TARGET_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_consultation_target_transition BEFORE UPDATE ON threaded_consultation_targets
      WHEN OLD.status<>'pending' OR NEW.status='pending'
        OR (NEW.status='responded')<>(NEW.response_message_id IS NOT NULL)
      BEGIN SELECT RAISE(ABORT,'THREADED_CONSULTATION_TARGET_TRANSITION'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_wait_identity_immutable
      BEFORE UPDATE OF id,owner_id,thread_id,agent_id,binding_id,parent_invocation_id,root_id,job_key,kind,request_hash,deadline,record,created_at
      ON threaded_waits BEGIN SELECT RAISE(ABORT,'THREADED_WAIT_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_wait_transition BEFORE UPDATE ON threaded_waits
      WHEN OLD.state<>'awaiting' OR NEW.state NOT IN ('settled','withdrawn','superseded') OR NEW.version<>OLD.version+1
      BEGIN SELECT RAISE(ABORT,'THREADED_WAIT_TRANSITION'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_callback_identity_immutable
      BEFORE UPDATE OF id,kind,source_id,owner_id,thread_id,agent_id,parent_invocation_id,record,created_at
      ON threaded_collaboration_callbacks BEGIN SELECT RAISE(ABORT,'THREADED_CALLBACK_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_callback_terminal_immutable BEFORE UPDATE ON threaded_collaboration_callbacks
      WHEN OLD.state IN ('delivered','rejected','cancelled')
      BEGIN SELECT RAISE(ABORT,'THREADED_CALLBACK_TERMINAL'); END;
  `);
  for (const table of ['threaded_tool_context_exposures','threaded_callback_lineage','threaded_user_route_requests','threaded_message_routes','threaded_route_completions','threaded_tool_receipts',
    'threaded_relay_events','threaded_consultation_settlements','threaded_hold_quota',
    'threaded_wait_operations','threaded_decision_responses','threaded_tracking_events']) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'THREADED_COLLABORATION_FACT_IMMUTABLE'); END;`);
  }
  for (const table of ['threaded_tool_context_exposures','threaded_callback_lineage','threaded_user_route_requests','threaded_message_routes','threaded_route_completions','threaded_tool_receipts',
    'threaded_relay_events','threaded_consultations','threaded_consultation_targets','threaded_consultation_settlements',
    'threaded_collaboration_callbacks','threaded_waits','threaded_hold_quota','threaded_wait_operations',
    'threaded_decision_responses','threaded_tracking_events']) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_retained BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'THREADED_COLLABORATION_FACT_RETAINED'); END;`);
  }
}

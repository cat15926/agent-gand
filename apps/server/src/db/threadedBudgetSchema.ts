import type Database from 'better-sqlite3';

/** The v29 scheduling migration owns the version; this fragment shares its outer transaction. */
export function applyThreadedBudgetSchema(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('THREADED_BUDGET_SCHEMA_REQUIRES_TRANSACTION');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS threaded_budget_attempt_scope_ref
      ON threaded_attempts(id,invocation_id,thread_id,owner_id);
    CREATE TABLE IF NOT EXISTS threaded_budget_roots (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, home_thread_id TEXT NOT NULL,
      current_version INTEGER NOT NULL CHECK(current_version>=1),
      state TEXT NOT NULL CHECK(state IN ('open','paused')), created_at INTEGER NOT NULL,
      UNIQUE(id,owner_id),
      FOREIGN KEY(id,home_thread_id,owner_id) REFERENCES threaded_messages(id,thread_id,owner_id)
    );
    CREATE TABLE IF NOT EXISTS threaded_budget_versions (
      root_id TEXT NOT NULL, owner_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>=1),
      policy TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('open','paused')),
      request_id TEXT NOT NULL, request_hash TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(root_id,version), UNIQUE(owner_id,request_id),
      FOREIGN KEY(root_id,owner_id) REFERENCES threaded_budget_roots(id,owner_id)
    );
    CREATE TABLE IF NOT EXISTS threaded_budget_invocations (
      invocation_id TEXT PRIMARY KEY, root_id TEXT NOT NULL, owner_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL, a2a_depth INTEGER NOT NULL CHECK(a2a_depth>=0),
      policy_version INTEGER NOT NULL, admitted_at INTEGER NOT NULL,
      FOREIGN KEY(invocation_id,thread_id,owner_id) REFERENCES threaded_invocations(id,thread_id,owner_id),
      FOREIGN KEY(source_message_id,thread_id,owner_id) REFERENCES threaded_messages(id,thread_id,owner_id),
      FOREIGN KEY(root_id,owner_id) REFERENCES threaded_budget_roots(id,owner_id),
      FOREIGN KEY(root_id,policy_version) REFERENCES threaded_budget_versions(root_id,version)
    );
    CREATE TABLE IF NOT EXISTS threaded_budget_attempts (
      attempt_id TEXT PRIMARY KEY, invocation_id TEXT NOT NULL, root_id TEXT NOT NULL,
      owner_id TEXT NOT NULL, thread_id TEXT NOT NULL, attempt_no INTEGER NOT NULL CHECK(attempt_no>=1),
      reserved_activity_ms INTEGER NOT NULL CHECK(reserved_activity_ms>=0),
      activity_valid_until INTEGER, admitted_at INTEGER NOT NULL,
      UNIQUE(invocation_id,attempt_no),
      FOREIGN KEY(invocation_id) REFERENCES threaded_budget_invocations(invocation_id),
      FOREIGN KEY(attempt_id,invocation_id,thread_id,owner_id)
        REFERENCES threaded_attempts(id,invocation_id,thread_id,owner_id) DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(root_id,owner_id) REFERENCES threaded_budget_roots(id,owner_id)
    );
    CREATE TABLE IF NOT EXISTS threaded_budget_requests (
      id TEXT PRIMARY KEY, root_id TEXT NOT NULL, owner_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL, attempt_id TEXT NOT NULL, request_key TEXT NOT NULL,
      request_hash TEXT NOT NULL, policy_version INTEGER NOT NULL,
      claim_id TEXT NOT NULL, generation INTEGER NOT NULL, fencing_token TEXT NOT NULL, claim_owner TEXT NOT NULL,
      reserved_output INTEGER NOT NULL CHECK(reserved_output>=1),
      reserved_cost INTEGER NOT NULL CHECK(reserved_cost>=0), pricing_reference TEXT,
      known_output INTEGER CHECK(known_output>=0), known_cost INTEGER CHECK(known_cost>=0),
      execution_state TEXT NOT NULL CHECK(execution_state IN ('reserved','started','quiescent','unknown','not_started')),
      usage_state TEXT NOT NULL CHECK(usage_state IN ('reserved','settled','unknown')),
      outcome_hash TEXT, outcome_kind TEXT, evidence_reference TEXT, created_at INTEGER NOT NULL, started_at INTEGER, settled_at INTEGER,
      UNIQUE(attempt_id,request_key), UNIQUE(id,owner_id,thread_id,invocation_id,attempt_id),
      FOREIGN KEY(attempt_id) REFERENCES threaded_budget_attempts(attempt_id) DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(root_id,owner_id) REFERENCES threaded_budget_roots(id,owner_id),
      FOREIGN KEY(root_id,policy_version) REFERENCES threaded_budget_versions(root_id,version)
    );
    CREATE INDEX IF NOT EXISTS threaded_budget_request_owner_window ON threaded_budget_requests(owner_id,started_at,usage_state);
    CREATE TABLE IF NOT EXISTS threaded_budget_activity (
      id TEXT PRIMARY KEY, root_id TEXT NOT NULL, owner_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
      authorization_id TEXT NOT NULL, operation_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('model','tool')),
      started_at INTEGER NOT NULL, observed_at INTEGER NOT NULL, ended_at INTEGER,
      state TEXT NOT NULL CHECK(state IN ('active','unknown','closed')),
      UNIQUE(attempt_id,operation_key),
      FOREIGN KEY(attempt_id) REFERENCES threaded_budget_attempts(attempt_id),
      FOREIGN KEY(authorization_id) REFERENCES threaded_budget_requests(id),
      CHECK(observed_at>=started_at), CHECK(ended_at IS NULL OR ended_at>=started_at),
      CHECK((state='closed' AND ended_at IS NOT NULL) OR (state<>'closed' AND ended_at IS NULL))
    );
    CREATE TABLE IF NOT EXISTS threaded_budget_reconciliations (
      authorization_id TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      evidence_reference TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(authorization_id,request_id),
      FOREIGN KEY(authorization_id) REFERENCES threaded_budget_requests(id)
    );
    CREATE TABLE IF NOT EXISTS threaded_budget_outcomes (
      authorization_id TEXT NOT NULL, outcome_hash TEXT NOT NULL, kind TEXT NOT NULL, record TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY(authorization_id,outcome_hash),
      FOREIGN KEY(authorization_id) REFERENCES threaded_budget_requests(id)
    );
    CREATE TABLE IF NOT EXISTS threaded_owner_budget_versions (
      owner_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>=1),
      policy TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, reason TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY(owner_id,version), UNIQUE(owner_id,request_id),
      FOREIGN KEY(owner_id) REFERENCES threaded_instances(instance_owner_id)
    );
    CREATE TRIGGER IF NOT EXISTS threaded_budget_root_identity BEFORE UPDATE OF id,owner_id,home_thread_id,created_at
      ON threaded_budget_roots BEGIN SELECT RAISE(ABORT,'THREADED_BUDGET_IDENTITY_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_budget_request_identity BEFORE UPDATE OF id,root_id,owner_id,thread_id,
      invocation_id,attempt_id,request_key,request_hash,policy_version,claim_id,generation,fencing_token,claim_owner,
      reserved_output,reserved_cost,pricing_reference,created_at ON threaded_budget_requests
      BEGIN SELECT RAISE(ABORT,'THREADED_BUDGET_IDENTITY_IMMUTABLE'); END;
  `);
  // These facts are historical charges and decisions, not mutable cache projections.
  for (const table of ['threaded_budget_versions', 'threaded_budget_invocations', 'threaded_budget_reconciliations',
    'threaded_budget_outcomes', 'threaded_owner_budget_versions']) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'THREADED_BUDGET_FACT_IMMUTABLE'); END;`);
  }
  for (const table of ['threaded_budget_roots', 'threaded_budget_versions', 'threaded_budget_invocations',
    'threaded_budget_attempts', 'threaded_budget_requests', 'threaded_budget_activity',
    'threaded_budget_reconciliations', 'threaded_budget_outcomes', 'threaded_owner_budget_versions']) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_retained BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'THREADED_BUDGET_FACT_RETAINED'); END;`);
  }
}

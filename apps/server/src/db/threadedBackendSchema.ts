import type Database from 'better-sqlite3';

export function applyThreadedBackendSchema(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('THREADED_BACKEND_SCHEMA_TRANSACTION_REQUIRED');
  db.exec(`
    CREATE TABLE IF NOT EXISTS threaded_backend_requests (
      id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, authorization_id TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL, thread_id TEXT NOT NULL, invocation_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
      claim_id TEXT NOT NULL, generation INTEGER NOT NULL, fencing_token TEXT NOT NULL,
      backend TEXT NOT NULL CHECK(backend IN ('api','claude-sdk')), request_key TEXT NOT NULL,
      manifest_id TEXT NOT NULL, payload_hash TEXT NOT NULL, request_hash TEXT NOT NULL,
      native_id TEXT, session_version INTEGER NOT NULL, backend_version TEXT NOT NULL,
      model TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('sending','complete','unknown')),
      payload_included INTEGER NOT NULL CHECK(payload_included IN (0,1)),
      delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0,1)),
      input_tokens INTEGER, output_tokens INTEGER, cost_microusd INTEGER, response_id TEXT,
      created_at INTEGER NOT NULL, settled_at INTEGER,
      UNIQUE(binding_id,request_key),
      FOREIGN KEY(binding_id) REFERENCES threaded_execution_bindings(id),
      FOREIGN KEY(authorization_id,owner_id,thread_id,invocation_id,attempt_id)
        REFERENCES threaded_budget_requests(id,owner_id,thread_id,invocation_id,attempt_id),
      CHECK(input_tokens IS NULL OR input_tokens>=0), CHECK(output_tokens IS NULL OR output_tokens>=0),
      CHECK(cost_microusd IS NULL OR cost_microusd>=0)
    );
    CREATE TABLE IF NOT EXISTS threaded_backend_processes (
      token TEXT PRIMARY KEY, binding_id TEXT NOT NULL, host TEXT NOT NULL, pid INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('registered','closed','verified_stopped')),
      created_at INTEGER NOT NULL, stopped_at INTEGER,
      FOREIGN KEY(binding_id) REFERENCES threaded_execution_bindings(id)
    );
    CREATE TABLE IF NOT EXISTS threaded_backend_quiescence (
      id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, claim_id TEXT NOT NULL, generation INTEGER NOT NULL,
      fencing_token TEXT NOT NULL, reason TEXT NOT NULL CHECK(reason IN ('not_started','process_exited','reconciled')),
      side_effects TEXT NOT NULL CHECK(side_effects IN ('none','reconciled')),
      request_count INTEGER NOT NULL, process_count INTEGER NOT NULL, created_at INTEGER NOT NULL,
      FOREIGN KEY(binding_id) REFERENCES threaded_execution_bindings(id)
    );
    CREATE TABLE IF NOT EXISTS threaded_backend_native_events (
      id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, manifest_id TEXT NOT NULL, native_id TEXT NOT NULL,
      backend_version TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('anchor','compact')),
      record TEXT NOT NULL, created_at INTEGER NOT NULL,
      FOREIGN KEY(binding_id) REFERENCES threaded_execution_bindings(id)
    );
    CREATE TRIGGER IF NOT EXISTS threaded_backend_request_identity BEFORE UPDATE OF id,binding_id,authorization_id,
      owner_id,thread_id,invocation_id,attempt_id,claim_id,generation,fencing_token,backend,request_key,manifest_id,
      payload_hash,request_hash,native_id,session_version,backend_version,model,payload_included,created_at
      ON threaded_backend_requests BEGIN SELECT RAISE(ABORT,'THREADED_BACKEND_IDENTITY_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_backend_receipt_immutable BEFORE UPDATE ON threaded_backend_requests
      WHEN OLD.state<>'sending' BEGIN SELECT RAISE(ABORT,'THREADED_BACKEND_RECEIPT_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_backend_quiescence_immutable BEFORE UPDATE ON threaded_backend_quiescence
      BEGIN SELECT RAISE(ABORT,'THREADED_BACKEND_RECEIPT_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_backend_native_event_immutable BEFORE UPDATE ON threaded_backend_native_events
      BEGIN SELECT RAISE(ABORT,'THREADED_BACKEND_RECEIPT_IMMUTABLE'); END;
  `);
  for (const table of ['threaded_backend_requests', 'threaded_backend_processes', 'threaded_backend_quiescence','threaded_backend_native_events']) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_retained BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'THREADED_BACKEND_RECEIPT_RETAINED'); END;`);
  }
}

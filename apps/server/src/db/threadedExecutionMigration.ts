import type Database from 'better-sqlite3';

/** Append-only successor to the shipped v25 foundation. */
export const THREADED_EXECUTION_MIGRATION = {
  version: 26,
  name: 'threaded-execution-boundary-v1',
  descriptor: 'threaded-trusted-binding-snapshot-v1;invocation-unique-run-attempt-retry-v1;scoped-control-approval-v1;immutable-output-terminal-proof-v1;durable-quiescent-release-receipt-v1;default-deny-resource-port-v1;no-production-executor-v1',
} as const;

export function applyThreadedExecutionMigration(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('THREADED_MIGRATION_REQUIRES_TRANSACTION');
  const add = (table: string, name: string, definition: string) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  };
  add('threaded_invocations', 'goal', "TEXT NOT NULL DEFAULT ''");
  add('threaded_invocations', 'pause_requested', 'INTEGER NOT NULL DEFAULT 0 CHECK(pause_requested IN (0,1))');
  add('threaded_invocations', 'cancel_requested', 'INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1))');
  add('threaded_invocations', 'recovery_reason', 'TEXT');
  add('threaded_invocations', 'account_id', 'TEXT REFERENCES accounts(id)');
  add('threaded_invocations', 'account_identity_generation', 'INTEGER CHECK(account_identity_generation>=1)');
  add('threaded_invocations', 'client_request_id', 'TEXT');
  add('threaded_invocations', 'request_hash', 'TEXT');
  add('threaded_invocations', 'reserved_run_id', 'TEXT');
  add('threaded_attempts', 'claim_id', 'TEXT');
  add('threaded_attempts', 'fencing_token', 'TEXT');
  add('threaded_attempts', 'execution_reason', 'TEXT');
  add('threaded_attempts', 'outcome_record', 'TEXT');
  add('threaded_attempts', 'resource_release_state', "TEXT CHECK(resource_release_state IN ('pending','released'))");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS threaded_invocation_request ON threaded_invocations(owner_id,client_request_id);
    CREATE UNIQUE INDEX IF NOT EXISTS threaded_invocation_reserved_run ON threaded_invocations(reserved_run_id);
    CREATE UNIQUE INDEX IF NOT EXISTS threaded_attempt_scope ON threaded_attempts(id,invocation_id,thread_id,owner_id,agent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS threaded_run_scope ON threaded_run_bindings(run_id,invocation_id,thread_id,owner_id);
    CREATE TRIGGER IF NOT EXISTS threaded_invocation_request_immutable
      BEFORE UPDATE OF goal,account_id,account_identity_generation,reserved_run_id,client_request_id,request_hash ON threaded_invocations
      BEGIN SELECT RAISE(ABORT,'THREADED_INVOCATION_REQUEST_IMMUTABLE'); END;
    CREATE TABLE IF NOT EXISTS threaded_execution_bindings (
      id TEXT PRIMARY KEY CHECK(length(id)>0),
      attempt_id TEXT NOT NULL UNIQUE,
      invocation_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      authority_epoch INTEGER NOT NULL CHECK(authority_epoch>=1),
      thread_authority_epoch INTEGER NOT NULL CHECK(thread_authority_epoch>=1),
      claim_id TEXT NOT NULL CHECK(length(claim_id)>0),
      claim_owner TEXT NOT NULL CHECK(length(claim_owner)>0),
      generation INTEGER NOT NULL CHECK(generation>=1),
      fencing_token TEXT NOT NULL CHECK(length(fencing_token)>0),
      member_version INTEGER NOT NULL CHECK(member_version>=1),
      role_version INTEGER NOT NULL CHECK(role_version>=1),
      permission_version INTEGER NOT NULL CHECK(permission_version>=1),
      member_account_version INTEGER CHECK(member_account_version>=1),
      agent_version INTEGER NOT NULL CHECK(agent_version>=1),
      agent_definition_hash TEXT NOT NULL,
      account_id TEXT REFERENCES accounts(id),
      account_config_version INTEGER CHECK(account_config_version>=1),
      account_credential_version INTEGER CHECK(account_credential_version>=1),
      account_identity_generation INTEGER CHECK(account_identity_generation>=1),
      created_at TEXT NOT NULL,
      UNIQUE(id,attempt_id,invocation_id,thread_id,owner_id),
      FOREIGN KEY(attempt_id,invocation_id,thread_id,owner_id,agent_id)
        REFERENCES threaded_attempts(id,invocation_id,thread_id,owner_id,agent_id),
      FOREIGN KEY(run_id,invocation_id,thread_id,owner_id)
        REFERENCES threaded_run_bindings(run_id,invocation_id,thread_id,owner_id),
      CHECK((account_id IS NULL AND account_config_version IS NULL AND account_credential_version IS NULL AND account_identity_generation IS NULL)
        OR (account_id IS NOT NULL AND account_config_version IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS threaded_execution_binding_account ON threaded_execution_bindings(account_id,invocation_id);
    CREATE TRIGGER IF NOT EXISTS threaded_execution_binding_immutable
      BEFORE UPDATE ON threaded_execution_bindings BEGIN SELECT RAISE(ABORT,'THREADED_EXECUTION_BINDING_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_execution_binding_delete_forbidden
      BEFORE DELETE ON threaded_execution_bindings BEGIN SELECT RAISE(ABORT,'THREADED_EXECUTION_BINDING_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_bound_attempt_fence_immutable
      BEFORE UPDATE OF claim_id,claim_owner,generation,fencing_token,authority_epoch ON threaded_attempts
      WHEN EXISTS (SELECT 1 FROM threaded_execution_bindings WHERE attempt_id=OLD.id)
      BEGIN SELECT RAISE(ABORT,'THREADED_ATTEMPT_FENCE_IMMUTABLE'); END;

    CREATE TABLE IF NOT EXISTS threaded_control_requests (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('invocation','member','thread')),
      agent_id TEXT,
      invocation_id TEXT,
      action TEXT NOT NULL CHECK(action IN ('pause','resume','cancel')),
      status TEXT NOT NULL DEFAULT 'applied' CHECK(status IN ('applied','pending','rejected')),
      version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
      request_key TEXT,
      record TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_id,request_key),
      FOREIGN KEY(thread_id,owner_id) REFERENCES threaded_threads(id,owner_id),
      FOREIGN KEY(invocation_id,thread_id,owner_id) REFERENCES threaded_invocations(id,thread_id,owner_id),
      FOREIGN KEY(thread_id,owner_id,agent_id) REFERENCES threaded_members(thread_id,owner_id,agent_id),
      CHECK((scope='thread' AND agent_id IS NULL AND invocation_id IS NULL)
        OR (scope='member' AND agent_id IS NOT NULL AND invocation_id IS NULL)
        OR (scope='invocation' AND invocation_id IS NOT NULL))
    );
    CREATE TRIGGER IF NOT EXISTS threaded_control_identity_immutable
      BEFORE UPDATE OF id,thread_id,owner_id,scope,agent_id,invocation_id,action,request_key,record ON threaded_control_requests
      BEGIN SELECT RAISE(ABORT,'THREADED_CONTROL_IDENTITY_IMMUTABLE'); END;

    CREATE TABLE IF NOT EXISTS threaded_approvals (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','expired')),
      request_key TEXT NOT NULL,
      decision_request_id TEXT,
      record TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(invocation_id,request_key),
      UNIQUE(owner_id,decision_request_id),
      FOREIGN KEY(binding_id,attempt_id,invocation_id,thread_id,owner_id)
        REFERENCES threaded_execution_bindings(id,attempt_id,invocation_id,thread_id,owner_id)
    );
    CREATE TRIGGER IF NOT EXISTS threaded_approval_identity_immutable
      BEFORE UPDATE OF id,thread_id,owner_id,invocation_id,attempt_id,binding_id,request_key,record ON threaded_approvals
      BEGIN SELECT RAISE(ABORT,'THREADED_APPROVAL_IDENTITY_IMMUTABLE'); END;

    CREATE TABLE IF NOT EXISTS threaded_outputs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(id,binding_id,attempt_id,invocation_id,thread_id,owner_id),
      FOREIGN KEY(binding_id,attempt_id,invocation_id,thread_id,owner_id)
        REFERENCES threaded_execution_bindings(id,attempt_id,invocation_id,thread_id,owner_id)
    );
    CREATE TRIGGER IF NOT EXISTS threaded_output_immutable
      BEFORE UPDATE ON threaded_outputs BEGIN SELECT RAISE(ABORT,'THREADED_OUTPUT_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_output_delete_forbidden
      BEFORE DELETE ON threaded_outputs BEGIN SELECT RAISE(ABORT,'THREADED_OUTPUT_IMMUTABLE'); END;

    CREATE TABLE IF NOT EXISTS threaded_invocation_terminals (
      invocation_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      run_id TEXT NOT NULL UNIQUE,
      attempt_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      output_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('completed','failed','cancelled')),
      proof TEXT NOT NULL,
      committed_at TEXT NOT NULL,
      FOREIGN KEY(run_id,invocation_id,thread_id,owner_id)
        REFERENCES threaded_run_bindings(run_id,invocation_id,thread_id,owner_id),
      FOREIGN KEY(binding_id,attempt_id,invocation_id,thread_id,owner_id)
        REFERENCES threaded_execution_bindings(id,attempt_id,invocation_id,thread_id,owner_id),
      FOREIGN KEY(output_id,binding_id,attempt_id,invocation_id,thread_id,owner_id)
        REFERENCES threaded_outputs(id,binding_id,attempt_id,invocation_id,thread_id,owner_id),
      CHECK(status<>'completed' OR output_id IS NOT NULL)
    );
    CREATE TRIGGER IF NOT EXISTS threaded_invocation_terminal_immutable
      BEFORE UPDATE ON threaded_invocation_terminals BEGIN SELECT RAISE(ABORT,'THREADED_TERMINAL_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_invocation_terminal_delete_forbidden
      BEFORE DELETE ON threaded_invocation_terminals BEGIN SELECT RAISE(ABORT,'THREADED_TERMINAL_IMMUTABLE'); END;
  `);
}

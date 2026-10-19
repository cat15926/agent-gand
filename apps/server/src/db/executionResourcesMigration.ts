import type Database from 'better-sqlite3';

export const EXECUTION_RESOURCES_MIGRATION = {
  version: 27,
  name: 'shared-execution-resources-v1',
  descriptor: 'mixed-agent-exclusive-thread-slot-v1;atomic-resource-set-and-capacity-v1;durable-fifo-thread-round-robin-v1;monotonic-resource-epochs-v1;immutable-quiescence-receipts-v1;session-identity-cas-v1;durable-availability-v1',
} as const;

/** No historical descriptor or data is rewritten. */
export function applyExecutionResourcesMigration(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('RESOURCE_MIGRATION_REQUIRES_TRANSACTION');
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_resource_policy (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version>=1), record TEXT NOT NULL,
      FOREIGN KEY(owner_id) REFERENCES threaded_instances(instance_owner_id)
    );
    CREATE TABLE IF NOT EXISTS execution_resource_tickets (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL, request_key TEXT NOT NULL, operation_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('legacy','threaded')), agent_id TEXT NOT NULL,
      thread_id TEXT, run_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
      parent_claim_id TEXT, request_hash TEXT NOT NULL, request TEXT NOT NULL,
      policy_version INTEGER NOT NULL CHECK(policy_version>=1),
      status TEXT NOT NULL CHECK(status IN ('waiting','active','released','cancelled')),
      eligible INTEGER NOT NULL CHECK(eligible IN (0,1)), created_at INTEGER NOT NULL,
      UNIQUE(owner_id,request_key), UNIQUE(owner_id,operation_id),
      FOREIGN KEY(owner_id) REFERENCES threaded_instances(instance_owner_id),
      FOREIGN KEY(agent_id) REFERENCES agents(id),
      FOREIGN KEY(parent_claim_id) REFERENCES execution_resource_claims(id)
    );
    CREATE INDEX IF NOT EXISTS execution_resource_ticket_waiters ON execution_resource_tickets(status,eligible,seq);
    CREATE TRIGGER IF NOT EXISTS execution_resource_ticket_identity_immutable
      BEFORE UPDATE OF id,owner_id,request_key,operation_id,mode,agent_id,thread_id,run_id,attempt_id,parent_claim_id,request_hash,request,policy_version ON execution_resource_tickets
      BEGIN SELECT RAISE(ABORT,'RESOURCE_TICKET_IDENTITY_IMMUTABLE'); END;
    CREATE TABLE IF NOT EXISTS execution_resource_epochs (
      resource_key TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK(generation>=1)
    );
    CREATE TRIGGER IF NOT EXISTS execution_resource_epoch_monotonic
      BEFORE UPDATE ON execution_resource_epochs WHEN NEW.resource_key<>OLD.resource_key OR NEW.generation<=OLD.generation
      BEGIN SELECT RAISE(ABORT,'RESOURCE_EPOCH_MUST_INCREASE'); END;
    CREATE TRIGGER IF NOT EXISTS execution_resource_epoch_retained
      BEFORE DELETE ON execution_resource_epochs BEGIN SELECT RAISE(ABORT,'RESOURCE_EPOCH_RETAINED'); END;
    CREATE TABLE IF NOT EXISTS execution_resource_claims (
      id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES execution_resource_tickets(id),
      owner_nonce TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>=1), fencing_token TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK(state IN ('reserved','started','unknown','quiescent','released')),
      expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, released_at INTEGER,
      FOREIGN KEY(ticket_id) REFERENCES execution_resource_tickets(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS execution_resource_claim_active_ticket ON execution_resource_claims(ticket_id) WHERE state<>'released';
    CREATE TRIGGER IF NOT EXISTS execution_resource_claim_identity_immutable
      BEFORE UPDATE OF id,ticket_id,owner_nonce,generation,fencing_token,created_at ON execution_resource_claims
      BEGIN SELECT RAISE(ABORT,'RESOURCE_CLAIM_IDENTITY_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS execution_resource_claim_retained
      BEFORE DELETE ON execution_resource_claims BEGIN SELECT RAISE(ABORT,'RESOURCE_CLAIM_RETAINED'); END;
    CREATE TABLE IF NOT EXISTS execution_resource_claim_items (
      claim_id TEXT NOT NULL REFERENCES execution_resource_claims(id),
      resource_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('agent','session','workspace','capacity')),
      access TEXT NOT NULL CHECK(access IN ('exclusive','slot','read','write','capacity')),
      generation INTEGER NOT NULL CHECK(generation>=1),
      PRIMARY KEY(claim_id,resource_key)
    );
    CREATE INDEX IF NOT EXISTS execution_resource_item_key ON execution_resource_claim_items(resource_key,claim_id);
    CREATE TRIGGER IF NOT EXISTS execution_resource_item_immutable
      BEFORE UPDATE ON execution_resource_claim_items BEGIN SELECT RAISE(ABORT,'RESOURCE_ITEM_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS execution_resource_item_retained
      BEFORE DELETE ON execution_resource_claim_items BEGIN SELECT RAISE(ABORT,'RESOURCE_ITEM_RETAINED'); END;
    CREATE TABLE IF NOT EXISTS execution_resource_fairness (
      owner_id TEXT NOT NULL, lane TEXT NOT NULL, last_served INTEGER NOT NULL,
      PRIMARY KEY(owner_id,lane), FOREIGN KEY(owner_id) REFERENCES threaded_instances(instance_owner_id)
    );
    CREATE TABLE IF NOT EXISTS execution_resource_quiescence (
      id TEXT PRIMARY KEY, claim_id TEXT NOT NULL UNIQUE REFERENCES execution_resource_claims(id),
      proof TEXT NOT NULL, evidence TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS execution_resource_proof_immutable
      BEFORE UPDATE ON execution_resource_quiescence BEGIN SELECT RAISE(ABORT,'RESOURCE_PROOF_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS execution_resource_proof_retained
      BEFORE DELETE ON execution_resource_quiescence BEGIN SELECT RAISE(ABORT,'RESOURCE_PROOF_RETAINED'); END;
    CREATE TABLE IF NOT EXISTS execution_resource_availability (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, reason TEXT NOT NULL, agent_id TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS execution_resource_sessions (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, binding_key TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version>=1), native_id TEXT, resource_key TEXT,
      state TEXT NOT NULL CHECK(state IN ('ready','invalid','reconciling')),
      record TEXT NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(owner_id,binding_key), FOREIGN KEY(owner_id) REFERENCES threaded_instances(instance_owner_id)
    );
    CREATE TABLE IF NOT EXISTS execution_resource_session_versions (
      session_id TEXT NOT NULL REFERENCES execution_resource_sessions(id),
      version INTEGER NOT NULL CHECK(version>=1), native_id TEXT, resource_key TEXT,
      record TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(session_id,version)
    );
    CREATE TRIGGER IF NOT EXISTS execution_resource_session_version_immutable
      BEFORE UPDATE ON execution_resource_session_versions BEGIN SELECT RAISE(ABORT,'RESOURCE_SESSION_VERSION_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS execution_resource_session_version_retained
      BEFORE DELETE ON execution_resource_session_versions BEGIN SELECT RAISE(ABORT,'RESOURCE_SESSION_VERSION_RETAINED'); END;
  `);
}

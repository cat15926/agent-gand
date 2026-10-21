import type Database from 'better-sqlite3';
import {applyThreadedReleaseSchema} from './threadedReleaseSchema.ts';
export const THREADED_OPERATIONS_MIGRATION={version:34,name:'threaded-release-os-operations-v1',
  descriptor:'independent-ingress-dispatch-controls-v1;frozen-canary-thread-root-admissions-v1;registered-os-command-owned-process-resource-proof-v1;immutable-operations-audit-v1'} as const;
export function applyThreadedOperationsMigration(db:Database.Database){
  if(!db.inTransaction)throw new Error('THREADED_MIGRATION_REQUIRES_TRANSACTION');
  applyThreadedReleaseSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS threaded_os_commands (
    command_id TEXT PRIMARY KEY REFERENCES threaded_commands(id),registration_id TEXT NOT NULL,authorization TEXT NOT NULL,
    owner_id TEXT NOT NULL,thread_id TEXT NOT NULL,agent_id TEXT NOT NULL,binding_id TEXT NOT NULL,claim_record TEXT,
    registration_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('running','unknown','completed','failed','cancelled')),
    record TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS threaded_os_command_events (
    id TEXT PRIMARY KEY,command_id TEXT NOT NULL REFERENCES threaded_os_commands(command_id),kind TEXT NOT NULL,record TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS threaded_os_command_identity_immutable BEFORE UPDATE ON threaded_os_commands
    WHEN NEW.command_id<>OLD.command_id OR NEW.registration_id<>OLD.registration_id OR NEW.authorization<>OLD.authorization
      OR NEW.owner_id<>OLD.owner_id OR NEW.thread_id<>OLD.thread_id OR NEW.agent_id<>OLD.agent_id OR NEW.binding_id<>OLD.binding_id
      OR NEW.registration_hash<>OLD.registration_hash OR NEW.created_at<>OLD.created_at
      OR (OLD.claim_record IS NOT NULL AND (NEW.claim_record IS NULL OR NEW.claim_record<>OLD.claim_record))
    BEGIN SELECT RAISE(ABORT,'THREADED_OS_COMMAND_IDENTITY_IMMUTABLE'); END;`);
  for(const table of ['threaded_os_command_events'])db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'THREADED_OS_COMMAND_EVENT_IMMUTABLE'); END;`);
  for(const table of ['threaded_os_commands','threaded_os_command_events'])db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_retained BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'THREADED_OS_COMMAND_RETAINED'); END;`);
}

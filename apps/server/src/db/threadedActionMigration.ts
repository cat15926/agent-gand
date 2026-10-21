import type Database from 'better-sqlite3';

export const THREADED_ACTION_MIGRATION = {
  version:32,name:'threaded-actions-v1',
  descriptor:'canonical-subject-family-slot-cas-v1;immutable-standing-generation-freshness-v1;platform-task-facade-v1;github-head-local-review-v1;generation-bound-command-wait-v1',
} as const;
export function applyThreadedActionMigration(db:Database.Database):void {
  if(!db.inTransaction)throw new Error('THREADED_MIGRATION_REQUIRES_TRANSACTION');
  db.exec(`
    CREATE TABLE IF NOT EXISTS threaded_actions (
      id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,thread_id TEXT NOT NULL REFERENCES threaded_threads(id),
      subject_key TEXT NOT NULL,family TEXT NOT NULL,slot TEXT NOT NULL,
      generation INTEGER NOT NULL,version INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','replaceable','completed')),
      root_id TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      UNIQUE(owner_id,subject_key,family,slot)
    );
    CREATE TABLE IF NOT EXISTS threaded_action_generations (
      action_id TEXT NOT NULL REFERENCES threaded_actions(id),generation INTEGER NOT NULL,
      record TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(action_id,generation)
    );
    CREATE TABLE IF NOT EXISTS threaded_action_holders (
      action_id TEXT NOT NULL,generation INTEGER NOT NULL,agent_id TEXT NOT NULL,
      outcome TEXT CHECK(outcome IN ('succeeded','failed','cancelled','unavailable','rejected_ownership')),
      evidence_id TEXT,PRIMARY KEY(action_id,generation,agent_id),
      FOREIGN KEY(action_id,generation) REFERENCES threaded_action_generations(action_id,generation)
    );
    CREATE TABLE IF NOT EXISTS threaded_action_message_fences (
      message_id TEXT PRIMARY KEY REFERENCES threaded_messages(id),action_id TEXT NOT NULL,generation INTEGER NOT NULL,
      FOREIGN KEY(action_id,generation) REFERENCES threaded_action_generations(action_id,generation)
    );
    CREATE TABLE IF NOT EXISTS threaded_action_operations (
      binding_id TEXT NOT NULL REFERENCES threaded_execution_bindings(id),request_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(binding_id,request_key)
    );
    CREATE TABLE IF NOT EXISTS threaded_action_evidence (
      id TEXT PRIMARY KEY,action_id TEXT NOT NULL,generation INTEGER NOT NULL,agent_id TEXT NOT NULL,
      kind TEXT NOT NULL,record TEXT NOT NULL,created_at INTEGER NOT NULL,
      FOREIGN KEY(action_id,generation) REFERENCES threaded_action_generations(action_id,generation)
    );
    CREATE TABLE IF NOT EXISTS threaded_action_freshness (
      action_id TEXT PRIMARY KEY REFERENCES threaded_actions(id),generation INTEGER NOT NULL,
      status TEXT NOT NULL,head_sha TEXT,authorization TEXT,checked_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threaded_action_candidates (
      id TEXT PRIMARY KEY,action_id TEXT NOT NULL,generation INTEGER NOT NULL,agent_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL REFERENCES threaded_action_evidence(id),verdict TEXT NOT NULL,created_at INTEGER NOT NULL,
      UNIQUE(action_id,generation,agent_id,evidence_id),
      FOREIGN KEY(action_id,generation) REFERENCES threaded_action_generations(action_id,generation)
    );
    CREATE TABLE IF NOT EXISTS threaded_task_ownership (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id),owner_id TEXT NOT NULL,thread_id TEXT NOT NULL,
      creator_id TEXT NOT NULL,version INTEGER NOT NULL,criteria_hash TEXT NOT NULL,source_record TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threaded_task_writes (
      task_id TEXT PRIMARY KEY REFERENCES threaded_task_ownership(task_id),expected_version INTEGER NOT NULL,
      next_status TEXT NOT NULL,next_assignee TEXT,next_result TEXT
    );
    CREATE TRIGGER IF NOT EXISTS threaded_task_ownership_version BEFORE UPDATE ON threaded_task_ownership
      WHEN NEW.task_id<>OLD.task_id OR NEW.owner_id<>OLD.owner_id OR NEW.thread_id<>OLD.thread_id
        OR NEW.creator_id<>OLD.creator_id OR NEW.criteria_hash<>OLD.criteria_hash OR NEW.version<>OLD.version+1
        OR NEW.source_record<>OLD.source_record
      BEGIN SELECT RAISE(ABORT,'THREADED_TASK_OWNERSHIP_IMMUTABLE'); END;
    CREATE TABLE IF NOT EXISTS threaded_task_transitions (
      id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES threaded_task_ownership(task_id),version INTEGER NOT NULL,
      binding_id TEXT NOT NULL REFERENCES threaded_execution_bindings(id),action_id TEXT,generation INTEGER,
      record TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(task_id,version)
    );
    CREATE TRIGGER IF NOT EXISTS threaded_task_facade BEFORE UPDATE ON tasks
      WHEN EXISTS(SELECT 1 FROM threaded_task_ownership WHERE task_id=OLD.id) AND (
        NOT EXISTS(SELECT 1 FROM threaded_task_writes w JOIN threaded_task_ownership o ON o.task_id=w.task_id
          WHERE w.task_id=OLD.id AND w.expected_version=o.version AND w.next_status=NEW.status
            AND w.next_assignee IS NEW.assignee AND w.next_result IS NEW.result)
        OR NEW.run_id IS NOT OLD.run_id OR NEW.title IS NOT OLD.title OR NEW.body IS NOT OLD.body
        OR NEW.created_by IS NOT OLD.created_by OR NEW.blocked_by IS NOT OLD.blocked_by OR NEW.kind IS NOT OLD.kind
        OR NEW.reviewer_id IS NOT OLD.reviewer_id OR NEW.acceptance_criteria IS NOT OLD.acceptance_criteria
        OR NEW.created_at IS NOT OLD.created_at OR NEW.max_attempts IS NOT OLD.max_attempts)
      BEGIN SELECT RAISE(ABORT,'THREADED_TASK_FACADE_REQUIRED'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_task_retained BEFORE DELETE ON tasks
      WHEN EXISTS(SELECT 1 FROM threaded_task_ownership WHERE task_id=OLD.id)
      BEGIN SELECT RAISE(ABORT,'THREADED_TASK_RETAINED'); END;
    CREATE TABLE IF NOT EXISTS threaded_commands (
      id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,thread_id TEXT NOT NULL,agent_id TEXT NOT NULL,
      action_id TEXT NOT NULL,generation INTEGER NOT NULL,binding_id TEXT NOT NULL,
      port TEXT NOT NULL,authorization TEXT NOT NULL,args TEXT NOT NULL,source_record TEXT NOT NULL,state TEXT NOT NULL,
      version INTEGER NOT NULL,result TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      FOREIGN KEY(action_id,generation) REFERENCES threaded_action_generations(action_id,generation)
    );
    CREATE TABLE IF NOT EXISTS threaded_command_waits (
      command_id TEXT PRIMARY KEY REFERENCES threaded_commands(id),parent_invocation_id TEXT NOT NULL,
      record TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('awaiting','delivered','stale'))
    );
    CREATE TABLE IF NOT EXISTS threaded_command_events (
      id TEXT PRIMARY KEY,command_id TEXT NOT NULL REFERENCES threaded_commands(id),record TEXT NOT NULL,created_at INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS threaded_action_cas BEFORE UPDATE ON threaded_actions
      WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.thread_id<>OLD.thread_id
        OR NEW.subject_key<>OLD.subject_key OR NEW.family<>OLD.family OR NEW.slot<>OLD.slot
        OR NEW.root_id<>OLD.root_id OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1
        OR NEW.generation NOT IN (OLD.generation,OLD.generation+1)
        OR (NEW.generation=OLD.generation AND OLD.state='completed')
      BEGIN SELECT RAISE(ABORT,'THREADED_ACTION_CAS'); END;
    CREATE TRIGGER IF NOT EXISTS threaded_action_holder_transition BEFORE UPDATE ON threaded_action_holders
      WHEN OLD.outcome IS NOT NULL OR NEW.outcome IS NULL OR NEW.action_id<>OLD.action_id
        OR NEW.generation<>OLD.generation OR NEW.agent_id<>OLD.agent_id
      BEGIN SELECT RAISE(ABORT,'THREADED_ACTION_HOLDER_TERMINAL'); END;
  `);
  for(const table of ['threaded_action_generations','threaded_action_message_fences','threaded_action_operations',
    'threaded_action_evidence','threaded_action_candidates','threaded_task_transitions','threaded_command_events']) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'THREADED_ACTION_FACT_IMMUTABLE'); END;`);
  }
  for(const table of ['threaded_actions','threaded_action_generations','threaded_action_holders','threaded_action_message_fences',
    'threaded_action_operations','threaded_action_evidence','threaded_action_freshness','threaded_action_candidates','threaded_task_ownership',
    'threaded_task_transitions','threaded_commands','threaded_command_waits','threaded_command_events']) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_retained BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'THREADED_ACTION_FACT_RETAINED'); END;`);
  }
}

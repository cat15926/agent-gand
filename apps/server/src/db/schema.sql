-- agent-gand P0 schema（规格 §3）
-- 约定：时间戳一律 ISO 字符串；JSON 数组存 TEXT；ID 用 crypto.randomUUID()

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, definition TEXT NOT NULL,
  source TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1, definition_hash TEXT, source_path TEXT, sync_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_versions (
  agent_id TEXT NOT NULL, version INTEGER NOT NULL, definition TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY(agent_id, version)
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, goal TEXT NOT NULL, mode TEXT NOT NULL,
  conversation_id TEXT,
  turn_no INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL, agent_ids TEXT NOT NULL,  -- JSON array
  supervisor_id TEXT,
  default_reviewer_id TEXT,
  workspace TEXT,                                 -- 命名工作区（§10.2，NULL=runId 专属；§11.2 可为 ext:<id>）
  title TEXT,                                     -- 会话标题（§13.2，NULL=用目标前 24 字）
  deleted_at TEXT,                                -- 软删时间（§13.3，NULL=在册）
  created_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, mode TEXT NOT NULL,
  agent_ids TEXT NOT NULL, supervisor_id TEXT, default_reviewer_id TEXT,
  members_version INTEGER NOT NULL DEFAULT 1, workspace TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
);
CREATE TABLE IF NOT EXISTS run_agent_snapshots (
  run_id TEXT NOT NULL, agent_id TEXT NOT NULL, version INTEGER NOT NULL,
  definition TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(run_id, agent_id)
);
CREATE TABLE IF NOT EXISTS external_workspaces (
  id TEXT PRIMARY KEY, label TEXT NOT NULL,
  abs_path TEXT NOT NULL UNIQUE,                  -- realpath 后的本机目录（§11.2）
  trusted INTEGER NOT NULL DEFAULT 0,             -- 信任目录：fs.write 免逐次审批（仍受 plan 子目录隔离）
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, run_id TEXT, title TEXT NOT NULL, body TEXT,
  status TEXT NOT NULL DEFAULT 'pending',         -- pending|in_progress|completed
  assignee TEXT, created_by TEXT,
  blocked_by TEXT NOT NULL DEFAULT '[]',          -- JSON array of task ids
  kind TEXT NOT NULL DEFAULT 'work',
  reviewer_id TEXT,
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  result TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL,
  conversation_id TEXT,
  seq INTEGER,
  from_agent TEXT NOT NULL, to_agent TEXT NOT NULL, -- agent id | 'user' | 'system'
  kind TEXT NOT NULL, body TEXT NOT NULL, meta TEXT,
  task_id TEXT, reply_to TEXT,
  message_type TEXT NOT NULL DEFAULT 'informational', payload TEXT,
  delivery_status TEXT, client_message_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_attempts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, kind TEXT NOT NULL, attempt_no INTEGER NOT NULL,
  status TEXT NOT NULL, input_context TEXT, output TEXT, error TEXT,
  lease_owner TEXT, lease_expires_at TEXT,
  created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS task_reviews (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL, verdict TEXT NOT NULL,
  summary TEXT NOT NULL, issues TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_id TEXT,
  span_kind TEXT NOT NULL, name TEXT NOT NULL,    -- llm|tool|agent|message|approval|orchestration
  input TEXT, output TEXT, status TEXT NOT NULL,  -- running|ok|error
  attributes TEXT NOT NULL DEFAULT '{}',
  tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0,
  started_at TEXT NOT NULL, first_token_at TEXT, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  tool_name TEXT NOT NULL, input TEXT, reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',         -- pending|approved|rejected|edited
  edited_input TEXT, decided_by TEXT, decided_at TEXT, created_at TEXT NOT NULL,
  idempotency_key TEXT, checkpoint_id TEXT
);
CREATE TABLE IF NOT EXISTS run_checkpoints (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
  kind TEXT NOT NULL, status TEXT NOT NULL, phase TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '{}', waiting_on TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(run_id, seq)
);
CREATE TABLE IF NOT EXISTS tool_executions (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  task_id TEXT, attempt_id TEXT, tool_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE, input TEXT NOT NULL,
  replay_policy TEXT NOT NULL, status TEXT NOT NULL,
  output TEXT, error TEXT, span_id TEXT,
  created_at TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS collaboration_dispatches (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL, parent_dispatch_id TEXT, batch_id TEXT,
  kind TEXT NOT NULL, from_actor TEXT NOT NULL, target_agent_id TEXT NOT NULL,
  reason TEXT, status TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal',
  depth INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT NOT NULL,
  content_hash TEXT, output_message_id TEXT, error TEXT, created_at TEXT NOT NULL,
  started_at TEXT, finished_at TEXT,
  UNIQUE(run_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS collaboration_attempts (
  id TEXT PRIMARY KEY, dispatch_id TEXT NOT NULL, run_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL, agent_id TEXT NOT NULL, attempt_no INTEGER NOT NULL,
  status TEXT NOT NULL, input_context TEXT, output TEXT, control_action TEXT,
  deduplicated_to TEXT, error TEXT,
  lease_owner TEXT, lease_expires_at TEXT, created_at TEXT NOT NULL,
  started_at TEXT, ended_at TEXT,
  UNIQUE(dispatch_id, attempt_no)
);
CREATE TABLE IF NOT EXISTS collaboration_batches (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  initiator_agent_id TEXT NOT NULL, source_dispatch_id TEXT NOT NULL,
  question TEXT NOT NULL, target_agent_ids TEXT NOT NULL, result_dispatch_id TEXT,
  status TEXT NOT NULL, timeout_at TEXT NOT NULL, created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS collaboration_user_decisions (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  dispatch_id TEXT, idempotency_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', prompt_message_id TEXT NOT NULL,
  payload TEXT NOT NULL, resolution TEXT, linked_run_id TEXT,
  created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS collaboration_budget_revisions (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, decision_id TEXT NOT NULL UNIQUE,
  increase_percent INTEGER NOT NULL, previous_limits TEXT NOT NULL,
  new_limits TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runtime_contracts (
  run_id TEXT PRIMARY KEY, version INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runtime_subjects (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, subject_key TEXT NOT NULL,
  kind TEXT NOT NULL, parent_subject_id TEXT, status TEXT NOT NULL,
  objective TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(run_id, subject_key)
);
CREATE TABLE IF NOT EXISTS runtime_custody_events (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, subject_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
  holder_agent_id TEXT, pending_holder_agent_id TEXT,
  generation INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runtime_custody (
  subject_id TEXT PRIMARY KEY, state TEXT NOT NULL,
  holder_agent_id TEXT, pending_holder_agent_id TEXT,
  generation INTEGER NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runtime_dispatch_subjects (
  dispatch_id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, expected_generation INTEGER
);
CREATE TABLE IF NOT EXISTS runtime_handoff_capsules (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, dispatch_id TEXT NOT NULL,
  version INTEGER NOT NULL, source_attempt_id TEXT NOT NULL,
  payload TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(dispatch_id,version)
);
CREATE TABLE IF NOT EXISTS runtime_context_assemblies (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, dispatch_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE, segments TEXT NOT NULL,
  char_count INTEGER NOT NULL, token_estimate INTEGER NOT NULL,
  context_sha256 TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runtime_completion_evaluations (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
  status TEXT NOT NULL, reasons TEXT NOT NULL, disposition TEXT NOT NULL,
  snapshot TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(run_id,seq)
);
CREATE TABLE IF NOT EXISTS runtime_completion_candidates (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, subject_id TEXT NOT NULL,
  subject_key TEXT NOT NULL, attempt_id TEXT NOT NULL, generation INTEGER NOT NULL,
  agent_id TEXT NOT NULL, action TEXT NOT NULL, summary TEXT NOT NULL,
  evidence_refs TEXT NOT NULL, exit_guard_status TEXT NOT NULL,
  exit_guard_reasons TEXT NOT NULL, status TEXT NOT NULL,
  reasons TEXT NOT NULL, retryable INTEGER NOT NULL DEFAULT 0,
  feedback TEXT, idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS runtime_successor_obligations (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_subject_id TEXT NOT NULL,
  kind TEXT NOT NULL, target_subject_id TEXT, source_action_id TEXT NOT NULL,
  stable_key TEXT NOT NULL, status TEXT NOT NULL, required INTEGER NOT NULL DEFAULT 1,
  generation INTEGER NOT NULL, payload TEXT NOT NULL,
  resolution_source_id TEXT, resolution TEXT, created_at TEXT NOT NULL, resolved_at TEXT,
  UNIQUE(run_id,stable_key,generation),
  UNIQUE(run_id,kind,source_action_id,stable_key)
);
CREATE TABLE IF NOT EXISTS runtime_contract_revisions (
  run_id TEXT NOT NULL, runtime_revision INTEGER NOT NULL,
  payload TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(run_id,runtime_revision)
);
CREATE TABLE IF NOT EXISTS runtime_coordination_subjects (
  plan_id TEXT NOT NULL, revision INTEGER NOT NULL, step_id TEXT NOT NULL,
  subject_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY(plan_id,revision,step_id)
);
CREATE TABLE IF NOT EXISTS runtime_coordination_evidence (
  subject_id TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE,
  refs TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runtime_subjects_run ON runtime_subjects(run_id, status);
CREATE INDEX IF NOT EXISTS idx_runtime_custody_events_subject ON runtime_custody_events(subject_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runtime_capsules_run ON runtime_handoff_capsules(run_id,dispatch_id,version);
CREATE INDEX IF NOT EXISTS idx_runtime_completion_run ON runtime_completion_evaluations(run_id,seq);
CREATE INDEX IF NOT EXISTS idx_runtime_candidates_run ON runtime_completion_candidates(run_id,status,created_at);
CREATE INDEX IF NOT EXISTS idx_runtime_candidates_subject ON runtime_completion_candidates(subject_id,generation,status);
CREATE INDEX IF NOT EXISTS idx_runtime_obligations_parent ON runtime_successor_obligations(parent_subject_id,status,generation);
CREATE INDEX IF NOT EXISTS idx_runtime_obligations_target ON runtime_successor_obligations(target_subject_id,status,generation);
CREATE INDEX IF NOT EXISTS idx_runtime_obligations_run ON runtime_successor_obligations(run_id,status,created_at);
CREATE INDEX IF NOT EXISTS idx_runtime_coordination_subject_plan ON runtime_coordination_subjects(plan_id,revision);
CREATE TABLE IF NOT EXISTS capability_snapshots (
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coordination_drafts (
  id TEXT PRIMARY KEY, capability_snapshot_id TEXT NOT NULL,
  payload TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coordination_plans (
  id TEXT PRIMARY KEY, run_id TEXT UNIQUE, draft_id TEXT NOT NULL,
  capability_snapshot_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL, payload TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coordination_plan_revisions (
  plan_id TEXT NOT NULL, revision INTEGER NOT NULL,
  trigger_kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(plan_id, revision)
);
CREATE TABLE IF NOT EXISTS coordination_events (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,
  draft_id TEXT, plan_id TEXT, run_id TEXT,
  payload TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coordination_step_states (
  plan_id TEXT NOT NULL, run_id TEXT NOT NULL, revision INTEGER NOT NULL,
  step_id TEXT NOT NULL, status TEXT NOT NULL, attempt_no INTEGER NOT NULL DEFAULT 0,
  output TEXT, error TEXT, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY(plan_id, revision, step_id)
);
CREATE TABLE IF NOT EXISTS coordination_step_attempts (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, run_id TEXT NOT NULL, revision INTEGER NOT NULL,
  step_id TEXT NOT NULL, attempt_no INTEGER NOT NULL, status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE, input TEXT, output TEXT, error TEXT, span_id TEXT,
  created_at TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
  UNIQUE(plan_id, revision, step_id, attempt_no)
);
CREATE TABLE IF NOT EXISTS coordination_planner_feedback (
  id TEXT PRIMARY KEY, original_draft_id TEXT NOT NULL,
  chosen_protocols TEXT NOT NULL, original_confidence REAL NOT NULL,
  corrected INTEGER NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id);
CREATE INDEX IF NOT EXISTS idx_messages_run ON messages(run_id);
CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_checkpoints_run ON run_checkpoints(run_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_tool_executions_run ON tool_executions(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attempts_task ON task_attempts(task_id, attempt_no);
CREATE INDEX IF NOT EXISTS idx_attempts_status_lease ON task_attempts(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_reviews_task ON task_reviews(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_collab_dispatch_run_status ON collaboration_dispatches(run_id, status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_collab_dispatch_agent_status ON collaboration_dispatches(conversation_id, target_agent_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_collab_attempt_lease ON collaboration_attempts(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_collab_batch_status ON collaboration_batches(run_id, status, timeout_at);
CREATE INDEX IF NOT EXISTS idx_collab_decision_status ON collaboration_user_decisions(conversation_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_collab_budget_run ON collaboration_budget_revisions(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_coordination_drafts_snapshot ON coordination_drafts(capability_snapshot_id, created_at);
CREATE INDEX IF NOT EXISTS idx_coordination_plans_status ON coordination_plans(status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_coordination_plans_draft ON coordination_plans(draft_id);
CREATE INDEX IF NOT EXISTS idx_coordination_events_draft ON coordination_events(draft_id, created_at);
CREATE INDEX IF NOT EXISTS idx_coordination_events_plan ON coordination_events(plan_id, created_at);
CREATE INDEX IF NOT EXISTS idx_coordination_events_run ON coordination_events(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_coordination_step_states_run ON coordination_step_states(run_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_coordination_step_attempts_run ON coordination_step_attempts(run_id, step_id, attempt_no);
CREATE INDEX IF NOT EXISTS idx_coordination_planner_feedback_created ON coordination_planner_feedback(created_at DESC);

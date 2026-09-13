-- agent-gand P0 schema（规格 §3）
-- 约定：时间戳一律 ISO 字符串；JSON 数组存 TEXT；ID 用 crypto.randomUUID()

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, definition TEXT NOT NULL,
  source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, goal TEXT NOT NULL, mode TEXT NOT NULL,
  status TEXT NOT NULL, agent_ids TEXT NOT NULL,  -- JSON array
  supervisor_id TEXT,
  workspace TEXT,                                 -- 命名工作区（§10.2，NULL=runId 专属；§11.2 可为 ext:<id>）
  title TEXT,                                     -- 会话标题（§13.2，NULL=用目标前 24 字）
  deleted_at TEXT,                                -- 软删时间（§13.3，NULL=在册）
  created_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS external_workspaces (
  id TEXT PRIMARY KEY, label TEXT NOT NULL,
  abs_path TEXT NOT NULL UNIQUE,                  -- realpath 后的本机目录（§11.2）
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
  from_agent TEXT NOT NULL, to_agent TEXT NOT NULL, -- agent id | 'user' | 'system'
  kind TEXT NOT NULL, body TEXT NOT NULL, meta TEXT,
  task_id TEXT, reply_to TEXT,
  message_type TEXT NOT NULL DEFAULT 'informational', payload TEXT,
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
  tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0,
  started_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  tool_name TEXT NOT NULL, input TEXT, reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',         -- pending|approved|rejected|edited
  edited_input TEXT, decided_by TEXT, decided_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id);
CREATE INDEX IF NOT EXISTS idx_messages_run ON messages(run_id);
CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_attempts_task ON task_attempts(task_id, attempt_no);
CREATE INDEX IF NOT EXISTS idx_attempts_status_lease ON task_attempts(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_reviews_task ON task_reviews(task_id, created_at);

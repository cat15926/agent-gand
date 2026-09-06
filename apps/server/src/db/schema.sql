-- agent-gand P0 schema（规格 §3）
-- 约定：时间戳一律 ISO 字符串；JSON 数组存 TEXT；ID 用 crypto.randomUUID()

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, definition TEXT NOT NULL,
  source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, goal TEXT NOT NULL, mode TEXT NOT NULL,
  status TEXT NOT NULL, agent_ids TEXT NOT NULL,  -- JSON array
  workspace TEXT,                                 -- 命名工作区（§10.2，NULL=runId 专属）
  created_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, run_id TEXT, title TEXT NOT NULL, body TEXT,
  status TEXT NOT NULL DEFAULT 'pending',         -- pending|in_progress|completed
  assignee TEXT, created_by TEXT,
  blocked_by TEXT NOT NULL DEFAULT '[]',          -- JSON array of task ids
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL,
  from_agent TEXT NOT NULL, to_agent TEXT NOT NULL, -- agent id | 'user' | 'system'
  kind TEXT NOT NULL, body TEXT NOT NULL, meta TEXT,
  created_at TEXT NOT NULL
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

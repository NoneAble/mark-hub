-- Cleaner jobs and issues (R3-F002)

CREATE TABLE IF NOT EXISTS clean_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  check_invalid INTEGER NOT NULL DEFAULT 0,
  concurrency INTEGER NOT NULL DEFAULT 8,
  progress REAL NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_clean_jobs_user ON clean_jobs(user_id, created_at);

CREATE TABLE IF NOT EXISTS clean_issues (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_clean_issues_job ON clean_issues(job_id);
CREATE INDEX IF NOT EXISTS ix_clean_issues_user ON clean_issues(user_id, created_at);

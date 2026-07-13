-- MarkHub Postgres schema v0001 (fresh install) — full FK graph

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) NOT NULL,
  username VARCHAR(128) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW() NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (username)
);

CREATE TABLE IF NOT EXISTS folders (
  id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  parent_id VARCHAR(36),
  name VARCHAR(255) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  visibility VARCHAR(16) NOT NULL DEFAULT 'private',
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMP WITHOUT TIME ZONE,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW() NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY(user_id) REFERENCES users (id),
  FOREIGN KEY(parent_id) REFERENCES folders (id)
);
CREATE INDEX IF NOT EXISTS ix_folders_user_parent_sort ON folders (user_id, parent_id, sort_order);
CREATE INDEX IF NOT EXISTS ix_folders_user_id ON folders (user_id);
CREATE INDEX IF NOT EXISTS ix_folders_parent_id ON folders (parent_id);

CREATE TABLE IF NOT EXISTS bookmarks (
  id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  folder_id VARCHAR(36) NOT NULL,
  title VARCHAR(500) NOT NULL,
  url TEXT NOT NULL,
  url_normalized TEXT NOT NULL DEFAULT '',
  description TEXT,
  visibility VARCHAR(16) NOT NULL DEFAULT 'private',
  is_favorite BOOLEAN NOT NULL DEFAULT FALSE,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  ai_summary TEXT,
  ai_category VARCHAR(255),
  link_status VARCHAR(32) NOT NULL DEFAULT 'unknown',
  deleted_at TIMESTAMP WITHOUT TIME ZONE,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW() NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY(user_id) REFERENCES users (id),
  FOREIGN KEY(folder_id) REFERENCES folders (id)
);
CREATE INDEX IF NOT EXISTS ix_bookmarks_user_url_norm ON bookmarks (user_id, url_normalized);
CREATE INDEX IF NOT EXISTS ix_bookmarks_user_folder_sort ON bookmarks (user_id, folder_id, sort_order);
CREATE INDEX IF NOT EXISTS ix_bookmarks_user_id ON bookmarks (user_id);
CREATE INDEX IF NOT EXISTS ix_bookmarks_folder_id ON bookmarks (folder_id);

CREATE TABLE IF NOT EXISTS tags (
  id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  name VARCHAR(128) NOT NULL,
  color VARCHAR(32),
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW() NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_tag_user_name UNIQUE (user_id, name),
  FOREIGN KEY(user_id) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS ix_tags_user_id ON tags (user_id);

CREATE TABLE IF NOT EXISTS bookmark_tags (
  id SERIAL PRIMARY KEY,
  bookmark_id VARCHAR(36) NOT NULL,
  tag_id VARCHAR(36) NOT NULL,
  CONSTRAINT uq_bookmark_tag UNIQUE (bookmark_id, tag_id),
  FOREIGN KEY(bookmark_id) REFERENCES bookmarks (id),
  FOREIGN KEY(tag_id) REFERENCES tags (id)
);
CREATE INDEX IF NOT EXISTS ix_bookmark_tags_bookmark_id ON bookmark_tags (bookmark_id);
CREATE INDEX IF NOT EXISTS ix_bookmark_tags_tag_id ON bookmark_tags (tag_id);

CREATE TABLE IF NOT EXISTS boards (
  id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(32) NOT NULL DEFAULT 'ai_channels',
  source_folder_ids TEXT NOT NULL DEFAULT '[]',
  schema_version INTEGER NOT NULL DEFAULT 1,
  last_full_scan_at TIMESTAMP WITHOUT TIME ZONE,
  last_incremental_cursor INTEGER,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW() NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY(user_id) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS ix_boards_user_id ON boards (user_id);

CREATE TABLE IF NOT EXISTS board_groups (
  id VARCHAR(36) NOT NULL,
  board_id VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  color VARCHAR(32),
  keywords TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  collapsed BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (id),
  FOREIGN KEY(board_id) REFERENCES boards (id)
);
CREATE INDEX IF NOT EXISTS ix_board_groups_board_id ON board_groups (board_id);

CREATE TABLE IF NOT EXISTS annotations (
  id VARCHAR(36) NOT NULL,
  board_id VARCHAR(36) NOT NULL,
  bookmark_id VARCHAR(36) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  risk VARCHAR(16) NOT NULL DEFAULT '',
  price_tag VARCHAR(16) NOT NULL DEFAULT '',
  category VARCHAR(255),
  group_id VARCHAR(36),
  secondary_group_ids TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  source_ref VARCHAR(255),
  source_folder_id VARCHAR(36),
  source_folder_path TEXT,
  present BOOLEAN NOT NULL DEFAULT TRUE,
  first_seen_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW() NOT NULL,
  last_seen_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW() NOT NULL,
  missing_since TIMESTAMP WITHOUT TIME ZONE,
  annotation_updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW() NOT NULL,
  fields TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (id),
  FOREIGN KEY(board_id) REFERENCES boards (id),
  FOREIGN KEY(bookmark_id) REFERENCES bookmarks (id),
  FOREIGN KEY(group_id) REFERENCES board_groups (id),
  FOREIGN KEY(source_folder_id) REFERENCES folders (id)
);
CREATE INDEX IF NOT EXISTS ix_annotations_board_bookmark ON annotations (board_id, bookmark_id);
CREATE INDEX IF NOT EXISTS ix_annotations_board_id ON annotations (board_id);
CREATE INDEX IF NOT EXISTS ix_annotations_bookmark_id ON annotations (bookmark_id);

CREATE TABLE IF NOT EXISTS settings (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  key VARCHAR(128) NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  is_secret BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT uq_setting_user_key UNIQUE (user_id, key),
  FOREIGN KEY(user_id) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS ix_settings_user_id ON settings (user_id);

CREATE TABLE IF NOT EXISTS op_logs (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  entity_type VARCHAR(32) NOT NULL,
  entity_id VARCHAR(36) NOT NULL,
  action VARCHAR(32) NOT NULL,
  snapshot TEXT,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW() NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS ix_op_logs_user_id_id ON op_logs (user_id, id);

CREATE TABLE IF NOT EXISTS reorder_clocks (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  scope VARCHAR(32) NOT NULL,
  parent_id VARCHAR(36) NOT NULL DEFAULT '',
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW() NOT NULL,
  CONSTRAINT uq_reorder_clock UNIQUE (user_id, scope, parent_id),
  FOREIGN KEY(user_id) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS ix_reorder_clocks_user_id ON reorder_clocks (user_id);

CREATE TABLE IF NOT EXISTS clean_jobs (
  id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  check_invalid BOOLEAN NOT NULL DEFAULT FALSE,
  concurrency INTEGER NOT NULL DEFAULT 8,
  progress DOUBLE PRECISION NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW() NOT NULL,
  finished_at TIMESTAMP WITHOUT TIME ZONE,
  PRIMARY KEY (id),
  FOREIGN KEY(user_id) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS ix_clean_jobs_user_id ON clean_jobs (user_id);

CREATE TABLE IF NOT EXISTS clean_issues (
  id VARCHAR(36) NOT NULL,
  job_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  entity_type VARCHAR(32) NOT NULL,
  entity_id VARCHAR(36) NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW() NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY(job_id) REFERENCES clean_jobs (id),
  FOREIGN KEY(user_id) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS ix_clean_issues_job_id ON clean_issues (job_id);
CREATE INDEX IF NOT EXISTS ix_clean_issues_user_id ON clean_issues (user_id);

CREATE TABLE IF NOT EXISTS share_links (
  id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  token VARCHAR(64) NOT NULL,
  target_type VARCHAR(32) NOT NULL DEFAULT 'folder',
  target_id VARCHAR(36) NOT NULL,
  password_hash VARCHAR(255),
  expires_at TIMESTAMP WITHOUT TIME ZONE,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW() NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (token),
  FOREIGN KEY(user_id) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS ix_share_links_user_id ON share_links (user_id);

CREATE TABLE IF NOT EXISTS rate_limits (
  key VARCHAR(255) NOT NULL,
  window_start DOUBLE PRECISION NOT NULL DEFAULT 0,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key)
);

CREATE TABLE IF NOT EXISTS ai_tasks (
  id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  kind VARCHAR(32) NOT NULL DEFAULT 'batch',
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  progress DOUBLE PRECISION NOT NULL DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '{}',
  result TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW() NOT NULL,
  finished_at TIMESTAMP WITHOUT TIME ZONE,
  PRIMARY KEY (id),
  FOREIGN KEY(user_id) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS ix_ai_tasks_user_id ON ai_tasks (user_id);

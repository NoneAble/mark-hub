-- MarkHub SQLite schema v0001 (fresh install) — full FK graph

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) NOT NULL,
  username VARCHAR(128) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
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
  is_system BOOLEAN NOT NULL DEFAULT 0,
  deleted_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
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
  is_favorite BOOLEAN NOT NULL DEFAULT 0,
  is_archived BOOLEAN NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  ai_summary TEXT,
  ai_category VARCHAR(255),
  link_status VARCHAR(32) NOT NULL DEFAULT 'unknown',
  deleted_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_tag_user_name UNIQUE (user_id, name),
  FOREIGN KEY(user_id) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS ix_tags_user_id ON tags (user_id);

CREATE TABLE IF NOT EXISTS bookmark_tags (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  bookmark_id VARCHAR(36) NOT NULL,
  tag_id VARCHAR(36) NOT NULL,
  CONSTRAINT uq_bookmark_tag UNIQUE (bookmark_id, tag_id),
  FOREIGN KEY(bookmark_id) REFERENCES bookmarks (id),
  FOREIGN KEY(tag_id) REFERENCES tags (id)
);
CREATE INDEX IF NOT EXISTS ix_bookmark_tags_bookmark_id ON bookmark_tags (bookmark_id);
CREATE INDEX IF NOT EXISTS ix_bookmark_tags_tag_id ON bookmark_tags (tag_id);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  user_id VARCHAR(36) NOT NULL,
  "key" VARCHAR(128) NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  is_secret BOOLEAN NOT NULL DEFAULT 0,
  CONSTRAINT uq_setting_user_key UNIQUE (user_id, "key"),
  FOREIGN KEY(user_id) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS ix_settings_user_id ON settings (user_id);

CREATE TABLE IF NOT EXISTS op_logs (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  user_id VARCHAR(36) NOT NULL,
  entity_type VARCHAR(32) NOT NULL,
  entity_id VARCHAR(36) NOT NULL,
  action VARCHAR(32) NOT NULL,
  snapshot TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS ix_op_logs_user_id_id ON op_logs (user_id, id);

CREATE TABLE IF NOT EXISTS reorder_clocks (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  user_id VARCHAR(36) NOT NULL,
  scope VARCHAR(32) NOT NULL,
  parent_id VARCHAR(36) NOT NULL DEFAULT '',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT uq_reorder_clock UNIQUE (user_id, scope, parent_id),
  FOREIGN KEY(user_id) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS ix_reorder_clocks_user_id ON reorder_clocks (user_id);

CREATE TABLE IF NOT EXISTS share_links (
  id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  token VARCHAR(64) NOT NULL,
  target_type VARCHAR(32) NOT NULL DEFAULT 'folder',
  target_id VARCHAR(36) NOT NULL,
  password_hash VARCHAR(255),
  expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (token),
  FOREIGN KEY(user_id) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS ix_share_links_user_id ON share_links (user_id);

CREATE TABLE IF NOT EXISTS rate_limits (
  "key" VARCHAR(255) NOT NULL,
  window_start FLOAT NOT NULL DEFAULT 0,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("key")
);


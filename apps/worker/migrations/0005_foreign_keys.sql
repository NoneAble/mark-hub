-- RQG-DATA-CONSTRAINTS-002: D1 referential integrity
-- Rebuild core tables with FOREIGN KEY clauses and repair orphan rows.
-- Wrangler applies each migration transactionally. Defer newly-created constraints
-- until every parent/child table has been rebuilt; PRAGMA foreign_keys cannot be
-- toggled from inside an active transaction.
PRAGMA defer_foreign_keys = TRUE;

-- Repair invalid-user rows from leaves toward roots before general orphan repair.
DELETE FROM bookmark_tags
WHERE bookmark_id IN (SELECT id FROM bookmarks WHERE user_id NOT IN (SELECT id FROM users))
   OR tag_id IN (SELECT id FROM tags WHERE user_id NOT IN (SELECT id FROM users));

DELETE FROM bookmarks WHERE user_id NOT IN (SELECT id FROM users);
DELETE FROM tags WHERE user_id NOT IN (SELECT id FROM users);
DELETE FROM settings WHERE user_id NOT IN (SELECT id FROM users);
DELETE FROM op_logs WHERE user_id NOT IN (SELECT id FROM users);
DELETE FROM reorder_clocks WHERE user_id NOT IN (SELECT id FROM users);
DELETE FROM share_links WHERE user_id NOT IN (SELECT id FROM users);
DELETE FROM folders WHERE user_id NOT IN (SELECT id FROM users);

-- General orphan repair after root cleanup.
UPDATE folders
SET parent_id = NULL
WHERE parent_id IS NOT NULL
  AND parent_id NOT IN (SELECT id FROM folders);

DELETE FROM bookmarks
WHERE folder_id NOT IN (SELECT id FROM folders)
   OR user_id NOT IN (SELECT id FROM users);

DELETE FROM bookmark_tags
WHERE bookmark_id NOT IN (SELECT id FROM bookmarks)
   OR tag_id NOT IN (SELECT id FROM tags);

-- folders
ALTER TABLE folders RENAME TO folders__old;
CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'private',
  is_system INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (parent_id) REFERENCES folders(id)
);
INSERT INTO folders SELECT id, user_id, parent_id, name, sort_order, visibility, is_system, deleted_at, created_at, updated_at FROM folders__old;
DROP TABLE folders__old;
CREATE INDEX IF NOT EXISTS ix_folders_user_parent ON folders(user_id, parent_id, sort_order);

-- bookmarks
ALTER TABLE bookmarks RENAME TO bookmarks__old;
CREATE TABLE bookmarks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  url_normalized TEXT NOT NULL,
  description TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  is_favorite INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  ai_summary TEXT,
  ai_category TEXT,
  link_status TEXT NOT NULL DEFAULT 'unknown',
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (folder_id) REFERENCES folders(id)
);
INSERT INTO bookmarks SELECT id, user_id, folder_id, title, url, url_normalized, description, visibility, is_favorite, is_archived, sort_order, ai_summary, ai_category, link_status, deleted_at, created_at, updated_at FROM bookmarks__old;
DROP TABLE bookmarks__old;
CREATE INDEX IF NOT EXISTS ix_bookmarks_user_url ON bookmarks(user_id, url_normalized);
CREATE INDEX IF NOT EXISTS ix_bookmarks_user_folder ON bookmarks(user_id, folder_id, sort_order);

-- tags
ALTER TABLE tags RENAME TO tags__old;
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, name),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
INSERT INTO tags SELECT id, user_id, name, color, created_at, updated_at FROM tags__old;
DROP TABLE tags__old;

-- bookmark_tags
ALTER TABLE bookmark_tags RENAME TO bookmark_tags__old;
CREATE TABLE bookmark_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bookmark_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  UNIQUE(bookmark_id, tag_id),
  FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id),
  FOREIGN KEY (tag_id) REFERENCES tags(id)
);
INSERT INTO bookmark_tags (id, bookmark_id, tag_id) SELECT id, bookmark_id, tag_id FROM bookmark_tags__old;
DROP TABLE bookmark_tags__old;

-- settings
ALTER TABLE settings RENAME TO settings__old;
CREATE TABLE settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  is_secret INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, key),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
INSERT INTO settings (id, user_id, key, value, is_secret) SELECT id, user_id, key, value, is_secret FROM settings__old;
DROP TABLE settings__old;

-- op_logs
ALTER TABLE op_logs RENAME TO op_logs__old;
CREATE TABLE op_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  snapshot TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
INSERT INTO op_logs (id, user_id, entity_type, entity_id, action, snapshot, created_at)
SELECT id, user_id, entity_type, entity_id, action, snapshot, created_at FROM op_logs__old;
DROP TABLE op_logs__old;
CREATE INDEX IF NOT EXISTS ix_op_logs_user ON op_logs(user_id, id);

-- reorder_clocks
ALTER TABLE reorder_clocks RENAME TO reorder_clocks__old;
CREATE TABLE reorder_clocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  parent_id TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, scope, parent_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
INSERT INTO reorder_clocks (id, user_id, scope, parent_id, updated_at)
SELECT id, user_id, scope, parent_id, updated_at FROM reorder_clocks__old;
DROP TABLE reorder_clocks__old;

-- share_links
ALTER TABLE share_links RENAME TO share_links__old;
CREATE TABLE share_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  password_hash TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
INSERT INTO share_links SELECT id, user_id, token, target_type, target_id, password_hash, expires_at, created_at FROM share_links__old;
DROP TABLE share_links__old;

-- A bare foreign_key_check only emits result rows. Convert every violation into
-- a CHECK failure so Wrangler rolls back the migration deterministically.
CREATE TABLE __markhub_foreign_key_guard (
  ok INTEGER NOT NULL CHECK (ok = 1)
);
INSERT INTO __markhub_foreign_key_guard (ok)
SELECT 0 FROM pragma_foreign_key_check;
DROP TABLE __markhub_foreign_key_guard;

-- RQG-DATA-CONSTRAINTS-002: repair orphans + enforce full FK graph on upgrades
-- from create_all() / older schemas. Safe to run once; uses table rebuilds
-- because SQLite cannot ADD CONSTRAINT for foreign keys.

PRAGMA foreign_keys = OFF;

-- ---- orphan repair (validate existing rows) ----
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

DELETE FROM tags WHERE user_id NOT IN (SELECT id FROM users);

DELETE FROM settings WHERE user_id NOT IN (SELECT id FROM users);
DELETE FROM op_logs WHERE user_id NOT IN (SELECT id FROM users);
DELETE FROM reorder_clocks WHERE user_id NOT IN (SELECT id FROM users);
DELETE FROM share_links WHERE user_id NOT IN (SELECT id FROM users);
DELETE FROM folders WHERE user_id NOT IN (SELECT id FROM users);

-- ---- rebuild folders with parent_id FK (rename-old → create final name) ----
ALTER TABLE folders RENAME TO folders__old;
CREATE TABLE folders (
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
INSERT INTO folders (
  id, user_id, parent_id, name, sort_order, visibility, is_system,
  deleted_at, created_at, updated_at
)
SELECT
  id, user_id, parent_id, name, sort_order, visibility, is_system,
  deleted_at, created_at, updated_at
FROM folders__old;
DROP TABLE folders__old;
CREATE INDEX IF NOT EXISTS ix_folders_user_parent_sort ON folders (user_id, parent_id, sort_order);
CREATE INDEX IF NOT EXISTS ix_folders_user_id ON folders (user_id);
CREATE INDEX IF NOT EXISTS ix_folders_parent_id ON folders (parent_id);

-- ---- rebuild bookmarks to re-bind folder FK after folders rebuild ----
ALTER TABLE bookmarks RENAME TO bookmarks__old;
CREATE TABLE bookmarks (
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
INSERT INTO bookmarks (
  id, user_id, folder_id, title, url, url_normalized, description, visibility,
  is_favorite, is_archived, sort_order, ai_summary, ai_category, link_status,
  deleted_at, created_at, updated_at
)
SELECT
  id, user_id, folder_id, title, url, url_normalized, description, visibility,
  is_favorite, is_archived, sort_order, ai_summary, ai_category, link_status,
  deleted_at, created_at, updated_at
FROM bookmarks__old;
DROP TABLE bookmarks__old;
CREATE INDEX IF NOT EXISTS ix_bookmarks_user_url_norm ON bookmarks (user_id, url_normalized);
CREATE INDEX IF NOT EXISTS ix_bookmarks_user_folder_sort ON bookmarks (user_id, folder_id, sort_order);
CREATE INDEX IF NOT EXISTS ix_bookmarks_user_id ON bookmarks (user_id);
CREATE INDEX IF NOT EXISTS ix_bookmarks_folder_id ON bookmarks (folder_id);

PRAGMA foreign_keys = ON;

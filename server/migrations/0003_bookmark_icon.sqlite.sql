-- Add bookmark icon URL/path column (favicon support).
-- Also repair bookmark_tags: 0002's bookmarks rename dance rewrote its FK to
-- the dropped "bookmarks__old" table (SQLite rewrites FK references on RENAME
-- even with foreign_keys=OFF), leaving a dangling parent that breaks any
-- INSERT/DELETE on bookmark_tags once foreign_keys=ON.

PRAGMA foreign_keys = OFF;

ALTER TABLE bookmarks ADD COLUMN icon TEXT;

ALTER TABLE bookmark_tags RENAME TO bookmark_tags__old;
CREATE TABLE bookmark_tags (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  bookmark_id VARCHAR(36) NOT NULL,
  tag_id VARCHAR(36) NOT NULL,
  CONSTRAINT uq_bookmark_tag UNIQUE (bookmark_id, tag_id),
  FOREIGN KEY(bookmark_id) REFERENCES bookmarks (id),
  FOREIGN KEY(tag_id) REFERENCES tags (id)
);
INSERT INTO bookmark_tags (id, bookmark_id, tag_id)
SELECT id, bookmark_id, tag_id FROM bookmark_tags__old
WHERE bookmark_id IN (SELECT id FROM bookmarks)
  AND tag_id IN (SELECT id FROM tags);
DROP TABLE bookmark_tags__old;
CREATE INDEX IF NOT EXISTS ix_bookmark_tags_bookmark_id ON bookmark_tags (bookmark_id);
CREATE INDEX IF NOT EXISTS ix_bookmark_tags_tag_id ON bookmark_tags (tag_id);

PRAGMA foreign_keys = ON;

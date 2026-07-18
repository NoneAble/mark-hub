-- Favicon blob storage (metadata auto-fetch).
-- Note: the bookmarks.icon column is added at runtime by ensureIconSchema()
-- (ALTER TABLE guarded by try/catch) so existing and fresh databases converge
-- without a duplicate-column migration failure.
CREATE TABLE IF NOT EXISTS favicon_blobs (
  name TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);

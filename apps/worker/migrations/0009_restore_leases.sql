-- Restore concurrency control + staging TTL (MH-RESTORE-001 / MH-RESTORE-003).
-- One lease row per user; replace_all must hold an unexpired lease from live
-- snapshot through cutover batch, and the batch itself re-checks the lease.
CREATE TABLE IF NOT EXISTS restore_leases (
  user_id TEXT NOT NULL PRIMARY KEY,
  restore_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Staging rows get a creation stamp so the scheduled handler can reclaim
-- rows orphaned by a Worker killed between staging and cutover.
ALTER TABLE restore_staging ADD COLUMN created_at TEXT;
CREATE INDEX IF NOT EXISTS ix_restore_staging_created ON restore_staging(created_at);

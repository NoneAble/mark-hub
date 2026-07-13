-- Size-independent atomic replace_all restores stage rows before a fixed-size live cutover.
CREATE TABLE IF NOT EXISTS restore_staging (
  restore_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (restore_id, kind, entity_key)
);

CREATE INDEX IF NOT EXISTS ix_restore_staging_restore
  ON restore_staging(restore_id, user_id, kind);

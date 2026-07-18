-- RQG-DATA-CONSTRAINTS-002: repair orphans + add missing FK constraints on Postgres

-- orphan repair
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
DELETE FROM folders WHERE user_id NOT IN (SELECT id FROM users);

-- helper: add FK only when missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_folders_parent_id'
  ) THEN
    ALTER TABLE folders
      ADD CONSTRAINT fk_folders_parent_id
      FOREIGN KEY (parent_id) REFERENCES folders (id);
  END IF;
END $$;

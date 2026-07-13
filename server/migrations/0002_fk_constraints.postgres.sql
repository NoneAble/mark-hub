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

DELETE FROM board_groups
WHERE board_id NOT IN (SELECT id FROM boards);

UPDATE annotations SET group_id = NULL
WHERE group_id IS NOT NULL
  AND group_id NOT IN (SELECT id FROM board_groups);

UPDATE annotations SET source_folder_id = NULL
WHERE source_folder_id IS NOT NULL
  AND source_folder_id NOT IN (SELECT id FROM folders);

DELETE FROM annotations
WHERE board_id NOT IN (SELECT id FROM boards)
   OR bookmark_id NOT IN (SELECT id FROM bookmarks);

DELETE FROM boards WHERE user_id NOT IN (SELECT id FROM users);
DELETE FROM settings WHERE user_id NOT IN (SELECT id FROM users);
DELETE FROM op_logs WHERE user_id NOT IN (SELECT id FROM users);
DELETE FROM reorder_clocks WHERE user_id NOT IN (SELECT id FROM users);
DELETE FROM clean_issues
WHERE job_id NOT IN (SELECT id FROM clean_jobs)
   OR user_id NOT IN (SELECT id FROM users);
DELETE FROM clean_jobs WHERE user_id NOT IN (SELECT id FROM users);
DELETE FROM share_links WHERE user_id NOT IN (SELECT id FROM users);
DELETE FROM ai_tasks WHERE user_id NOT IN (SELECT id FROM users);
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

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_annotations_group_id'
  ) THEN
    ALTER TABLE annotations
      ADD CONSTRAINT fk_annotations_group_id
      FOREIGN KEY (group_id) REFERENCES board_groups (id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_annotations_source_folder_id'
  ) THEN
    ALTER TABLE annotations
      ADD CONSTRAINT fk_annotations_source_folder_id
      FOREIGN KEY (source_folder_id) REFERENCES folders (id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_clean_issues_user_id'
  ) THEN
    ALTER TABLE clean_issues
      ADD CONSTRAINT fk_clean_issues_user_id
      FOREIGN KEY (user_id) REFERENCES users (id);
  END IF;
END $$;

-- Add bookmark icon URL/path column (favicon support)
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS icon TEXT;

ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS name TEXT;
CREATE INDEX IF NOT EXISTS user_stats_activity_idx ON user_stats (created_at DESC);
-- Add twin_observation to activities for per-activity twin voice
ALTER TABLE activities ADD COLUMN IF NOT EXISTS twin_observation TEXT;

-- Add micro_wins cache to athlete_ai_profiles
ALTER TABLE athlete_ai_profiles ADD COLUMN IF NOT EXISTS micro_wins JSONB;
ALTER TABLE athlete_ai_profiles ADD COLUMN IF NOT EXISTS micro_wins_generated_at TIMESTAMPTZ;

-- Index for fast lookup of activities needing observations
CREATE INDEX IF NOT EXISTS idx_activities_twin_observation 
  ON activities (athlete_id, activity_date DESC) 
  WHERE twin_observation IS NULL;

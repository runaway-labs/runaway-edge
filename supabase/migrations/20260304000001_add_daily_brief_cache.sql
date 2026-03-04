ALTER TABLE athletes
  ADD COLUMN IF NOT EXISTS daily_brief JSONB,
  ADD COLUMN IF NOT EXISTS daily_brief_generated_at TIMESTAMPTZ;

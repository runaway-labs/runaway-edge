-- Migration: Add Garmin fitness stats columns to athletes table
-- Stores cached fitness metrics from Garmin Health API

ALTER TABLE athletes
ADD COLUMN IF NOT EXISTS garmin_fitness_stats JSONB,
ADD COLUMN IF NOT EXISTS garmin_stats_updated_at TIMESTAMPTZ;

-- Add index for querying athletes with recent stats
CREATE INDEX IF NOT EXISTS idx_athletes_garmin_stats_updated
ON athletes(garmin_stats_updated_at)
WHERE garmin_connected = true;

COMMENT ON COLUMN athletes.garmin_fitness_stats IS 'Cached fitness metrics from Garmin (VO2 max, training status, HRV, etc.)';
COMMENT ON COLUMN athletes.garmin_stats_updated_at IS 'When Garmin fitness stats were last fetched';

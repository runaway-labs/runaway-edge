-- Migration: Activities Schema
-- Creates/updates activities table to store Strava activity data

CREATE TABLE IF NOT EXISTS activities (
  id BIGINT PRIMARY KEY,
  athlete_id BIGINT NOT NULL,

  -- Basic activity info
  name TEXT,
  distance DECIMAL,
  moving_time INTEGER,
  elapsed_time INTEGER,
  elevation_gain DECIMAL,
  type TEXT,

  -- Timestamps
  activity_date TIMESTAMPTZ,
  start_date_local TIMESTAMPTZ,
  timezone TEXT,

  -- Location data
  start_latlng DECIMAL[],
  end_latlng DECIMAL[],

  -- Performance metrics
  average_speed DECIMAL,
  max_speed DECIMAL,
  average_cadence DECIMAL,
  average_heart_rate INTEGER,
  max_heart_rate INTEGER,

  -- Elevation
  elev_high DECIMAL,
  elev_low DECIMAL,

  -- Identifiers
  upload_id BIGINT,
  external_id TEXT,

  -- Flags
  trainer BOOLEAN DEFAULT FALSE,
  commute BOOLEAN DEFAULT FALSE,
  manual BOOLEAN DEFAULT FALSE,
  private BOOLEAN DEFAULT FALSE,
  flagged BOOLEAN DEFAULT FALSE,

  -- Workout data
  workout_type INTEGER,
  average_watts DECIMAL,
  max_watts DECIMAL,
  kilojoules DECIMAL,
  device_watts BOOLEAN DEFAULT FALSE,
  suffer_score DECIMAL,

  -- Map data
  map_summary_polyline TEXT,

  -- Metadata
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indices for efficient queries
CREATE INDEX IF NOT EXISTS idx_activities_athlete_id
  ON activities(athlete_id);

CREATE INDEX IF NOT EXISTS idx_activities_activity_date
  ON activities(activity_date DESC);

CREATE INDEX IF NOT EXISTS idx_activities_athlete_date
  ON activities(athlete_id, activity_date DESC);

CREATE INDEX IF NOT EXISTS idx_activities_type
  ON activities(type);

-- Create index for recent activities (common query pattern)
CREATE INDEX IF NOT EXISTS idx_activities_recent
  ON activities(athlete_id, activity_date DESC)
  WHERE activity_date > NOW() - INTERVAL '90 days';

-- Function: Get athlete activity summary
CREATE OR REPLACE FUNCTION get_athlete_activity_summary(
  p_athlete_id BIGINT,
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  total_activities BIGINT,
  total_distance_meters DECIMAL,
  total_time_seconds BIGINT,
  total_elevation_meters DECIMAL,
  avg_distance_meters DECIMAL,
  avg_pace_min_per_km DECIMAL,
  longest_run_meters DECIMAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT AS total_activities,
    SUM(distance)::DECIMAL AS total_distance_meters,
    SUM(moving_time)::BIGINT AS total_time_seconds,
    SUM(elevation_gain)::DECIMAL AS total_elevation_meters,
    AVG(distance)::DECIMAL AS avg_distance_meters,
    CASE
      WHEN SUM(distance) > 0 THEN
        (SUM(moving_time::DECIMAL) / 60 / (SUM(distance) / 1000))::DECIMAL
      ELSE
        NULL
    END AS avg_pace_min_per_km,
    MAX(distance)::DECIMAL AS longest_run_meters
  FROM activities
  WHERE athlete_id = p_athlete_id
    AND activity_date > NOW() - INTERVAL '1 day' * p_days
    AND distance > 0;
END;
$$ LANGUAGE plpgsql;

-- Function: Get recent activities for an athlete
CREATE OR REPLACE FUNCTION get_recent_activities(
  p_athlete_id BIGINT,
  p_limit INTEGER DEFAULT 20
)
RETURNS SETOF activities AS $$
BEGIN
  RETURN QUERY
  SELECT *
  FROM activities
  WHERE athlete_id = p_athlete_id
  ORDER BY activity_date DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- Grant permissions
GRANT SELECT, INSERT, UPDATE ON activities TO authenticated, service_role;

-- Comments for documentation
COMMENT ON TABLE activities IS 'Stores Strava activity data synchronized from the API';
COMMENT ON COLUMN activities.map_summary_polyline IS 'Encoded polyline for activity route visualization';
COMMENT ON COLUMN activities.suffer_score IS 'Strava-calculated intensity score';
COMMENT ON FUNCTION get_athlete_activity_summary IS 'Returns summary statistics for an athlete over a specified period';

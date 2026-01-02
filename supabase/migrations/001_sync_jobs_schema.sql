-- Migration: Sync Jobs Schema
-- Creates tables and functions for Strava activity sync jobs

-- Enable pg_cron extension
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Create sync_jobs table if it doesn't exist
CREATE TABLE IF NOT EXISTS sync_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id BIGINT NOT NULL,
  sync_type TEXT NOT NULL CHECK (sync_type IN ('full', 'incremental')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),

  -- Timestamps for sync window
  after_timestamp TIMESTAMPTZ,
  before_timestamp TIMESTAMPTZ,

  -- Job lifecycle timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  -- Progress tracking
  total_activities INTEGER DEFAULT 0,
  processed_activities INTEGER DEFAULT 0,
  failed_activities INTEGER DEFAULT 0,

  -- Error handling
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,

  -- Metadata (JSON for flexibility)
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Create index on status and created_at for efficient job queue queries
CREATE INDEX IF NOT EXISTS idx_sync_jobs_status_created
  ON sync_jobs(status, created_at)
  WHERE status IN ('pending', 'in_progress');

-- Create index on athlete_id for athlete-specific queries
CREATE INDEX IF NOT EXISTS idx_sync_jobs_athlete_id
  ON sync_jobs(athlete_id);

-- Create strava_tokens table if it doesn't exist
CREATE TABLE IF NOT EXISTS strava_tokens (
  athlete_id BIGINT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create index on expires_at for token refresh queries
CREATE INDEX IF NOT EXISTS idx_strava_tokens_expires_at
  ON strava_tokens(expires_at);

-- Create athletes table if it doesn't exist (for OAuth data)
CREATE TABLE IF NOT EXISTS athletes (
  id BIGINT PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  profile_picture TEXT,
  city TEXT,
  state TEXT,
  country TEXT,
  sex TEXT,
  weight DECIMAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Function: Clean up old completed jobs (older than 30 days)
CREATE OR REPLACE FUNCTION cleanup_old_sync_jobs()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM sync_jobs
  WHERE status IN ('completed', 'failed')
    AND completed_at < NOW() - INTERVAL '30 days';

  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Function: Reset stuck jobs (in_progress for more than 30 minutes)
CREATE OR REPLACE FUNCTION reset_stuck_sync_jobs()
RETURNS INTEGER AS $$
DECLARE
  reset_count INTEGER;
BEGIN
  UPDATE sync_jobs
  SET
    status = 'pending',
    started_at = NULL,
    retry_count = retry_count + 1,
    error_message = 'Job timed out and was reset'
  WHERE status = 'in_progress'
    AND started_at < NOW() - INTERVAL '30 minutes'
    AND retry_count < 3; -- Only retry up to 3 times

  GET DIAGNOSTICS reset_count = ROW_COUNT;

  -- Mark jobs that have been retried too many times as failed
  UPDATE sync_jobs
  SET
    status = 'failed',
    completed_at = NOW(),
    error_message = 'Job exceeded maximum retry count (3)'
  WHERE status = 'in_progress'
    AND started_at < NOW() - INTERVAL '30 minutes'
    AND retry_count >= 3;

  RETURN reset_count;
END;
$$ LANGUAGE plpgsql;

-- Function: Get job statistics
CREATE OR REPLACE FUNCTION get_sync_job_stats()
RETURNS TABLE (
  total_pending BIGINT,
  total_in_progress BIGINT,
  total_completed_24h BIGINT,
  total_failed_24h BIGINT,
  avg_processing_time_minutes DECIMAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*) FILTER (WHERE status = 'pending') AS total_pending,
    COUNT(*) FILTER (WHERE status = 'in_progress') AS total_in_progress,
    COUNT(*) FILTER (WHERE status = 'completed' AND completed_at > NOW() - INTERVAL '24 hours') AS total_completed_24h,
    COUNT(*) FILTER (WHERE status = 'failed' AND completed_at > NOW() - INTERVAL '24 hours') AS total_failed_24h,
    AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) / 60) FILTER (
      WHERE status = 'completed'
        AND completed_at > NOW() - INTERVAL '24 hours'
        AND started_at IS NOT NULL
    ) AS avg_processing_time_minutes
  FROM sync_jobs;
END;
$$ LANGUAGE plpgsql;

-- Grant necessary permissions
GRANT SELECT, INSERT, UPDATE ON sync_jobs TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON strava_tokens TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON athletes TO authenticated, service_role;

-- Comment on tables and columns for documentation
COMMENT ON TABLE sync_jobs IS 'Tracks Strava activity sync jobs with their status and progress';
COMMENT ON COLUMN sync_jobs.metadata IS 'Flexible JSON field for job-specific metadata like max_activities limit';
COMMENT ON COLUMN sync_jobs.retry_count IS 'Number of times this job has been retried after failures';

COMMENT ON TABLE strava_tokens IS 'Stores Strava OAuth tokens for each athlete';
COMMENT ON TABLE athletes IS 'Stores basic athlete information from Strava OAuth';

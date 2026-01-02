-- Migration: Setup pg_cron for automated sync job processing
-- Schedules periodic tasks to process sync jobs and maintain the system

-- Note: pg_cron extension should already be enabled from previous migration

-- Schedule 1: Process sync jobs every 5 minutes
-- Calls the sync-processor Edge Function via HTTP
SELECT cron.schedule(
  'process-sync-jobs',
  '*/5 * * * *', -- Every 5 minutes
  $$
  SELECT
    net.http_post(
      url := 'https://your-project-ref.supabase.co/functions/v1/sync-processor',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
      ),
      body := '{}'::jsonb
    ) AS request_id;
  $$
);

-- Schedule 2: Reset stuck jobs every 10 minutes
-- Jobs that have been in_progress for more than 30 minutes
SELECT cron.schedule(
  'reset-stuck-jobs',
  '*/10 * * * *', -- Every 10 minutes
  $$
  SELECT reset_stuck_sync_jobs();
  $$
);

-- Schedule 3: Clean up old jobs daily at 2 AM
-- Removes completed/failed jobs older than 30 days
SELECT cron.schedule(
  'cleanup-old-jobs',
  '0 2 * * *', -- Daily at 2 AM UTC
  $$
  SELECT cleanup_old_sync_jobs();
  $$
);

-- View all scheduled jobs
-- Run this to see current cron jobs:
-- SELECT * FROM cron.job;

-- To unschedule a job (if needed):
-- SELECT cron.unschedule('process-sync-jobs');
-- SELECT cron.unschedule('reset-stuck-jobs');
-- SELECT cron.unschedule('cleanup-old-jobs');

COMMENT ON EXTENSION pg_cron IS 'PostgreSQL-based cron scheduler for automated job processing';

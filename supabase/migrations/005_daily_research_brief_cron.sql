-- Migration: Schedule daily research brief generation
-- Runs every morning at 6 AM UTC to generate AI-powered research recommendations
-- The brief is committed to the Runaway iOS repo as a markdown file

-- Ensure pg_net extension is enabled for HTTP calls
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Schedule: Daily research brief at 6 AM UTC
-- Calls the daily-research-brief Edge Function via HTTP
SELECT cron.schedule(
  'daily-research-brief',
  '0 6 * * *', -- Daily at 6 AM UTC
  $$
  SELECT
    net.http_post(
      url := current_setting('app.settings.supabase_url', true) || '/functions/v1/daily-research-brief',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
      ),
      body := jsonb_build_object('trigger', 'scheduled', 'timestamp', now()::text)
    ) AS request_id;
  $$
);

-- Alternative: If app.settings are not configured, use this instead:
-- Replace YOUR_PROJECT_REF with your actual Supabase project reference
-- Replace YOUR_SERVICE_ROLE_KEY with your actual service role key
/*
SELECT cron.schedule(
  'daily-research-brief',
  '0 6 * * *', -- Daily at 6 AM UTC (adjust for your timezone if needed)
  $$
  SELECT
    net.http_post(
      url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/daily-research-brief',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY'
      ),
      body := '{}'::jsonb
    ) AS request_id;
  $$
);
*/

-- View the scheduled job:
-- SELECT * FROM cron.job WHERE jobname = 'daily-research-brief';

-- Check job run history:
-- SELECT * FROM cron.job_run_details WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'daily-research-brief') ORDER BY start_time DESC LIMIT 10;

-- To manually trigger (for testing):
-- Run this in SQL Editor, replacing with your project details:
/*
SELECT
  net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/daily-research-brief',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer YOUR_ANON_KEY'
    ),
    body := '{}'::jsonb
  ) AS request_id;
*/

-- To unschedule (if needed):
-- SELECT cron.unschedule('daily-research-brief');

-- To change the schedule (e.g., 7 AM instead of 6 AM):
-- SELECT cron.unschedule('daily-research-brief');
-- Then re-run the schedule command with new time

COMMENT ON FUNCTION cron.schedule IS 'Daily research brief scheduled for 6 AM UTC - generates AI-powered app improvement recommendations';

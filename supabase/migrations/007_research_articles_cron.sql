-- Migration: Schedule daily article fetch at 6 AM UTC
-- Fetches running/fitness articles from RSS feeds and stores in database
-- This eliminates load times in the iOS app - articles are pre-fetched

-- Ensure pg_net extension is enabled for HTTP calls
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Schedule: Daily article fetch at 6 AM UTC
-- Calls the fetch-daily-articles Edge Function via HTTP
SELECT cron.schedule(
  'fetch-daily-articles',
  '0 6 * * *', -- Daily at 6 AM UTC
  $$
  SELECT
    net.http_post(
      url := current_setting('app.settings.supabase_url', true) || '/functions/v1/fetch-daily-articles',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
      ),
      body := jsonb_build_object('trigger', 'scheduled', 'timestamp', now()::text)
    ) AS request_id;
  $$
);

-- View the scheduled job:
-- SELECT * FROM cron.job WHERE jobname = 'fetch-daily-articles';

-- Check job run history:
-- SELECT * FROM cron.job_run_details WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'fetch-daily-articles') ORDER BY start_time DESC LIMIT 10;

-- To manually trigger (for testing), run in SQL Editor:
-- SELECT net.http_post(
--   url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/fetch-daily-articles',
--   headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY'),
--   body := '{}'::jsonb
-- );

-- To unschedule (if needed):
-- SELECT cron.unschedule('fetch-daily-articles');

COMMENT ON FUNCTION cron.schedule IS 'Daily article fetch scheduled for 6 AM UTC - pre-fetches running articles for instant app loading';

-- Disable cron jobs for check-conditions and process-deliveries.
-- These functions are now triggered manually via HTTP instead of on a schedule.

SELECT cron.unschedule('check-conditions')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'check-conditions');

SELECT cron.unschedule('process-deliveries')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-deliveries');

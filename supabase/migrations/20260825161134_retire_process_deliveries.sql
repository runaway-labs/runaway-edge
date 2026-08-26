-- Permanently retire the process-deliveries caller.
-- Delivery and alert history remain intact; only the scheduled sender is removed.
select cron.unschedule('process-deliveries-job')
where exists (select 1 from cron.job where jobname = 'process-deliveries-job');

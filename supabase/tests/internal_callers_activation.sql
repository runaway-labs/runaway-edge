set search_path = public, extensions;
create extension if not exists pgtap with schema extensions;

begin;
select plan(9);

select is(
  (select count(*) from cron.job where jobname in (
    'check-conditions-job', 'process-deliveries-job', 'sync-race-directory-job',
    'daily-research-brief', 'fetch-daily-articles'
  )),
  5::bigint,
  'activation retains exactly the five reviewed internal schedules'
);

select is(
  (select count(*) from cron.job where jobname in (
    'check-conditions-job', 'process-deliveries-job', 'sync-race-directory-job',
    'daily-research-brief', 'fetch-daily-articles'
  ) and position('X-Runaway-Internal-Secret' in command) > 0
    and position('private.require_internal_job_secret()' in command) > 0),
  5::bigint,
  'all five cron commands use only the dedicated secret'
);

select is(
  (select count(*) from cron.job where active and jobname in (
    'check-conditions-job', 'daily-research-brief', 'fetch-daily-articles'
  )),
  3::bigint,
  'the three previously active schedules are active after activation'
);

select is(
  (select count(*) from cron.job where not active and jobname in (
    'process-deliveries-job', 'sync-race-directory-job'
  )),
  2::bigint,
  'process deliveries and race directory schedules remain inactive'
);

select is(
  (select count(*) from cron.job where
    (jobname = 'check-conditions-job' and schedule = '*/30 * * * *') or
    (jobname = 'process-deliveries-job' and schedule = '* * * * *') or
    (jobname = 'sync-race-directory-job' and schedule = '0 2 * * *') or
    (jobname = 'daily-research-brief' and schedule = '0 6 * * *') or
    (jobname = 'fetch-daily-articles' and schedule = '0 6 * * *')
  ),
  5::bigint,
  'every reviewed cron schedule is preserved exactly'
);

select is(
  (select count(*) from pg_trigger where tgrelid = 'public.activities'::regclass and not tgisinternal and tgname = 'runaway_activity_insert_internal'),
  1::bigint,
  'exactly one dedicated activity notification trigger exists'
);

select is(
  (select count(*) from pg_trigger where tgrelid = 'public.activities'::regclass and not tgisinternal and tgname in ('activity-insert-notification', 'on_activity_insert')),
  0::bigint,
  'both legacy activity callers remain absent'
);

select like(
  pg_get_functiondef('public.notify_activity_insert()'::regprocedure),
  '%X-Runaway-Internal-Secret%',
  'the sole activity caller sends the dedicated-secret header'
);

select unlike(
  pg_get_functiondef('public.notify_activity_insert()'::regprocedure),
  '%Authorization%',
  'the sole activity caller has no bearer fallback'
);

select * from finish();
rollback;

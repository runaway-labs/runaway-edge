set search_path = public, extensions;
create extension if not exists pgtap with schema extensions;

begin;
select plan(9);

select is(
  (select count(*) from cron.job where jobname in (
    'check-conditions-job', 'sync-race-directory-job',
    'daily-research-brief', 'fetch-daily-articles'
  )),
  4::bigint,
  'activation retains exactly the four reviewed internal schedules'
);

select is(
  (select count(*) from cron.job where jobname in (
    'check-conditions-job', 'sync-race-directory-job',
    'daily-research-brief', 'fetch-daily-articles'
  ) and position('X-Runaway-Internal-Secret' in command) > 0
    and position('private.require_internal_job_secret()' in command) > 0),
  4::bigint,
  'all four cron commands use only the dedicated secret'
);

select is(
  (select count(*) from cron.job where active and jobname in (
    'check-conditions-job', 'daily-research-brief', 'fetch-daily-articles'
  )),
  3::bigint,
  'the three previously active schedules are active after activation'
);

select is(
  (select count(*) from cron.job where not active and jobname = 'sync-race-directory-job'),
  1::bigint,
  'the race directory schedule remains inactive'
);

select is(
  (select count(*) from cron.job where
    (jobname = 'check-conditions-job' and schedule = '*/30 * * * *') or
    (jobname = 'sync-race-directory-job' and schedule = '0 2 * * *') or
    (jobname = 'daily-research-brief' and schedule = '0 6 * * *') or
    (jobname = 'fetch-daily-articles' and schedule = '0 6 * * *')
  ),
  4::bigint,
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

select ok(
  pg_get_functiondef('public.notify_activity_insert()'::regprocedure)
    like '%X-Runaway-Internal-Secret%',
  'the sole activity caller sends the dedicated-secret header'
);

select ok(
  pg_get_functiondef('public.notify_activity_insert()'::regprocedure)
    not like '%Authorization%',
  'the sole activity caller has no bearer fallback'
);

select * from finish();
rollback;

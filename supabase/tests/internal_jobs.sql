\set ON_ERROR_STOP on
\getenv task4_database_url TEST_DATABASE_URL

set search_path = public, extensions;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;

begin;
insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  'f4000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated',
  'task-4-internal-jobs@example.test', 'not-used-by-this-test', now(),
  '{}'::jsonb, '{}'::jsonb, now(), now()
);
insert into public.races (
  id, director_id, name, race_date, race_time, location_name,
  latitude, longitude, timezone, status
) values (
  'f4000000-0000-0000-0000-000000000002',
  'f4000000-0000-0000-0000-000000000001',
  'Task 4 claim race', current_date + 1, '08:00:00', 'Test location',
  0, 0, 'UTC', 'upcoming'
);
insert into public.runners (id, race_id, name, email, notification_preferences)
values (
  'f4000000-0000-0000-0000-000000000003',
  'f4000000-0000-0000-0000-000000000002',
  'Task 4 runner', 'task-4-runner@example.test',
  '{"sms": false, "email": true}'::jsonb
);
insert into public.alerts (id, race_id, alert_type, subject, message)
values (
  'f4000000-0000-0000-0000-000000000004',
  'f4000000-0000-0000-0000-000000000002',
  'automatic', 'Task 4 subject', 'Task 4 message'
);
insert into public.alert_deliveries (
  id, alert_id, runner_id, channel, recipient, status,
  claim_generation, lease_expires_at
) values
  ('f4000000-0000-0000-0000-000000000010', 'f4000000-0000-0000-0000-000000000004', 'f4000000-0000-0000-0000-000000000003', 'email', 'task-4-runner@example.test', 'pending', 0, null),
  ('f4000000-0000-0000-0000-000000000011', 'f4000000-0000-0000-0000-000000000004', 'f4000000-0000-0000-0000-000000000003', 'email', 'task-4-runner@example.test', 'pending', 0, null),
  ('f4000000-0000-0000-0000-000000000012', 'f4000000-0000-0000-0000-000000000004', 'f4000000-0000-0000-0000-000000000003', 'email', 'task-4-runner@example.test', 'sent', 1, null),
  ('f4000000-0000-0000-0000-000000000013', 'f4000000-0000-0000-0000-000000000004', 'f4000000-0000-0000-0000-000000000003', 'email', 'task-4-runner@example.test', 'processing', 4, now() - interval '1 minute'),
  ('f4000000-0000-0000-0000-000000000014', 'f4000000-0000-0000-0000-000000000004', 'f4000000-0000-0000-0000-000000000003', 'email', 'task-4-runner@example.test', 'processing', 7, now() + interval '10 minutes');
commit;

begin;
select plan(36);

select ok(to_regprocedure('private.claim_pending_deliveries(integer)') is not null, 'private leased claim exists');
select ok(to_regprocedure('public.claim_pending_deliveries(integer)') is not null, 'service-role claim wrapper exists');
select ok(to_regprocedure('private.begin_delivery_submission(uuid,bigint)') is not null, 'private fenced submission transition exists');
select ok(to_regprocedure('public.begin_delivery_submission(uuid,bigint)') is not null, 'service-role submission wrapper exists');
select ok(to_regprocedure('private.finalize_delivery(uuid,bigint,text,text,text,timestamp with time zone)') is not null, 'private fenced finalizer exists');
select ok(to_regprocedure('public.finalize_delivery(uuid,bigint,text,text,text,timestamp with time zone)') is not null, 'service-role finalizer wrapper exists');
select ok(has_function_privilege('service_role', 'private.claim_pending_deliveries(integer)', 'execute'), 'service_role can claim');
select ok(not has_function_privilege('anon', 'private.claim_pending_deliveries(integer)', 'execute'), 'anon cannot claim');
select ok(not has_function_privilege('authenticated', 'private.claim_pending_deliveries(integer)', 'execute'), 'authenticated cannot claim');
select ok(has_function_privilege('service_role', 'private.begin_delivery_submission(uuid,bigint)', 'execute'), 'service_role can begin submission');
select ok(has_function_privilege('service_role', 'private.finalize_delivery(uuid,bigint,text,text,text,timestamp with time zone)', 'execute'), 'service_role can finalize');
select has_column('public', 'alert_deliveries', 'claim_generation', 'deliveries persist a fencing generation');
select has_column('public', 'alert_deliveries', 'lease_expires_at', 'deliveries persist an expiring lease');

delete from vault.secrets where name = 'internal_job_secret';
select throws_ok(
  $$select private.require_internal_job_secret()$$,
  '22023', 'internal job secret is not configured',
  'missing Vault secret fails closed before HTTP'
);
select vault.create_secret(
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  'internal_job_secret'
);
select is(
  private.require_internal_job_secret(),
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  'Vault accepts canonical lowercase hex encoding'
);

select is(
  (select count(*) from cron.job where jobname in (
    'check-conditions-job', 'process-deliveries-job', 'sync-race-directory-job',
    'daily-research-brief', 'fetch-daily-articles'
  )),
  5::bigint, 'all five internal HTTP cron callers are installed'
);
select is(
  (select count(*) from cron.job where jobname in (
    'check-conditions-job', 'process-deliveries-job', 'sync-race-directory-job',
    'daily-research-brief', 'fetch-daily-articles'
  ) and position('private.require_internal_job_secret()' in command) > 0),
  5::bigint, 'every cron caller validates Vault at execution time'
);
select is(
  (select count(*) from cron.job where jobname in (
    'check-conditions-job', 'process-deliveries-job', 'sync-race-directory-job',
    'daily-research-brief', 'fetch-daily-articles'
  ) and (position('Authorization' in command) > 0 or position('service_role' in command) > 0)),
  0::bigint, 'cron has no bearer or service-role fallback'
);
select ok(
  position('private.require_internal_job_secret()' in pg_get_functiondef('public.notify_activity_insert()'::regprocedure)) > 0,
  'activity trigger validates Vault before HTTP'
);

create temporary table task4_claim_results (
  worker text not null,
  delivery_id uuid not null,
  claim_generation bigint not null,
  lease_expires_at timestamptz not null
) on commit drop;
create temporary table task4_claim_timing (started_at timestamptz not null) on commit drop;
insert into task4_claim_timing values (clock_timestamp());

select dblink_connect('task4_worker_a', :'task4_database_url');
select dblink_connect('task4_worker_b', :'task4_database_url');
select dblink_send_query(
  'task4_worker_a',
  $$with claimed as materialized (select * from public.claim_pending_deliveries(1)),
    held as materialized (select pg_sleep(2))
    select claimed.id, claimed.claim_generation, claimed.lease_expires_at
    from claimed cross join held$$
);
select pg_sleep(0.1);
select dblink_send_query(
  'task4_worker_b',
  $$with claimed as materialized (select * from public.claim_pending_deliveries(1)),
    held as materialized (select pg_sleep(2))
    select claimed.id, claimed.claim_generation, claimed.lease_expires_at
    from claimed cross join held$$
);
insert into task4_claim_results
select 'worker_a', delivery_id, claim_generation, lease_expires_at
from dblink_get_result('task4_worker_a')
  as result(delivery_id uuid, claim_generation bigint, lease_expires_at timestamptz);
insert into task4_claim_results
select 'worker_b', delivery_id, claim_generation, lease_expires_at
from dblink_get_result('task4_worker_b')
  as result(delivery_id uuid, claim_generation bigint, lease_expires_at timestamptz);
select dblink_disconnect('task4_worker_a');
select dblink_disconnect('task4_worker_b');

select is((select count(*) from task4_claim_results), 2::bigint, 'two workers claim while locks are held');
select is((select count(distinct delivery_id) from task4_claim_results), 2::bigint, 'workers never claim the same ID');
select cmp_ok(
  extract(epoch from clock_timestamp() - (select started_at from task4_claim_timing)),
  '<', 3.5, 'SKIP LOCKED prevents serial blocking'
);
select ok(
  not exists (
    select 1
    from task4_claim_results result
    join public.alert_deliveries delivery on delivery.id = result.delivery_id
    where result.claim_generation <> 1
      or result.lease_expires_at <= clock_timestamp()
      or delivery.status <> 'processing'
      or delivery.claim_generation <> result.claim_generation
  ),
  'claim atomically persists matching lease and fence'
);

create temporary table task4_reclaimed as
select * from public.claim_pending_deliveries(1);
select is((select id from task4_reclaimed), 'f4000000-0000-0000-0000-000000000013'::uuid, 'expired processing is reclaimable');
select is((select claim_generation from task4_reclaimed), 5::bigint, 'reclaim increments the fence');
select is((select count(*) from public.claim_pending_deliveries(1)), 0::bigint, 'unexpired processing is not reclaimable');

set local role service_role;
select is(
  public.finalize_delivery('f4000000-0000-0000-0000-000000000013', 4, 'failed', null, 'stale', null),
  false, 'stale finalizer cannot overwrite reclaimed work'
);
select is(
  public.begin_delivery_submission('f4000000-0000-0000-0000-000000000013', 5),
  true, 'current fence crosses the provider boundary'
);
select is(
  (select status from public.alert_deliveries where id = 'f4000000-0000-0000-0000-000000000013'),
  'submitting', 'provider boundary is persisted before submission'
);
select is(
  public.finalize_delivery('f4000000-0000-0000-0000-000000000013', 4, 'sent', 'stale-id', null, now()),
  false, 'stale worker remains fenced after submission begins'
);
select is(
  public.finalize_delivery('f4000000-0000-0000-0000-000000000013', 5, 'sent', 'current-id', null, now()),
  true, 'current fence finalizes submitted work'
);
select is(
  (select status || ':' || provider_message_id from public.alert_deliveries where id = 'f4000000-0000-0000-0000-000000000013'),
  'sent:current-id', 'only current finalizer writes provider result'
);
select is(
  public.finalize_delivery((select min(delivery_id) from task4_claim_results), 1, 'retryable', null, 'pre-provider', null),
  true, 'known pre-provider failure finalizes from processing'
);
select is(
  (select status from public.alert_deliveries where id = (select min(delivery_id) from task4_claim_results)),
  'retryable', 'pre-provider retry state is persisted'
);
select is(
  public.finalize_delivery((select max(delivery_id) from task4_claim_results), 0, 'failed', null, 'stale', null),
  false, 'stale failure finalizer is rejected'
);
select is(
  public.finalize_delivery((select max(delivery_id) from task4_claim_results), 1, 'failed', null, 'terminal', null),
  true, 'current fence persists terminal failure'
);
reset role;

select * from finish();
rollback;

begin;
delete from public.alert_deliveries where alert_id = 'f4000000-0000-0000-0000-000000000004';
delete from public.alerts where id = 'f4000000-0000-0000-0000-000000000004';
delete from public.runners where id = 'f4000000-0000-0000-0000-000000000003';
delete from public.races where id = 'f4000000-0000-0000-0000-000000000002';
delete from auth.users where id = 'f4000000-0000-0000-0000-000000000001';
commit;

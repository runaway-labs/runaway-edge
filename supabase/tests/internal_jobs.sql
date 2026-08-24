\set ON_ERROR_STOP on
\getenv task4_database_url TEST_DATABASE_URL

set search_path = public, extensions;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;

begin;

insert into auth.users (
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values (
  'f4000000-0000-0000-0000-000000000001',
  'authenticated',
  'authenticated',
  'task-4-internal-jobs@example.test',
  'not-used-by-this-test',
  now(),
  '{}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

insert into public.races (
  id,
  director_id,
  name,
  race_date,
  race_time,
  location_name,
  latitude,
  longitude,
  timezone,
  status
)
values (
  'f4000000-0000-0000-0000-000000000002',
  'f4000000-0000-0000-0000-000000000001',
  'Task 4 claim race',
  current_date + 1,
  '08:00:00',
  'Test location',
  0,
  0,
  'UTC',
  'upcoming'
);

insert into public.runners (
  id,
  race_id,
  name,
  email,
  notification_preferences
)
values (
  'f4000000-0000-0000-0000-000000000003',
  'f4000000-0000-0000-0000-000000000002',
  'Task 4 runner',
  'task-4-runner@example.test',
  '{"sms": false, "email": true}'::jsonb
);

insert into public.alerts (
  id,
  race_id,
  alert_type,
  subject,
  message
)
values (
  'f4000000-0000-0000-0000-000000000004',
  'f4000000-0000-0000-0000-000000000002',
  'automatic',
  'Task 4 subject',
  'Task 4 message'
);

insert into public.alert_deliveries (
  id,
  alert_id,
  runner_id,
  channel,
  recipient,
  status
)
values
  (
    'f4000000-0000-0000-0000-000000000010',
    'f4000000-0000-0000-0000-000000000004',
    'f4000000-0000-0000-0000-000000000003',
    'email',
    'task-4-runner@example.test',
    'pending'
  ),
  (
    'f4000000-0000-0000-0000-000000000011',
    'f4000000-0000-0000-0000-000000000004',
    'f4000000-0000-0000-0000-000000000003',
    'email',
    'task-4-runner@example.test',
    'pending'
  ),
  (
    'f4000000-0000-0000-0000-000000000012',
    'f4000000-0000-0000-0000-000000000004',
    'f4000000-0000-0000-0000-000000000003',
    'email',
    'task-4-runner@example.test',
    'sent'
  );

commit;

begin;
select plan(14);

select ok(
  to_regprocedure('private.claim_pending_deliveries(integer)') is not null,
  'the private atomic claim function exists'
);

select ok(
  to_regprocedure('public.claim_pending_deliveries(integer)') is not null,
  'the service-role Data API wrapper exists'
);

select ok(
  has_function_privilege('service_role', 'private.claim_pending_deliveries(integer)', 'execute'),
  'service_role can execute the private claim function'
);

select ok(
  not has_function_privilege('anon', 'private.claim_pending_deliveries(integer)', 'execute'),
  'anon cannot execute the private claim function'
);

select ok(
  not has_function_privilege('authenticated', 'private.claim_pending_deliveries(integer)', 'execute'),
  'authenticated cannot execute the private claim function'
);

select ok(
  has_function_privilege('service_role', 'public.claim_pending_deliveries(integer)', 'execute'),
  'service_role can execute the Data API claim wrapper'
);

select ok(
  not has_function_privilege('anon', 'public.claim_pending_deliveries(integer)', 'execute'),
  'anon cannot execute the Data API claim wrapper'
);

select ok(
  not has_function_privilege('authenticated', 'public.claim_pending_deliveries(integer)', 'execute'),
  'authenticated cannot execute the Data API claim wrapper'
);

select col_not_null(
  'public',
  'alert_deliveries',
  'idempotency_key',
  'every delivery has a persisted idempotency key'
);

create temporary table task4_claim_results (
  worker text not null,
  delivery_id uuid not null
) on commit drop;

create temporary table task4_claim_timing (
  started_at timestamptz not null
) on commit drop;

insert into task4_claim_timing values (clock_timestamp());

select dblink_connect('task4_worker_a', :'task4_database_url');
select dblink_connect('task4_worker_b', :'task4_database_url');

select dblink_send_query(
  'task4_worker_a',
  $$select claimed.id
    from public.claim_pending_deliveries(1) claimed,
         lateral (select pg_sleep(2)) hold$$
);

select pg_sleep(0.1);

select dblink_send_query(
  'task4_worker_b',
  $$select claimed.id
    from public.claim_pending_deliveries(1) claimed,
         lateral (select pg_sleep(2)) hold$$
);

insert into task4_claim_results
select 'worker_a', delivery_id
from dblink_get_result('task4_worker_a') as result(delivery_id uuid);

insert into task4_claim_results
select 'worker_b', delivery_id
from dblink_get_result('task4_worker_b') as result(delivery_id uuid);

select dblink_disconnect('task4_worker_a');
select dblink_disconnect('task4_worker_b');

select is(
  (select count(*) from task4_claim_results),
  2::bigint,
  'two concurrent workers each claim one delivery'
);

select is(
  (select count(distinct delivery_id) from task4_claim_results),
  2::bigint,
  'concurrent workers never claim the same delivery ID'
);

select cmp_ok(
  extract(epoch from clock_timestamp() - (select started_at from task4_claim_timing)),
  '<',
  3.5,
  'SKIP LOCKED lets both claims complete without serial blocking'
);

select is(
  (
    select status
    from public.alert_deliveries
    where id = 'f4000000-0000-0000-0000-000000000012'
  ),
  'sent',
  'a sent delivery is never reclaimed'
);

update public.alert_deliveries
set status = 'retryable'
where id = (select min(delivery_id) from task4_claim_results);

set local role service_role;

select is(
  (
    select id
    from public.claim_pending_deliveries(1)
  ),
  (select min(delivery_id) from task4_claim_results),
  'a retryable delivery can be claimed exactly once again'
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

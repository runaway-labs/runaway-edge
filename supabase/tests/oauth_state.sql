\getenv task5_database_url TEST_DATABASE_URL

set search_path = public, extensions;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;

begin;
select plan(36);

select has_table('private', 'oauth_states', 'private OAuth state table exists');
select has_column('private', 'oauth_states', 'state_hash', 'OAuth state stores a hash');
select has_column('private', 'oauth_states', 'provider', 'OAuth state stores its provider');
select has_column('private', 'oauth_states', 'auth_user_id', 'OAuth state binds an auth user');
select has_column('private', 'oauth_states', 'redirect_url', 'OAuth state stores a trusted redirect');
select has_column('private', 'oauth_states', 'expires_at', 'OAuth state expires');
select has_column('private', 'oauth_states', 'consumed_at', 'OAuth state records consumption');
select has_column('private', 'oauth_states', 'created_at', 'OAuth state records creation');

select ok(
  has_table_privilege('service_role', 'private.oauth_states', 'select,insert,update,delete'),
  'service_role alone can persist OAuth state'
);
select ok(not has_table_privilege('anon', 'private.oauth_states', 'select'), 'anon cannot read OAuth state');
select ok(not has_table_privilege('authenticated', 'private.oauth_states', 'select'), 'users cannot read OAuth state');

select has_function(
  'public', 'create_oauth_state',
  array['text', 'text', 'uuid', 'text', 'timestamp with time zone'],
  'service-role creation RPC exists'
);
select has_function(
  'public', 'consume_oauth_state', array['text', 'text'],
  'atomic consumption RPC exists'
);
select has_function('private', 'cleanup_oauth_states', array[]::text[], 'cleanup function exists');
select ok(
  has_function_privilege(
    'service_role',
    'public.create_oauth_state(text,text,uuid,text,timestamp with time zone)',
    'execute'
  ),
  'service_role can create OAuth state'
);
select ok(
  has_function_privilege('service_role', 'public.consume_oauth_state(text,text)', 'execute'),
  'service_role can consume OAuth state'
);
select ok(
  not has_function_privilege('anon', 'public.create_oauth_state(text,text,uuid,text,timestamp with time zone)', 'execute'),
  'anon cannot create OAuth state'
);
select ok(
  not has_function_privilege('authenticated', 'public.consume_oauth_state(text,text)', 'execute'),
  'authenticated callers cannot consume OAuth state'
);

set local role service_role;
select public.create_oauth_state(
  repeat('a', 64), 'strava', '11111111-1111-1111-1111-111111111111',
  'runaway://strava-connected', clock_timestamp() + interval '10 minutes'
);
reset role;

set local role service_role;
select results_eq(
  $query$select auth_user_id, redirect_url from public.consume_oauth_state('strava', repeat('a', 64))$query$,
  $values$values (
    '11111111-1111-1111-1111-111111111111'::uuid,
    'runaway://strava-connected'::text
  )$values$,
  'valid state returns only its server-bound user and redirect'
);
reset role;
select ok(
  (select consumed_at is not null from private.oauth_states where state_hash = repeat('a', 64)),
  'valid state is marked consumed atomically'
);
set local role service_role;
select is_empty(
  $query$select * from public.consume_oauth_state('strava', repeat('a', 64))$query$,
  'replayed state is rejected'
);
reset role;

set local role service_role;
select public.create_oauth_state(
  repeat('b', 64), 'garmin', '11111111-1111-1111-1111-111111111111',
  'runaway://garmin-connected', clock_timestamp() + interval '10 minutes'
);
select is_empty(
  $query$select * from public.consume_oauth_state('strava', repeat('b', 64))$query$,
  'provider-mismatched state is rejected'
);
select results_eq(
  $query$select auth_user_id from public.consume_oauth_state('garmin', repeat('b', 64))$query$,
  $values$values ('11111111-1111-1111-1111-111111111111'::uuid)$values$,
  'provider mismatch does not consume the valid provider state'
);
reset role;

insert into private.oauth_states (
  state_hash, provider, auth_user_id, redirect_url, expires_at
) values (
  repeat('c', 64), 'strava', '11111111-1111-1111-1111-111111111111',
  'runaway://strava-connected', clock_timestamp() - interval '1 second'
);
set local role service_role;
select is_empty(
  $query$select * from public.consume_oauth_state('strava', repeat('c', 64))$query$,
  'expired state is rejected'
);
select is_empty(
  $query$select * from public.consume_oauth_state('strava', repeat('d', 64))$query$,
  'altered or unknown state is rejected'
);
select public.create_oauth_state(
  repeat('e', 64), 'strava', '22222222-2222-2222-2222-222222222222',
  'https://runaway-web-203308554831.us-central1.run.app/settings',
  clock_timestamp() + interval '10 minutes'
);
select results_eq(
  $query$select auth_user_id from public.consume_oauth_state('strava', repeat('e', 64))$query$,
  $values$values ('22222222-2222-2222-2222-222222222222'::uuid)$values$,
  'cross-user substitution cannot change the state-bound user'
);
reset role;

select throws_ok(
  $$select public.create_oauth_state(repeat('f', 64), 'other', '11111111-1111-1111-1111-111111111111', 'runaway://strava-connected', clock_timestamp() + interval '10 minutes')$$,
  '22023', 'invalid OAuth provider', 'creation rejects an unknown provider'
);
select throws_ok(
  $$select public.create_oauth_state('plaintext-state', 'strava', '11111111-1111-1111-1111-111111111111', 'runaway://strava-connected', clock_timestamp() + interval '10 minutes')$$,
  '22023', 'invalid OAuth state hash', 'creation rejects a non-digest state key'
);
select throws_ok(
  $$select public.create_oauth_state(repeat('f', 64), 'strava', '11111111-1111-1111-1111-111111111111', 'runaway://strava-connected', clock_timestamp() + interval '1 hour')$$,
  '22023', 'invalid OAuth state expiry', 'creation enforces a short server-side TTL'
);

set local role service_role;
select public.create_oauth_state(
  repeat('1', 64), 'garmin', '11111111-1111-1111-1111-111111111111',
  'runaway://garmin-connected', clock_timestamp() + interval '10 minutes'
);
reset role;

create temporary table task5_atomic_results (
  worker text not null,
  result_count bigint not null
) on commit drop;
select dblink_connect('task5_worker_a', :'task5_database_url');
select dblink_connect('task5_worker_b', :'task5_database_url');
select dblink_exec('task5_worker_a', 'begin');
select dblink_exec('task5_worker_b', 'begin');
select dblink_exec('task5_worker_a', 'set local role service_role');
select dblink_exec('task5_worker_b', 'set local role service_role');
insert into task5_atomic_results
select 'worker_a', result_count
from dblink(
  'task5_worker_a',
  $$select count(*)::bigint from public.consume_oauth_state('garmin', repeat('1', 64))$$
) as result(result_count bigint);
select dblink_send_query(
  'task5_worker_b',
  $$select count(*)::bigint from public.consume_oauth_state('garmin', repeat('1', 64))$$
);
select pg_sleep(0.1);
select is(dblink_is_busy('task5_worker_b'), 1, 'second consumer waits on the in-flight atomic update');
select dblink_exec('task5_worker_a', 'commit');
insert into task5_atomic_results
select 'worker_b', result_count
from dblink_get_result('task5_worker_b') as result(result_count bigint);
select dblink_exec('task5_worker_b', 'commit');
select dblink_disconnect('task5_worker_a');
select dblink_disconnect('task5_worker_b');

select is(
  (select result_count from task5_atomic_results where worker = 'worker_a'),
  1::bigint,
  'first concurrent consumer succeeds'
);
select is(
  (select result_count from task5_atomic_results where worker = 'worker_b'),
  0::bigint,
  'second concurrent consumer observes the consumed state'
);
select is(
  (select sum(result_count) from task5_atomic_results),
  1::numeric,
  'atomic consumption has exactly one winner'
);
select ok(
  (select consumed_at is not null from private.oauth_states where state_hash = repeat('1', 64)),
  'concurrent winner persists consumed_at'
);

select cmp_ok(private.cleanup_oauth_states(), '>=', 1::bigint, 'cleanup removes expired or consumed rows');
select is_empty(
  $query$select 1 from private.oauth_states where expires_at <= clock_timestamp() or consumed_at is not null$query$,
  'cleanup leaves no expired or consumed OAuth state'
);

select * from finish();
rollback;

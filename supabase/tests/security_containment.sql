begin;

select plan(47);

select ok(
  not has_table_privilege('anon', 'public.profiles', 'select'),
  'anon cannot select profiles'
);

select ok(
  not has_table_privilege('authenticated', 'public.analytics_daily_summary', 'select'),
  'authenticated cannot select analytics_daily_summary'
);

select ok(
  not has_function_privilege('anon', 'public.ensure_athlete_exists(uuid,text)', 'execute'),
  'anon cannot execute ensure_athlete_exists'
);

select hasnt_column(
  'public',
  'profiles',
  'runsignup_access_token',
  'profiles omits the RunSignUp access token'
);

select hasnt_column(
  'public',
  'profiles',
  'runsignup_refresh_token',
  'profiles omits the RunSignUp refresh token'
);

select hasnt_column(
  'public',
  'profiles',
  'runsignup_token_expires_at',
  'profiles omits the RunSignUp token expiration'
);

select col_type_is(
  'public',
  'athletes',
  'runsignup_access_token',
  'text',
  'fresh replay provides the RunSignUp access-token column on athletes'
);

select col_type_is(
  'public',
  'athletes',
  'runsignup_refresh_token',
  'text',
  'fresh replay provides the RunSignUp refresh-token column on athletes'
);

select col_type_is(
  'public',
  'athletes',
  'runsignup_token_expires_at',
  'timestamp with time zone',
  'fresh replay provides the typed RunSignUp token expiration on athletes'
);

select col_type_is(
  'public',
  'activities',
  'client_operation_id',
  'uuid',
  'activity idempotency keys use the Task 7 UUID contract'
);

select col_is_null(
  'public',
  'activities',
  'client_operation_id',
  'legacy activities may retain a null client operation ID'
);

select ok(
  exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'public.activities'::regclass
      and c.contype = 'u'
      and c.conkey = array[
        (select attnum from pg_attribute where attrelid = c.conrelid and attname = 'athlete_id'),
        (select attnum from pg_attribute where attrelid = c.conrelid and attname = 'client_operation_id')
      ]::smallint[]
  ),
  'activities has an exact user-scoped unique constraint for PostgREST conflict inference'
);

select ok(
  exists (
    select 1
    from pg_constraint c
    join pg_index i on i.indexrelid = c.conindid
    where c.conrelid = 'public.activities'::regclass
      and c.contype = 'u'
      and i.indisunique
      and i.indisvalid
      and i.indpred is null
      and c.conkey = array[
        (select attnum from pg_attribute where attrelid = c.conrelid and attname = 'athlete_id'),
        (select attnum from pg_attribute where attrelid = c.conrelid and attname = 'client_operation_id')
      ]::smallint[]
  ),
  'the exact conflict target has a valid non-partial unique index'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.activities'::regclass),
  'activities enforces row-level security'
);

select ok(
  (select count(*) = 3 from pg_policies where schemaname = 'public' and tablename = 'activities' and cmd in ('SELECT', 'INSERT', 'UPDATE')),
  'activities has owner-scoped select, insert, and update policies'
);

select ok(
  to_regprocedure('public.notify_activity_insert()') is null,
  'the literal-bearing activity notification trigger function is removed'
);

select ok(
  to_regprocedure('public.trigger_activity_notification()') is null,
  'the literal-bearing activity notification function is removed'
);

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
values
  (
    '11111111-1111-1111-1111-111111111111',
    'authenticated',
    'authenticated',
    'security-containment-a@example.test',
    'not-used-by-this-test',
    now(),
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '22222222-2222-2222-2222-222222222222',
    'authenticated',
    'authenticated',
    'security-containment-b@example.test',
    'not-used-by-this-test',
    now(),
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.athletes (id, auth_user_id, email, first_name, role)
values
  (
    900000001,
    '11111111-1111-1111-1111-111111111111',
    'security-containment-a@example.test',
    'User A',
    'athlete'
  ),
  (
    900000002,
    '22222222-2222-2222-2222-222222222222',
    'security-containment-b@example.test',
    'User B',
    'athlete'
  )
on conflict (auth_user_id) do update
set id = excluded.id,
    email = excluded.email,
    first_name = excluded.first_name,
    role = excluded.role;

insert into public.activities (id, athlete_id, name, activity_date)
values
  (900000001, 900000001, 'Security containment A activity', now()),
  (900000002, 900000002, 'Security containment B activity', now());

insert into public.training_journal (
  athlete_id,
  week_start_date,
  week_end_date,
  narrative
)
values
  (900000001, current_date - 7, current_date - 1, 'Security containment A journal'),
  (900000002, current_date - 7, current_date - 1, 'Security containment B journal');

insert into public.chat_conversations (
  athlete_id,
  conversation_id,
  message,
  role,
  "timestamp"
)
values
  (
    900000001,
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'Security containment A conversation',
    'user',
    '2026-08-17 08:00:00'::timestamp
  ),
  (
    900000002,
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'Security containment B conversation',
    'user',
    '2026-08-17 09:00:00'::timestamp
  );

insert into public.weekly_training_plans (
  athlete_id,
  week_start_date,
  week_end_date,
  workouts
)
values
  (900000001, current_date - 7, current_date - 1, '[]'::jsonb),
  (900000002, current_date - 7, current_date - 1, '[]'::jsonb);

set local role anon;
select throws_ok(
  $$select * from public.activity_summary$$,
  '42501',
  null,
  'anon cannot query activity_summary'
);

select throws_ok(
  $$select * from public.analytics_activity_funnel$$,
  '42501',
  null,
  'anon cannot query analytics_activity_funnel'
);

select throws_ok(
  $$select * from public.analytics_activity_hours$$,
  '42501',
  null,
  'anon cannot query analytics_activity_hours'
);

select throws_ok(
  $$select * from public.analytics_audio_coaching$$,
  '42501',
  null,
  'anon cannot query analytics_audio_coaching'
);

select throws_ok(
  $$select * from public.analytics_daily_summary$$,
  '42501',
  null,
  'anon cannot query analytics_daily_summary'
);

select throws_ok(
  $$select * from public.analytics_user_engagement$$,
  '42501',
  null,
  'anon cannot query analytics_user_engagement'
);

select throws_ok(
  $$select * from public.conversation_summaries$$,
  '42501',
  null,
  'anon cannot query conversation_summaries'
);

select throws_ok(
  $$select * from public.monthly_activity_stats$$,
  '42501',
  null,
  'anon cannot query monthly_activity_stats'
);

select throws_ok(
  $$select * from public.profiles$$,
  '42501',
  null,
  'anon cannot query profiles'
);

select throws_ok(
  $$select * from public.recent_journal_entries$$,
  '42501',
  null,
  'anon cannot query recent_journal_entries'
);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

select lives_ok(
  $$insert into public.activities (id, athlete_id, name, client_operation_id)
    values (900000011, 900000001, 'Task 7 first create', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa')$$,
  'user A can insert an idempotent activity for their athlete'
);

select results_eq(
  $$insert into public.activities (id, athlete_id, name, client_operation_id)
    values (900000012, 900000001, 'Task 7 replay', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa')
    on conflict (athlete_id, client_operation_id)
    do update set name = excluded.name
    returning id, name$$,
  $$values (900000011::bigint, 'Task 7 replay'::text)$$,
  'Task 7 replay resolves the exact conflict target and returns the canonical row'
);

select throws_ok(
  $$insert into public.activities (id, athlete_id, name, client_operation_id)
    values (900000013, 900000002, 'Cross-owner create', 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb')$$,
  '42501',
  null,
  'user A cannot insert an activity for user B athlete'
);

set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

select lives_ok(
  $$insert into public.activities (id, athlete_id, name, client_operation_id)
    values (900000014, 900000002, 'Same operation UUID, other owner', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa')$$,
  'the same operation UUID is unique only within one athlete'
);

reset role;

select lives_ok(
  $$insert into public.activities (id, athlete_id, name, client_operation_id)
    values
      (900000015, 900000001, 'Legacy null one', null),
      (900000016, 900000001, 'Legacy null two', null)$$,
  'multiple legacy null operation IDs remain valid for one athlete'
);

set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

select results_eq(
  $$select email from public.profiles order by email$$,
  array['security-containment-a@example.test'],
  'user A sees only their profile through profiles'
);

select is_empty(
  $$select 1 from public.profiles where id = '22222222-2222-2222-2222-222222222222'::uuid$$,
  'user A cannot select user B through profiles'
);

select is_empty(
  $$select 1 from public.activity_summary where id = 900000002$$,
  'user A cannot select user B through activity_summary'
);

select is_empty(
  $$select 1 from public.conversation_summaries where athlete_id = 900000002$$,
  'user A cannot select user B through conversation_summaries'
);

select is_empty(
  $$select 1 from public.monthly_activity_stats where athlete_id = 900000002$$,
  'user A cannot select user B through monthly_activity_stats'
);

select is_empty(
  $$select 1 from public.recent_journal_entries where athlete_id = 900000002$$,
  'user A cannot select user B through recent_journal_entries'
);

select is_empty(
  $$select 1 from public.weekly_training_plans where athlete_id = 900000002$$,
  'user A cannot read user B training plan'
);

select throws_ok(
  $$select public.best_split_pr(900000002, 1, 0::double precision, 1000::double precision)$$,
  '42501',
  'not authorized',
  'user A cannot invoke best_split_pr for user B'
);

select throws_ok(
  $$select public.check_onboarding_status(900000002)$$,
  '42501',
  'not authorized',
  'user A cannot invoke check_onboarding_status for user B'
);

select throws_ok(
  $$select public.detect_rest_days(900000002, 1)$$,
  '42501',
  'not authorized',
  'user A cannot invoke detect_rest_days for user B'
);

select throws_ok(
  $$select public.ensure_athlete_exists('22222222-2222-2222-2222-222222222222'::uuid, 'security-containment-b@example.test')$$,
  '42501',
  'not authorized',
  'user A cannot create or look up an athlete for user B'
);

select throws_ok(
  $$select public.get_consecutive_rest_days(900000002, '2026-08-24'::date)$$,
  '42501',
  'not authorized',
  'user A cannot invoke get_consecutive_rest_days for user B'
);

select throws_ok(
  $$select public.get_current_week_plan(900000002)$$,
  '42501',
  'not authorized',
  'user A cannot invoke get_current_week_plan for user B'
);

select throws_ok(
  $$select * from public.get_rest_day_history(900000002, 30)$$,
  '42501',
  'not authorized',
  'user A cannot invoke get_rest_day_history for user B'
);

select throws_ok(
  $$select public.get_rest_days_count(900000002, '2026-08-01'::date, '2026-08-24'::date)$$,
  '42501',
  'not authorized',
  'user A cannot invoke get_rest_days_count for user B'
);

select * from finish();

rollback;

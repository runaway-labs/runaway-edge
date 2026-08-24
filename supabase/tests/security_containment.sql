begin;

select plan(17);

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
  $$select * from public.profiles$$,
  '42501',
  null,
  'anon cannot query profiles'
);

reset role;
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
  $$select public.get_current_week_plan(900000002)$$,
  '42501',
  'not authorized',
  'user A cannot invoke an athlete-ID RPC for user B'
);

select throws_ok(
  $$select public.ensure_athlete_exists('22222222-2222-2222-2222-222222222222'::uuid, 'security-containment-b@example.test')$$,
  '42501',
  'not authorized',
  'user A cannot create or look up an athlete for user B'
);

select * from finish();

rollback;

begin;

select plan(54);

select ok(
  case
    when to_regclass('public.profiles') is null then true
    else not has_table_privilege('anon', 'public.profiles', 'select')
  end,
  'profiles is absent locally or inaccessible to anon'
);

select ok(
  case
    when to_regclass('public.analytics_daily_summary') is null then true
    else not has_table_privilege('authenticated', 'public.analytics_daily_summary', 'select')
  end,
  'analytics_daily_summary is absent locally or inaccessible to authenticated users'
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
  (select count(*) = 4 from pg_policies where schemaname = 'public' and tablename = 'activities' and cmd in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')),
  'activities has owner-scoped select, insert, update, and delete policies'
);

select ok(
  to_regprocedure('public.notify_activity_insert()') is not null,
  'the dedicated-secret activity notification function exists without an active caller'
);

select hasnt_view(
  'public',
  'activity_summary',
  'clean local migration does not fabricate the captured live activity_summary definition'
);

select hasnt_view(
  'public',
  'conversation_summaries',
  'clean local migration does not fabricate the captured live conversation_summaries definition'
);

select hasnt_view(
  'public',
  'monthly_activity_stats',
  'clean local migration does not fabricate the captured live monthly_activity_stats definition'
);

select hasnt_view(
  'public',
  'recent_journal_entries',
  'clean local migration does not fabricate the captured live recent_journal_entries definition'
);

select is(
  (select count(*) from pg_trigger where tgrelid = 'public.activities'::regclass and not tgisinternal and tgname in ('activity-insert-notification', 'on_activity_insert', 'runaway_activity_insert_internal')),
  0::bigint,
  'base migrations leave legacy and dedicated activity callers inactive'
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
select ok(
  case
    when to_regclass('public.activity_summary') is null then true
    else not has_table_privilege('anon', 'public.activity_summary', 'select')
  end,
  'activity_summary is absent locally or inaccessible to anon'
);

select ok(
  case
    when to_regclass('public.analytics_activity_funnel') is null then true
    else not has_table_privilege('anon', 'public.analytics_activity_funnel', 'select')
  end,
  'analytics_activity_funnel is absent locally or inaccessible to anon'
);

select ok(
  case
    when to_regclass('public.analytics_activity_hours') is null then true
    else not has_table_privilege('anon', 'public.analytics_activity_hours', 'select')
  end,
  'analytics_activity_hours is absent locally or inaccessible to anon'
);

select ok(
  case
    when to_regclass('public.analytics_audio_coaching') is null then true
    else not has_table_privilege('anon', 'public.analytics_audio_coaching', 'select')
  end,
  'analytics_audio_coaching is absent locally or inaccessible to anon'
);

select ok(
  case
    when to_regclass('public.analytics_daily_summary') is null then true
    else not has_table_privilege('anon', 'public.analytics_daily_summary', 'select')
  end,
  'analytics_daily_summary is absent locally or inaccessible to anon'
);

select ok(
  case
    when to_regclass('public.analytics_user_engagement') is null then true
    else not has_table_privilege('anon', 'public.analytics_user_engagement', 'select')
  end,
  'analytics_user_engagement is absent locally or inaccessible to anon'
);

select ok(
  case
    when to_regclass('public.conversation_summaries') is null then true
    else not has_table_privilege('anon', 'public.conversation_summaries', 'select')
  end,
  'conversation_summaries is absent locally or inaccessible to anon'
);

select ok(
  case
    when to_regclass('public.monthly_activity_stats') is null then true
    else not has_table_privilege('anon', 'public.monthly_activity_stats', 'select')
  end,
  'monthly_activity_stats is absent locally or inaccessible to anon'
);

select throws_ok(
  $$select * from public.profiles$$,
  '42501',
  null,
  'anon cannot query profiles'
);

select ok(
  case
    when to_regclass('public.recent_journal_entries') is null then true
    else not has_table_privilege('anon', 'public.recent_journal_entries', 'select')
  end,
  'recent_journal_entries is absent locally or inaccessible to anon'
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
  $$delete from public.activities where id = 900000001 returning id$$,
  $$values (900000001::bigint)$$,
  'user A can delete their own activity'
);

select is_empty(
  $$delete from public.activities where id = 900000002 returning id$$,
  'user A cannot delete user B activity'
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
  case
    when to_regclass('public.activity_summary') is null then $$select 1 where false$$
    else $$select 1 from public.activity_summary where id = 900000002$$
  end,
  'activity_summary is absent locally or hides user B from user A'
);

select is_empty(
  case
    when to_regclass('public.conversation_summaries') is null then $$select 1 where false$$
    else $$select 1 from public.conversation_summaries where athlete_id = 900000002$$
  end,
  'conversation_summaries is absent locally or hides user B from user A'
);

select is_empty(
  case
    when to_regclass('public.monthly_activity_stats') is null then $$select 1 where false$$
    else $$select 1 from public.monthly_activity_stats where athlete_id = 900000002$$
  end,
  'monthly_activity_stats is absent locally or hides user B from user A'
);

select is_empty(
  case
    when to_regclass('public.recent_journal_entries') is null then $$select 1 where false$$
    else $$select 1 from public.recent_journal_entries where athlete_id = 900000002$$
  end,
  'recent_journal_entries is absent locally or hides user B from user A'
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

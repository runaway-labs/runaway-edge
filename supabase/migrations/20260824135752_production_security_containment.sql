-- Contain public views, training-plan RLS, and privileged RPC execution.

-- The profiles compatibility view is the sole view whose output changes: OAuth
-- credential columns are intentionally removed. Dropping it is required because
-- CREATE OR REPLACE VIEW cannot remove existing output columns.
revoke all on public.profiles from anon, authenticated;
drop view public.profiles;

create view public.profiles
with (security_invoker = true)
as
select
  auth_user_id as id,
  email,
  coalesce(first_name || ' ' || last_name, first_name, last_name, '') as full_name,
  organization as organization_name,
  phone,
  created_at,
  updated_at
from public.athletes
where auth_user_id is not null;

create trigger profiles_on_insert
  instead of insert on public.profiles
  for each row execute function public.profiles_insert_trigger();

create trigger profiles_on_update
  instead of update on public.profiles
  for each row execute function public.profiles_update_trigger();

grant select on public.profiles to authenticated;

-- Preserve all existing user-view definitions and output columns while making
-- their underlying table RLS policies apply to API callers.
alter view public.activity_summary set (security_invoker = true);
alter view public.conversation_summaries set (security_invoker = true);
alter view public.monthly_activity_stats set (security_invoker = true);
alter view public.recent_journal_entries set (security_invoker = true);

revoke all on public.activity_summary from anon, authenticated;
revoke all on public.conversation_summaries from anon, authenticated;
revoke all on public.monthly_activity_stats from anon, authenticated;
revoke all on public.recent_journal_entries from anon, authenticated;

grant select on public.activity_summary to authenticated;
grant select on public.conversation_summaries to authenticated;
grant select on public.monthly_activity_stats to authenticated;
grant select on public.recent_journal_entries to authenticated;

-- Aggregate analytics are an internal-only surface.
revoke all on public.analytics_activity_funnel from anon, authenticated, service_role;
revoke all on public.analytics_activity_hours from anon, authenticated, service_role;
revoke all on public.analytics_audio_coaching from anon, authenticated, service_role;
revoke all on public.analytics_daily_summary from anon, authenticated, service_role;
revoke all on public.analytics_user_engagement from anon, authenticated, service_role;

grant select on public.analytics_activity_funnel to service_role;
grant select on public.analytics_activity_hours to service_role;
grant select on public.analytics_audio_coaching to service_role;
grant select on public.analytics_daily_summary to service_role;
grant select on public.analytics_user_engagement to service_role;

-- Remove the global authenticated read policy and make the retained owner
-- policy explicitly authenticated and initplan-friendly.
drop policy if exists "Authenticated read access" on public.weekly_training_plans;
drop policy if exists "Users can read own plans" on public.weekly_training_plans;

create policy "Users can read own plans"
  on public.weekly_training_plans
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.athletes
      where athletes.id = weekly_training_plans.athlete_id
        and athletes.auth_user_id = (select auth.uid())
    )
  );

-- Keep authorization lookup code outside API-exposed schemas.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.current_user_owns_athlete(p_athlete_id bigint)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.athletes
    where id = p_athlete_id
      and auth_user_id = (select auth.uid())
  );
$$;

revoke all on function private.current_user_owns_athlete(bigint)
  from public, anon, authenticated, service_role;

create or replace function public.ensure_athlete_exists(
  p_auth_user_id uuid,
  p_email text default null::text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_athlete_id integer;
begin
  if (select auth.uid()) is null or p_auth_user_id <> (select auth.uid()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select id into v_athlete_id
  from public.athletes
  where auth_user_id = p_auth_user_id
     or auth_user_id::text = p_auth_user_id::text;

  if v_athlete_id is not null then
    return v_athlete_id;
  end if;

  insert into public.athletes (
    auth_user_id,
    email,
    first_name,
    strava_connected,
    created_at,
    updated_at
  ) values (
    p_auth_user_id,
    p_email,
    coalesce(split_part(p_email, '@', 1), 'Runner'),
    false,
    now(),
    now()
  )
  returning id into v_athlete_id;

  insert into public.athlete_stats (
    athlete_id,
    count,
    distance,
    moving_time,
    elapsed_time,
    elevation_gain,
    achievement_count,
    ytd_distance
  ) values (
    v_athlete_id,
    0, 0, 0, 0, 0, 0, 0
  );

  insert into public.athlete_onboarding (
    athlete_id,
    is_completed,
    current_step,
    created_at,
    updated_at
  ) values (
    v_athlete_id,
    false,
    0,
    now(),
    now()
  );

  return v_athlete_id;
end;
$function$;

create or replace function public.best_split_pr(
  p_athlete_id bigint,
  p_window_splits integer,
  p_min_dist double precision,
  p_max_dist double precision
)
returns table(activity_id bigint, elapsed_seconds integer, achieved_at timestamp with time zone)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
begin
  if not private.current_user_owns_athlete(p_athlete_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return query
  with splits_expanded as (
    select
      a.id as act_id,
      a.start_time as act_start,
      (s.value->>'elapsed_time')::int as split_elapsed,
      (s.value->>'distance')::float as split_dist,
      s.ord::int as split_pos
    from public.activities a,
         jsonb_array_elements(a.splits) with ordinality as s(value, ord)
    where a.athlete_id = p_athlete_id
      and a.splits is not null
      and jsonb_array_length(a.splits) >= p_window_splits
      and (s.value->>'elapsed_time') is not null
      and (s.value->>'distance') is not null
      and (s.value->>'elapsed_time')::int > 0
      and (s.value->>'distance')::float > 0
      and (s.value->>'elapsed_time')::float / (s.value->>'distance')::float >= 0.18
  ), windows as (
    select
      anchor.act_id,
      anchor.act_start,
      sum(member.split_elapsed) as total_elapsed,
      sum(member.split_dist) as total_dist,
      count(*) as cnt
    from splits_expanded anchor
    join splits_expanded member
      on member.act_id = anchor.act_id
      and member.split_pos >= anchor.split_pos
      and member.split_pos < anchor.split_pos + p_window_splits
    group by anchor.act_id, anchor.act_start, anchor.split_pos
    having count(*) = p_window_splits
  )
  select
    act_id::bigint as activity_id,
    total_elapsed::int as elapsed_seconds,
    act_start as achieved_at
  from windows
  where total_dist between p_min_dist and p_max_dist
  order by total_elapsed asc
  limit 1;
end;
$function$;

create or replace function public.check_onboarding_status(p_athlete_id integer)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  if not private.current_user_owns_athlete(p_athlete_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return exists (
    select 1
    from public.athlete_onboarding
    where athlete_id = p_athlete_id
      and is_completed = true
  );
end;
$function$;

create or replace function public.detect_rest_days(
  p_athlete_id integer,
  p_lookback_days integer default 7
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  check_date date;
  has_activity boolean;
  has_rest_day boolean;
  inserted_count integer := 0;
begin
  if not private.current_user_owns_athlete(p_athlete_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  for i in 1..p_lookback_days loop
    check_date := current_date - i;

    select exists (
      select 1
      from public.activities
      where athlete_id = p_athlete_id
        and date(to_timestamp(coalesce(activity_date, start_date))) = check_date
    ) into has_activity;

    select exists (
      select 1
      from public.rest_days
      where athlete_id = p_athlete_id
        and date = check_date
    ) into has_rest_day;

    if not has_activity and not has_rest_day then
      insert into public.rest_days (
        athlete_id,
        date,
        is_planned,
        reason,
        recovery_benefit
      ) values (
        p_athlete_id,
        check_date,
        false,
        'detected',
        75
      );
      inserted_count := inserted_count + 1;
    end if;
  end loop;

  return inserted_count;
end;
$function$;

create or replace function public.get_consecutive_rest_days(
  p_athlete_id integer,
  p_end_date date default current_date
)
returns integer
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  consecutive_count integer := 0;
  check_date date := p_end_date;
  has_rest boolean;
begin
  if not private.current_user_owns_athlete(p_athlete_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  loop
    select exists (
      select 1
      from public.rest_days
      where athlete_id = p_athlete_id
        and date = check_date
    ) into has_rest;

    exit when not has_rest;
    consecutive_count := consecutive_count + 1;
    check_date := check_date - interval '1 day';
  end loop;

  return consecutive_count;
end;
$function$;

create or replace function public.get_current_week_plan(p_athlete_id bigint)
returns public.weekly_training_plans
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  week_start date;
  result public.weekly_training_plans;
begin
  if not private.current_user_owns_athlete(p_athlete_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  week_start := date_trunc('week', current_date)::date - 1;
  if extract(dow from current_date) = 0 then
    week_start := current_date;
  end if;

  select * into result
  from public.weekly_training_plans
  where athlete_id = p_athlete_id
    and week_start_date = week_start;

  return result;
end;
$function$;

create or replace function public.get_rest_day_history(
  p_athlete_id integer,
  p_days integer default 30
)
returns table(
  id uuid,
  date date,
  is_planned boolean,
  reason text,
  notes text,
  recovery_benefit integer
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
begin
  if not private.current_user_owns_athlete(p_athlete_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return query
  select
    rd.id,
    rd.date,
    rd.is_planned,
    rd.reason,
    rd.notes,
    rd.recovery_benefit
  from public.rest_days rd
  where rd.athlete_id = p_athlete_id
    and rd.date >= current_date - p_days
  order by rd.date desc;
end;
$function$;

create or replace function public.get_rest_days_count(
  p_athlete_id integer,
  p_start_date date,
  p_end_date date
)
returns integer
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  rest_count integer;
begin
  if not private.current_user_owns_athlete(p_athlete_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select count(*)
  into rest_count
  from public.rest_days
  where athlete_id = p_athlete_id
    and date >= p_start_date
    and date <= p_end_date;

  return coalesce(rest_count, 0);
end;
$function$;

revoke execute on function public.best_split_pr(bigint, integer, double precision, double precision) from public, anon;
revoke execute on function public.check_onboarding_status(integer) from public, anon;
revoke execute on function public.detect_rest_days(integer, integer) from public, anon;
revoke execute on function public.ensure_athlete_exists(uuid, text) from public, anon;
revoke execute on function public.get_consecutive_rest_days(integer, date) from public, anon;
revoke execute on function public.get_current_week_plan(bigint) from public, anon;
revoke execute on function public.get_rest_day_history(integer, integer) from public, anon;
revoke execute on function public.get_rest_days_count(integer, date, date) from public, anon;

grant execute on function public.best_split_pr(bigint, integer, double precision, double precision) to authenticated, service_role;
grant execute on function public.check_onboarding_status(integer) to authenticated, service_role;
grant execute on function public.detect_rest_days(integer, integer) to authenticated, service_role;
grant execute on function public.ensure_athlete_exists(uuid, text) to authenticated, service_role;
grant execute on function public.get_consecutive_rest_days(integer, date) to authenticated, service_role;
grant execute on function public.get_current_week_plan(bigint) to authenticated, service_role;
grant execute on function public.get_rest_day_history(integer, integer) to authenticated, service_role;
grant execute on function public.get_rest_days_count(integer, date, date) to authenticated, service_role;

-- Trigger functions are never client RPCs. Preserve the required profile/auth
-- triggers, but remove direct grants and fix their search paths.
alter function public.handle_new_user() set search_path = public, pg_temp;
alter function public.profiles_insert_trigger() set search_path = public, pg_temp;
alter function public.profiles_update_trigger() set search_path = public, pg_temp;

revoke all on function public.handle_new_user() from public, anon, authenticated, service_role;
revoke all on function public.profiles_insert_trigger() from public, anon, authenticated, service_role;
revoke all on function public.profiles_update_trigger() from public, anon, authenticated, service_role;

-- Do not retain compromised literals in a callable function or active trigger.
-- Task 4 replaces this path with authenticated internal delivery.
drop trigger if exists on_activity_insert on public.activities;
drop function if exists public.notify_activity_insert();
drop function if exists public.trigger_activity_notification();

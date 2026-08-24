-- Support Task 7 idempotent activity creation while preserving nullable legacy rows.

set lock_timeout = '5s';
set statement_timeout = '5min';

do $$
declare
  orphan_activity_count bigint;
begin
  if to_regclass('public.activities') is null or to_regclass('public.athletes') is null then
    raise exception 'missing activities/athletes dependency';
  end if;
  select count(*) into orphan_activity_count
  from public.activities activity
  left join public.athletes athlete on athlete.id = activity.athlete_id
  where athlete.id is null;
  raise notice 'task8 evidence activities rows=%, ownerless_rows=%',
    (select count(*) from public.activities), orphan_activity_count;
  if orphan_activity_count <> 0 then
    raise exception 'activities contains % ownerless rows', orphan_activity_count;
  end if;
end
$$;

alter table public.activities
  add column if not exists client_operation_id uuid;

create unique index if not exists activities_athlete_client_operation_id_uidx
  on public.activities (athlete_id, client_operation_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.activities'::regclass
      and conname = 'activities_athlete_client_operation_id_key'
  ) then
    alter table public.activities
      add constraint activities_athlete_client_operation_id_key
      unique using index activities_athlete_client_operation_id_uidx;
  end if;
end
$$;

comment on column public.activities.client_operation_id is
  'Stable client-generated UUID used with athlete_id for idempotent activity creation.';

alter table public.activities enable row level security;

drop policy if exists "Users can view own activities by auth_user_id" on public.activities;
drop policy if exists "Users can view own activities" on public.activities;
drop policy if exists "Users can insert own activities" on public.activities;
drop policy if exists "Users can update own activities" on public.activities;
drop policy if exists "Users can delete own activities" on public.activities;
drop policy if exists "Users can read own activities" on public.activities;
drop policy if exists "Service role can manage all activities" on public.activities;

create policy "Users can view own activities"
  on public.activities
  for select
  to authenticated
  using (
    exists (
      select 1 from public.athletes
      where athletes.id = activities.athlete_id
        and athletes.auth_user_id = (select auth.uid())
    )
  );

create policy "Users can insert own activities"
  on public.activities
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.athletes
      where athletes.id = activities.athlete_id
        and athletes.auth_user_id = (select auth.uid())
    )
  );

create policy "Users can update own activities"
  on public.activities
  for update
  to authenticated
  using (
    exists (
      select 1 from public.athletes
      where athletes.id = activities.athlete_id
        and athletes.auth_user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.athletes
      where athletes.id = activities.athlete_id
        and athletes.auth_user_id = (select auth.uid())
    )
    );

create policy "Users can delete own activities"
  on public.activities
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.athletes
      where athletes.id = activities.athlete_id
        and athletes.auth_user_id = (select auth.uid())
    )
  );

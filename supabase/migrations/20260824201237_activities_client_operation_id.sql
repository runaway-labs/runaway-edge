-- Support Task 7 idempotent activity creation while preserving nullable legacy rows.

alter table public.activities
  add column if not exists client_operation_id uuid;

alter table public.activities
  add constraint activities_athlete_client_operation_id_key
  unique (athlete_id, client_operation_id);

comment on column public.activities.client_operation_id is
  'Stable client-generated UUID used with athlete_id for idempotent activity creation.';

alter table public.activities enable row level security;

drop policy if exists "Users can view own activities by auth_user_id" on public.activities;
drop policy if exists "Users can view own activities" on public.activities;
drop policy if exists "Users can insert own activities" on public.activities;
drop policy if exists "Users can update own activities" on public.activities;

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

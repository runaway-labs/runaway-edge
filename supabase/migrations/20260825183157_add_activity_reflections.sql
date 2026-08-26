create table public.activity_reflections (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null,
  activity_id bigint not null references public.activities(id) on delete cascade,
  athlete_id bigint not null,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  effort smallint not null check (effort between 1 and 10),
  body_status text not null check (length(trim(body_status)) > 0),
  mood text not null check (length(trim(mood)) > 0),
  condition_tags text[] not null default '{}'::text[],
  note text check (note is null or length(note) <= 1000),
  local_debrief text not null,
  server_debrief text,
  reflected_at timestamptz not null,
  local_version bigint not null default 1 check (local_version > 0),
  server_version bigint not null default 0 check (server_version >= 0),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint activity_reflections_owner_activity_unique
    unique (auth_user_id, activity_id),
  constraint activity_reflections_owner_local_unique
    unique (auth_user_id, local_id),
  constraint activity_reflections_version_order
    check (server_version <= local_version)
);

create index activity_reflections_activity_idx
  on public.activity_reflections (activity_id);

create index activity_reflections_owner_sync_idx
  on public.activity_reflections (auth_user_id, last_synced_at);

alter table public.activity_reflections enable row level security;

create policy "Users can read their activity reflections"
  on public.activity_reflections
  for select
  to authenticated
  using (auth.uid() = auth_user_id);

create policy "Users can create reflections for their activities"
  on public.activity_reflections
  for insert
  to authenticated
  with check (
    auth.uid() = auth_user_id
    and exists (
      select 1
      from public.activities activity
      where activity.id = activity_id
        and activity.auth_user_id = auth.uid()
        and activity.athlete_id = athlete_id
    )
  );

create policy "Users can update reflections for their activities"
  on public.activity_reflections
  for update
  to authenticated
  using (auth.uid() = auth_user_id)
  with check (
    auth.uid() = auth_user_id
    and exists (
      select 1
      from public.activities activity
      where activity.id = activity_id
        and activity.auth_user_id = auth.uid()
        and activity.athlete_id = athlete_id
    )
  );

create policy "Users can delete their activity reflections"
  on public.activity_reflections
  for delete
  to authenticated
  using (auth.uid() = auth_user_id);

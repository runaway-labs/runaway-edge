create schema if not exists private;

create table private.oauth_states (
  state_hash text primary key,
  provider text not null,
  auth_user_id uuid not null,
  athlete_id bigint not null,
  redirect_url text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint oauth_states_hash_format check (state_hash ~ '^[0-9a-f]{64}$'),
  constraint oauth_states_provider check (provider in ('strava', 'garmin')),
  constraint oauth_states_redirect_present check (length(redirect_url) between 1 and 2048)
);

create index oauth_states_cleanup_idx
  on private.oauth_states (expires_at, consumed_at);

alter table private.oauth_states enable row level security;
revoke all on table private.oauth_states from public, anon, authenticated;
grant usage on schema private to service_role;
grant select, insert, update, delete on table private.oauth_states to service_role;

create or replace function private.cleanup_oauth_states()
returns bigint
language sql
volatile
security invoker
set search_path = ''
as $$
  with removed as (
    delete from private.oauth_states
    where expires_at <= clock_timestamp()
      or consumed_at is not null
    returning 1
  )
  select count(*)::bigint from removed;
$$;

revoke all on function private.cleanup_oauth_states()
  from public, anon, authenticated;
grant execute on function private.cleanup_oauth_states() to service_role;

create or replace function public.create_oauth_state(
  p_state_hash text,
  p_provider text,
  p_auth_user_id uuid,
  p_athlete_id bigint,
  p_redirect_url text,
  p_expires_at timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_state_hash is null or p_state_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid OAuth state hash';
  end if;

  if p_provider is null or p_provider not in ('strava', 'garmin') then
    raise exception using errcode = '22023', message = 'invalid OAuth provider';
  end if;

  if p_auth_user_id is null then
    raise exception using errcode = '22023', message = 'invalid OAuth user';
  end if;

  if p_athlete_id is null or not exists (
    select 1
    from public.athletes as athlete
    where athlete.id = p_athlete_id
      and athlete.auth_user_id = p_auth_user_id
  ) then
    raise exception using errcode = '22023', message = 'invalid OAuth athlete binding';
  end if;

  if p_redirect_url is null or length(p_redirect_url) not between 1 and 2048 then
    raise exception using errcode = '22023', message = 'invalid OAuth redirect';
  end if;

  if p_expires_at is null
    or p_expires_at <= clock_timestamp()
    or p_expires_at > clock_timestamp() + interval '15 minutes'
  then
    raise exception using errcode = '22023', message = 'invalid OAuth state expiry';
  end if;

  perform private.cleanup_oauth_states();

  insert into private.oauth_states (
    state_hash,
    provider,
    auth_user_id,
    athlete_id,
    redirect_url,
    expires_at
  ) values (
    p_state_hash,
    p_provider,
    p_auth_user_id,
    p_athlete_id,
    p_redirect_url,
    p_expires_at
  );
end;
$$;

revoke all on function public.create_oauth_state(text, text, uuid, bigint, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.create_oauth_state(text, text, uuid, bigint, text, timestamptz)
  to service_role;

create or replace function public.consume_oauth_state(
  p_provider text,
  p_state_hash text
)
returns table (
  auth_user_id uuid,
  athlete_id bigint,
  redirect_url text
)
language sql
volatile
security definer
set search_path = ''
as $$
  update private.oauth_states as oauth_state
  set consumed_at = clock_timestamp()
  where oauth_state.state_hash = p_state_hash
    and oauth_state.provider = p_provider
    and oauth_state.expires_at > clock_timestamp()
    and oauth_state.consumed_at is null
  returning oauth_state.auth_user_id, oauth_state.athlete_id, oauth_state.redirect_url;
$$;

revoke all on function public.consume_oauth_state(text, text)
  from public, anon, authenticated;
grant execute on function public.consume_oauth_state(text, text) to service_role;

alter table public.garmin_oauth_tokens enable row level security;
revoke all on table public.garmin_oauth_tokens from public, anon, authenticated;
grant select, insert, update, delete on table public.garmin_oauth_tokens to service_role;

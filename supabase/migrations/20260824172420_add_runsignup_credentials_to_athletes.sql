-- Fresh replay prerequisite for the service-only RunSignUp credential path.
-- The public.profiles compatibility view intentionally remains credential-free.
set lock_timeout = '5s';
set statement_timeout = '5min';

do $$
begin
  if to_regclass('public.athletes') is null then
    raise exception 'missing dependency public.athletes';
  end if;
  if to_regclass('public.profiles') is null then
    raise exception 'missing dependency public.profiles';
  end if;
  raise notice 'task8 evidence athletes rows=%', (select count(*) from public.athletes);
end
$$;

alter table public.athletes
  add column if not exists runsignup_access_token text,
  add column if not exists runsignup_refresh_token text,
  add column if not exists runsignup_token_expires_at timestamptz;

comment on column public.athletes.runsignup_access_token is
  'Service-only RunSignUp OAuth access token; never expose through public.profiles.';
comment on column public.athletes.runsignup_refresh_token is
  'Service-only RunSignUp OAuth refresh token; never expose through public.profiles.';
comment on column public.athletes.runsignup_token_expires_at is
  'Expiration of the service-only RunSignUp OAuth access token.';

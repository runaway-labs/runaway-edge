set lock_timeout = '5s';
set statement_timeout = '5min';

do $$
declare
  unsupported_status_count bigint;
begin
  if to_regclass('public.alert_deliveries') is null then
    raise exception 'missing dependency public.alert_deliveries';
  end if;
  if to_regclass('public.activities') is null then
    raise exception 'missing dependency public.activities';
  end if;

  select count(*) into unsupported_status_count
  from public.alert_deliveries
  where status not in ('pending', 'processing', 'submitting', 'ambiguous', 'sent', 'delivered', 'retryable', 'failed');
  raise notice 'task8 evidence alert_deliveries rows=%, unsupported_status_rows=%',
    (select count(*) from public.alert_deliveries), unsupported_status_count;
  if unsupported_status_count <> 0 then
    raise exception 'alert_deliveries contains % unsupported status rows', unsupported_status_count;
  end if;
end
$$;

alter table public.alert_deliveries
  drop constraint if exists alert_deliveries_status_check;

alter table public.alert_deliveries
  add constraint alert_deliveries_status_check
  check (status in (
    'pending', 'processing', 'submitting', 'ambiguous', 'sent', 'delivered', 'retryable', 'failed'
  )) not valid;

alter table public.alert_deliveries
  validate constraint alert_deliveries_status_check;

alter table public.alert_deliveries
  add column if not exists attempt_count integer not null default 0,
  add column if not exists processing_started_at timestamptz,
  add column if not exists claim_generation bigint not null default 0,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists idempotency_key text
    generated always as (id::text || ':' || channel) stored;

alter table public.alert_deliveries
  alter column idempotency_key set not null;

create index if not exists alert_deliveries_claimable_idx
  on public.alert_deliveries (status, lease_expires_at, created_at, id)
  where status in ('pending', 'retryable', 'processing', 'submitting');

create or replace function private.require_internal_job_secret()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  configured_secret text;
  distinct_digits integer;
begin
  select decrypted_secret
  into configured_secret
  from vault.decrypted_secrets
  where name = 'internal_job_secret'
  limit 1;

  if configured_secret is not null then
    select count(distinct digit)
    into distinct_digits
    from regexp_split_to_table(configured_secret, '') as digit;
  end if;

  if configured_secret is null
    or configured_secret !~ '^[0-9a-f]{64}$'
    or coalesce(distinct_digits, 0) < 8
  then
    raise exception using
      errcode = '22023',
      message = 'internal job secret is not configured';
  end if;

  return configured_secret;
end;
$$;

revoke all on function private.require_internal_job_secret()
  from public, anon, authenticated, service_role;

drop function if exists public.claim_pending_deliveries(integer);
drop function if exists private.claim_pending_deliveries(integer);

create or replace function private.reconcile_expired_submitting_deliveries()
returns integer
language sql
volatile
security invoker
set search_path = ''
as $$
  with expired as materialized (
    select delivery.id, delivery.claim_generation
    from public.alert_deliveries as delivery
    where delivery.status = 'submitting'
      and delivery.lease_expires_at <= clock_timestamp()
    for update skip locked
  ), reconciled as (
    update public.alert_deliveries as delivery
    set status = 'ambiguous',
        claim_generation = delivery.claim_generation + 1,
        processing_started_at = null,
        lease_expires_at = null,
        error_message = 'provider submission outcome requires manual reconciliation',
        updated_at = clock_timestamp()
    from expired
    where delivery.id = expired.id
      and delivery.claim_generation = expired.claim_generation
      and delivery.status = 'submitting'
      and delivery.lease_expires_at <= clock_timestamp()
    returning 1
  )
  select count(*)::integer from reconciled;
$$;

revoke all on function private.reconcile_expired_submitting_deliveries()
  from public, anon, authenticated;
grant execute on function private.reconcile_expired_submitting_deliveries()
  to service_role;

create function private.claim_pending_deliveries(batch_size integer)
returns table (
  id uuid,
  alert_id uuid,
  runner_id uuid,
  channel text,
  recipient text,
  status text,
  idempotency_key text,
  attempt_count integer,
  processing_started_at timestamptz,
  claim_generation bigint,
  lease_expires_at timestamptz
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  perform private.reconcile_expired_submitting_deliveries();

  return query
  with candidates as (
    select delivery.id
    from public.alert_deliveries as delivery
    where delivery.status in ('pending', 'retryable')
      or (
        delivery.status = 'processing'
        and delivery.lease_expires_at <= clock_timestamp()
      )
    order by delivery.created_at, delivery.id
    limit greatest(1, least(coalesce(batch_size, 50), 100))
    for update skip locked
  )
  update public.alert_deliveries as delivery
  set status = 'processing',
      attempt_count = delivery.attempt_count + 1,
      processing_started_at = clock_timestamp(),
      claim_generation = delivery.claim_generation + 1,
      lease_expires_at = clock_timestamp() + interval '5 minutes',
      updated_at = clock_timestamp()
  from candidates
  where delivery.id = candidates.id
    and (
      delivery.status in ('pending', 'retryable')
      or (
        delivery.status = 'processing'
        and delivery.lease_expires_at <= clock_timestamp()
      )
    )
  returning
    delivery.id,
    delivery.alert_id,
    delivery.runner_id,
    delivery.channel,
    delivery.recipient,
    delivery.status,
    delivery.idempotency_key,
    delivery.attempt_count,
    delivery.processing_started_at,
    delivery.claim_generation,
    delivery.lease_expires_at;
end;
$$;

revoke all on function private.claim_pending_deliveries(integer)
  from public, anon, authenticated;
grant usage on schema private to service_role;
grant execute on function private.claim_pending_deliveries(integer) to service_role;

create or replace function public.claim_pending_deliveries(batch_size integer)
returns table (
  id uuid,
  alert_id uuid,
  runner_id uuid,
  channel text,
  recipient text,
  status text,
  idempotency_key text,
  attempt_count integer,
  processing_started_at timestamptz,
  claim_generation bigint,
  lease_expires_at timestamptz
)
language sql
volatile
security definer
set search_path = ''
as $$
  select * from private.claim_pending_deliveries(batch_size);
$$;

revoke all on function public.claim_pending_deliveries(integer)
  from public, anon, authenticated;
grant execute on function public.claim_pending_deliveries(integer) to service_role;

create or replace function private.begin_delivery_submission(
  delivery_id uuid,
  claim_generation bigint
)
returns boolean
language sql
volatile
security invoker
set search_path = ''
as $$
  with transitioned as (
    update public.alert_deliveries as delivery
    set status = 'submitting',
        updated_at = clock_timestamp()
    where delivery.id = $1
      and delivery.status = 'processing'
      and delivery.claim_generation = $2
      and delivery.lease_expires_at > clock_timestamp()
    returning 1
  )
  select exists(select 1 from transitioned);
$$;

revoke all on function private.begin_delivery_submission(uuid, bigint)
  from public, anon, authenticated;
grant execute on function private.begin_delivery_submission(uuid, bigint)
  to service_role;

create or replace function public.begin_delivery_submission(
  delivery_id uuid,
  claim_generation bigint
)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select private.begin_delivery_submission($1, $2);
$$;

revoke all on function public.begin_delivery_submission(uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.begin_delivery_submission(uuid, bigint)
  to service_role;

create or replace function private.finalize_delivery(
  delivery_id uuid,
  claim_generation bigint,
  final_status text,
  provider_message_id text,
  error_message text,
  sent_at timestamptz
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  finalized boolean;
begin
  if $3 not in ('sent', 'retryable', 'failed') then
    raise exception using
      errcode = '22023',
      message = 'invalid delivery final status';
  end if;

  with transitioned as (
    update public.alert_deliveries as delivery
    set status = $3,
        provider_message_id = $4,
        error_message = $5,
        sent_at = case when $3 = 'sent' then coalesce($6, clock_timestamp()) else null end,
        processing_started_at = null,
        lease_expires_at = null,
        updated_at = clock_timestamp()
    where delivery.id = $1
      and delivery.status in ('processing', 'submitting')
      and delivery.claim_generation = $2
      and delivery.lease_expires_at > clock_timestamp()
    returning true
  )
  select coalesce(bool_or(true), false)
  into finalized
  from transitioned;

  return finalized;
end;
$$;

revoke all on function private.finalize_delivery(uuid, bigint, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function private.finalize_delivery(uuid, bigint, text, text, text, timestamptz)
  to service_role;

create or replace function public.finalize_delivery(
  delivery_id uuid,
  claim_generation bigint,
  final_status text,
  provider_message_id text,
  error_message text,
  sent_at timestamptz
)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select private.finalize_delivery(
    $1,
    $2,
    $3,
    $4,
    $5,
    $6
  );
$$;

revoke all on function public.finalize_delivery(uuid, bigint, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.finalize_delivery(uuid, bigint, text, text, text, timestamptz)
  to service_role;

create or replace function public.notify_activity_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform net.http_post(
    url := (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'supabase_url'
      limit 1
    ) || '/functions/v1/notify-activity-insert',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Runaway-Internal-Secret', private.require_internal_job_secret()
    ),
    body := jsonb_build_object(
      'type', 'INSERT',
      'table', TG_TABLE_NAME,
      'schema', TG_TABLE_SCHEMA,
      'record', to_jsonb(new),
      'old_record', null
    )
  );
  return new;
end;
$$;

revoke all on function public.notify_activity_insert()
  from public, anon, authenticated, service_role;

drop trigger if exists on_activity_insert on public.activities;
drop trigger if exists "activity-insert-notification" on public.activities;
drop trigger if exists runaway_activity_insert_internal on public.activities;

-- Pause every existing reviewed internal schedule. The separate rollout activation
-- script replaces commands only after Edge/Vault secrets and endpoints are ready.
do $$
declare
  job record;
begin
  for job in
    select jobid
    from cron.job
    where jobname in (
      'check-conditions-job', 'process-deliveries-job', 'sync-race-directory-job',
      'daily-research-brief', 'fetch-daily-articles'
    )
  loop
    perform cron.alter_job(job.jobid, active := false);
  end loop;
end
$$;

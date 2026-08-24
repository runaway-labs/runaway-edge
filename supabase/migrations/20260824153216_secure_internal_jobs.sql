alter table public.alert_deliveries
  drop constraint if exists alert_deliveries_status_check;

alter table public.alert_deliveries
  add constraint alert_deliveries_status_check
  check (status in ('pending', 'processing', 'sent', 'delivered', 'retryable', 'failed'));

alter table public.alert_deliveries
  add column if not exists attempt_count integer not null default 0,
  add column if not exists processing_started_at timestamptz,
  add column if not exists idempotency_key text
    generated always as (id::text || ':' || channel) stored;

alter table public.alert_deliveries
  alter column idempotency_key set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'alert_deliveries_idempotency_key_key'
      and conrelid = 'public.alert_deliveries'::regclass
  ) then
    alter table public.alert_deliveries
      add constraint alert_deliveries_idempotency_key_key unique (idempotency_key);
  end if;
end
$$;

create or replace function private.claim_pending_deliveries(batch_size integer)
returns table (
  id uuid,
  alert_id uuid,
  runner_id uuid,
  channel text,
  recipient text,
  status text,
  idempotency_key text,
  attempt_count integer,
  processing_started_at timestamptz
)
language sql
volatile
security invoker
set search_path = ''
as $$
  with candidates as (
    select delivery.id
    from public.alert_deliveries as delivery
    where delivery.status in ('pending', 'retryable')
    order by delivery.created_at, delivery.id
    limit greatest(1, least(coalesce(batch_size, 50), 100))
    for update skip locked
  )
  update public.alert_deliveries as delivery
  set status = 'processing',
      attempt_count = delivery.attempt_count + 1,
      processing_started_at = now(),
      updated_at = now()
  from candidates
  where delivery.id = candidates.id
    and delivery.status in ('pending', 'retryable')
  returning
    delivery.id,
    delivery.alert_id,
    delivery.runner_id,
    delivery.channel,
    delivery.recipient,
    delivery.status,
    delivery.idempotency_key,
    delivery.attempt_count,
    delivery.processing_started_at;
$$;

revoke all on function private.claim_pending_deliveries(integer) from public, anon, authenticated;
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
  processing_started_at timestamptz
)
language sql
volatile
security definer
set search_path = ''
as $$
  select * from private.claim_pending_deliveries(batch_size);
$$;

revoke all on function public.claim_pending_deliveries(integer) from public, anon, authenticated;
grant execute on function public.claim_pending_deliveries(integer) to service_role;

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
      'X-Runaway-Internal-Secret', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'internal_job_secret'
        limit 1
      )
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

revoke all on function public.notify_activity_insert() from public, anon, authenticated, service_role;

drop trigger if exists on_activity_insert on public.activities;
create trigger on_activity_insert
after insert on public.activities
for each row execute function public.notify_activity_insert();

select cron.unschedule(jobid)
from cron.job
where jobname in (
  'check-conditions-job',
  'process-deliveries-job',
  'sync-race-directory-job',
  'daily-research-brief',
  'fetch-daily-articles'
);

select cron.schedule(
  'check-conditions-job',
  '*/30 * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url' limit 1)
      || '/functions/v1/check-conditions',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Runaway-Internal-Secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'internal_job_secret' limit 1)
    ),
    body := '{}'::jsonb
  );
  $job$
);

select cron.schedule(
  'process-deliveries-job',
  '* * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url' limit 1)
      || '/functions/v1/process-deliveries',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Runaway-Internal-Secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'internal_job_secret' limit 1)
    ),
    body := '{}'::jsonb
  );
  $job$
);

select cron.schedule(
  'sync-race-directory-job',
  '0 2 * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url' limit 1)
      || '/functions/v1/sync-race-directory',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Runaway-Internal-Secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'internal_job_secret' limit 1)
    ),
    body := '{}'::jsonb
  );
  $job$
);

select cron.schedule(
  'daily-research-brief',
  '0 6 * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url' limit 1)
      || '/functions/v1/daily-research-brief',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Runaway-Internal-Secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'internal_job_secret' limit 1)
    ),
    body := jsonb_build_object('trigger', 'scheduled', 'timestamp', now()::text)
  );
  $job$
);

select cron.schedule(
  'fetch-daily-articles',
  '0 6 * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url' limit 1)
      || '/functions/v1/fetch-daily-articles',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Runaway-Internal-Secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'internal_job_secret' limit 1)
    ),
    body := jsonb_build_object('trigger', 'scheduled', 'timestamp', now()::text)
  );
  $job$
);

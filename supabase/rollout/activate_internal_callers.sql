\set ON_ERROR_STOP on

begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';

do $$
declare
  project_url text;
  approved_project_url text;
begin
  if current_setting('task8.endpoints_verified', true) is distinct from 'true' then
    raise exception 'set PGOPTIONS=-c task8.endpoints_verified=true only after endpoint smoke tests pass';
  end if;
  if to_regprocedure('private.require_internal_job_secret()') is null
    or to_regprocedure('public.notify_activity_insert()') is null
  then
    raise exception 'internal caller schema/RPC migration is not applied';
  end if;

  perform private.require_internal_job_secret();
  select decrypted_secret into project_url
  from vault.decrypted_secrets
  where name = 'supabase_url'
  limit 1;
  approved_project_url := current_setting('task8.approved_project_url', true);
  if project_url is null or project_url !~ '^https://[^/]+$' then
    raise exception 'Vault supabase_url is missing or malformed';
  end if;
  if approved_project_url is null
    or approved_project_url !~ '^https://[^/]+$'
    or project_url <> approved_project_url
  then
    raise exception 'Vault supabase_url does not match the independently approved HTTPS project URL';
  end if;
end
$$;

drop trigger if exists "activity-insert-notification" on public.activities;
drop trigger if exists on_activity_insert on public.activities;
drop trigger if exists runaway_activity_insert_internal on public.activities;

create trigger runaway_activity_insert_internal
after insert on public.activities
for each row execute function public.notify_activity_insert();

do $$
declare
  expected record;
  existing_count integer;
  existing_jobid bigint;
  existing_schedule text;
  caller_command text;
begin
  for expected in
    select *
    from (values
      ('check-conditions-job', '*/30 * * * *', 'check-conditions', true, false),
      ('sync-race-directory-job', '0 2 * * *', 'sync-race-directory', false, false),
      ('daily-research-brief', '0 6 * * *', 'daily-research-brief', true, true),
      ('fetch-daily-articles', '0 6 * * *', 'fetch-daily-articles', true, true)
    ) as jobs(jobname, schedule, target, active, scheduled_body)
  loop
    select count(*), min(jobid), min(schedule)
    into existing_count, existing_jobid, existing_schedule
    from cron.job
    where jobname = expected.jobname;

    if existing_count <> 1 then
      raise exception 'expected exactly one existing cron job %, found %', expected.jobname, existing_count;
    end if;
    if existing_schedule <> expected.schedule then
      raise exception 'cron schedule drift for %: expected %, found %',
        expected.jobname, expected.schedule, existing_schedule;
    end if;

    caller_command := format(
      'select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = ''supabase_url'' limit 1) || %L, headers := jsonb_build_object(''Content-Type'', ''application/json'', ''X-Runaway-Internal-Secret'', private.require_internal_job_secret()), body := %s);',
      '/functions/v1/' || expected.target,
      case when expected.scheduled_body
        then 'jsonb_build_object(''trigger'', ''scheduled'', ''timestamp'', now()::text)'
        else '''{}''::jsonb'
      end
    );

    perform cron.alter_job(existing_jobid, command := caller_command);
    perform cron.alter_job(existing_jobid, active := expected.active);
  end loop;
end
$$;

do $$
begin
  if (select count(*) from pg_trigger
      where tgrelid = 'public.activities'::regclass
        and not tgisinternal
        and tgname = 'runaway_activity_insert_internal') <> 1
  then
    raise exception 'dedicated activity caller cardinality check failed';
  end if;
  if exists (
    select 1 from pg_trigger
    where tgrelid = 'public.activities'::regclass
      and not tgisinternal
      and tgname in ('activity-insert-notification', 'on_activity_insert')
  ) then
    raise exception 'legacy activity caller remains installed';
  end if;
  if (select count(*) from cron.job
      where jobname in (
        'check-conditions-job', 'sync-race-directory-job',
        'daily-research-brief', 'fetch-daily-articles'
      )
        and command like '%X-Runaway-Internal-Secret%'
        and command like '%private.require_internal_job_secret()%') <> 4
  then
    raise exception 'dedicated-secret cron caller cardinality check failed';
  end if;
  if (select count(*) from cron.job where active and jobname in (
      'check-conditions-job', 'daily-research-brief', 'fetch-daily-articles'
    )) <> 3
    or (select count(*) from cron.job where not active and jobname =
      'sync-race-directory-job'
    ) <> 1
  then
    raise exception 'cron active-state preservation check failed';
  end if;
end
$$;

commit;

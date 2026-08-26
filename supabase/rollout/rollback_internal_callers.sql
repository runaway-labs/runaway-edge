\set ON_ERROR_STOP on

begin;
set local lock_timeout = '5s';
set local statement_timeout = '2min';

drop trigger if exists "activity-insert-notification" on public.activities;
drop trigger if exists on_activity_insert on public.activities;
drop trigger if exists runaway_activity_insert_internal on public.activities;

do $$
declare
  job record;
begin
  for job in
    select jobid
    from cron.job
    where jobname in (
      'check-conditions-job', 'sync-race-directory-job',
      'daily-research-brief', 'fetch-daily-articles'
    )
  loop
    perform cron.alter_job(job.jobid, active := false);
  end loop;
end
$$;

commit;

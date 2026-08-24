# Task 6 implementation report

## Scope and safety

Implemented only the Task 6 repository changes in the isolated
`/private/tmp/runaway-edge-security-containment` worktree. No migration was
applied, no Edge Function was deployed or deleted, and no production secret or
live data was read.

## Read-only production inventory

Project `nkxvjcdxiyjbndjvfmqy` reported 55 active Edge Functions. Ten approved
retirement candidates remain deployed: `debug-query`, `run-ddl`,
`fix-elevation`, `fix-elevation-stl`, `list-cron`, `kill-cron`,
`kill-research`, `data-sci-audit`, `pre-run-brief`, and
`backfill-training-zones`.

Three active functions are not represented by a source directory in this Edge
worktree and are intentionally not approved for retirement: `twin-engine`,
`ultratracker`, and `upload-race-course`. The checker reports them as
undocumented until an operational owner supplies their source and classifies
their gateway configuration.

The production migration inventory ends at `20260506000002`. The Task 1,
Task 4, and Task 5 migrations `20260824135752`, `20260824153216`, and
`20260824162713` are not applied. The live `profiles` view contains
`runsignup_access_token`, `runsignup_refresh_token`, and
`runsignup_token_expires_at`; `athletes` has the required base-table credential
columns. Existing cron jobs are limited to the expected internal workflow
names, and no retired target was found in cron or trigger metadata.

Searches of this Edge worktree, Runaway iOS, and runaway-platform found no
callers for any approved retirement candidate. `ultratracker` and
`upload-race-course` have platform-repository source; that does not make them
owned by this Edge deployment manifest.

## Changed paths

- `supabase/config.toml`
- `scripts/audit-deployment.ts`
- `scripts/audit-deployment.test.ts`
- `README.md`
- `.superpowers/sdd/2026-08-24-production-security-containment/progress.md`
- `task-6-implementation-report.md`

## Task 8 rollout and rollback

After explicit production approval, collect a sanitized inventory with function
metadata, migration versions, schema column names, and cron/trigger target
slugs, then require a clean audit before any retirement:

```bash
deno run --allow-read --allow-env --allow-net scripts/audit-deployment.ts /path/to/read-only-inventory.json
supabase functions deploy --project-ref nkxvjcdxiyjbndjvfmqy
supabase functions delete debug-query --project-ref nkxvjcdxiyjbndjvfmqy
supabase functions delete run-ddl --project-ref nkxvjcdxiyjbndjvfmqy
supabase functions delete fix-elevation --project-ref nkxvjcdxiyjbndjvfmqy
supabase functions delete fix-elevation-stl --project-ref nkxvjcdxiyjbndjvfmqy
supabase functions delete list-cron --project-ref nkxvjcdxiyjbndjvfmqy
supabase functions delete kill-cron --project-ref nkxvjcdxiyjbndjvfmqy
supabase functions delete kill-research --project-ref nkxvjcdxiyjbndjvfmqy
supabase functions delete data-sci-audit --project-ref nkxvjcdxiyjbndjvfmqy
supabase functions delete pre-run-brief --project-ref nkxvjcdxiyjbndjvfmqy
supabase functions delete backfill-training-zones --project-ref nkxvjcdxiyjbndjvfmqy
```

Do not run any delete until the three undocumented deployments are either added
to an owner-approved manifest or separately retired, and until the audit has no
schema or deployment drift. Roll back an accidental retirement by redeploying
the last known reviewed source for that slug; do not roll back by restoring a
public credential-bearing view or anonymous privileged function. Gateway JWT
setting rollback for a user/admin function requires an explicit security
approval and is not a routine operational rollback.

## Tests and results

`deno test scripts/audit-deployment.test.ts` could not start because Deno is
not installed in this worktree environment: `zsh: command not found: deno`
(exit `127`). The required production audit command was not run for the same
reason. No alternate runtime was substituted for Deno.

```bash
deno test scripts/audit-deployment.test.ts
deno run --allow-read --allow-env --allow-net scripts/audit-deployment.ts /path/to/read-only-inventory.json
```

The second command is expected to fail against the current production inventory
until Task 8 applies the containment migrations, deploys the manifest settings,
handles the three undocumented functions, and retires the approved list.

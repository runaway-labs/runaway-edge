# Task 8 local/preflight preparation report

Date: 2026-08-24
Worktree: `/private/tmp/runaway-edge-security-containment`
Branch: `codex/security-containment`
Task base: `ae54bbc663f60a889dc27a9adc936777a2f38cbe`
Project inventory target: `nkxvjcdxiyjbndjvfmqy`

## Safety outcome

No production mutation occurred. No linked migration was applied, no Edge
Function was deployed or deleted, no secret or Vault value was set, no cron or
trigger was altered, and no credential was rotated. All Management API and Edge
bundle operations were read-only.

## Implementation completed

- Reclassified `twin-engine`, `ultratracker`, and `upload-race-course` from
  `unknown-blocker` to `approved-retirement`, leaving 42 expected-active, 13
  approved-retirement, and zero unknown functions.
- Retrieved and reviewed each retirement's complete live bundle independently.
  All passed the deployment scanner before repository copy. Archives record the
  deployed gateway settings (`false`, `true`, and `true` respectively), canonical
  hashes, and `blocked-pending-security-review` restore policy.
- Retrieved and reviewed complete live bundles for the five missing active
  baselines. All passed secret scanning; their canonical hashes are now pinned
  in `FUNCTION_MANIFEST`.
- Generated `20260824201237_activities_client_operation_id.sql` with Supabase CLI
  2.98.2. It adds nullable UUID `public.activities.client_operation_id`, an exact
  non-partial unique constraint on `(athlete_id, client_operation_id)` for the
  Task 7 PostgREST conflict target, enables RLS, and installs owner-scoped
  authenticated SELECT/INSERT/UPDATE policies through `athletes.auth_user_id`.
- Extended pgTAP coverage for UUID/nullability, exact constraint and backing
  index, RLS/policy presence, same-owner replay returning the canonical row,
  cross-owner rejection, per-athlete uniqueness, and nullable legacy rows.
- Extended live drift/schema inventory for the migration version, column, type,
  nullability, exact unique constraint, RLS, and ownership-policy contract.
- Added a production runbook and sanitized Task 8 preflight inventory.

## Canonical live bundle results

```text
backfill-splits      files=2 sha256=250149d08c7f277231b8d0c43efe08d8ea7f244398562511c04447602eb70ff7 secret-scan=pass
identity-profile     files=3 sha256=22c65dc21db97fbfc17a7dee549d65dfa83801c1cbc13f340be9d5b7259a09b4 secret-scan=pass
feedback-workout     files=3 sha256=1bc3a324102f63039d3590a08d0c0ba5908aafc7c65f711dc8908c7ee3506723 secret-scan=pass
check-milestones     files=3 sha256=77eedb8acedf8464d301dfc391ddd2c255be43e09e3d275b3aae962be9d2c231 secret-scan=pass
generate-run-cues    files=3 sha256=c980d0bbabd4710161372cdd03c4172f5a72cd771508c058feafb11a47ca1f5e secret-scan=pass
twin-engine          files=2 sha256=4c3556a83fd61ef194a6e5095cef85b85e313d0d30de4de6586ce6acf63a2894 verify_jwt=false secret-scan=pass
ultratracker         files=2 sha256=cd52753fd39cc6211da32bf3e9e83f4a8973913df19f78b07e8803472354b556 verify_jwt=true secret-scan=pass
upload-race-course   files=3 sha256=382e0a2b01bbe0f40dcdc6e6210281e07facfc06688fe60c5174f4c3ac50df5e verify_jwt=true secret-scan=pass
```

No source contained a matching JWT, Supabase secret-key literal, bearer literal,
private key, or literal credential assignment.

The byte-preserved `upload-race-course` live archive contains one historical
trailing-whitespace line. It is intentionally unchanged so its canonical hash
remains recovery-verifiable; the cached whitespace gate excludes only
`supabase/retired-functions/**` and covers every active Task 8 path.

## Focused test outputs

### Test-first RED

Node 24's native TypeScript stripping with the existing Deno compatibility shim:

```text
17 passed; 3 failed
FAIL manifest explicitly classifies exactly 55 deployed slugs
FAIL schema audit requires the Task 7 activity idempotency and ownership contract
FAIL retirement entries require reviewed JWT and blocked restore metadata
```

Each failure was caused by the intended missing Task 8 behavior.

### Final focused audit

Same bounded runner after implementation:

```text
20 passed; 0 failed
```

Passing cases:

```text
manifest explicitly classifies exactly 55 deployed slugs
truncated function inventory and count mismatch fail closed
omitted inventory sections fail closed
extra local source directory and config section fail closed
bundle builder rejects a missing entrypoint
bundle builder rejects a missing relative dependency
missing and mismatched complete live bundle hashes fail closed
all active baselines are reviewed and a null baseline blocks every mode
canonical bundle hashes ignore checkout roots but detect modified bytes
pre mode permits exact archived retirement set and post mode requires it absent
unknown classifications block rollout even with exact inventory equality
schema audit requires redirect_url and fresh-replay RunSignUp columns
schema audit requires the Task 7 activity idempotency and ownership contract
all eight privileged RPC signatures and grants are mandatory
every delivery and OAuth-state RPC requires exact service-only role grants
retirement entries require reviewed JWT and blocked restore metadata
fresh-replay migration adds typed athlete columns without touching profiles
workflow gate rejects global JWT bypass and audit-after-deploy ordering
checked-in workflow and migration satisfy static release gates
README never presents archived utilities as active or runnable
```

### Deno

`npm_config_offline=true npx --yes deno test --allow-read scripts/audit-deployment.test.ts`
exited 1 with `ENOTCACHED`; the Deno package was not available in the npm cache.
No broad online retry was started after the checkpoint request.

### Supabase local stack and pgTAP

The sandboxed start failed on Docker socket permission. The approved unrestricted
start and read-only `docker info`/`supabase status` calls then remained blocked at
the Docker daemon with no output. All task-started processes were stopped at the
checkpoint. Consequently no local reset, migration execution, or pgTAP suite ran.

### iOS

`xcrun simctl list runtimes` and `xcrun simctl list devices available` could not
connect to CoreSimulatorService in the sandbox. No `xcodebuild` was started after
the checkpoint request, and the gitignored plist was not copied.

## Partial complete-bundle inventory

The interrupted read-only full inventory preserved 29/55 complete temporary
bundle downloads. The eight bundles required for Task 8 classification/baseline
closure are complete. The 26 missing full-audit bundles are:

```text
import-runners
job-status
journal
max-data
micro-wins
notify-activity-insert
oauth-callback
process-deliveries
regenerate-training-plan
send-alert
strava-auth
strava-webhook
sync-beta
sync-race-directory
training-plan
user-races
backfill-training-zones
data-sci-audit
debug-query
fix-elevation
fix-elevation-stl
kill-cron
kill-research
list-cron
pre-run-brief
run-ddl
```

## Remaining live blockers

1. Download and secret-scan the 26 missing live bundles, then run the complete
   `--mode deploy` read-only audit. It has not run at this checkpoint.
2. Generate a fresh sanitized read-only live schema/RPC/cron/trigger inventory.
   The `--mode pre` dry run has not run because the complete bundle set and schema
   inventory are unavailable.
3. Local Docker must become responsive; then run local reset, all migrations, and
   all three pgTAP suites (`security_containment.sql`, `internal_jobs.sql`, and
   `oauth_state.sql`). The Task 8 migration has not executed against PostgreSQL.
4. Required live migrations remain deferred:
   `20260824135752`, `20260824153216`, `20260824162713`, `20260824172420`, and
   `20260824201237`.
5. The 42 active functions are not deployed and their post-deploy bundle/JWT
   settings are not verified. The 13 retirement functions remain live and have
   not been deleted.
6. `INTERNAL_JOB_SECRET` is not provisioned in Edge/Vault; cron and trigger callers
   are not migrated; credential rotations are not performed.
7. Legacy Garmin initiation has not been blocked or drained for its ten-minute
   plaintext-state window. Production smoke checks, advisors, and logs remain
   unrun.
8. iOS tests still require a usable iOS 26.5 simulator/CoreSimulatorService. No
   plist or production configuration was copied into the isolated iOS worktree.

## Preflight status

`BLOCKED / NOT READY FOR LIVE WRITES`.

The preparation implementation and required eight-bundle review are complete,
but full deploy/pre audit, database-runtime verification, and iOS execution are
not. Production rollout remains with the controller after these blockers clear.

## Preserved unrelated changes

The carried modification to `supabase/functions/strava-webhook/index.ts` and the
pre-existing untracked `docs/superpowers/` plan/spec files were not modified for,
staged with, or included in the Task 8 preparation commit.

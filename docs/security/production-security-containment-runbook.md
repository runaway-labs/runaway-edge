# Production Security Containment Runbook

This is fail-closed production guidance. Task 8 local work must not run these commands against production.

## Inputs and hard stops

```sh
export REPO=/path/to/runaway-edge-security-containment
export PROJECT_REF='<production-project-ref>'
export DB_URL='<production-database-url>'
export SUPABASE_URL="https://${PROJECT_REF}.supabase.co"
export EVIDENCE_DIR="$REPO/.task8-production-evidence/$(date -u +%Y%m%dT%H%M%SZ)"
export TASK7_REPO=/private/tmp/runaway-ios-security-compatibility
export TASK7_COMMIT='1678581de84bae903a687aa198cb21b474e81500'
mkdir -p "$EVIDENCE_DIR" && chmod 700 "$EVIDENCE_DIR"
test "$(git -C "$REPO" rev-parse HEAD)" = '<approved-task-8-commit>'
test "$(git -C "$TASK7_REPO" rev-parse HEAD)" = "$TASK7_COMMIT"
test -z "$(git -C "$REPO" status --porcelain --untracked-files=all)"
test -z "$(git -C "$TASK7_REPO" status --porcelain --untracked-files=all)"
```

Stop on any mismatch, incomplete inventory, smoke failure, active Garmin initiation, unexpired Garmin state, or unexpected drift.

## Exact staged cohorts

| Cohort | Functions | JWT |
| --- | --- | --- |
| User | `backfill-splits check-milestones feedback-workout identity-profile journal sync-beta training-plan user-races` | enabled |
| Internal | `breakthrough-milestones check-conditions daily-research-brief fetch-daily-articles notify-activity-insert process-deliveries sync-race-directory` | disabled; dedicated secret required |
| OAuth initiators | `garmin-auth strava-auth` | enabled |
| OAuth callbacks | `garmin-callback oauth-callback` | disabled |

All 23 deferred functions stay at captured live bundle hashes and JWT flags. Bare fleet deployment is forbidden.

## Phase 0: compatible-app release gate

Task 7 source is only `/private/tmp/runaway-ios-security-compatibility` at the approved clean `TASK7_COMMIT`, not the original checkout. The commit must contain the tested actor-isolation and nil-`localRecordID` queue-coalescing fixes.

1. Build and sign that commit.
2. Verify `client_operation_id`, additive activity-schema compatibility, and contained OAuth errors.
3. Release it and enforce the approved compatible minimum version or adoption threshold.
4. Record build, release URL, availability, minimum-version control, adoption, and release-owner approval in `$EVIDENCE_DIR/ios-release-gate.txt`.

No database rollout starts before this signed gate.

## Phase 1: baseline and strict preflight

Capture all 55 bundles/JWT flags, five cron schedules/states, triggers, policies, RPC grants, migrations, row distributions, and view definitions. Production must contain exactly these captured definitions:

| View | Definition MD5 |
| --- | --- |
| `public.activity_summary` | `3f91ffc93cc5cd952cc9873de6c5dc63` |
| `public.conversation_summaries` | `2b46d7b0aafbacf2b8f044214d1f6ba3` |
| `public.monthly_activity_stats` | `ed5bab41993ca187a0a25c2098ebf9c2` |
| `public.recent_journal_entries` | `b9a0389d9cedcc19f11f70776d33ee23` |

```sh
cd "$REPO"
npx --yes deno test --allow-read scripts/audit-deployment.test.ts
npx --yes deno run --allow-read --allow-env --allow-net scripts/audit-deployment.ts --mode deploy --remote-bundles "$EVIDENCE_DIR/live-bundles-before" > "$EVIDENCE_DIR/audit-deploy.json"
test "$(jq '.errors|length' "$EVIDENCE_DIR/audit-deploy.json")" = 0
mkdir -p "$EVIDENCE_DIR/baseline-checkout/supabase/functions"
cp -R "$EVIDENCE_DIR/live-bundles-before/." "$EVIDENCE_DIR/baseline-checkout/supabase/functions/"
jq -r '.comparisons[] | "[functions.\(.slug)]\nverify_jwt = \(.deployedVerifyJwt)\n"' "$EVIDENCE_DIR/audit-deploy.json" > "$EVIDENCE_DIR/baseline-checkout/supabase/config.toml"
test "$(find "$EVIDENCE_DIR/baseline-checkout/supabase/functions" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" = 55
chmod -R a-w "$EVIDENCE_DIR/baseline-checkout"
```

Capture with a read-only database role:

```sql
begin read only;
select c.relname,md5(pg_get_viewdef(c.oid, true)) definition_md5,c.reloptions from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('activity_summary','conversation_summaries','monthly_activity_stats','recent_journal_entries') order by c.relname;
select schemaname,tablename,policyname,cmd,roles,qual,with_check from pg_policies where schemaname in ('public','private') order by schemaname,tablename,policyname;
select count(*) total,count(*) filter(where athlete_id is null) ownerless,count(*) filter(where client_operation_id is not null) with_operation_id from public.activities;
select athlete_id,count(*) from public.activities group by athlete_id order by count(*) desc;
select count(*) plans,count(*) filter(where athlete.id is null) orphans from public.weekly_training_plans plan left join public.athletes athlete on athlete.id=plan.athlete_id;
select status,count(*) from public.alert_deliveries group by status order by status;
select jobname,schedule,active from cron.job order by jobname;
commit;
```

Require four exact view hashes, zero plan orphans, reviewed ownership/policies, and exact captured schedules/states.

## Phase 2: Garmin initiation block and drain

`garmin-auth` checks this switch before creating OAuth or PKCE state.

```sh
umask 077
printf '%s\n' 'GARMIN_OAUTH_INITIATION_BLOCKED=true' > "$EVIDENCE_DIR/garmin-block.env"
supabase secrets set --project-ref "$PROJECT_REF" --env-file "$EVIDENCE_DIR/garmin-block.env"
supabase functions deploy garmin-auth --project-ref "$PROJECT_REF"
status="$(curl -sS -o "$EVIDENCE_DIR/garmin-block.json" -w '%{http_code}' -H "Authorization: Bearer $TASK8_SMOKE_USER_JWT" "$SUPABASE_URL/functions/v1/garmin-auth")"
test "$status" = 503
test "$(jq -r .code "$EVIDENCE_DIR/garmin-block.json")" = GARMIN_OAUTH_INITIATION_BLOCKED
sleep 600
```

From this point through Phase 6, `cohort-user` and `cohort-internal` audits intentionally treat `garmin-auth` as already deployed while the other OAuth functions remain pinned to baseline. Refresh bundles after the block deployment and require that only `garmin-auth` differs from the Phase 1 active baseline.

Require zero from this query without deleting rows; recheck every 60 seconds if nonzero and do not proceed:

```sql
select (select count(*) from private.oauth_states where provider='garmin' and consumed_at is null and expires_at>now())+(select count(*) from public.garmin_oauth_tokens where expires_at>now()) as unexpired_garmin_state;
```

Repeat the `503` smoke and zero-state query immediately before OAuth migration and before unblocking.

## Phase 3: five base migrations, no callers

Apply only these files in order; do not run activation:

```sh
for migration in supabase/migrations/20260824135752_production_security_containment.sql supabase/migrations/20260824153216_secure_internal_jobs.sql supabase/migrations/20260824162713_oauth_state_security.sql supabase/migrations/20260824172420_add_runsignup_credentials_to_athletes.sql supabase/migrations/20260824201237_activities_client_operation_id.sql
do
  psql "$DB_URL" -v ON_ERROR_STOP=1 -X -f "$migration" || exit 1
done
```

Require all five target jobs inactive and no `activity-insert-notification`, `on_activity_insert`, or `runaway_activity_insert_internal`. Run `--mode cohort-user`; it must require `internal_callers_inactive=true`.

## Phase 4: user cohort and smoke

```sh
for slug in backfill-splits check-milestones feedback-workout identity-profile journal sync-beta training-plan user-races; do supabase functions deploy "$slug" --project-ref "$PROJECT_REF" || exit 1; done
```

Refresh all bundles and run `--mode cohort-user`. Smoke activity create/retry with one `client_operation_id`, owner select/update/delete, cross-owner denial, and all eight endpoint contracts.

## Phase 5: secrets and internal cohort

Generate one high-entropy value. Put the same value in Edge secrets and Vault without printing it; retain prior values in the approved secret manager.

```sh
supabase secrets set --project-ref "$PROJECT_REF" --env-file "$EVIDENCE_DIR/internal-edge-secret.env"
psql "$DB_URL" -v ON_ERROR_STOP=1 -X -f "$EVIDENCE_DIR/install-internal-vault-secret.sql"
for slug in breakthrough-milestones check-conditions daily-research-brief fetch-daily-articles notify-activity-insert process-deliveries sync-race-directory; do supabase functions deploy "$slug" --project-ref "$PROJECT_REF" || exit 1; done
```

Vault SQL must create/update exactly `internal_job_secret` and verify `supabase_url` is approved HTTPS. Run `--mode cohort-internal`; callers remain inactive. Smoke all seven endpoints with the secret and require `401/403` without it or with only service-role bearer.

## Phase 6: final caller activation

Only after all internal endpoint smokes pass:

```sh
PGOPTIONS="-c task8.endpoints_verified=true -c task8.approved_project_url=$SUPABASE_URL" psql "$DB_URL" -v ON_ERROR_STOP=1 -X -f supabase/rollout/activate_internal_callers.sql
```

Require exactly one `runaway_activity_insert_internal`, no legacy trigger, five secret-only cron commands, three originally active jobs active, and `process-deliveries-job` plus `sync-race-directory-job` inactive with schedules unchanged. Smoke one insert/one notification, invoke active jobs once, and prove inactive jobs did not run.

## Phase 7: OAuth cohort while Garmin stays blocked

```sh
for slug in garmin-auth strava-auth garmin-callback oauth-callback; do supabase functions deploy "$slug" --project-ref "$PROJECT_REF" || exit 1; done
```

Run `--mode cohort-oauth`; it requires dedicated callers. Smoke Strava flow, Garmin invalid/expired/replayed state rejection, redirect allowlist, ownership, Garmin `503`, and zero unexpired state.

## Phase 8: retirement with before/after smoke

Download all bundles and run `--mode pre`; repeat all smokes. Retire exactly these 13 reviewed archives, one explicit slug at a time:

```sh
RETIREMENT_SLUGS='backfill-training-zones data-sci-audit debug-query fix-elevation fix-elevation-stl kill-cron kill-research list-cron pre-run-brief run-ddl twin-engine ultratracker upload-race-course'
for slug in $RETIREMENT_SLUGS; do
  supabase functions delete "$slug" --project-ref "$PROJECT_REF" || exit 1
  supabase functions list --project-ref "$PROJECT_REF" --output json > "$EVIDENCE_DIR/functions-after-$slug.json" || exit 1
  test "$(jq --arg slug "$slug" '[.[] | select(.slug == $slug)] | length' "$EVIDENCE_DIR/functions-after-$slug.json")" = 0 || exit 1
done
```

Never deploy or retire a deferred function. Then download all bundles, run `--mode post`, repeat all smokes, and prove no fleet deployment. Any restore remains blocked pending the archive-specific security review.

## Phase 9: unblock Garmin

```sh
supabase secrets unset GARMIN_OAUTH_INITIATION_BLOCKED --project-ref "$PROJECT_REF"
supabase functions deploy garmin-auth --project-ref "$PROJECT_REF"
```

Smoke initiation/callback, one-time consumption, and replay rejection. Failure restores the block and invokes OAuth rollback.

## Executable rollback

### Trigger, cron, endpoint, or uncertain secret state

```sh
psql "$DB_URL" -v ON_ERROR_STOP=1 -X -f supabase/rollout/rollback_internal_callers.sql
```

Require all five jobs inactive and all three activity trigger names absent. Never reactivate automatically.

### Function or JWT partial failure

Use the immutable baseline checkout and captured `supabase/config.toml`; never fleet-deploy or override JWT flags.

```sh
cd "$EVIDENCE_DIR/baseline-checkout"
for slug in $PARTIALLY_DEPLOYED_APPROVED_SLUGS; do supabase functions deploy "$slug" --project-ref "$PROJECT_REF" || exit 1; done
cd "$REPO"
```

Refresh all 55 bundles and audit the last completed stage; rolled-back and deferred hashes/JWT flags must equal baseline.

### Edge or Vault secret failure

```sh
psql "$DB_URL" -v ON_ERROR_STOP=1 -X -f supabase/rollout/rollback_internal_callers.sql
supabase secrets set --project-ref "$PROJECT_REF" --env-file "$EVIDENCE_DIR/rollback-internal-edge-secret.env"
psql "$DB_URL" -v ON_ERROR_STOP=1 -X -f "$EVIDENCE_DIR/rollback-internal-vault-secret.sql"
```

Disable callers first, never print values, and direct-smoke endpoints before another activation window.

### OAuth partial failure

```sh
supabase secrets set --project-ref "$PROJECT_REF" --env-file "$EVIDENCE_DIR/garmin-block.env"
cd "$EVIDENCE_DIR/baseline-checkout"
for slug in garmin-auth strava-auth garmin-callback oauth-callback; do supabase functions deploy "$slug" --project-ref "$PROJECT_REF" || exit 1; done
cd "$REPO"
```

Keep Garmin blocked, restore changed provider secrets, never delete state, wait for expiry, require zero, and repeat initiation/callback/replay smokes.

### Schema/RPC or retirement failure

Do not write ad-hoc down migrations. Disable callers, keep Garmin blocked, preserve output, and use approved point-in-time recovery if anything committed outside its transaction. Restore only an exact approved archive with captured JWT and incident-commander approval. `run-ddl` stays restore-blocked pending separate review.

## Credential rotation matrix

| Credential | Timing | Scope/owner | Verify before revoking old value |
| --- | --- | --- | --- |
| Internal-job secret | Before activation | Edge plus Vault/backend owner | Seven endpoints and exact five callers |
| Legacy service-role/JWT caller value | After post-audit | Project and legitimate consumers/platform owner | No caller contains it; consumers use replacement |
| RunSignUp access/refresh | After column move | Per athlete/integrations owner | Owner-only refresh; profiles expose none |
| Garmin consumer secret | OAuth stable, initiation blocked | Garmin plus Edge/OAuth owner | Callback, consumption, replay, initiation |
| Strava client secret | OAuth stable | Strava plus Edge/OAuth owner | Initiation, callback, ownership, replay |
| Supabase deployment token | After rollout | CI only/platform owner | Replacement runs explicit cohort workflow |

Record identifier, owner, timestamps, consumers, verification, and revocation; never secret values.

## Final evidence gate

Attach Task 7 build evidence, every audit JSON, bundle/JWT inventories, before/after database evidence, policy predicates, row distributions, migration output, caller states, Garmin block/drain/unblock, before/after smokes, rotations, rollback artifacts, and approved Task 8 commit. Missing evidence remains a blocker.

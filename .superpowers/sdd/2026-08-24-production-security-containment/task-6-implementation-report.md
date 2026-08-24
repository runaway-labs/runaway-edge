# Task 6 implementation report

## Outcome and safety

Task 6 now has a fail-closed deployment gate covering all 55 functions observed
in production. No migration was applied, no function was deployed or deleted,
and no production configuration, secret, or row data was mutated.

## Manifest and inventories

- 42 functions are `expected-active` with an explicit user, provider, internal,
  or admin JWT class.
- 10 functions are `approved-retirement`: `debug-query`, `run-ddl`,
  `fix-elevation`, `fix-elevation-stl`, `list-cron`, `kill-cron`,
  `kill-research`, `data-sci-audit`, `pre-run-brief`, and
  `backfill-training-zones`.
- 3 functions are `unknown-blocker`: `twin-engine`, `ultratracker`, and
  `upload-race-course`. Task 8 may not deploy or retire functions until an owner
  resolves these classifications.

Exact function-set equality is required. Missing inventory sections, duplicate
or truncated functions, missing live metadata or complete bundle hashes,
missing cron/trigger inventories, and mode-specific count mismatches fail.

Read-only production hook inventory found five Edge cron targets:
`check-conditions-job`, `daily-research-brief`, `fetch-daily-articles`,
`process-deliveries-job`, and `sync-race-directory-job`. The only direct Edge
trigger target is `on_activity_insert:public.activities` to
`notify-activity-insert`.

## Retirement recovery coverage

All 10 approved retirement bundles were retrieved through read-only Supabase
`get_edge_function`, archived under `supabase/retired-functions/<slug>/bundle`,
and scanned for JWTs, Supabase secret literals, bearer literals, private keys,
and literal credential assignments. All 10 scans passed. Each archive has an
`archive.json` recording its source, file count, deterministic bundle SHA-256,
and review status. Any missing, modified, empty, or secret-bearing archive makes
both deploy and retirement audits fail.

Complete reviewed baseline bundles were retrieved for 50 of 55 live functions.
Supabase rate-limited `backfill-splits`, `identity-profile`,
`feedback-workout`, `check-milestones`, and `generate-run-cues` after three
attempts. Their baseline hash is intentionally unset; CI must still download and
hash their complete live bundles, and pre/post mode compares them to the local
deployable bundle. No missing hash is accepted.

## Schema reconciliation

Generated `20260824172420_add_runsignup_credentials_to_athletes.sql` with the
Supabase CLI. It adds `runsignup_access_token text`,
`runsignup_refresh_token text`, and `runsignup_token_expires_at timestamptz` to
`public.athletes` for fresh replay without modifying `public.profiles`.

The live audit requires all Task 1, Task 4, and Task 5 migrations and explicit
catalog assumptions, including credential-free profiles, view/grant/RLS/RPC
containment, delivery and internal-secret schema, persisted OAuth state with
`redirect_url`, and service-only Garmin OAuth tokens.

## Rollout and rollback for Task 8

1. Resolve all three `unknown-blocker` classifications and update the 55-slug
   manifest deliberately.
2. Apply the four approved local containment migrations through the Task 8
   approval gate.
3. Download each current live bundle into a separate temporary workdir and run
   `--mode deploy`; this verifies the reviewed baseline before deployment.
4. Deploy with `supabase functions deploy --project-ref <ref> --use-api` and no
   global JWT override. Repository `config.toml` supplies each endpoint class.
5. Download each deployed bundle again and run `--mode pre`. It must pass before
   any retirement deletion.
6. Delete only the ten approved retirement slugs, then download inventory again
   and run `--mode post`.

If an approved retirement must be restored, deploy its reviewed archive from
`supabase/retired-functions/<slug>/bundle` with the recorded function-specific
JWT setting after explicit approval. Never roll back by reopening credential
views, anonymous privileged RPCs, or a global JWT bypass.

## Changed paths

- `.github/workflows/deploy-functions.yml`
- `scripts/audit-deployment.ts`
- `scripts/audit-deployment.test.ts`
- `supabase/config.toml`
- `supabase/migrations/20260824172420_add_runsignup_credentials_to_athletes.sql`
- `supabase/tests/security_containment.sql`
- `supabase/functions/run-ddl/index.ts` (removed from active deployment source)
- `supabase/functions/pre-run-brief/*` and
  `supabase/functions/backfill-training-zones/*` (existing carried removals)
- `supabase/retired-functions/**`
- `README.md`
- `.superpowers/sdd/2026-08-24-production-security-containment/progress.md`
- `.superpowers/sdd/2026-08-24-production-security-containment/task-6-implementation-report.md`

## Tests and exact results


## Review-fix checkpoint verification

- Focused audit suite: `node --experimental-strip-types` with a temporary Deno filesystem/test compatibility harness, `13 passed; 0 failed`.
- Preferred offline fallback attempt: `npm_config_offline=true npx --yes deno test --allow-read scripts/audit-deployment.test.ts` exited immediately with `ENOTCACHED`; no package download or live operation occurred.
- Static whitespace check: `git diff --check` initially identified two extra EOF blank lines; corrected before commit.
- Production mutations: none. No deploy, function deletion, migration application, or write query was performed.
- Retirement recovery coverage: 10/10 approved-retirement functions have reviewed, secret-scanned source archives under `supabase/retired-functions/`; no retirement target is unarchived.
- Task 8 remains blocked for the three `unknown-blocker` functions (`twin-engine`, `ultratracker`, `upload-race-course`) and until the fail-closed live preflight obtains complete live hashes for every function and all schema/cron/trigger checks pass.
- Archive fidelity exception: full `git diff --cached --check` reports pre-existing trailing whitespace in byte-preserved live archives for `debug-query`, `fix-elevation-stl`, `kill-research`, and `list-cron`. These bytes are intentionally unchanged so archive hashes remain valid; the active-file check excludes only `supabase/retired-functions/**`.

## Remaining-finding closure

- Reviewed-baseline enforcement now rejects null or missing active baselines in `deploy`, `pre`, and `post`; the exact unresolved Task 8 blockers remain `backfill-splits`, `check-milestones`, `feedback-workout`, `generate-run-cues`, and `identity-profile`.
- Bundle hashing canonicalizes local, downloaded, and archived roots to paths relative to the functions bundle. Byte-identical cross-root bundles hash equally; changed bytes hash differently.
- Live inventory now requires exact grant data for all eight protected user RPC signatures and fails on an omitted signature, omitted grant field, missing function, anonymous EXECUTE, or missing authenticated/service-role EXECUTE.
- Read-only deployed metadata confirmed `verify_jwt=false` for all ten approved-retirement functions. Every manifest entry and `archive.json` records that value plus `restore_policy=blocked-pending-security-review`.
- Archived utilities are documented as retired, non-runnable recovery evidence. No archive implies automatic restoration; restoration requires a dedicated security review.
- Focused bounded suite: Node 24 native TypeScript stripping with the local Deno compatibility harness, `18 passed; 0 failed`.
- Static check: `git diff --check`, exit 0.
- Production mutations: none.

## Final service-only RPC and README closure

- Added exact live grant inventory for five service-only public RPCs: `claim_pending_deliveries(integer)`, `begin_delivery_submission(uuid,bigint)`, `finalize_delivery(uuid,bigint,text,text,text,timestamp with time zone)`, `create_oauth_state(text,text,uuid,bigint,text,timestamp with time zone)`, and `consume_oauth_state(text,text)`.
- Every signature now requires `anon=false`, `authenticated=false`, and `service_role=true`; omitted signatures, omitted role fields, and every wrong role value fail closed. The delivery and OAuth-state schema assumptions independently apply the same three-role contract.
- Removed the stale hardcoded README migration count. The README now points to the migrations directory as the source-derived inventory; the checkout contained 27 migration files at this review checkpoint.
- Focused bounded suite: `19 passed; 0 failed`, including all 30 per-signature wrong/omitted role combinations and missing-signature coverage.
- Static check: `git diff --check`, exit 0.
- Production mutations: none.

## README source-derived inventory wording

- Replaced the stale active-function directory count with wording derived from `supabase/functions/`; migration wording remains source-derived from `supabase/migrations/`.
- Added focused regression coverage rejecting hardcoded README function or migration directory counts.
- Focused bounded suite: `19 passed; 0 failed`.
- Static check: `git diff --check`, exit 0.

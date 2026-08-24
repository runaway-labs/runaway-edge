# Task 4 implementation report

## Outcome

Task 4 is implemented locally on `codex/security-containment` without deploying functions, applying migrations, provisioning secrets, or mutating any live database.

Internal-job requests use a shared fixed-length constant-time comparison of `X-Runaway-Internal-Secret` against the Edge environment's `INTERNAL_JOB_SECRET`. Missing configuration returns stable `500 INTERNAL_AUTH_NOT_CONFIGURED`; missing or mismatched credentials return stable `401 INVALID_INTERNAL_CREDENTIALS`. Guard failures are returned without logging either credential.

Delivery processing now atomically claims `pending` or `retryable` rows through `FOR UPDATE SKIP LOCKED`, marks them `processing` in the same statement, and conditionally transitions only still-processing rows to `sent`, `retryable`, or `failed`. Each row has a generated `<delivery-id>:<channel>` idempotency key. Resend receives this key in `Idempotency-Key`; SMS failures are not automatically retried because Twilio's Messages API does not document an equivalent idempotency contract.

## Changed paths

- `.superpowers/sdd/2026-08-24-production-security-containment/progress.md`
- `.superpowers/sdd/2026-08-24-production-security-containment/task-4-implementation-report.md`
- `supabase/config.toml`
- `supabase/functions/_shared/cors.ts`
- `supabase/functions/_shared/require-internal.ts`
- `supabase/functions/_shared/require-internal.test.ts`
- `supabase/functions/_shared/resend.ts`
- `supabase/functions/_shared/types.ts`
- `supabase/functions/notify-activity-insert/index.ts`
- `supabase/functions/check-conditions/index.ts`
- `supabase/functions/process-deliveries/index.ts`
- `supabase/functions/breakthrough-milestones/index.ts`
- `supabase/functions/daily-research-brief/index.ts`
- `supabase/functions/fetch-daily-articles/index.ts`
- `supabase/functions/sync-race-directory/index.ts`
- `supabase/migrations/20260824153216_secure_internal_jobs.sql`
- `supabase/tests/internal_jobs.sql`

The shared CORS helper path is included because the three existing internal handlers imported `handleCors`, `jsonResponse`, and `errorResponse`, but the module exported only `corsHeaders`; the missing export contract was reproduced before adding the minimal helpers.

## Migration behavior

`supabase migration new secure_internal_jobs` generated `supabase/migrations/20260824153216_secure_internal_jobs.sql` with Supabase CLI `2.98.2`.

The migration:

- Extends delivery state with `processing` and `retryable`.
- Adds `attempt_count`, `processing_started_at`, and a generated unique `idempotency_key`.
- Creates `private.claim_pending_deliveries(integer)` as a short atomic claim/update statement using `FOR UPDATE SKIP LOCKED`.
- Grants private function execution only to `service_role`.
- Adds a revoked-by-default `public.claim_pending_deliveries(integer)` security-definer wrapper so the non-exposed `private` schema remains absent from the Data API while service-role Edge code can invoke the RPC.
- Recreates the activity insert trigger with runtime Vault lookup of `supabase_url` and `internal_job_secret`.
- Replaces the five scheduled HTTP commands with Vault-backed `X-Runaway-Internal-Secret` headers.

## Exact tests and results

### Test-first RED

Command: Node 24 TypeScript shim importing `supabase/functions/_shared/require-internal.test.ts` before implementation.

Result: exit `1`, expected `ERR_MODULE_NOT_FOUND` for `supabase/functions/_shared/require-internal.ts`.

### Requested Deno test

Command:

```bash
deno test supabase/functions/_shared/require-internal.test.ts
```

Result: exit `127`; `zsh:1: command not found: deno`.

### Safe local Deno-test fallback

Command: Node `v24.16.0` with `--experimental-strip-types`, a minimal `Deno.test` registration shim, and the real test/module imports.

Result: exit `0`; 3 tests passed:

- `requireInternal fails closed when the server secret is not configured`
- `requireInternal gives the same stable error for missing and mismatched credentials`
- `requireInternal accepts the exact internal credential`

### Shared CORS dependency contract

RED result: exit `1`; missing exports were exactly `handleCors`, `jsonResponse`, and `errorResponse`.

GREEN result: exit `0`; `ok - shared CORS export contract`.

### Guard ordering

Command: local Node static boundary check over all seven handler entrypoints.

Result: exit `0`; 7 checks passed. Every handler validates the method, calls `requireInternal(req)`, and only then reaches request-body parsing or admin-client construction.

### Database pgTAP test

Requested command:

```bash
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/internal_jobs.sql
```

Result: not run. The safe availability gate exited `2` with `NOT RUN: TEST_DATABASE_URL is unset; refusing to guess a database target.` Docker is unavailable, so no isolated Supabase/Postgres runtime could be started. Consequently, migration execution and the two-connection `dblink` concurrency assertions have not received DB-runtime validation in this task.

### Static checks

- `git diff --check`: exit `0`, no whitespace errors.
- Embedded-secret/log scan over Task 4 guard, handlers, and migration: no literal internal secret and no internal-secret logging found.
- The scan identified the existing `sync-race-directory` to `classify-races` service-role bearer call. That target is not one of the seven approved Task 4 internal handlers, so its existing authentication contract was preserved rather than widening this task.

## Rollout dependencies

- Task 8 approval is required before generating or setting the 32-byte internal secret.
- Task 8 must provision the same value as Edge secret `INTERNAL_JOB_SECRET` and Vault secret `internal_job_secret` before this migration/function set is activated.
- Task 8 must apply the migration and deploy all seven guarded functions as one coordinated rollout; callers will fail closed until both secret stores are populated.
- Rerun the exact Deno test in an environment with Deno installed.
- Rerun `supabase/tests/internal_jobs.sql` against an isolated test database with pgTAP and dblink available before production rollout.
- Validate the pre-existing `classify-races` authentication contract during the Task 6/8 deployment inventory; it was intentionally not reclassified in Task 4.
- No Edge secret, Vault value, migration, cron job, trigger, function deployment, or production data was changed by this task.

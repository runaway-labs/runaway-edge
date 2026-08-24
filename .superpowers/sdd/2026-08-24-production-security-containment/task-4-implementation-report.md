# Task 4 implementation report

## Outcome

Task 4 is implemented locally on `codex/security-containment` without deploying functions, applying migrations, provisioning secrets, or mutating any live database.

Internal-job requests use a shared fixed-length constant-time comparison of `X-Runaway-Internal-Secret` against the Edge environment's `INTERNAL_JOB_SECRET`. The only accepted encoding is exactly 64 lowercase hexadecimal characters matching `[0-9a-f]{64}`, decoding to exactly 32 bytes, with at least eight distinct hexadecimal digits. Prefixes, separators, padding, uppercase, whitespace, placeholders, and low-entropy repeated values are rejected before comparison. Missing or malformed configuration returns stable `500 INTERNAL_AUTH_NOT_CONFIGURED`; missing, malformed, or mismatched credentials return stable `401 INVALID_INTERNAL_CREDENTIALS`. Guard failures are returned without logging either credential.

Delivery processing now atomically claims `pending`, `retryable`, or expired `processing` rows through `FOR UPDATE SKIP LOCKED`. Every claim receives a five-minute lease and incremented fencing generation. Submission and finalization require the current generation and an unexpired lease, so stale workers cannot overwrite reclaimed attempts. A finalization RPC error or rejected transition is counted as `finalization_failed` and makes the handler response unsuccessful rather than silently reporting delivery success.

Provider outcomes are explicit. Failures proven to occur before provider submission, including alert-context lookup, configuration/validation, and submission-fence acquisition failures, are retryable. Twilio provider rejection and ambiguous network/post-submission outcomes are terminal because no provider idempotency mechanism currently guarantees duplicate suppression. Resend ambiguous outcomes remain retryable only because the stable delivery idempotency key is submitted to Resend.

## Changed paths

- `.superpowers/sdd/2026-08-24-production-security-containment/progress.md`
- `.superpowers/sdd/2026-08-24-production-security-containment/task-4-implementation-report.md`
- `supabase/config.toml`
- `supabase/functions/_shared/cors.ts`
- `supabase/functions/_shared/require-internal.ts`
- `supabase/functions/_shared/require-internal.test.ts`
- `supabase/functions/_shared/internal-handler.ts`
- `supabase/functions/_shared/internal-handlers.test.ts`
- `supabase/functions/_shared/resend.ts`
- `supabase/functions/_shared/twilio.ts`
- `supabase/functions/_shared/twilio.test.ts`
- `supabase/functions/_shared/types.ts`
- `supabase/functions/notify-activity-insert/handler.ts`
- `supabase/functions/notify-activity-insert/index.ts`
- `supabase/functions/check-conditions/handler.ts`
- `supabase/functions/check-conditions/index.ts`
- `supabase/functions/process-deliveries/handler.ts`
- `supabase/functions/process-deliveries/delivery-state.ts`
- `supabase/functions/process-deliveries/delivery-state.test.ts`
- `supabase/functions/process-deliveries/index.ts`
- `supabase/functions/breakthrough-milestones/handler.ts`
- `supabase/functions/breakthrough-milestones/index.ts`
- `supabase/functions/daily-research-brief/handler.ts`
- `supabase/functions/daily-research-brief/index.ts`
- `supabase/functions/fetch-daily-articles/handler.ts`
- `supabase/functions/fetch-daily-articles/index.ts`
- `supabase/functions/sync-race-directory/handler.ts`
- `supabase/functions/sync-race-directory/index.ts`
- `supabase/migrations/20260824153216_secure_internal_jobs.sql`
- `supabase/tests/internal_jobs.sql`

The shared CORS helper path is included because the three existing internal handlers imported `handleCors`, `jsonResponse`, and `errorResponse`, but the module exported only `corsHeaders`; the missing export contract was reproduced before adding the minimal helpers.

## Migration behavior

`supabase migration new secure_internal_jobs` generated `supabase/migrations/20260824153216_secure_internal_jobs.sql` with Supabase CLI `2.98.2`.

The migration:

- Extends delivery state with `processing`, `submitting`, and `retryable`.
- Adds `attempt_count`, `processing_started_at`, `lease_expires_at`, monotonically increasing `claim_generation`, and a generated unique `idempotency_key`.
- Creates `private.claim_pending_deliveries(integer)` as a short atomic claim/update statement using `FOR UPDATE SKIP LOCKED`, including reclaim of expired processing leases.
- Adds fenced submission and finalization functions that accept transitions only for the current generation with an unexpired lease.
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

### Review-fix verification

- Combined safe local TypeScript regression run: exit `0`, 21/21 tests passed.
- Canonical guard suite: exit `0`, 5 tests passed.
- Seven-handler guard-order suite: exit `0`, 7 tests passed; each proved zero injected operation calls and zero provider/admin `fetch` calls before authentication.
- Twilio outcome suite: exit `0`, 4 tests passed.
- Delivery-state/finalization suite: exit `0`, 5 tests passed.
- Node static syntax checks for shared modules, delivery state, and all seven handlers: exit `0`.
- SQL pgTAP plan audit: exit `0`; `plan(36)` matches 36 authored assertions.
- Lease/fence SQL contract static check: exit `0`.
- Delivery finalization static check: exit `0`.
- Seven-handler production wiring static check: exit `0`.
- Requested combined Deno test command: exit `127`, `zsh:1: command not found: deno`. The same TypeScript tests were executed safely with Node's TypeScript stripping test runner.
- pgTAP database execution: not run, exit `2`: `TEST_DATABASE_URL` is unset; the harness refused to guess a database target. Docker is unavailable, so no disposable PostgreSQL/Supabase runtime was available.

## Rollout dependencies

### Remaining P2 review fixes

Expired `submitting` rows are now deterministically reconciled by `private.reconcile_expired_submitting_deliveries()` before every normal claim. Reconciliation locks eligible rows with `FOR UPDATE SKIP LOCKED`, requires the observed claim generation and expired lease, advances the generation, clears the lease, and moves the row to terminal `ambiguous` with a stable manual-reconciliation error. The claim query does not include `ambiguous`, so these outcomes cannot retry automatically or remain stranded in `submitting`.

The pgTAP concurrency scenario now opens explicit remote transactions for both dblink workers. Worker A claims and retains its transaction lock while an asynchronous two-second sleep runs; worker B claims and records completion during that sleep; both workers then explicitly commit. The suite asserts distinct IDs and worker B completion in under 1.5 seconds, demonstrating real overlap and `SKIP LOCKED` behavior. Before `SET LOCAL ROLE service_role`, the suite grants that role read access to the postgres-owned temporary result tables needed by the RPC assertions.

P2 changed paths:

- `.superpowers/sdd/2026-08-24-production-security-containment/progress.md`
- `.superpowers/sdd/2026-08-24-production-security-containment/task-4-implementation-report.md`
- `supabase/functions/_shared/types.ts`
- `supabase/migrations/20260824153216_secure_internal_jobs.sql`
- `supabase/tests/internal_jobs.sql`

P2 verification results:

- Combined safe local TypeScript regression run: exit `0`, 21/21 tests passed.
- Node TypeScript syntax checks: exit `0`, 13/13 files passed.
- SQL pgTAP plan audit: exit `0`; `plan(44)` matches 44 authored assertions.
- Reconciliation/fencing static contract: exit `0`.
- Explicit remote overlap and temporary-table ownership static contract: exit `0`.
- `git diff --check`: exit `0`.
- Requested combined Deno run: exit `127`, `zsh:1: command not found: deno`.
- pgTAP database execution: not run, exit `2`: `TEST_DATABASE_URL` is unset; the harness refused to guess a database target. Docker remains unavailable, so no disposable PostgreSQL/Supabase runtime was available.

No deployment, live database/function mutation, secret generation, or secret provisioning occurred.

- Task 8 approval is required before generating or setting the 32-byte internal secret. A compliant generator is `openssl rand -hex 32`; Task 4 did not generate a value.
- Task 8 must provision the identical canonical 64-character lowercase hexadecimal value as Edge secret `INTERNAL_JOB_SECRET` and Vault secret `internal_job_secret` before this migration/function set is activated.
- Task 8 must apply the migration and deploy all seven guarded functions as one coordinated rollout; callers will fail closed until both secret stores are populated.
- Rerun the exact Deno test in an environment with Deno installed.
- Rerun `supabase/tests/internal_jobs.sql` against an isolated test database with pgTAP and dblink available before production rollout.
- Validate the pre-existing `classify-races` authentication contract during the Task 6/8 deployment inventory; it was intentionally not reclassified in Task 4.
- No Edge secret, Vault value, migration, cron job, trigger, function deployment, or production data was changed by this task.

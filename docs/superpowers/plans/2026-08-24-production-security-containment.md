# Production Security Containment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove confirmed public data exposure and enforce explicit authentication boundaries across the `runaway-labs` database, Edge Functions, and affected iOS call sites.

**Architecture:** Database access is contained with invoker-rights views, owner-scoped RLS, and restricted RPC grants. Edge Functions are divided into user, provider, and internal classes, each using one shared guard before service-role access. OAuth callbacks use persisted one-time state, while iOS request and response shapes remain compatible.

**Tech Stack:** PostgreSQL 17, Supabase Auth/RLS/Vault/Edge Functions, Deno TypeScript, Swift, Swift Testing/XCTest.

**Spec:** `docs/superpowers/specs/2026-08-24-production-security-containment-design.md`

## Global Constraints

- Preserve existing successful iOS response contracts.
- Never authorize from `user_metadata` or from request-supplied athlete IDs.
- Never expose the service-role key or internal-job secret to iOS or public SQL results.
- Keep provider callbacks JWT-free only when provider-specific validation is present.
- Run focused tests after each completed change set, per user direction.
- Use Computer Use only for dashboard operations unavailable through the Supabase plugin or CLI, especially Edge Function secret configuration.
- Do not rotate or delete credentials until replacement configuration has been confirmed.
- Do not remove a deployed function until repository and production usage searches show no caller.

---

### Task 1: Contain database views, RLS, and privileged RPC grants

**Files:**

- Create with CLI: `supabase migration new production_security_containment`
- Create: `supabase/tests/security_containment.sql`
- Modify: `supabase/config.toml`

**Interfaces:**

- Consumes: Existing public views, RLS policies, and RPC signatures.
- Produces: Owner-scoped user views, service-only analytics views, protected RPCs, and stable API view names.

- [ ] **Step 1: Generate the migration file with the Supabase CLI**

Run:

```bash
supabase migration new production_security_containment
```

Use the exact generated path printed by the CLI for every migration step below.

- [ ] **Step 2: Replace the credential-bearing `profiles` view**

Add SQL that removes provider credentials while preserving public profile fields:

```sql
revoke all on public.profiles from anon, authenticated;

create or replace view public.profiles
with (security_invoker = true)
as
select
  auth_user_id as id,
  email,
  coalesce(first_name || ' ' || last_name, first_name, last_name, '') as full_name,
  organization as organization_name,
  phone,
  created_at,
  updated_at
from public.athletes
where auth_user_id is not null;

grant select on public.profiles to authenticated;
```

- [ ] **Step 3: Convert user-facing views to invoker rights**

Apply `security_invoker = true`, revoke `anon`, and grant only `SELECT` to `authenticated` for:

```text
activity_summary
conversation_summaries
monthly_activity_stats
recent_journal_entries
```

Preserve each current view query and output columns. Confirm every base table has an owner-scoped `SELECT` policy before granting the view.

- [ ] **Step 4: Restrict aggregate analytics views to service role**

Apply:

```sql
revoke all on public.analytics_activity_funnel from anon, authenticated;
revoke all on public.analytics_activity_hours from anon, authenticated;
revoke all on public.analytics_audio_coaching from anon, authenticated;
revoke all on public.analytics_daily_summary from anon, authenticated;
revoke all on public.analytics_user_engagement from anon, authenticated;

grant select on public.analytics_activity_funnel to service_role;
grant select on public.analytics_activity_hours to service_role;
grant select on public.analytics_audio_coaching to service_role;
grant select on public.analytics_daily_summary to service_role;
grant select on public.analytics_user_engagement to service_role;
```

- [ ] **Step 5: Remove the global training-plan read policy**

Apply:

```sql
drop policy if exists "Authenticated read access"
on public.weekly_training_plans;
```

Retain the owner-scoped `Users can read own plans` policy and rewrite its `auth.uid()` expression as `(select auth.uid())` if needed.

- [ ] **Step 6: Add an ownership helper for privileged RPCs**

Create a non-exposed schema and helper:

```sql
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.current_user_owns_athlete(p_athlete_id bigint)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.athletes
    where id = p_athlete_id
      and auth_user_id = (select auth.uid())
  );
$$;
```

- [ ] **Step 7: Protect `ensure_athlete_exists` without changing its signature**

Add this guard at the beginning of the existing function body:

```sql
if (select auth.uid()) is null or p_auth_user_id <> (select auth.uid()) then
  raise exception 'not authorized' using errcode = '42501';
end if;
```

Set `search_path = public, pg_temp`, revoke execution from `PUBLIC` and `anon`, and grant it only to `authenticated` and `service_role`.

- [ ] **Step 8: Protect athlete-ID RPCs and trigger-only functions**

For user-callable functions, reject the call unless `private.current_user_owns_athlete(p_athlete_id)` is true. Apply this to:

```text
best_split_pr(bigint, integer, double precision, double precision)
check_onboarding_status(integer)
detect_rest_days(integer, integer)
get_consecutive_rest_days(integer, date)
get_current_week_plan(bigint)
get_rest_day_history(integer, integer)
get_rest_days_count(integer, date, date)
```

Revoke `EXECUTE` from `PUBLIC` and `anon`. Grant only to `authenticated` and `service_role` after the ownership guard is present.

Revoke API-role execution from trigger-only functions:

```text
handle_new_user()
notify_activity_insert()
profiles_insert_trigger()
profiles_update_trigger()
trigger_activity_notification()
```

- [ ] **Step 9: Add post-change database regression tests**

Create `supabase/tests/security_containment.sql` with transactions that set JWT claims for `anon`, user A, and user B. Assert:

```sql
select has_table_privilege('anon', 'public.profiles', 'select') = false;
select has_table_privilege('authenticated', 'public.analytics_daily_summary', 'select') = false;
select has_function_privilege('anon', 'public.ensure_athlete_exists(uuid,text)', 'execute') = false;
```

Insert two isolated test athletes and verify user A cannot select user B through user-facing views, cannot read user B's training plan, and cannot invoke an athlete-ID RPC for user B. Roll back the transaction.

- [ ] **Step 10: Apply and test on a development branch or local database**

Run the project-supported migration command discovered through `supabase migration --help`, then run:

```bash
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/security_containment.sql
```

Expected: every assertion returns true and the script exits zero.

---

### Task 2: Add shared user authorization for Edge Functions

**Files:**

- Create: `supabase/functions/_shared/require-user.ts`
- Create: `supabase/functions/_shared/require-user.test.ts`
- Modify: `supabase/functions/_shared/supabase-client.ts`

**Interfaces:**

- Consumes: `Authorization` header, Supabase Auth, `athletes.auth_user_id`.
- Produces: `requireUser(req, requestedAthleteId?) -> Promise<UserContext>`.

- [ ] **Step 1: Implement the shared user guard**

Use this public contract:

```ts
export interface UserContext {
  authUserId: string
  athleteId: number
  authorization: string
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

export async function requireUser(
  req: Request,
  requestedAthleteId?: number | null,
): Promise<UserContext>
```

The implementation must validate the bearer token through `auth.getUser()`, resolve exactly one athlete row by `auth_user_id`, and return `403 ATHLETE_MISMATCH` when a supplied athlete ID differs.

- [ ] **Step 2: Ensure authorization occurs before admin-client creation**

Expose a dedicated `getSupabaseAdmin()` helper from `_shared/supabase-client.ts`. User handlers must call `requireUser()` before calling `getSupabaseAdmin()`.

- [ ] **Step 3: Add post-change unit tests**

Test these behaviors with dependency injection around Auth and athlete lookup:

```text
missing Authorization -> 401
invalid token -> 401
no athlete record -> 403
requested athlete differs -> 403
matching user and athlete -> UserContext
```

Run:

```bash
deno test supabase/functions/_shared/require-user.test.ts
```

Expected: all tests pass.

---

### Task 3: Migrate user Edge Functions to the shared guard

**Files:**

- Modify: `supabase/functions/sync-beta/index.ts`
- Modify: `supabase/functions/training-plan/index.ts`
- Modify: `supabase/functions/identity-profile/index.ts`
- Modify: `supabase/functions/feedback-workout/index.ts`
- Modify: `supabase/functions/check-milestones/index.ts`
- Modify: `supabase/functions/backfill-splits/index.ts`
- Modify: `supabase/functions/journal/index.ts`
- Modify: `supabase/config.toml`
- Create: `supabase/functions/_tests/user-endpoint-auth.test.ts`

**Interfaces:**

- Consumes: `requireUser()` from Task 2.
- Produces: Authenticated, owner-scoped versions of existing endpoint contracts.

- [ ] **Step 1: Guard all request paths before privileged work**

For each endpoint, parse the legacy athlete ID, call `requireUser(req, athleteId)`, and use `context.athleteId` for every database filter and external-provider lookup.

Do not trust `user_id`, `athlete_id`, or `activity_id` ownership without joining or filtering through `context.athleteId`.

- [ ] **Step 2: Correct journal route compatibility**

Support both existing forms during migration:

```text
GET /journal/:athlete_id
GET /journal?athlete_id=:athlete_id
```

Authorize both through the same resolved athlete context. Cap `limit` to `1...100` and cap `generate-recent` to four weeks.

- [ ] **Step 3: Bound synchronization workloads**

For `sync-beta` and `backfill-splits`, enforce:

```ts
const MAX_SYNC_ACTIVITIES = 500
const MAX_BACKFILL_ACTIVITIES = 100
```

Reject invalid, negative, non-integer, or excessive values with `400 INVALID_REQUEST`. Do not permit client-triggered unbounded `sync_all`; full-history sync becomes an internal job in a later phase.

- [ ] **Step 4: Enable JWT verification for all migrated user endpoints**

Add explicit `config.toml` entries with `verify_jwt = true` for every endpoint in this task. Repository config becomes the deployment authority.

- [ ] **Step 5: Add post-change endpoint authorization tests**

Test every handler through a shared table-driven harness:

```text
no token -> 401
invalid token -> 401
user A with athlete B request -> 403
user A with athlete A request -> existing success or domain response
```

Run:

```bash
deno test supabase/functions/_tests/user-endpoint-auth.test.ts
```

Expected: all endpoint cases pass without external API calls for rejected requests.

---

### Task 4: Authenticate internal jobs and make deliveries idempotent

**Files:**

- Create: `supabase/functions/_shared/require-internal.ts`
- Create: `supabase/functions/_shared/require-internal.test.ts`
- Modify: `supabase/functions/notify-activity-insert/index.ts`
- Modify: `supabase/functions/check-conditions/index.ts`
- Modify: `supabase/functions/process-deliveries/index.ts`
- Modify: `supabase/functions/breakthrough-milestones/index.ts`
- Modify: `supabase/functions/daily-research-brief/index.ts`
- Modify: `supabase/functions/fetch-daily-articles/index.ts`
- Modify: `supabase/functions/sync-race-directory/index.ts`
- Create with CLI: `supabase migration new secure_internal_jobs`
- Create: `supabase/tests/internal_jobs.sql`

**Interfaces:**

- Consumes: `X-Runaway-Internal-Secret`, Supabase Vault, pending delivery rows.
- Produces: Authenticated internal invocations and atomically claimed deliveries.

- [ ] **Step 1: Implement the internal guard**

Expose:

```ts
export function requireInternal(req: Request): void
```

Read `INTERNAL_JOB_SECRET` from the Edge environment and compare it to `X-Runaway-Internal-Secret`. Missing configuration returns `500`; missing or mismatched request credentials return `401` before parsing the body or creating an admin client.

- [ ] **Step 2: Apply the guard to every internal handler**

Call `requireInternal(req)` immediately after handling `OPTIONS` and method validation. Preserve `verify_jwt = false` only for these guarded internal endpoints.

- [ ] **Step 3: Add an atomic delivery claim RPC**

Generate the migration through the CLI, then add a `private.claim_pending_deliveries(batch_size integer)` function using `FOR UPDATE SKIP LOCKED`. Update claimed rows from `pending` to `processing` in the same transaction and return only those rows.

Grant execution only to `service_role`.

- [ ] **Step 4: Update delivery state transitions**

`process-deliveries` must claim rows atomically, then transition each row to `sent`, `retryable`, or `failed`. Store an idempotency key derived from delivery ID and channel. Do not resend `sent` rows.

- [ ] **Step 5: Configure the internal secret**

Generate a 32-byte random secret. Use the Supabase dashboard through Computer Use if no plugin or CLI secret-management capability is available. Store the same value as the Edge Function secret `INTERNAL_JOB_SECRET` and as a Supabase Vault secret used by cron/database webhook SQL. Never print the value in logs or the plan.

- [ ] **Step 6: Update cron and database webhook callers**

Read the internal secret from Vault at execution time and send only the dedicated internal header. Remove any hard-coded anon JWT or service-role token from job commands.

- [ ] **Step 7: Add post-change internal-auth and concurrency tests**

Run:

```bash
deno test supabase/functions/_shared/require-internal.test.ts
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/internal_jobs.sql
```

Expected: invalid credentials cause no writes, and two concurrent claims never return the same delivery ID.

---

### Task 5: Implement persisted, one-time OAuth state

**Files:**

- Create with CLI: `supabase migration new oauth_state_security`
- Create: `supabase/functions/_shared/oauth-state.ts`
- Create: `supabase/functions/_shared/oauth-state.test.ts`
- Modify: `supabase/functions/strava-auth/index.ts`
- Modify: `supabase/functions/oauth-callback/index.ts`
- Modify: `supabase/functions/garmin-auth/index.ts`
- Modify: `supabase/functions/garmin-callback/index.ts`
- Modify: `supabase/config.toml`

**Interfaces:**

- Consumes: Authenticated OAuth initiation and provider callback `state`.
- Produces: Opaque, expiring, single-use OAuth state records.

- [ ] **Step 1: Add the private OAuth state table**

Create `private.oauth_states` with:

```text
state_hash text primary key
provider text not null
auth_user_id uuid not null
redirect_url text not null
expires_at timestamptz not null
consumed_at timestamptz null
created_at timestamptz not null default now()
```

Grant access only to `service_role`. Add a cleanup function for expired or consumed rows.

- [ ] **Step 2: Implement OAuth state creation and consumption**

Expose:

```ts
export async function createOAuthState(input: {
  provider: 'strava' | 'garmin'
  authUserId: string
  redirectUrl: string
}): Promise<string>

export async function consumeOAuthState(input: {
  provider: 'strava' | 'garmin'
  state: string
}): Promise<{ authUserId: string; redirectUrl: string }>
```

Generate 32 random bytes, return only the base64url token, and persist only its SHA-256 hash. Consumption must atomically set `consumed_at` and reject missing, expired, consumed, or provider-mismatched state.

- [ ] **Step 3: Update initiation and callback handlers**

OAuth initiation remains JWT-protected and derives the user from `requireUser()`. Provider callbacks use `verify_jwt = false`, consume state before code exchange, and never accept an auth user ID or redirect URL directly from untrusted state content.

- [ ] **Step 4: Add post-change OAuth tests**

Run:

```bash
deno test supabase/functions/_shared/oauth-state.test.ts
```

Expected: valid state succeeds once; replay, expiry, provider mismatch, and altered values fail.

---

### Task 6: Reconcile and remove obsolete production functions

**Files:**

- Modify: `supabase/config.toml`
- Modify: `README.md`
- Create: `scripts/audit-deployment.ts`
- Create: `scripts/audit-deployment.test.ts`

**Interfaces:**

- Consumes: Repository function directories/config and Supabase deployed-function inventory.
- Produces: A deterministic drift report and an approved removal list.

- [ ] **Step 1: Implement deployment inventory comparison**

The script must compare:

```text
function slug
repository directory presence
config.toml presence
verify_jwt value
deployed status
deployed source hash when available
```

Exit nonzero on undocumented deployed functions or JWT mismatch.

- [ ] **Step 2: Classify obsolete functions**

Search all three Runaway repositories and production cron/database hooks for callers before classifying:

```text
debug-query
run-ddl
fix-elevation
fix-elevation-stl
list-cron
kill-cron
kill-research
data-sci-audit
pre-run-brief
backfill-training-zones
```

Do not remove `pre-run-brief` or `backfill-training-zones` if an active client or operational workflow still calls them.

- [ ] **Step 3: Remove approved obsolete deployments**

Use the Supabase CLI command discovered via `supabase functions --help`. Use Computer Use only if the CLI and plugin cannot delete deployed functions. Record every removed slug in `README.md` release notes.

- [ ] **Step 4: Add post-change drift tests**

Run:

```bash
deno test scripts/audit-deployment.test.ts
deno run --allow-read --allow-env --allow-net scripts/audit-deployment.ts
```

Expected: tests pass and production reports no undocumented function or JWT-setting drift.

---

### Task 7: Preserve iOS authentication compatibility

**Files:**

- Modify: `/Users/jack.rudelic/projects/labs/runaway/Runaway iOS/Runaway iOS/Services/AthleteService.swift`
- Modify: `/Users/jack.rudelic/projects/labs/runaway/Runaway iOS/Runaway iOS/Models/UserSession.swift`
- Modify: `/Users/jack.rudelic/projects/labs/runaway/Runaway iOS/RunawayWidget/SetDailyCommitmentIntent.swift`
- Test: `/Users/jack.rudelic/projects/labs/runaway/Runaway iOS/Runaway iOSTests/AthleteServiceTests.swift`
- Test: `/Users/jack.rudelic/projects/labs/runaway/Runaway iOS/RunawayWidgetTests/SetDailyCommitmentIntentTests.swift`

**Interfaces:**

- Consumes: Scalar `ensure_athlete_exists` RPC response and authenticated Supabase session.
- Produces: Correct athlete setup and honest widget mutation status.

- [ ] **Step 1: Decode the athlete RPC as a scalar integer**

Replace the keyed response wrapper with direct scalar decoding while preserving the public `ensureAthleteExists` return type.

- [ ] **Step 2: Stop swallowing setup failures**

Store and surface a session setup error when athlete creation or lookup fails. Do not transition to a fully ready session without an athlete ID.

- [ ] **Step 3: Correct widget authentication behavior**

Do not send the publishable key as a user bearer token. If a valid shared user session token cannot be safely supplied to the widget, deep-link the mutation into the authenticated app and return a truthful result instead of an optimistic success.

- [ ] **Step 4: Add post-change iOS tests**

Test scalar decoding, setup failure state, widget missing-session behavior, rejected server responses, and successful authenticated mutation.

Run the narrow test targets using the project's existing Xcode scheme. Do not run the full suite until the narrow targets pass.

---

### Task 8: Deploy, verify, and rotate credentials

**Files:**

- Modify: `README.md`
- Create: `docs/security/production-security-containment-runbook.md`

**Interfaces:**

- Consumes: Completed Tasks 1 through 7.
- Produces: Verified production containment and a repeatable operational runbook.

- [ ] **Step 1: Apply database migrations**

Apply migrations through the Supabase migration workflow. Confirm migration history immediately after application.

- [ ] **Step 2: Deploy functions by security class**

Deploy in this order:

```text
shared modules and user endpoints
internal jobs and updated callers
OAuth initiation and callbacks
deployment cleanup
```

Do not deploy a handler before its required secret, table, or caller migration exists.

- [ ] **Step 3: Run role-based production smoke checks**

Use read-only queries and controlled test accounts to confirm:

```text
anon cannot select contained views
user A cannot read user B data
user A cannot invoke an RPC for athlete B
user endpoints reject missing JWTs
internal endpoints reject missing secrets
OAuth state rejects replay
```

- [ ] **Step 4: Run Supabase advisors and inspect logs**

Run security and performance advisors. Confirm that security-definer-view and anonymous-security-definer-function findings are cleared for contained objects. Inspect Edge and Postgres logs for new 401, 403, 500, and 503 patterns.

- [ ] **Step 5: Rotate exposed or shared credentials**

Rotate RunSignUp access/refresh credentials that were present in the public view. Rotate any service-role token found embedded in cron commands after every caller has migrated to the internal secret. Verify replacement credentials before revoking old credentials.

- [ ] **Step 6: Run focused and integrated tests after all changes**

Run database security tests, Deno authorization tests, deployment drift tests, and affected iOS test targets. Then run the repository's full existing test commands only after the focused suites pass.

- [ ] **Step 7: Document evidence and rollback commands**

Record migration versions, deployed function versions, advisor results, test outputs, credential rotation completion, and exact rollback procedures in the runbook. Do not record secret values.

- [ ] **Step 8: Request final code review**

Request an independent review focused on authorization bypasses, backward compatibility, migration safety, and rollback completeness before closing the phase.

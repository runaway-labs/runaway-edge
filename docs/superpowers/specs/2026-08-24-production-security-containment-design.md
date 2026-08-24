# Production Security Containment Design

## Objective

Contain the confirmed production data exposure and authorization weaknesses in
`runaway-labs` while preserving the iOS application's authenticated workflows,
provider callbacks, database webhooks, and scheduled jobs.

This phase is limited to access control, credential exposure, deployment
consistency, and regression coverage. It does not include the iOS offline-sync
redesign, query-performance tuning, or visual-system work.

## Current Risks

The live project currently has these confirmed conditions:

- Ten public views execute with owner privileges and are granted to `anon`.
- The `profiles` view exposes RunSignUp access and refresh tokens.
- Thirteen `SECURITY DEFINER` functions are executable by `anon`.
- `ensure_athlete_exists` accepts an arbitrary auth UUID without checking
  `auth.uid()`.
- `weekly_training_plans` has an authenticated `USING (true)` read policy.
- Forty-five of fifty-five deployed Edge Functions have JWT verification
  disabled, including user, webhook, cron, and administrative handlers.
- Multiple service-role handlers trust request-supplied athlete IDs.
- Production function settings and inventory differ from repository config.

## Security Boundary Model

Every Edge Function belongs to exactly one class.

### User endpoints

User endpoints require a valid Supabase access token. The handler resolves the
authenticated user with `auth.getUser()`, looks up the athlete by
`athletes.auth_user_id`, and ignores caller-supplied athlete identity for
authorization.

Request athlete IDs may remain temporarily for backward compatibility, but the
handler rejects the request unless the supplied value equals the resolved
athlete ID.

Initial user endpoints in scope:

- `sync-beta`
- `training-plan`
- `identity-profile`
- `feedback-workout`
- `check-milestones`
- `backfill-splits`
- `journal`

### Provider webhooks and OAuth callbacks

Provider routes cannot require a Supabase user JWT because Strava and Garmin do
not send one. They must verify provider-specific authenticity or a server-side,
single-use state record before performing privileged work.

- OAuth initiation creates an opaque random state value stored server-side with
  the authenticated user ID, redirect target, provider, and expiration.
- OAuth callbacks consume the state exactly once before exchanging the code.
- Provider webhook handlers validate all authenticity data available from the
  provider and minimize effects that can be triggered from an untrusted body.
- Strava deauthorization must not clear credentials solely from an unsigned
  `owner_id`; it must be reconciled against stored provider identity and token
  state.

### Internal jobs and database webhooks

Cron, queue workers, and database-webhook handlers require a dedicated rotated
internal secret. The secret is distinct from the Supabase service-role key and
is compared before parsing or acting on the payload.

Initial internal handlers in scope:

- `notify-activity-insert`
- `check-conditions`
- `process-deliveries`
- `breakthrough-milestones`
- `daily-research-brief`
- `fetch-daily-articles`
- `sync-race-directory`

The service-role key remains server-side and is used only after the request has
passed the appropriate guard.

### Administrative and diagnostic functions

Temporary functions such as `debug-query`, `run-ddl`, `fix-elevation`,
`fix-elevation-stl`, `list-cron`, `kill-cron`, `kill-research`, and
`data-sci-audit` are not product APIs. They will be removed from production
unless a documented operational owner and authentication requirement exists.

## Database Containment

### Views

The containment migration will:

1. Revoke all privileges from `anon` and `authenticated` on the ten flagged
   views.
2. Set user-facing views to `security_invoker = true` so base-table RLS applies.
3. Grant `SELECT` to `authenticated` only for user-facing views whose base-table
   policies correctly scope rows.
4. Grant analytics-wide views only to `service_role`.
5. Remove RunSignUp token columns from `profiles`. Tokens are not profile data
   and must never be available through a user-facing view.

User-facing candidate views:

- `activity_summary`
- `conversation_summaries`
- `monthly_activity_stats`
- `profiles`
- `recent_journal_entries`

Service-only analytics views:

- `analytics_activity_funnel`
- `analytics_activity_hours`
- `analytics_audio_coaching`
- `analytics_daily_summary`
- `analytics_user_engagement`

### Privileged functions

The containment migration will revoke `EXECUTE` from `PUBLIC` and `anon` on all
flagged `SECURITY DEFINER` functions. Trigger-only functions will not be granted
to API roles.

Authenticated RPCs that accept an athlete ID will enforce ownership inside the
function using `auth.uid()`. `ensure_athlete_exists` will require
`p_auth_user_id = auth.uid()` and reject null or mismatched callers. All
privileged functions will set an explicit, minimal `search_path`.

### Row-level security

The global authenticated read policy on `weekly_training_plans` will be removed.
The existing owner-scoped policy will remain authoritative. Policies touched by
this phase will use `(select auth.uid())` to avoid repeated per-row Auth function
evaluation.

## Shared Edge Authorization Components

The Edge repository will provide three focused shared modules:

- `_shared/require-user.ts`: validates the bearer token, resolves the current
  user and athlete, and optionally verifies a legacy request athlete ID.
- `_shared/require-internal.ts`: validates the dedicated internal-job secret.
- `_shared/oauth-state.ts`: creates, validates, consumes, and expires opaque
  provider OAuth state records.

These modules return typed success values and normalized JSON error responses.
Handlers must not instantiate a service-role client before their guard succeeds.

## Failure Handling

- Authentication failures return `401`; ownership failures return `403`.
- Invalid or consumed OAuth state returns `400` without exchanging the code.
- Internal-job authentication failures return `401` and perform no database or
  external-provider work.
- Provider webhook failures use provider-appropriate retry status codes.
- No error response includes provider tokens, Supabase keys, raw JWTs, or full
  third-party response bodies.

## Regression Coverage

Database tests will demonstrate that:

- `anon` cannot select any contained view.
- An authenticated user sees only their own rows through user-facing views.
- RunSignUp token columns are absent from `profiles`.
- `anon` cannot execute privileged RPCs.
- An authenticated user cannot request another athlete's RPC data or create an
  athlete for another auth UUID.
- Training plans are owner-scoped.

Edge tests will demonstrate that:

- Missing and invalid bearer tokens fail before a service-role client is used.
- A valid user cannot substitute another athlete ID.
- Missing or invalid internal secrets produce no side effects.
- OAuth state is opaque, expiring, and single use.

## Rollout

1. Inventory iOS call sites for the user endpoints and preserve request and
   response shapes.
2. Add failing database and Edge authorization regression tests.
3. Add shared guards and update user endpoints.
4. Add internal-job authentication and update cron/database webhook callers.
5. Add persisted OAuth state and update provider callback flows.
6. Apply the containment migration for views, RPC grants, and RLS.
7. Deploy updated functions with class-appropriate JWT settings.
8. Remove obsolete administrative functions.
9. Run security advisors and role-based smoke queries.
10. Rotate RunSignUp credentials and the new internal-job secret.
11. Compare deployed functions, JWT settings, and migration versions against the
    repository and fail deployment on drift.

## Rollback

The migration will preserve view names and user-facing result shapes so grants
can be restored without reverting schema. Function deployments will be versioned
and rolled out by class. If a user endpoint fails after enforcing ownership, its
previous version may be restored temporarily, but public credential-bearing
views and anonymous privileged RPC execution must not be reopened.

## Success Criteria

- No credential-bearing view is accessible to `anon` or ordinary authenticated
  users.
- No privileged RPC is executable anonymously.
- Every user endpoint derives athlete ownership from the verified user.
- Every internal job requires a dedicated internal secret.
- OAuth callbacks use persisted, expiring, single-use state.
- Production contains no undocumented administrative Edge Functions.
- Supabase advisors report no security-definer-view or anonymous
  security-definer-function findings for contained objects.
- Existing authenticated iOS flows retain their response contracts.

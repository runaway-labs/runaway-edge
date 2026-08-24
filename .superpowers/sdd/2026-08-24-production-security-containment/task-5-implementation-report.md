# Task 5 implementation report

## Outcome

Task 5 is implemented locally on `codex/security-containment` without applying migrations, deploying Edge Functions, provisioning secrets, or changing any live environment.

OAuth initiation now verifies the Supabase user and linked athlete through the shared `requireUser()` guard before parsing redirect input or creating state. Caller-supplied `auth_user_id` remains tolerated in existing request shapes but is ignored for authorization and state binding.

OAuth state is 32 cryptographically random bytes returned as an unpadded base64url token. Edge code persists only its SHA-256 digest through service-role-only RPCs. The private record binds provider, verified auth user, trusted redirect target, creation time, ten-minute expiry, and one-time consumption time. Consumption uses a single conditional `UPDATE ... RETURNING`, so missing, malformed, altered, expired, provider-mismatched, consumed, replayed, and concurrent losing requests fail before code exchange or credential writes.

## Changed paths

- `.superpowers/sdd/2026-08-24-production-security-containment/progress.md`
- `.superpowers/sdd/2026-08-24-production-security-containment/task-5-implementation-report.md`
- `supabase/config.toml`
- `supabase/functions/_shared/oauth-state.ts`
- `supabase/functions/_shared/oauth-state.test.ts`
- `supabase/functions/strava-auth/index.ts`
- `supabase/functions/oauth-callback/index.ts`
- `supabase/functions/garmin-auth/index.ts`
- `supabase/functions/garmin-callback/index.ts`
- `supabase/migrations/20260824162713_oauth_state_security.sql`
- `supabase/tests/oauth_state.sql`

## Migration and database behavior

`supabase migration new oauth_state_security` generated `supabase/migrations/20260824162713_oauth_state_security.sql` with Supabase CLI `2.98.2`.

The migration:

- Creates RLS-enabled `private.oauth_states` with the approved fields and hash/provider/redirect constraints.
- Grants table access only to `service_role`; `anon` and `authenticated` receive no table or RPC access.
- Adds `private.cleanup_oauth_states()` for expired or consumed records.
- Adds revoked-by-default public-schema service-role RPC wrappers so Edge Functions can use PostgREST without exposing the private schema.
- Enforces a maximum fifteen-minute database acceptance window while Edge creation uses a ten-minute TTL.
- Implements one-winner atomic consumption with provider, digest, expiry, and `consumed_at is null` predicates in one update.
- Enables RLS and revokes public user access on `public.garmin_oauth_tokens`, which still stores the PKCE verifier but now receives only state digests as lookup keys from new initiation flows.

## Edge behavior

- `strava-auth` and `garmin-auth` keep `verify_jwt = true` and call `requireUser()` before request parsing, state persistence, or service-role client creation.
- `oauth-callback` and `garmin-callback` use `verify_jwt = false` because providers do not send a Supabase JWT; both consume valid server-side state before reading provider outcomes, exchanging an authorization code, or writing credentials.
- Missing or invalid state returns sanitized HTTP `400` and performs no provider or credential operation.
- Provider denial and post-consumption failures redirect only to the trusted persisted target with fixed messages.
- No state, authorization code, access token, refresh token, provider response body, database error body, or raw exception is logged or returned.
- Credential writes use the auth user returned by consumed state. Strava no longer upserts a provider-controlled athlete ID with caller-controlled auth identity.
- Garmin preserves PKCE S256 and stores its verifier under the SHA-256 state digest. The verifier row is removed after successful state consumption and lookup, before code exchange.

## Exact tests and results

### Test-first RED

Command: Node `v24.16.0` TypeScript shim importing `supabase/functions/_shared/oauth-state.test.ts` against the compileable not-implemented service surface.

Result: exit `1`; 0/8 passed. Every state behavior failed on the intended unimplemented creation/consumption path.

### Requested Deno test

Command:

```bash
deno test supabase/functions/_shared/oauth-state.test.ts
```

Result: exit `127`; `zsh:1: command not found: deno`.

### Safe local Deno-test fallback

Command: Node `v24.16.0` with `--experimental-strip-types`, a minimal `Deno.test` registration shim, and the real test/module import.

Result: exit `0`; 8/8 tests passed:

- Opaque 32-byte base64url state and digest-only persistence.
- Valid one-time consumption with trusted user and redirect return.
- Missing and altered state rejection before database access.
- Expired state rejection.
- Provider mismatch rejection without consuming the correct-provider state.
- Cross-user binding for distinct verified users.
- Exactly one winner under concurrent consumption.
- Sanitized database failure behavior.

### TypeScript syntax

Command: Node `--experimental-strip-types --check` over the shared state module/test and all four OAuth handlers.

Result: exit `0`; 6/6 files passed.

### SQL pgTAP coverage

Authored `supabase/tests/oauth_state.sql` with 36 assertions covering schema, columns, grants, RPC privileges, valid state, replay, provider mismatch, expiry, altered state, cross-user binding, input constraints, cleanup, and two-transaction atomic consumption through `dblink`.

Plan audit result: exit `0`; `plan(36)` matches 36 authored assertions.

Requested database command:

```bash
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/oauth_state.sql
```

Result: not run. The safe availability gate exited `2` with `NOT RUN: TEST_DATABASE_URL is unset; refusing to guess a database target.` Docker is unavailable, so no disposable PostgreSQL/Supabase runtime could be started. Database migration and transactional atomicity assertions therefore still require DB-runtime validation before rollout.

### Security boundary checks

Result: exit `0`.

- Initiation guard ordering passed for both providers.
- Neither initiation handler reads caller `auth_user_id`.
- Callback state consumption precedes provider fetch and athlete writes for both providers.
- JWT config is explicit: initiation `true`, callbacks `false`.
- No sensitive-value logging pattern was found.
- TypeScript syntax and pgTAP plan checks passed in the same run.

## Compatibility notes

- Initiation remains compatible with GET query and POST JSON callers and preserves `success` plus `authorization_url`; Garmin also preserves the `oauth_token` response field.
- Existing `auth_user_id` request fields are accepted but ignored. Identity now always comes from the shared user guard.
- Mobile redirects remain `runaway://strava-connected` and `runaway://garmin-connected`. Web redirects are restricted to the configured local origins and `https://runaway-web-203308554831.us-central1.run.app`; query parameters are preserved and outcome parameters are set safely with `URL.searchParams`.
- Strava success and error redirect parameters remain compatible, including mobile `athlete_id` on success. Garmin success and error redirect parameters remain compatible.
- Invalid callback state now returns HTTP `400` instead of attempting a fallback redirect derived from untrusted state.
- Strava credential writes now update the existing athlete selected by verified `auth_user_id` rather than upserting by provider athlete ID. This prevents cross-user reassignment but requires the authenticated athlete row guaranteed by initiation to remain present until callback.
- Pre-deployment Garmin PKCE rows use plaintext state keys. They are not deleted or rewritten by this migration and expire within ten minutes, but callbacks deployed with Task 5 will only find digest-keyed rows. Rollout should either tolerate that short in-flight reconnect window or wait ten minutes after blocking old initiation before switching callbacks.

## Rollout dependencies

- Task 8 approval remains required before migration application or Edge deployment.
- Apply `20260824162713_oauth_state_security.sql` before enabling the new initiation handlers, then deploy `strava-auth`, `oauth-callback`, `garmin-auth`, `garmin-callback`, and their `config.toml` settings as one coordinated release.
- Account for the ten-minute pre-deployment Garmin PKCE compatibility window described above.
- Confirm the production web redirect origin list before rollout; add any approved origin in code rather than accepting arbitrary redirects.
- Run the exact Deno test in an environment with Deno installed.
- Run `supabase/tests/oauth_state.sql` against an isolated database with pgTAP and dblink before production rollout.
- Verify deployed gateway settings after deployment: auth initiators require JWT and provider callbacks do not.
- No new secret is required by Task 5, and no secret was generated or provisioned.

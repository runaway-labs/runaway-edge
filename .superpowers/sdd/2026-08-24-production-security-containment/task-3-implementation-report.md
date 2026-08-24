# Task 3 implementation report

## Changed files

- `supabase/functions/_shared/user-endpoint.ts`
- `supabase/functions/_tests/user-endpoint-auth.test.ts`
- `supabase/functions/sync-beta/index.ts`
- `supabase/functions/training-plan/index.ts`
- `supabase/functions/identity-profile/index.ts`
- `supabase/functions/feedback-workout/index.ts`
- `supabase/functions/check-milestones/index.ts`
- `supabase/functions/backfill-splits/index.ts`
- `supabase/functions/journal/index.ts`
- `supabase/functions/user-races/index.ts`
- `supabase/config.toml`
- `.superpowers/sdd/2026-08-24-production-security-containment/progress.md`
- `.superpowers/sdd/2026-08-24-production-security-containment/task-3-implementation-report.md`

## Implementation

- Added a shared user-endpoint adapter that keeps the service-role client lazy,
  parses legacy athlete IDs, and maps the Task 2 guard's stable `HttpError`
  values to JSON responses.
- Migrated all seven planned user handlers to call `requireUser()` before
  service-role access and to use only `context.athleteId` for privileged
  database filters, token refreshes, provider lookups, and writes.
- Scoped consumed `activity_id` values to the verified athlete in
  `feedback-workout` and `check-milestones`; split updates are also scoped by
  both activity and verified athlete.
- Bounded `sync-beta` to 1...500 activities, rejected client `sync_all`, and
  bounded `backfill-splits` to 1...100 activities with
  `400 INVALID_REQUEST` responses.
- Preserved both journal GET routes, clamped `limit` to 1...100, and capped
  `generate-recent` at four weeks.
- Migrated `user-races` authentication to the shared guard. RunSignUp
  credentials are now read and written through the service-role client on the
  verified `athletes.id` base row, never through `profiles`.
- Added explicit `verify_jwt = true` configuration for every migrated user
  endpoint, including `user-races`. Existing provider webhook and internal-job
  exceptions remain unchanged.

## Production catalog confirmation

A read-only query against project `runaway-labs` inspected only
`information_schema.columns` and `information_schema.role_table_grants`.
It confirmed that the three RunSignUp credential columns exist on the
`public.athletes` base table as well as on the pre-containment `profiles`
view. No credential values were selected, printed, or logged, and no production
mutation was performed.

## Tests and static checks

Required endpoint suite:

```text
$ npx --yes deno test supabase/functions/_tests/user-endpoint-auth.test.ts
ok | 35 passed | 0 failed (22ms)
```

The table-driven cases cover missing token, invalid token, athlete substitution,
and matching-owner domain behavior for all seven planned handlers. Focused
cases cover sync/backfill workload rejection, both journal routes and caps, and
`user-races` service-only credential reads/writes without credential response
exposure.

Existing shared guard regression suite:

```text
$ npx --yes deno test supabase/functions/_shared/require-user.test.ts
ok | 9 passed | 0 failed (14ms)
```

Static type check:

```text
$ npx --yes deno check supabase/functions/_shared/user-endpoint.ts \
    supabase/functions/sync-beta/index.ts \
    supabase/functions/training-plan/index.ts \
    supabase/functions/identity-profile/index.ts \
    supabase/functions/feedback-workout/index.ts \
    supabase/functions/check-milestones/index.ts \
    supabase/functions/backfill-splits/index.ts \
    supabase/functions/journal/index.ts \
    supabase/functions/user-races/index.ts
exit 0; all nine modules checked
```

Scoped whitespace check:

```text
$ git diff --check -- <Task 3 implementation paths>
exit 0; no output
```

The first sandboxed `npx` attempt could not resolve `registry.npmjs.org`
(`ENOTFOUND`). The same commands were rerun with approved network access;
the results above are from the final successful runs.

## Compatibility and Task 7 notes

- iOS callers must send a valid Supabase session JWT to every migrated endpoint.
  Legacy `user_id` and `athlete_id` fields remain accepted, but a mismatch
  now returns `403 ATHLETE_MISMATCH`.
- Existing successful response payloads are preserved. Authentication failures
  use the shared `{ error: { code, message } }` envelope.
- `sync-beta` callers must stop sending `sync_all = true` and keep
  `max_activities` in 1...500.
- `backfill-splits` callers must keep `limit` in 1...100. Its invalid-request
  response is now the structured `INVALID_REQUEST` envelope.
- Journal callers may continue using either path or query athlete IDs. Limits
  above/below bounds are clamped and recent generation never exceeds four weeks.
- `user-races` request and success payloads remain compatible; only its
  internal credential storage path changed.

## Residual risks

- Nothing was deployed. Repository `verify_jwt` settings become effective only
  in the later approved deployment task.
- The handler tests use injected service/provider boundaries. A local Supabase
  Edge runtime integration test remains necessary before deployment.
- Production contains the RunSignUp columns on `athletes`, but the historical
  local migration shown in this worktree does not create them. Task 6 must
  reconcile that schema drift for fresh database replays.
- Credentials previously exposed through `profiles` still require rotation in
  Task 8 after the contained code and schema are deployed.

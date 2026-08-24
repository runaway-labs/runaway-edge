# Task 2 implementation report — shared user-auth guard

## Files

- `supabase/functions/_shared/require-user.ts` — bearer-JWT authentication,
  authenticated-athlete resolution, typed user context, and stable HTTP errors
  for returned and rejected Supabase failures.
- `supabase/functions/_shared/require-user.test.ts` — pure injected-client Deno
  coverage for required guard outcomes.
- `.superpowers/sdd/2026-08-24-production-security-containment/progress.md` —
  marks Tasks 1 and 2 complete after testing.

`supabase/functions/_shared/supabase-client.ts` already exported the required
`getSupabaseAdmin()` helper, so no change was necessary there. The guard uses
only `getSupabaseClient()` and calls `auth.getUser(accessToken)` before looking
up `athletes.auth_user_id`; it does not create or expose a service-role client.

## Tests

Command:

```sh
npx --yes deno test supabase/functions/_shared/require-user.test.ts
```

Result: `ok | 9 passed | 0 failed (15ms)`.

Covered outcomes: missing authorization (`401`), invalid token (`401`), missing
athlete (`403`), returned athlete lookup failure (`500`), duplicate-row
`maybeSingle` failure (`500`), rejected Auth request (`500`), rejected athlete
query (`500`), mismatched requested athlete (`403`), and matching authenticated
user/athlete context. The 5xx tests assert exact stable status, code, and message
values that do not include upstream errors or bearer-token details.

## Review fixes

- Rejected `auth.getUser()` promises become `500 AUTH_LOOKUP_FAILED` with a
  fixed public message.
- Returned or rejected athlete lookup failures, including duplicate-row
  `maybeSingle` errors, become `500 ATHLETE_LOOKUP_FAILED` with a fixed public
  message.
- Upstream exception objects are discarded and are neither logged nor exposed.

## Commit

Implementation commit SHA: `74bdb1042b53aefd03b3de3367f336b9c29f5bb6`.

## Residual risks

- Task 3 must adopt `requireUser()` in each user-facing Edge Function before
  creating a service-role client.
- The athlete lookup relies on the existing `athletes` access path returning the
  authenticated user's single row; deployment should retain that RLS behavior.
- This task intentionally does not change function deployment settings or make
  any live Supabase changes.

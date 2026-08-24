# Task 2 implementation report — shared user-auth guard

## Files

- `supabase/functions/_shared/require-user.ts` — bearer-JWT authentication,
  authenticated-athlete resolution, typed user context, and stable HTTP errors.
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

Result: `ok | 5 passed | 0 failed (15ms)`.

Covered outcomes: missing authorization (`401`), invalid token (`401`), missing
athlete (`403`), mismatched requested athlete (`403`), and matching authenticated
user/athlete context.

## Commit

Implementation commit SHA: recorded in the follow-up report update commit.

## Residual risks

- Task 3 must adopt `requireUser()` in each user-facing Edge Function before
  creating a service-role client.
- The athlete lookup relies on the existing `athletes` access path returning the
  authenticated user's single row; deployment should retain that RLS behavior.
- This task intentionally does not change function deployment settings or make
  any live Supabase changes.

# Task 1 implementation report

## Changed files

- `supabase/migrations/20260824135752_production_security_containment.sql`
- `supabase/tests/security_containment.sql`
- `.superpowers/sdd/2026-08-24-production-security-containment/task-1-implementation-report.md`

No `supabase/config.toml` change was required for this database-only task.

## Implementation

- Rebuilt `public.profiles` with `security_invoker = true` and removed the
  three RunSignUp credential columns while restoring its INSTEAD OF triggers.
- Applied invoker rights and authenticated-only SELECT grants to the four
  owner-scoped user views, preserving their deployed definitions.
- Restricted analytics views to service-role SELECT only.
- Removed the global training-plan read policy and recreated the owner policy
  for `authenticated` with `(select auth.uid())`.
- Added `private.current_user_owns_athlete(bigint)` and applied ownership
  guards, fixed search paths, and least-privilege execution grants to all
  eight user-callable privileged RPCs.
- Removed the two obsolete activity-notification trigger functions containing
  compromised embedded credentials. No credential literal was copied into the
  repository, report, or tests.
- Removed client execution grants from the remaining trigger-only functions
  and set their explicit search paths.

## Validation

Read-only production catalog checks confirmed RLS plus a SELECT/ALL policy on
every base table used by the joined user views: `activities`, `activity_types`,
`athletes`, `chat_conversations`, `gear`, and `training_journal`. No
production DDL or data query was run.

Safe static checks passed:

```text
$ git diff --check -- <Task 1 files>
(exit 0; no output)

$ credential-literal scan
no embedded JWT detected
```

Local migration and pgTAP execution could not run because Docker is not
installed and no local database is listening:

```text
$ supabase migration up
failed to connect to postgres: failed to connect to `host=127.0.0.1 user=postgres database=postgres`: dial error (dial tcp 127.0.0.1:54322: connect: operation not permitted)

$ supabase test db supabase/tests/security_containment.sql
failed to connect to postgres: failed to connect to `host=127.0.0.1 user=postgres database=postgres`: dial error (dial tcp 127.0.0.1:54322: connect: operation not permitted)

$ TEST_DATABASE_URL availability check
TEST_DATABASE_URL is unset
```

## Commit

Implementation commit: `9084d22` (`feat: contain Supabase database access`).

## Residual risks and follow-ups

- Install Docker or provide an isolated development database, then run
  `supabase migration up` and `supabase test db supabase/tests/security_containment.sql`
  before any deployment.
- Task 4 must replace the removed activity-notification trigger path with an
  authenticated internal delivery mechanism that obtains its secret at runtime
  rather than embedding it in database source.
- The profiles rebuild preserves its write triggers, but those paths need a
  local integration smoke test once the development database is available.

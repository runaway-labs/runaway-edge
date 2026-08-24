# Production security containment runbook

## Safety boundary

This runbook separates read-only preflight from live mutation. Task 8 preparation
must not apply a linked migration, deploy or delete an Edge Function, set a
secret, alter Vault/cron/trigger state, or rotate credentials. The controller
may perform those actions only after reviewing the committed preflight evidence.

Project reference: `nkxvjcdxiyjbndjvfmqy`.

## Reviewed deployment classes

- Expected active: 42 functions. Every function has an explicit authentication
  class, repository `verify_jwt` setting, complete reviewed live baseline hash,
  and complete local deployable hash.
- Approved retirement: 13 functions. Every function has a read-only live source
  archive, canonical SHA-256, deployed `verify_jwt` value, passing embedded-secret
  scan, and `blocked-pending-security-review` restore policy.
- Unknown blocker: none.

The Task 8 additions to the retirement set are `twin-engine` (`verify_jwt=false`),
`ultratracker` (`verify_jwt=true`), and `upload-race-course`
(`verify_jwt=true`). Their archives are recovery evidence only and are not
runnable from the active function tree.

## Read-only preflight

1. Confirm the checkout head and Task 8 preparation commits.
2. Retrieve every live function bundle independently with
   `supabase functions download <slug> --project-ref nkxvjcdxiyjbndjvfmqy --use-api`
   into a temporary directory outside the repository.
3. Scan every downloaded text file for JWTs, Supabase secret keys, bearer
   literals, private keys, and literal credential assignments. Stop immediately
   if any match is present; never copy or print the value.
4. Build the sanitized live database inventory with read-only Management API
   queries from `scripts/audit-deployment.ts`. Never substitute or guess a
   database URL.
5. Run `scripts/audit-deployment.ts --mode deploy` against the complete downloaded
   bundle set. This validates reviewed live baselines before any deployment.
6. Run `scripts/audit-deployment.ts --mode pre` as a dry run to record expected
   pre-retirement drift. Before live migrations/deployment this mode is expected
   to report the unapplied Task 1/4/5/6/8 schema and local-vs-live bundle/JWT
   differences; those are rollout work, not permission to mutate production.
7. Review migration history, schema assumptions, protected RPC grants, cron
   targets, and trigger targets in the generated inventory. Secret values must
   never appear in any artifact.

## Controller rollout sequence after review

1. Confirm replacement values are ready before changing any secret or credential.
2. Apply the five required migrations in migration order and immediately confirm
   linked migration history. The final migration is
   `20260824201237_activities_client_operation_id.sql`.
3. Provision the same newly generated 32-byte internal-job secret in Edge secrets
   and Vault without logging it. Do not revoke prior caller credentials until all
   callers use the dedicated header.
4. Block legacy Garmin OAuth initiation and wait at least ten minutes for old
   plaintext PKCE state to expire before switching callbacks.
5. Deploy shared modules and user endpoints, internal jobs and callers, OAuth
   initiation/callbacks, then remaining active deployment cleanup. Deploy from
   `supabase/config.toml` without a global JWT override.
6. Download all deployed bundles again and run `--mode pre`. Continue only if it
   passes with the exact 42 active plus 13 retirement functions.
7. Delete only the 13 approved retirement slugs. Download inventory again and
   run `--mode post`, which requires all retirements absent.
8. Run role-based smoke checks, security/performance advisors, and Edge/Postgres
   log review before rotating RunSignUp or legacy service-role credentials.
9. Verify replacement credentials, then revoke old credentials and repeat smoke,
   advisor, and log checks.

## Rollback

- Database: stop rollout and prepare a reviewed forward migration. Do not reopen
  credential-bearing views, anonymous privileged RPCs, or owner-bypassing RLS.
- Active function: redeploy the preceding reviewed repository commit with that
  function's explicit `verify_jwt` setting; do not use `--no-verify-jwt`.
- Retired function: restoration is blocked. A dedicated security review must
  establish safe authentication/authorization, remove privileged caller input,
  rescan the complete archive, and explicitly approve a new active source.
- Internal secret: keep the prior value valid until every caller verifies the
  replacement. If verification fails, restore caller configuration first and
  investigate without printing either value.
- OAuth: keep initiation blocked if callback/state compatibility is uncertain.
  Never fall back to caller-supplied identity, redirect, or plaintext state.

## Required evidence

Record sanitized migration versions, function versions and hashes, deployed JWT
settings, schema assumptions, cron/trigger targets, test outputs, advisor results,
smoke results, credential-rotation completion, and exact rollback commands. Do
not record secret values, provider tokens, authorization codes, or raw production
row data.

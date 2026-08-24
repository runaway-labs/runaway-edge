import {
  REQUIRED_MIGRATIONS,
  REQUIRED_SCHEMA_ASSUMPTIONS,
  PRIVILEGED_RPC_SIGNATURES,
  SERVICE_ONLY_RPC_SIGNATURES,
  FUNCTION_MANIFEST,
  auditDeployment,
  auditMigrationSource,
  auditWorkflowSource,
  buildBundleHash,
  type DeploymentInventory,
  type ManifestEntry,
  type RepositorySnapshot,
} from "./audit-deployment.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertIncludes(errors: string[], fragment: string): void {
  assert(errors.some((error) => error.includes(fragment)), "missing error containing: " + fragment + "\n" + errors.join("\n"));
}

const SAFE_WORKFLOW = [
  "npx --yes deno test --allow-read scripts/audit-deployment.test.ts",
  "npx --yes deno run scripts/audit-deployment.ts --mode deploy",
  "supabase functions deploy --project-ref project",
].join("\n");

const MIGRATION = [
  "alter table public.athletes",
  "add column if not exists runsignup_access_token text,",
  "add column if not exists runsignup_refresh_token text,",
  "add column if not exists runsignup_token_expires_at timestamptz;",
].join("\n");

function manifest(includeUnknown = false): ManifestEntry[] {
  const entries: ManifestEntry[] = [
    {
      slug: "alpha",
      classification: "expected-active",
      authClass: "user",
      verifyJwt: true,
      baselineBundleSha256: "baseline-alpha",
    },
    {
      slug: "old",
      classification: "approved-retirement",
      archiveBundleSha256: "archive-old",
      verifyJwt: false,
      restorePolicy: "blocked-pending-security-review",
    },
  ];
  if (includeUnknown) {
    entries.push({
      slug: "mystery",
      classification: "unknown-blocker",
      baselineBundleSha256: "baseline-mystery",
    });
  }
  return entries;
}

function repository(): RepositorySnapshot {
  return {
    sourceDirectories: new Set(["alpha"]),
    config: new Map([["alpha", { verifyJwt: true }]]),
    bundleHashes: new Map([["alpha", "local-alpha"]]),
    bundleErrors: [],
    migrationSource: MIGRATION,
    workflowSource: SAFE_WORKFLOW,
    archives: new Map([["old", {
      bundleHash: "archive-old",
      secretSafe: true,
      fileCount: 1,
      verifyJwt: false,
      restorePolicy: "blocked-pending-security-review",
    }]]),
  };
}

function schema() {
  return {
    columns: {
      "public.profiles": ["id", "email", "full_name", "organization_name", "phone", "created_at", "updated_at"],
      "public.athletes": ["runsignup_access_token", "runsignup_refresh_token", "runsignup_token_expires_at"],
      "public.activities": ["client_operation_id"],
      "private.oauth_states": ["state_hash", "provider", "auth_user_id", "athlete_id", "redirect_url", "expires_at", "consumed_at", "created_at"],
    },
    assumptions: Object.fromEntries(REQUIRED_SCHEMA_ASSUMPTIONS.map((name) => [name, true])),
  };
}

function inventory(mode: "deploy" | "pre" | "post" = "pre", includeUnknown = false): DeploymentInventory {
  const functions = [
    {
      slug: "alpha",
      status: "ACTIVE",
      verify_jwt: true,
      ezbr_sha256: "metadata-alpha",
      bundle_sha256: mode === "deploy" ? "baseline-alpha" : "local-alpha",
    },
  ];
  if (mode !== "post") {
    functions.push({
      slug: "old",
      status: "ACTIVE",
      verify_jwt: false,
      ezbr_sha256: "metadata-old",
      bundle_sha256: "archive-old",
    });
  }
  if (includeUnknown) {
    functions.push({
      slug: "mystery",
      status: "ACTIVE",
      verify_jwt: false,
      ezbr_sha256: "metadata-mystery",
      bundle_sha256: "baseline-mystery",
    });
  }
  return {
    projectRef: "test-project",
    functions,
    migrations: REQUIRED_MIGRATIONS.map((version) => ({ version })),
    schema: schema(),
    cronTargets: [
      { jobName: "check-conditions-job", target: "check-conditions" },
      { jobName: "daily-research-brief", target: "daily-research-brief" },
      { jobName: "fetch-daily-articles", target: "fetch-daily-articles" },
      { jobName: "process-deliveries-job", target: "process-deliveries" },
      { jobName: "sync-race-directory-job", target: "sync-race-directory" },
    ],
    triggerTargets: [
      { triggerName: "on_activity_insert:public.activities", target: "notify-activity-insert" },
    ],
    privilegedRpcs: PRIVILEGED_RPC_SIGNATURES.map((signature) => ({
      signature,
      exists: true,
      anonExecute: false,
      authenticatedExecute: true,
      serviceRoleExecute: true,
    })),
    serviceOnlyRpcs: SERVICE_ONLY_RPC_SIGNATURES.map((rpc) => ({
      ...rpc,
      anonExecute: false,
      authenticatedExecute: false,
      serviceRoleExecute: true,
    })),
  };
}

Deno.test("manifest explicitly classifies exactly 55 deployed slugs", () => {
  assert(FUNCTION_MANIFEST.length === 55, "manifest must contain exactly 55 entries");
  assert(new Set(FUNCTION_MANIFEST.map((entry) => entry.slug)).size === 55, "manifest slugs must be unique");
  const counts = Object.fromEntries(["expected-active", "approved-retirement", "unknown-blocker"].map((classification) => [
    classification,
    FUNCTION_MANIFEST.filter((entry) => entry.classification === classification).length,
  ]));
  assert(counts["expected-active"] === 42, JSON.stringify(counts));
  assert(counts["approved-retirement"] === 13, JSON.stringify(counts));
  assert(counts["unknown-blocker"] === 0, JSON.stringify(counts));
});
Deno.test("truncated function inventory and count mismatch fail closed", async () => {
  const value = inventory("pre");
  value.functions.pop();
  const report = await auditDeployment(value, repository(), "pre", manifest());
  assertIncludes(report.errors, "deployed function count");
  assertIncludes(report.errors, "old: missing from deployed inventory");
});

Deno.test("omitted inventory sections fail closed", async () => {
  const value = inventory("pre") as unknown as Record<string, unknown>;
  delete value.cronTargets;
  delete value.triggerTargets;
  delete (value.schema as Record<string, unknown>).assumptions;
  const report = await auditDeployment(value as unknown as DeploymentInventory, repository(), "pre", manifest());
  assertIncludes(report.errors, "cronTargets section is missing");
  assertIncludes(report.errors, "triggerTargets section is missing");
  assertIncludes(report.errors, "schema.assumptions section is missing");
});

Deno.test("extra local source directory and config section fail closed", async () => {
  const repo = repository();
  repo.sourceDirectories.add("extra");
  repo.config.set("extra", { verifyJwt: false });
  const report = await auditDeployment(inventory("pre"), repo, "pre", manifest());
  assertIncludes(report.errors, "extra: unexpected local function source directory");
  assertIncludes(report.errors, "extra: unexpected config.toml function section");
});

Deno.test("bundle builder rejects a missing entrypoint", async () => {
  const bundle = await buildBundleHash(new Map(), "supabase/functions/alpha/index.ts");
  assertIncludes(bundle.errors, "missing deployable file");
  assert(!bundle.hash, "missing entrypoint must not produce a hash");
});

Deno.test("bundle builder rejects a missing relative dependency", async () => {
  const files = new Map([
    ["supabase/functions/alpha/index.ts", 'import "./missing.ts";\n'],
  ]);
  const bundle = await buildBundleHash(files, "supabase/functions/alpha/index.ts");
  assertIncludes(bundle.errors, "missing relative dependency ./missing.ts");
  assert(!bundle.hash, "missing dependency must not produce a hash");
});

Deno.test("missing and mismatched complete live bundle hashes fail closed", async () => {
  const missing = inventory("pre");
  missing.functions[0].bundle_sha256 = "";
  assertIncludes((await auditDeployment(missing, repository(), "pre", manifest())).errors, "complete live bundle hash is missing");

  const mismatch = inventory("pre");
  mismatch.functions[0].bundle_sha256 = "wrong";
  assertIncludes((await auditDeployment(mismatch, repository(), "pre", manifest())).errors, "deployed bundle does not match local deployable bundle");
});

Deno.test("all active baselines are reviewed and a null baseline blocks every mode", async () => {
  const checkedInBlockers = FUNCTION_MANIFEST
    .filter((entry) => entry.classification === "expected-active" && !entry.baselineBundleSha256)
    .map((entry) => entry.slug)
    .sort();
  assert(checkedInBlockers.length === 0, "reviewed-baseline blockers: " + checkedInBlockers.join(", "));
  const entries = manifest();
  entries[0].baselineBundleSha256 = null;
  for (const mode of ["deploy", "pre", "post"] as const) {
    const report = await auditDeployment(inventory(mode), repository(), mode, entries);
    assertIncludes(report.errors, "alpha: reviewed live baseline bundle hash is missing; Task 8 is blocked");
  }
});

Deno.test("canonical bundle hashes ignore checkout roots but detect modified bytes", async () => {
  const source = 'import "../_shared/helper.ts";\nconsole.log("same");\n';
  const helper = "export const value = 1;\n";
  const local = await buildBundleHash(new Map([
    ["checkout/supabase/functions/alpha/index.ts", source],
    ["checkout/supabase/functions/_shared/helper.ts", helper],
  ]), "checkout/supabase/functions/alpha/index.ts");
  const downloaded = await buildBundleHash(new Map([
    ["download/source/supabase/functions/alpha/index.ts", source],
    ["download/source/supabase/functions/_shared/helper.ts", helper],
  ]), "download/source/supabase/functions/alpha/index.ts");
  const archive = await buildBundleHash(new Map([
    ["functions/alpha/index.ts", source],
    ["functions/_shared/helper.ts", helper],
  ]), "functions/alpha/index.ts");
  const modified = await buildBundleHash(new Map([
    ["functions/alpha/index.ts", source],
    ["functions/_shared/helper.ts", "export const value = 2;\n"],
  ]), "functions/alpha/index.ts");
  assert(local.hash === downloaded.hash && local.hash === archive.hash, "byte-identical bundles must hash equally across roots");
  assert(modified.hash !== local.hash, "modified bundle must produce a different hash");
});

Deno.test("pre mode permits exact archived retirement set and post mode requires it absent", async () => {
  const pre = await auditDeployment(inventory("pre"), repository(), "pre", manifest());
  assert(pre.errors.length === 0, pre.errors.join("\n"));

  const prematurePost = await auditDeployment(inventory("pre"), repository(), "post", manifest());
  assertIncludes(prematurePost.errors, "old: unexpected deployed function");

  const post = await auditDeployment(inventory("post"), repository(), "post", manifest());
  assert(post.errors.length === 0, post.errors.join("\n"));
});

Deno.test("unknown classifications block rollout even with exact inventory equality", async () => {
  const report = await auditDeployment(inventory("pre", true), repository(), "pre", manifest(true));
  assertIncludes(report.errors, "mystery: unknown-blocker classification must be resolved");
});

Deno.test("schema audit requires redirect_url and fresh-replay RunSignUp columns", async () => {
  const value = inventory("pre");
  value.schema.columns["private.oauth_states"] = value.schema.columns["private.oauth_states"].filter((column) => column !== "redirect_url");
  value.schema.columns["public.athletes"] = [];
  const errors = (await auditDeployment(value, repository(), "pre", manifest())).errors;
  assertIncludes(errors, "private.oauth_states is missing redirect_url");
  assertIncludes(errors, "public.athletes is missing runsignup_access_token");
});

Deno.test("schema audit requires the Task 7 activity idempotency and ownership contract", async () => {
  const value = inventory("pre");
  value.schema.columns["public.activities"] = [];
  value.schema.assumptions["activities_client_operation_id_contract"] = false;
  const errors = (await auditDeployment(value, repository(), "pre", manifest())).errors;
  assertIncludes(errors, "public.activities is missing client_operation_id");
  assertIncludes(errors, "schema assumption failed: activities_client_operation_id_contract");
});

Deno.test("all eight privileged RPC signatures and grants are mandatory", async () => {
  const omitted = inventory("pre");
  const missingSignature = omitted.privilegedRpcs.pop()!.signature;
  assertIncludes((await auditDeployment(omitted, repository(), "pre", manifest())).errors, "privileged RPC inventory missing " + missingSignature);

  const anonymous = inventory("pre");
  anonymous.privilegedRpcs[0].anonExecute = true;
  assertIncludes((await auditDeployment(anonymous, repository(), "pre", manifest())).errors, "anon retains EXECUTE");

  const incomplete = inventory("pre");
  delete (incomplete.privilegedRpcs[0] as unknown as Record<string, unknown>).serviceRoleExecute;
  assertIncludes((await auditDeployment(incomplete, repository(), "pre", manifest())).errors, "signature/grant data is incomplete");
});

Deno.test("every delivery and OAuth-state RPC requires exact service-only role grants", async () => {
  for (const expected of SERVICE_ONLY_RPC_SIGNATURES) {
    for (const roleCase of [
      { field: "anonExecute", value: true, error: "anon must not have EXECUTE" },
      { field: "authenticatedExecute", value: true, error: "authenticated must not have EXECUTE" },
      { field: "serviceRoleExecute", value: false, error: "service_role EXECUTE grant is missing" },
    ] as const) {
      const wrong = inventory("pre");
      const rpc = wrong.serviceOnlyRpcs.find((entry) => entry.signature === expected.signature)!;
      rpc[roleCase.field] = roleCase.value;
      assertIncludes((await auditDeployment(wrong, repository(), "pre", manifest())).errors, expected.signature + ": " + roleCase.error);

      const omitted = inventory("pre");
      const omittedRpc = omitted.serviceOnlyRpcs.find((entry) => entry.signature === expected.signature)!;
      delete (omittedRpc as unknown as Record<string, unknown>)[roleCase.field];
      assertIncludes((await auditDeployment(omitted, repository(), "pre", manifest())).errors, expected.signature + ": service-only RPC role grant data is incomplete");
    }
  }

  const missing = inventory("pre");
  const missingSignature = missing.serviceOnlyRpcs.pop()!.signature;
  assertIncludes((await auditDeployment(missing, repository(), "pre", manifest())).errors, "service-only RPC inventory missing " + missingSignature);
});

Deno.test("retirement entries require reviewed JWT and blocked restore metadata", async () => {
  const retirements = FUNCTION_MANIFEST.filter((entry) => entry.classification === "approved-retirement");
  assert(retirements.length === 13, "expected thirteen retirements");
  const jwtEnabled = retirements.filter((entry) => entry.verifyJwt).map((entry) => entry.slug).sort();
  assert(
    JSON.stringify(jwtEnabled) === JSON.stringify(["ultratracker", "upload-race-course"]),
    "unexpected JWT-enabled retirement set: " + jwtEnabled.join(", "),
  );
  for (const entry of retirements) {
    assert(entry.restorePolicy === "blocked-pending-security-review", entry.slug + " must block restoration pending review");
    const metadata = JSON.parse(await Deno.readTextFile("supabase/retired-functions/" + entry.slug + "/archive.json"));
    assert(metadata.verify_jwt === entry.verifyJwt, entry.slug + " archive verify_jwt mismatch");
    assert(metadata.restore_policy === "blocked-pending-security-review", entry.slug + " archive restore policy mismatch");
  }
});

Deno.test("fresh-replay migration adds typed athlete columns without touching profiles", () => {
  assert(auditMigrationSource(MIGRATION).length === 0, auditMigrationSource(MIGRATION).join("\n"));
  assertIncludes(auditMigrationSource("alter table public.profiles add column runsignup_access_token text;"), "must not modify public.profiles");
});

Deno.test("workflow gate rejects global JWT bypass and audit-after-deploy ordering", () => {
  assertIncludes(auditWorkflowSource("supabase functions deploy --no-verify-jwt\nnpx --yes deno run audit-deployment.ts --mode deploy"), "--no-verify-jwt");
  assertIncludes(auditWorkflowSource("supabase functions deploy\nnpx --yes deno run audit-deployment.ts --mode deploy"), "audit must run before deployment");
  assert(auditWorkflowSource(SAFE_WORKFLOW).length === 0, auditWorkflowSource(SAFE_WORKFLOW).join("\n"));
});

Deno.test("checked-in workflow and migration satisfy static release gates", async () => {
  const [workflow, migrationSource] = await Promise.all([
    Deno.readTextFile(".github/workflows/deploy-functions.yml"),
    Deno.readTextFile("supabase/migrations/20260824172420_add_runsignup_credentials_to_athletes.sql"),
  ]);
  assert(auditWorkflowSource(workflow).length === 0, auditWorkflowSource(workflow).join("\n"));
  assert(auditMigrationSource(migrationSource).length === 0, auditMigrationSource(migrationSource).join("\n"));
});

Deno.test("README never presents archived utilities as active or runnable", async () => {
  const readme = await Deno.readTextFile("README.md");
  assert(!readme.includes("| `run-ddl` |"), "run-ddl must not appear in active utility inventory");
  assert(!readme.includes("supabase/functions/run-ddl"), "README must not point at an active run-ddl path");
  assert(readme.includes("retired and non-runnable"), "README must identify archives as retired and non-runnable");
  assert(readme.includes("blocked pending a dedicated security review"), "README must block automatic restoration");
  assert(!/migrations\/\s+#\s+\d+\s+PostgreSQL migrations/.test(readme), "README migration documentation must not hardcode a drifting count");
  assert(!/\[\d+\s+functions\]/.test(readme), "README function documentation must not hardcode a drifting count");
});

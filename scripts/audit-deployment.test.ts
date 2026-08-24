import { auditDeployment, type DeploymentInventory, type RepositorySnapshot } from "./audit-deployment.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const sourceFiles = new Map([
  ["supabase/migrations/20260824135752_production_security_containment.sql", "drop view public.profiles; security_invoker = true"],
  ["supabase/migrations/20260824153216_secure_internal_jobs.sql", "private.require_internal_job_secret X-Runaway-Internal-Secret"],
  ["supabase/migrations/20260824162713_oauth_state_security.sql", "create table private.oauth_states (state_hash text)"],
  ["supabase/functions/user-races/index.ts", '.from("athletes")'],
]);

function healthyRepository(): RepositorySnapshot {
  const slugs = [
    "activity-observations", "backfill-splits", "chat", "check-milestones", "classify-races", "comprehensive-analysis", "daily-brief", "delete-account", "disconnect", "feedback-workout", "garmin-auth", "garmin-stats", "generate-run-cues", "generate-training-plan", "get-race-course", "goal-assessment", "identity-profile", "journal", "job-status", "max-data", "micro-wins", "regenerate-training-plan", "strava-auth", "sync-beta", "training-plan", "user-races", "garmin-callback", "garmin-webhook", "oauth-callback", "strava-webhook", "breakthrough-milestones", "check-conditions", "daily-research-brief", "fetch-daily-articles", "notify-activity-insert", "process-deliveries", "sync-race-directory", "check-hooks", "check-hooks2", "check-webhook-config", "import-runners", "send-alert",
  ];
  const jwtFree = new Set(["garmin-callback", "garmin-webhook", "oauth-callback", "strava-webhook", "breakthrough-milestones", "check-conditions", "daily-research-brief", "fetch-daily-articles", "notify-activity-insert", "process-deliveries", "sync-race-directory"]);
  return { directories: new Set(slugs), config: new Map(slugs.map((slug) => [slug, !jwtFree.has(slug)])), files: new Map(sourceFiles) };
}

function healthyInventory(): DeploymentInventory {
  const repository = healthyRepository();
  return {
    functions: [...repository.directories].map((slug) => ({ slug, status: "ACTIVE", verify_jwt: repository.config.get(slug), ezbr_sha256: `remote-${slug}` })),
    migrations: ["20260824135752", "20260824153216", "20260824162713"].map((version) => ({ version })),
    schema: {
      "public.profiles": ["id", "email", "full_name", "organization_name", "phone", "created_at", "updated_at"],
      "public.athletes": ["runsignup_access_token", "runsignup_refresh_token", "runsignup_token_expires_at"],
      "private.oauth_states": ["state_hash", "provider", "auth_user_id", "athlete_id", "expires_at", "consumed_at"],
    },
    cronTargets: [{ jobName: "delivery", target: "process-deliveries" }],
    triggerTargets: [{ triggerName: "activity", target: "notify-activity-insert" }],
  };
}

Deno.test("audit accepts an aligned deployment and schema inventory", () => {
  const report = auditDeployment(healthyInventory(), healthyRepository());
  assert(report.errors.length === 0, report.errors.join("\n"));
});

Deno.test("audit rejects undocumented functions, JWT drift, and approved retirements", () => {
  const inventory = healthyInventory();
  inventory.functions.find((entry) => entry.slug === "chat")!.verify_jwt = false;
  inventory.functions.push({ slug: "twin-engine", status: "ACTIVE", verify_jwt: false });
  inventory.functions.push({ slug: "debug-query", status: "ACTIVE", verify_jwt: false });
  const errors = auditDeployment(inventory, healthyRepository()).errors.join("\n");
  assert(errors.includes("chat: deployed verify_jwt=false"), errors);
  assert(errors.includes("twin-engine: undocumented deployed function"), errors);
  assert(errors.includes("debug-query: approved retirement remains deployed"), errors);
});

Deno.test("audit rejects stale database targets and fresh-replay credential schema drift", () => {
  const inventory = healthyInventory();
  inventory.migrations = [];
  inventory.schema!["public.profiles"].push("runsignup_access_token");
  inventory.cronTargets = [{ jobName: "old job", target: "kill-cron" }];
  const errors = auditDeployment(inventory, healthyRepository()).errors.join("\n");
  assert(errors.includes("schema blocker: migration 20260824135752 is not applied"), errors);
  assert(errors.includes("schema blocker: public.profiles still exposes runsignup_access_token"), errors);
  assert(errors.includes("old job: stale database target kill-cron"), errors);
});

Deno.test("audit rejects a missing managed source directory and config entry", () => {
  const repository = healthyRepository();
  repository.directories.delete("journal");
  repository.config.delete("journal");
  const errors = auditDeployment(healthyInventory(), repository).errors.join("\n");
  assert(errors.includes("journal: missing repository source directory"), errors);
  assert(errors.includes("journal: missing config.toml function entry"), errors);
});

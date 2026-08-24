type AuthClass = "user" | "provider" | "internal" | "admin";

export interface ActiveFunction {
  slug: string;
  authClass: AuthClass;
  verifyJwt: boolean;
  source: string;
}

export interface Retirement {
  slug: string;
  reason: string;
}

export interface DeployedFunction {
  slug: string;
  status?: string;
  verify_jwt?: boolean;
  ezbr_sha256?: string;
}

export interface DeploymentInventory {
  functions: DeployedFunction[];
  migrations?: { version: string }[];
  schema?: Record<string, string[]>;
  cronTargets?: { jobName: string; target: string }[];
  triggerTargets?: { triggerName: string; target: string }[];
}

export interface RepositorySnapshot {
  directories: Set<string>;
  config: Map<string, boolean>;
  files: Map<string, string>;
  sourceHashes?: Map<string, string>;
}

export interface DriftReport {
  errors: string[];
  comparisons: Array<Record<string, unknown>>;
  retirement: Retirement[];
}

const user = [
  "activity-observations", "backfill-splits", "chat", "check-milestones",
  "classify-races", "comprehensive-analysis", "daily-brief", "delete-account",
  "disconnect", "feedback-workout", "garmin-auth", "garmin-stats",
  "generate-run-cues", "generate-training-plan", "get-race-course",
  "goal-assessment", "identity-profile", "journal", "job-status", "max-data",
  "micro-wins", "regenerate-training-plan", "strava-auth", "sync-beta",
  "training-plan", "user-races",
];
const provider = ["garmin-callback", "garmin-webhook", "oauth-callback", "strava-webhook"];
const internal = [
  "breakthrough-milestones", "check-conditions", "daily-research-brief",
  "fetch-daily-articles", "notify-activity-insert", "process-deliveries",
  "sync-race-directory",
];
const admin = ["check-hooks", "check-hooks2", "check-webhook-config", "import-runners", "send-alert"];

export const DEPLOYMENT_MANIFEST: ActiveFunction[] = [
  ...user.map((slug) => ({ slug, authClass: "user" as const, verifyJwt: true, source: `supabase/functions/${slug}/index.ts` })),
  ...provider.map((slug) => ({ slug, authClass: "provider" as const, verifyJwt: false, source: `supabase/functions/${slug}/index.ts` })),
  ...internal.map((slug) => ({ slug, authClass: "internal" as const, verifyJwt: false, source: `supabase/functions/${slug}/index.ts` })),
  ...admin.map((slug) => ({ slug, authClass: "admin" as const, verifyJwt: true, source: `supabase/functions/${slug}/index.ts` })),
].sort((left, right) => left.slug.localeCompare(right.slug));

export const RETIREMENT_MANIFEST: Retirement[] = [
  { slug: "debug-query", reason: "temporary diagnostic endpoint" },
  { slug: "run-ddl", reason: "temporary DDL endpoint" },
  { slug: "fix-elevation", reason: "one-off repair endpoint" },
  { slug: "fix-elevation-stl", reason: "one-off repair endpoint" },
  { slug: "list-cron", reason: "temporary cron diagnostic endpoint" },
  { slug: "kill-cron", reason: "temporary cron control endpoint" },
  { slug: "kill-research", reason: "temporary research control endpoint" },
  { slug: "data-sci-audit", reason: "temporary data-science diagnostic endpoint" },
  { slug: "pre-run-brief", reason: "unreferenced legacy endpoint" },
  { slug: "backfill-training-zones", reason: "unreferenced legacy endpoint" },
];

const requiredMigrations = ["20260824135752", "20260824153216", "20260824162713"];
const requiredProfileColumns = ["id", "email", "full_name", "organization_name", "phone", "created_at", "updated_at"];
const forbiddenProfileColumns = ["runsignup_access_token", "runsignup_refresh_token", "runsignup_token_expires_at"];
const requiredAthleteColumns = [...forbiddenProfileColumns];
const requiredOAuthColumns = ["state_hash", "provider", "auth_user_id", "athlete_id", "expires_at", "consumed_at"];

function parseTomlFunctions(text: string): Map<string, boolean> {
  const output = new Map<string, boolean>();
  let current: string | undefined;
  for (const rawLine of text.split("\n")) {
    const section = rawLine.match(/^\[functions\.([^\]]+)\]\s*$/);
    if (section) {
      current = section[1];
      continue;
    }
    const jwt = rawLine.match(/^verify_jwt\s*=\s*(true|false)\b/);
    if (current && jwt) output.set(current, jwt[1] === "true");
  }
  return output;
}

function missing(values: string[] | undefined, required: string[]): string[] {
  const present = new Set(values ?? []);
  return required.filter((value) => !present.has(value));
}

function checkRepositoryAssumptions(repository: RepositorySnapshot): string[] {
  const errors: string[] = [];
  const containment = repository.files.get("supabase/migrations/20260824135752_production_security_containment.sql") ?? "";
  const internalJobs = repository.files.get("supabase/migrations/20260824153216_secure_internal_jobs.sql") ?? "";
  const oauth = repository.files.get("supabase/migrations/20260824162713_oauth_state_security.sql") ?? "";
  const userRaces = repository.files.get("supabase/functions/user-races/index.ts") ?? "";
  if (!containment.includes("drop view public.profiles") || !containment.includes("security_invoker = true")) errors.push("source migration does not rebuild profiles as an invoker-rights credential-free view");
  if (!internalJobs.includes("private.require_internal_job_secret") || !internalJobs.includes("X-Runaway-Internal-Secret")) errors.push("source migration does not preserve internal-job secret callers");
  if (!oauth.includes("create table private.oauth_states") || !oauth.includes("state_hash")) errors.push("source migration does not provide persisted OAuth state");
  if (userRaces.includes('.from("profiles")') || userRaces.includes(".from('profiles')")) errors.push("user-races still reads credentials through profiles");
  return errors;
}

export function auditDeployment(inventory: DeploymentInventory, repository: RepositorySnapshot): DriftReport {
  const errors = checkRepositoryAssumptions(repository);
  const comparisons: Array<Record<string, unknown>> = [];
  const activeBySlug = new Map(DEPLOYMENT_MANIFEST.map((entry) => [entry.slug, entry]));
  const retiredBySlug = new Map(RETIREMENT_MANIFEST.map((entry) => [entry.slug, entry]));
  const deployedBySlug = new Map(inventory.functions.map((entry) => [entry.slug, entry]));

  for (const entry of DEPLOYMENT_MANIFEST) {
    const sourcePresent = repository.directories.has(entry.slug);
    const configJwt = repository.config.get(entry.slug);
    const deployed = deployedBySlug.get(entry.slug);
    const sourceHash = repository.sourceHashes?.get(entry.slug);
    comparisons.push({ slug: entry.slug, repository_directory: sourcePresent, config_present: configJwt !== undefined, config_verify_jwt: configJwt, expected_verify_jwt: entry.verifyJwt, deployed_status: deployed?.status ?? "MISSING", deployed_source_hash: deployed?.ezbr_sha256 ?? null, repository_source_hash: sourceHash ?? null });
    if (!sourcePresent) errors.push(`${entry.slug}: missing repository source directory`);
    if (configJwt === undefined) errors.push(`${entry.slug}: missing config.toml function entry`);
    else if (configJwt !== entry.verifyJwt) errors.push(`${entry.slug}: config.toml verify_jwt=${configJwt}, expected ${entry.verifyJwt} for ${entry.authClass}`);
    if (!deployed) errors.push(`${entry.slug}: expected deployment is missing`);
    else {
      if (deployed.status !== "ACTIVE") errors.push(`${entry.slug}: deployed status is ${deployed.status ?? "UNKNOWN"}, expected ACTIVE`);
      if (deployed.verify_jwt !== entry.verifyJwt) errors.push(`${entry.slug}: deployed verify_jwt=${deployed.verify_jwt}, expected ${entry.verifyJwt} for ${entry.authClass}`);
    }
  }

  for (const deployed of inventory.functions) {
    if (retiredBySlug.has(deployed.slug)) {
      errors.push(`${deployed.slug}: approved retirement remains deployed`);
    } else if (!activeBySlug.has(deployed.slug)) {
      errors.push(`${deployed.slug}: undocumented deployed function`);
    }
  }

  const migrations = new Set((inventory.migrations ?? []).map((migration) => migration.version));
  for (const version of requiredMigrations) if (!migrations.has(version)) errors.push(`schema blocker: migration ${version} is not applied`);
  const schema = inventory.schema ?? {};
  for (const column of missing(schema["public.profiles"], requiredProfileColumns)) errors.push(`schema blocker: public.profiles is missing ${column}`);
  for (const column of forbiddenProfileColumns.filter((column) => (schema["public.profiles"] ?? []).includes(column))) errors.push(`schema blocker: public.profiles still exposes ${column}`);
  for (const column of missing(schema["public.athletes"], requiredAthleteColumns)) errors.push(`schema blocker: public.athletes is missing ${column}`);
  for (const column of missing(schema["private.oauth_states"], requiredOAuthColumns)) errors.push(`schema blocker: private.oauth_states is missing ${column}`);

  for (const target of inventory.cronTargets ?? []) {
    const entry = activeBySlug.get(target.target);
    if (!entry) errors.push(`${target.jobName}: stale database target ${target.target}`);
    else if (entry.authClass !== "internal") errors.push(`${target.jobName}: database target ${target.target} is not an internal-job function`);
  }
  for (const target of inventory.triggerTargets ?? []) {
    const entry = activeBySlug.get(target.target);
    if (!entry) errors.push(`${target.triggerName}: stale database target ${target.target}`);
    else if (entry.authClass !== "internal") errors.push(`${target.triggerName}: database target ${target.target} is not an internal-job function`);
  }

  return { errors: [...new Set(errors)].sort(), comparisons, retirement: RETIREMENT_MANIFEST };
}

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readRepository(root: string): Promise<RepositorySnapshot> {
  const functionsRoot = `${root}/supabase/functions`;
  const directories = new Set<string>();
  const sourceHashes = new Map<string, string>();
  for await (const entry of Deno.readDir(functionsRoot)) {
    if (!entry.isDirectory || entry.name.startsWith("_")) continue;
    directories.add(entry.name);
    try { sourceHashes.set(entry.name, await sha256(await Deno.readTextFile(`${functionsRoot}/${entry.name}/index.ts`))); } catch { /* reported as missing source */ }
  }
  const files = new Map<string, string>();
  for (const path of [
    "supabase/migrations/20260824135752_production_security_containment.sql",
    "supabase/migrations/20260824153216_secure_internal_jobs.sql",
    "supabase/migrations/20260824162713_oauth_state_security.sql",
    "supabase/functions/user-races/index.ts",
  ]) {
    try { files.set(path, await Deno.readTextFile(`${root}/${path}`)); } catch { files.set(path, ""); }
  }
  return { directories, config: parseTomlFunctions(await Deno.readTextFile(`${root}/supabase/config.toml`)), files, sourceHashes };
}

async function main(): Promise<number> {
  const inventoryPath = Deno.args[0] ?? Deno.env.get("RUNAWAY_DEPLOYMENT_INVENTORY");
  if (!inventoryPath) {
    console.error("Provide a sanitized read-only inventory JSON as the first argument or RUNAWAY_DEPLOYMENT_INVENTORY. Task 8 must collect functions, migration versions, schema column names, and cron/trigger targets without secrets.");
    return 2;
  }
  const inventory = JSON.parse(await Deno.readTextFile(inventoryPath)) as DeploymentInventory;
  const report = auditDeployment(inventory, await readRepository(Deno.cwd()));
  console.log(JSON.stringify(report, null, 2));
  return report.errors.length === 0 ? 0 : 1;
}

if (import.meta.main) Deno.exit(await main());

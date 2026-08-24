export type AuditMode = "deploy" | "cohort-user" | "cohort-internal" | "cohort-oauth" | "pre" | "post";
export type Classification = "expected-active" | "approved-retirement" | "unknown-blocker";
export type AuthClass = "user" | "provider" | "internal" | "admin";
export type RolloutCohort = "user" | "internal" | "oauth";

export interface ManifestEntry {
  slug: string;
  classification: Classification;
  authClass?: AuthClass;
  verifyJwt?: boolean;
  baselineVerifyJwt?: boolean;
  baselineBundleSha256?: string | null;
  rolloutCohort?: RolloutCohort;
  archiveBundleSha256?: string;
  restorePolicy?: "blocked-pending-security-review";
}
export interface FunctionInventory {
  slug: string;
  status: string;
  verify_jwt: boolean;
  ezbr_sha256: string;
  bundle_sha256: string;
}

export interface DeploymentInventory {
  projectRef: string;
  functions: FunctionInventory[];
  migrations: { version: string }[];
  schema: {
    columns: Record<string, string[]>;
    assumptions: Record<string, boolean>;
  };
  cronTargets: { jobName: string; target: string }[];
  triggerTargets: { triggerName: string; target: string }[];
  privilegedRpcs: Array<{
    signature: string;
    exists: boolean;
    anonExecute: boolean;
    authenticatedExecute: boolean;
    serviceRoleExecute: boolean;
  }>;
  serviceOnlyRpcs: Array<{
    signature: string;
    category: "delivery" | "oauth-state";
    anonExecute: boolean;
    authenticatedExecute: boolean;
    serviceRoleExecute: boolean;
  }>;
}

export interface FunctionConfig {
  verifyJwt?: boolean;
  entrypoint?: string;
  importMap?: string;
}

export interface RepositorySnapshot {
  sourceDirectories: Set<string>;
  config: Map<string, FunctionConfig>;
  bundleHashes: Map<string, string>;
  bundleErrors: string[];
  migrationSource: string;
  workflowSource: string;
  archives: Map<string, {
    bundleHash?: string;
    secretSafe: boolean;
    fileCount: number;
    verifyJwt?: boolean;
    restorePolicy?: string;
  }>;
}

export interface DriftReport {
  mode: AuditMode;
  errors: string[];
  comparisons: Array<Record<string, unknown>>;
}

export const ROLLOUT_COHORTS: Record<RolloutCohort, string[]> = {
  user: [
    "backfill-splits", "check-milestones", "feedback-workout", "identity-profile",
    "journal", "sync-beta", "training-plan", "user-races",
  ],
  internal: [
    "breakthrough-milestones", "check-conditions", "daily-research-brief",
    "fetch-daily-articles", "notify-activity-insert", "process-deliveries",
    "sync-race-directory",
  ],
  oauth: ["garmin-auth", "garmin-callback", "oauth-callback", "strava-auth"],
};

const BASELINE_VERIFY_JWT: Record<string, boolean> = {
  "activity-observations": false,
  "backfill-splits": true,
  "breakthrough-milestones": false,
  chat: true,
  "check-conditions": false,
  "check-hooks": false,
  "check-hooks2": false,
  "check-milestones": true,
  "check-webhook-config": false,
  "classify-races": false,
  "comprehensive-analysis": false,
  "daily-brief": false,
  "daily-research-brief": false,
  "delete-account": false,
  disconnect: false,
  "feedback-workout": true,
  "fetch-daily-articles": false,
  "garmin-auth": false,
  "garmin-callback": false,
  "garmin-stats": false,
  "garmin-webhook": false,
  "generate-run-cues": true,
  "generate-training-plan": true,
  "get-race-course": false,
  "goal-assessment": true,
  "identity-profile": true,
  "import-runners": false,
  "job-status": false,
  journal: false,
  "max-data": false,
  "micro-wins": false,
  "notify-activity-insert": false,
  "oauth-callback": false,
  "process-deliveries": false,
  "regenerate-training-plan": false,
  "send-alert": false,
  "strava-auth": false,
  "strava-webhook": false,
  "sync-beta": false,
  "sync-race-directory": false,
  "training-plan": false,
  "user-races": false,
};

function rolloutCohort(slug: string): RolloutCohort | undefined {
  return (Object.keys(ROLLOUT_COHORTS) as RolloutCohort[])
    .find((cohort) => ROLLOUT_COHORTS[cohort].includes(slug));
}

const active = (
  slug: string,
  authClass: AuthClass,
  verifyJwt: boolean,
  baselineBundleSha256: string | null,
): ManifestEntry => ({
  slug,
  classification: "expected-active",
  authClass,
  verifyJwt,
  baselineVerifyJwt: BASELINE_VERIFY_JWT[slug] ?? verifyJwt,
  baselineBundleSha256,
  rolloutCohort: rolloutCohort(slug),
});

const retirement = (
  slug: string,
  archiveBundleSha256: string,
  verifyJwt: boolean,
  restorePolicy: "blocked-pending-security-review",
): ManifestEntry => ({
  slug,
  classification: "approved-retirement",
  archiveBundleSha256,
  verifyJwt,
  restorePolicy,
});

export const FUNCTION_MANIFEST: ManifestEntry[] = [
  active("activity-observations", "user", true, "67b6c7dace9cc4c381e954ffd8348e50b5793ac0d9518a37847ce9a80af377e6"),
  active("backfill-splits", "user", true, "250149d08c7f277231b8d0c43efe08d8ea7f244398562511c04447602eb70ff7"),
  active("breakthrough-milestones", "internal", false, "86a1db4bb1423b46ff98c9ff096ebb048a470b89d9c28b915c0bc478dbfffe0f"),
  active("chat", "user", true, "3a8631d1aff7c2a79b9d5cedffb49804d59acd03476fba7102533796f6e9fd47"),
  active("check-conditions", "internal", false, "2908bc4e2a20843554704261cbe06710107fb9ef06dcd655dee01f60d03ec2e0"),
  active("check-hooks", "admin", true, "a68594576728cbfeb1a6583ff12c6238a29328728294e1a94285126b261624f8"),
  active("check-hooks2", "admin", true, "4107689ba922084e998bdcc6d406a163097ee56db288b10c7e16fa1e805e345a"),
  active("check-milestones", "user", true, "77eedb8acedf8464d301dfc391ddd2c255be43e09e3d275b3aae962be9d2c231"),
  active("check-webhook-config", "admin", true, "f9f59d650056a8e2cf7d5975c0e18632626e7a767872cfab44a7b406a1a61384"),
  active("classify-races", "user", true, "0cee2ad5fe00f3b2050a4900b9e23d90371dd638aeaea4effa85a086af60ff8a"),
  active("comprehensive-analysis", "user", true, "e11ea13591ee5c714cf4624a4b3a2a93a5dcc80d7eedfaf545cd209b7635e3f4"),
  active("daily-brief", "user", true, "514b3d9bc9b5bd66d6c163c4cfb099d071f842d66e2e1293d4658f322e66469d"),
  active("daily-research-brief", "internal", false, "023bfba24cc134a3394c46ca949fe6a5209a56c06caa7ba35ee6a0a28b1d66a1"),
  active("delete-account", "user", true, "4154c791ceaf54d4d943913b7d510ddb630c7bc8ebf1c710cc7eb9a6eb6b9488"),
  active("disconnect", "user", true, "ff1857d87f5700315ab92a159b172c77c4a027cf8cbd457da6350541400ca743"),
  active("feedback-workout", "user", true, "1bc3a324102f63039d3590a08d0c0ba5908aafc7c65f711dc8908c7ee3506723"),
  active("fetch-daily-articles", "internal", false, "cb898b3b1df74689d588d7ecf20f7fb643be6b8d97cd2dbadbcb2c8b5fbdd199"),
  active("garmin-auth", "user", true, "dec66e6c626e4b72dfeeda1eae80992cd319b6dca1aa92e851f119d49de69ecb"),
  active("garmin-callback", "provider", false, "3058a60772b59b727d73a8b130a57df5fe375dce13e542189fd22fc696c7d34d"),
  active("garmin-stats", "user", true, "c187d692ee33a0f4628015d983c1021119028a025b1384cb15b77963b7805045"),
  active("garmin-webhook", "provider", false, "e87fe07eb8bcacc12c592b8130b77ee4a785e1ae354041f21f7c854bd8f4b82b"),
  active("generate-run-cues", "user", true, "c980d0bbabd4710161372cdd03c4172f5a72cd771508c058feafb11a47ca1f5e"),
  active("generate-training-plan", "user", true, "b156878f55db883d02eadc4c89ea34cf97e7914317b826c03cf6291c0dc8deb6"),
  active("get-race-course", "user", true, "0179b9d368ff32c7454454628d719349290b8645231d33a710058f00ec2e95f4"),
  active("goal-assessment", "user", true, "c7cffab0c5044728c68599f03a31aea7562d5bcc28ca8796634ab7afc2a048f3"),
  active("identity-profile", "user", true, "22c65dc21db97fbfc17a7dee549d65dfa83801c1cbc13f340be9d5b7259a09b4"),
  active("import-runners", "admin", true, "951e366188157ba667ab5d8f607124e6be985db771ccc602dced2cdffc89ae26"),
  active("job-status", "user", true, "908543fb1e93d7aea9325cace1786cf7078130b68aa1c91f1eb9aca515e58ea2"),
  active("journal", "user", true, "a36ad9a80e9fd2d7bde50aad5f798380e9bb599ca17c7b62de1f2da80d133c0f"),
  active("max-data", "user", true, "5729536feab554073f5c28e7902296386d5b81e7f44aaa070143f9cbfa8b3e9b"),
  active("micro-wins", "user", true, "70ae6d2dd5f8d23a4df2308b0841f072c8751f467aeaa25dddeb58c4f1673b57"),
  active("notify-activity-insert", "internal", false, "20c470211d55568cbbd3407ae9d8729df3a16f6eab6dcb71a2a9091839949978"),
  active("oauth-callback", "provider", false, "ff6ba2cac0fb6130224e7397d7a1266b086684bdcd6379f553c28f0e0350f1cd"),
  active("process-deliveries", "internal", false, "d1be0e375312d8a643077eb33ef18a2079537a94bb8842a78504354d75993877"),
  active("regenerate-training-plan", "user", true, "003e29f660bc9fbee9dd5bb6d9446778a102a19c653457168257abbaa80edd1b"),
  active("send-alert", "admin", true, "aeac3fe28e2ffa3837004b4d54b2a33fa1e21ddb759316036f7f71f6638eb9d0"),
  active("strava-auth", "user", true, "a0d9e7a6e02db94e23924d671c18ae23aed7fce11872ac0eea84347e48c0486b"),
  active("strava-webhook", "provider", false, "ec1578f7553886f804f7a0496e4b2805a019aa65fab44ce8765b98824fb09dc3"),
  active("sync-beta", "user", true, "654f59ae6eec006615f8389178c0d75b54920c79bdfe16da3d349d61876f0cfa"),
  active("sync-race-directory", "internal", false, "c8a72874e9f302d154fed980434ebc09f2e176927952d2484568cb9b04a03a27"),
  active("training-plan", "user", true, "b47fe5fb81255e67efa45b083a6d2fb76395b3ad1279824a6f4d7d48327e5db6"),
  active("user-races", "user", true, "c7235c6930a7f3e2d3cb39f5a711f5fe6a64d4161a4e1a8e6abe12f068209fcd"),
  retirement("backfill-training-zones", "6a8a7c80bba8c10bebf4df8fdc0bfd4b9d79be49072e6781e71bdfff7564d7d1", false, "blocked-pending-security-review"),
  retirement("data-sci-audit", "d54be8867712fd1d9477311191ffbb994591301aa2e71c6c7f613393eb678911", false, "blocked-pending-security-review"),
  retirement("debug-query", "4e6a2b5c5085a5befcffcfc4b4ca420d7425cb452614b4e9d0114d2e108d2189", false, "blocked-pending-security-review"),
  retirement("fix-elevation", "f53a5eaf95a38e1ac1423fb73263b4d23d9267f8c472cb32c82abf5d7bd69ccc", false, "blocked-pending-security-review"),
  retirement("fix-elevation-stl", "664201f042431a486e6ce906a08397e842b3ef4a2be233982dd6aa4ef01a148a", false, "blocked-pending-security-review"),
  retirement("kill-cron", "163e73b4f6547152cbd7f091377e193c8c11d8638ca16ab5877f42293cfee61b", false, "blocked-pending-security-review"),
  retirement("kill-research", "4857d2f509e2778a9bc0db7313122399278957a35eb8d7ab66fc8eff35001301", false, "blocked-pending-security-review"),
  retirement("list-cron", "89eb52fed794b69ece00cae6a00edf606cfb75b3edfafd51b092881ce16ed6e4", false, "blocked-pending-security-review"),
  retirement("pre-run-brief", "05e5a78556777a6c13f496233ff265617351110457815142863a428acd53c286", false, "blocked-pending-security-review"),
  retirement("run-ddl", "ac9d54ec64b273c8ddf7d294693557461df22eed57851540b963dbf0e7b4c793", false, "blocked-pending-security-review"),
  retirement("twin-engine", "4c3556a83fd61ef194a6e5095cef85b85e313d0d30de4de6586ce6acf63a2894", false, "blocked-pending-security-review"),
  retirement("ultratracker", "cd52753fd39cc6211da32bf3e9e83f4a8973913df19f78b07e8803472354b556", true, "blocked-pending-security-review"),
  retirement("upload-race-course", "382e0a2b01bbe0f40dcdc6e6210281e07facfc06688fe60c5174f4c3ac50df5e", true, "blocked-pending-security-review"),
];

export const REQUIRED_MIGRATIONS = [
  "20260824135752",
  "20260824153216",
  "20260824162713",
  "20260824172420",
  "20260824201237",
];

export const REQUIRED_SCHEMA_ASSUMPTIONS = [
  "live_view_definitions_match",
  "profiles_security_invoker_and_scoped",
  "user_views_security_invoker_and_scoped",
  "analytics_views_service_only",
  "weekly_training_plans_owner_scoped",
  "privileged_rpcs_anon_revoked",
  "athlete_rpcs_owner_guarded",
  "internal_delivery_schema",
  "internal_job_rpcs_service_only",
  "oauth_states_secure",
  "oauth_state_rpcs_service_only",
  "garmin_oauth_tokens_service_only",
  "runsignup_credentials_on_athletes",
  "profiles_credential_free",
  "activities_client_operation_id_contract",
];

export const PRE_ACTIVATION_CALLER_ASSUMPTION = "internal_callers_inactive";
export const POST_ACTIVATION_CALLER_ASSUMPTION = "internal_callers_use_dedicated_secret";

const PROFILE_COLUMNS = [
  "id", "email", "full_name", "organization_name", "phone", "created_at", "updated_at",
];
const RUNSIGNUP_COLUMNS = [
  "runsignup_access_token", "runsignup_refresh_token", "runsignup_token_expires_at",
];
const ACTIVITY_IDEMPOTENCY_COLUMNS = ["client_operation_id"];
const OAUTH_COLUMNS = [
  "state_hash", "provider", "auth_user_id", "athlete_id", "redirect_url",
  "expires_at", "consumed_at", "created_at",
];
const EXPECTED_CRON = [
  ["check-conditions-job", "check-conditions"],
  ["daily-research-brief", "daily-research-brief"],
  ["fetch-daily-articles", "fetch-daily-articles"],
  ["process-deliveries-job", "process-deliveries"],
  ["sync-race-directory-job", "sync-race-directory"],
];
const EXPECTED_TRIGGERS = [
  ["runaway_activity_insert_internal:public.activities", "notify-activity-insert"],
];

export const PRIVILEGED_RPC_SIGNATURES = [
  "public.best_split_pr(bigint,integer,double precision,double precision)",
  "public.check_onboarding_status(integer)",
  "public.detect_rest_days(integer,integer)",
  "public.ensure_athlete_exists(uuid,text)",
  "public.get_consecutive_rest_days(integer,date)",
  "public.get_current_week_plan(bigint)",
  "public.get_rest_day_history(integer,integer)",
  "public.get_rest_days_count(integer,date,date)",
];

export const SERVICE_ONLY_RPC_SIGNATURES = [
  { signature: "public.begin_delivery_submission(uuid,bigint)", category: "delivery" as const },
  { signature: "public.claim_pending_deliveries(integer)", category: "delivery" as const },
  { signature: "public.finalize_delivery(uuid,bigint,text,text,text,timestamp with time zone)", category: "delivery" as const },
  { signature: "public.consume_oauth_state(text,text)", category: "oauth-state" as const },
  { signature: "public.create_oauth_state(text,text,uuid,bigint,text,timestamp with time zone)", category: "oauth-state" as const },
];

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["JWT literal", /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/],
  ["Supabase secret literal", /\bsb_secret_[A-Za-z0-9_-]{10,}/],
  ["bearer literal", /\bBearer\s+(?!\$\{|Deno\.env)[A-Za-z0-9._-]{20,}/i],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["credential assignment", /\b(?:api[_-]?key|client[_-]?secret|service[_-]?role[_-]?key|access[_-]?token|refresh[_-]?token)\b\s*[:=]\s*["'`](?!\$\{|Deno\.env|process\.env|env\()[^"'`\n]{12,}["'`]/i],
];

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function setDifference(actual: Set<string>, expected: Set<string>): string[] {
  return sorted([...actual].filter((value) => !expected.has(value)));
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

export function canonicalBundlePath(path: string): string {
  const normalized = normalizePath(path);
  const marker = "supabase/functions/";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex >= 0) return normalized.slice(markerIndex + marker.length);
  if (normalized.startsWith("functions/")) return normalized.slice("functions/".length);
  return normalized;
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "" : normalized.slice(0, index);
}

function parseConfig(text: string): Map<string, FunctionConfig> {
  const output = new Map<string, FunctionConfig>();
  let current: string | undefined;
  for (const line of text.split("\n")) {
    const section = line.match(/^\[functions\.([^\]]+)\]\s*$/);
    if (section) {
      current = section[1];
      if (output.has(current)) throw new Error("duplicate config section: " + current);
      output.set(current, {});
      continue;
    }
    if (!current) continue;
    const jwt = line.match(/^verify_jwt\s*=\s*(true|false)\b/);
    const entrypoint = line.match(/^entrypoint\s*=\s*["']([^"']+)["']/);
    const importMap = line.match(/^import_map\s*=\s*["']([^"']+)["']/);
    const config = output.get(current)!;
    if (jwt) config.verifyJwt = jwt[1] === "true";
    if (entrypoint) config.entrypoint = entrypoint[1];
    if (importMap) config.importMap = importMap[1];
  }
  return output;
}

function relativeImports(source: string): string[] {
  const imports = new Set<string>();
  const patterns = [
    /(?:from\s*|import\s*\(\s*)["'](\.{1,2}\/[^"'?#]+)["']/g,
    /import\s*["'](\.{1,2}\/[^"'?#]+)["']/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) imports.add(match[1]);
  }
  return sorted(imports);
}

function resolveImport(
  files: Map<string, string>,
  importer: string,
  specifier: string,
): string | undefined {
  const base = normalizePath(dirname(importer) + "/" + specifier);
  for (const candidate of [base, base + ".ts", base + ".tsx", base + ".js", base + ".mjs", base + "/index.ts"]) {
    if (files.has(candidate)) return candidate;
  }
  return undefined;
}

export async function hashFiles(files: Map<string, string>): Promise<string> {
  const canonicalFiles = new Map<string, string>();
  for (const [path, content] of files) {
    const canonicalPath = canonicalBundlePath(path);
    if (canonicalFiles.has(canonicalPath)) throw new Error("duplicate canonical bundle path: " + canonicalPath);
    canonicalFiles.set(canonicalPath, content);
  }
  const chunks: string[] = [];
  for (const path of sorted(canonicalFiles.keys())) {
    const content = canonicalFiles.get(path)!;
    chunks.push(path + "\0" + new TextEncoder().encode(content).length + "\0" + content);
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(chunks.join("\0")),
  );
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export async function buildBundleHash(
  files: Map<string, string>,
  entrypoint: string,
  extraFiles: string[] = [],
): Promise<{ hash?: string; errors: string[]; files: string[] }> {
  const errors: string[] = [];
  const pending = [normalizePath(entrypoint), ...extraFiles.map(normalizePath)];
  const included = new Map<string, string>();
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (included.has(path)) continue;
    const source = files.get(path);
    if (source === undefined) {
      errors.push("missing deployable file " + path);
      continue;
    }
    included.set(path, source);
    if (!/\.[cm]?[jt]sx?$/.test(path)) continue;
    for (const specifier of relativeImports(source)) {
      const resolved = resolveImport(files, path, specifier);
      if (!resolved) errors.push(path + ": missing relative dependency " + specifier);
      else pending.push(resolved);
    }
  }
  return {
    hash: errors.length === 0 ? await hashFiles(included) : undefined,
    errors: sorted(new Set(errors)),
    files: sorted(included.keys()),
  };
}

function requireInventoryShape(inventory: DeploymentInventory | undefined): string[] {
  const errors: string[] = [];
  if (!inventory || typeof inventory !== "object") return ["inventory is missing"];
  if (!inventory.projectRef) errors.push("inventory projectRef is missing");
  if (!Array.isArray(inventory.functions)) errors.push("inventory functions section is missing");
  if (!Array.isArray(inventory.migrations)) errors.push("inventory migrations section is missing");
  if (!inventory.schema || typeof inventory.schema !== "object") errors.push("inventory schema section is missing");
  if (!inventory.schema?.columns || typeof inventory.schema.columns !== "object") errors.push("inventory schema.columns section is missing");
  if (!inventory.schema?.assumptions || typeof inventory.schema.assumptions !== "object") errors.push("inventory schema.assumptions section is missing");
  if (!Array.isArray(inventory.cronTargets)) errors.push("inventory cronTargets section is missing");
  if (!Array.isArray(inventory.triggerTargets)) errors.push("inventory triggerTargets section is missing");
  if (!Array.isArray(inventory.privilegedRpcs)) errors.push("inventory privilegedRpcs section is missing");
  if (!Array.isArray(inventory.serviceOnlyRpcs)) errors.push("inventory serviceOnlyRpcs section is missing");
  return errors;
}

function comparePairs(
  label: string,
  actualPairs: Array<[string, string]>,
  expectedPairs: Array<[string, string]>,
): string[] {
  const actual = new Set(actualPairs.map((pair) => pair[0] + "->" + pair[1]));
  const expected = new Set(expectedPairs.map((pair) => pair[0] + "->" + pair[1]));
  return [
    ...setDifference(expected, actual).map((value) => label + " missing " + value),
    ...setDifference(actual, expected).map((value) => label + " unexpected " + value),
  ];
}

export function auditMigrationSource(source: string): string[] {
  const errors: string[] = [];
  const required = [
    /add column if not exists runsignup_access_token text/i,
    /add column if not exists runsignup_refresh_token text/i,
    /add column if not exists runsignup_token_expires_at timestamptz/i,
  ];
  for (const pattern of required) if (!pattern.test(source)) errors.push("fresh replay migration is missing " + pattern.source);
  if (/alter\s+(?:table|view)\s+public\.profiles/i.test(source)) errors.push("fresh replay credential migration must not modify public.profiles");
  return errors;
}

export function auditWorkflowSource(source: string): string[] {
  const errors: string[] = [];
  if (source.includes("--no-verify-jwt")) errors.push("workflow must never use --no-verify-jwt");
  const auditIndex = source.indexOf("audit-deployment.ts");
  const deployIndex = source.indexOf("supabase functions deploy");
  if (auditIndex < 0) errors.push("workflow is missing the fail-closed drift audit");
  if (deployIndex < 0) errors.push("workflow is missing the function deployment");
  if (auditIndex >= 0 && deployIndex >= 0 && auditIndex > deployIndex) errors.push("workflow audit must run before deployment");
  if (!source.includes("--mode deploy") && !source.includes("before_mode=deploy")) errors.push("workflow must use the pre-deploy audit mode");
  if (!source.includes("npx --yes deno test")) errors.push("workflow is missing audit tests");
  const approved = new Set(Object.values(ROLLOUT_COHORTS).flat());
  for (const match of source.matchAll(/supabase functions deploy(?:\s+([^\s\\]+))?/g)) {
    const target = match[1];
    if (!target || target.startsWith("--")) errors.push("workflow fleet deployment is forbidden; every deploy must name one approved function");
    else if (!target.startsWith("$") && !approved.has(target)) errors.push("workflow has unapproved function deployment target " + target);
  }
  return errors;
}

export function auditActivationSources(base: string, activation: string, rollback: string): string[] {
  const errors: string[] = [];
  if (/create\s+trigger\s+\S+\s+after\s+insert\s+on\s+public\.activities/i.test(base)) {
    errors.push("base migration must not install the activity caller trigger");
  }
  if (/cron\.schedule\s*\([\s\S]*?\/functions\/v1\//i.test(base)) {
    errors.push("base migration must not install HTTP cron callers");
  }
  for (const marker of [
    "task8.endpoints_verified", "internal_job_secret", "supabase_url",
    "runaway_activity_insert_internal", "cron.alter_job",
  ]) {
    if (!activation.includes(marker)) errors.push("activation script is missing " + marker);
  }
  for (const legacy of ["activity-insert-notification", "on_activity_insert"]) {
    if (!activation.includes(legacy)) errors.push("activation script does not remove legacy caller " + legacy);
  }
  if (!rollback.includes("active := false")) errors.push("rollback must disable internal cron callers");
  if (!rollback.includes("runaway_activity_insert_internal")) errors.push("rollback must remove the dedicated activity trigger");
  return errors;
}

function deployedCohorts(mode: AuditMode): Set<RolloutCohort> {
  if (mode === "cohort-user") return new Set(["user"]);
  if (mode === "cohort-internal") return new Set(["user", "internal"]);
  if (["cohort-oauth", "pre", "post"].includes(mode)) return new Set(["user", "internal", "oauth"]);
  return new Set();
}

export async function auditDeployment(
  inventory: DeploymentInventory | undefined,
  repository: RepositorySnapshot,
  mode: AuditMode,
  manifest: ManifestEntry[] = FUNCTION_MANIFEST,
): Promise<DriftReport> {
  const errors = [
    ...requireInventoryShape(inventory),
    ...repository.bundleErrors,
    ...auditMigrationSource(repository.migrationSource),
    ...auditWorkflowSource(repository.workflowSource),
  ];
  const comparisons: Array<Record<string, unknown>> = [];
  if (!inventory || errors.some((error) => error.startsWith("inventory ") || error === "inventory is missing")) {
    return { mode, errors: sorted(new Set(errors)), comparisons };
  }

  if (manifest.length !== 55 && manifest === FUNCTION_MANIFEST) errors.push("manifest count is " + manifest.length + ", expected 55");
  const manifestSlugs = manifest.map((entry) => entry.slug);
  if (new Set(manifestSlugs).size !== manifestSlugs.length) errors.push("manifest contains duplicate slugs");

  const activeEntries = manifest.filter((entry) => entry.classification === "expected-active");
  const retirementEntries = manifest.filter((entry) => entry.classification === "approved-retirement");
  const unknownEntries = manifest.filter((entry) => entry.classification === "unknown-blocker");
  const activeSlugs = new Set(activeEntries.map((entry) => entry.slug));
  const deployedRolloutCohorts = deployedCohorts(mode);

  const extraSources = setDifference(repository.sourceDirectories, activeSlugs);
  const missingSources = setDifference(activeSlugs, repository.sourceDirectories);
  const configSlugs = new Set(repository.config.keys());
  const extraConfig = setDifference(configSlugs, activeSlugs);
  const missingConfig = setDifference(activeSlugs, configSlugs);
  errors.push(...extraSources.map((slug) => slug + ": unexpected local function source directory"));
  errors.push(...missingSources.map((slug) => slug + ": missing local function source directory"));
  errors.push(...extraConfig.map((slug) => slug + ": unexpected config.toml function section"));
  errors.push(...missingConfig.map((slug) => slug + ": missing config.toml function section"));

  for (const entry of activeEntries) {
    if (typeof entry.baselineBundleSha256 !== "string" || entry.baselineBundleSha256.length === 0) {
      errors.push(entry.slug + ": reviewed live baseline bundle hash is missing; Task 8 is blocked");
    }
    if (typeof entry.baselineVerifyJwt !== "boolean") errors.push(entry.slug + ": captured live baseline verify_jwt is missing");
    const config = repository.config.get(entry.slug);
    if (config && config.verifyJwt === undefined) errors.push(entry.slug + ": config verify_jwt is missing");
    else if (config && config.verifyJwt !== entry.verifyJwt) errors.push(entry.slug + ": config verify_jwt=" + config.verifyJwt + ", expected " + entry.verifyJwt);
    if (!repository.bundleHashes.get(entry.slug)) errors.push(entry.slug + ": local deployable bundle hash is missing");
  }

  const archiveSlugs = new Set(repository.archives.keys());
  const expectedArchives = new Set(retirementEntries.map((entry) => entry.slug));
  errors.push(...setDifference(archiveSlugs, expectedArchives).map((slug) => slug + ": unexpected retirement archive"));
  errors.push(...setDifference(expectedArchives, archiveSlugs).map((slug) => slug + ": retirement archive is missing"));
  for (const entry of retirementEntries) {
    const archive = repository.archives.get(entry.slug);
    if (!archive) continue;
    if (!archive.secretSafe) errors.push(entry.slug + ": retirement archive failed embedded-secret scan");
    if (archive.fileCount === 0) errors.push(entry.slug + ": retirement archive is empty");
    if (!archive.bundleHash) errors.push(entry.slug + ": retirement archive bundle hash is missing");
    else if (archive.bundleHash !== entry.archiveBundleSha256) errors.push(entry.slug + ": retirement archive bundle hash mismatch");
    if (entry.verifyJwt === undefined) errors.push(entry.slug + ": retirement manifest verify_jwt is missing");
    else if (archive.verifyJwt !== entry.verifyJwt) errors.push(entry.slug + ": retirement archive verify_jwt does not match reviewed deployed flag");
    if (!entry.restorePolicy) errors.push(entry.slug + ": retirement manifest restore_policy is missing");
    else if (archive.restorePolicy !== entry.restorePolicy) errors.push(entry.slug + ": retirement archive restore_policy mismatch");
  }

  const expectedLive = new Set(
    manifest
      .filter((entry) => mode !== "post" || entry.classification !== "approved-retirement")
      .map((entry) => entry.slug),
  );
  const functions = inventory.functions ?? [];
  const liveSlugs = new Set(functions.map((entry) => entry.slug));
  if (liveSlugs.size !== functions.length) errors.push("inventory contains duplicate function slugs");
  if (functions.length !== expectedLive.size) errors.push("deployed function count is " + functions.length + ", expected " + expectedLive.size + " in " + mode + " mode");
  errors.push(...setDifference(expectedLive, liveSlugs).map((slug) => slug + ": missing from deployed inventory"));
  errors.push(...setDifference(liveSlugs, expectedLive).map((slug) => slug + ": unexpected deployed function"));

  const bySlug = new Map(functions.map((entry) => [entry.slug, entry]));
  for (const entry of manifest) {
    const deployed = bySlug.get(entry.slug);
    comparisons.push({
      slug: entry.slug,
      classification: entry.classification,
      localBundleHash: repository.bundleHashes.get(entry.slug) ?? null,
      deployedBundleHash: deployed?.bundle_sha256 ?? null,
      deployedMetadataHash: deployed?.ezbr_sha256 ?? null,
      deployedVerifyJwt: deployed?.verify_jwt ?? null,
    });
    if (entry.classification === "unknown-blocker") {
      errors.push(entry.slug + ": unknown-blocker classification must be resolved before rollout");
    }
    if (!deployed) {
      if (entry.classification === "approved-retirement" && mode === "post") continue;
      continue;
    }
    if (deployed.status !== "ACTIVE") errors.push(entry.slug + ": deployed status is " + deployed.status + ", expected ACTIVE");
    if (!deployed.ezbr_sha256) errors.push(entry.slug + ": deployed metadata hash is missing");
    if (!deployed.bundle_sha256) errors.push(entry.slug + ": complete live bundle hash is missing");

    if (entry.classification === "expected-active") {
      const cohortIsDeployed = entry.rolloutCohort !== undefined && deployedRolloutCohorts.has(entry.rolloutCohort);
      if (!cohortIsDeployed) {
        if (entry.baselineBundleSha256 && deployed.bundle_sha256 !== entry.baselineBundleSha256) {
          errors.push(entry.slug + (mode === "deploy"
            ? ": reviewed live baseline bundle hash mismatch"
            : ": deferred function no longer matches captured live baseline"));
        }
        if (typeof entry.baselineVerifyJwt === "boolean" && deployed.verify_jwt !== entry.baselineVerifyJwt) {
          errors.push(entry.slug + ": deferred function verify_jwt no longer matches captured live baseline");
        }
      } else {
        if (deployed.verify_jwt !== entry.verifyJwt) errors.push(entry.slug + ": deployed verify_jwt=" + deployed.verify_jwt + ", expected " + entry.verifyJwt);
        const localHash = repository.bundleHashes.get(entry.slug);
        if (!localHash || deployed.bundle_sha256 !== localHash) errors.push(entry.slug + ": deployed bundle does not match local deployable bundle");
      }
    }
    if (mode === "deploy") {
      if (entry.classification === "approved-retirement" && deployed.bundle_sha256 !== entry.archiveBundleSha256) {
        errors.push(entry.slug + ": live retirement bundle does not match recoverable archive");
      }
    } else if (entry.classification === "approved-retirement" && mode === "pre") {
      if (deployed.bundle_sha256 !== entry.archiveBundleSha256) errors.push(entry.slug + ": pre-retirement live bundle does not match archive");
    }
    if (entry.classification === "approved-retirement" && deployed.verify_jwt !== entry.verifyJwt) {
      errors.push(entry.slug + ": retirement deployed verify_jwt=" + deployed.verify_jwt + ", expected reviewed flag " + entry.verifyJwt);
    }
  }

  if (mode !== "deploy") {
  const migrationVersions = new Set((inventory.migrations ?? []).map((entry) => entry.version));
  for (const version of REQUIRED_MIGRATIONS) if (!migrationVersions.has(version)) errors.push("schema blocker: migration " + version + " is not applied");

  const columns = inventory.schema?.columns ?? {};
  const profileColumns = new Set(columns["public.profiles"] ?? []);
  if (profileColumns.size !== PROFILE_COLUMNS.length || PROFILE_COLUMNS.some((column) => !profileColumns.has(column))) errors.push("schema blocker: public.profiles columns do not exactly match the credential-free contract");
  for (const column of RUNSIGNUP_COLUMNS) if (!(columns["public.athletes"] ?? []).includes(column)) errors.push("schema blocker: public.athletes is missing " + column);
  for (const column of ACTIVITY_IDEMPOTENCY_COLUMNS) if (!(columns["public.activities"] ?? []).includes(column)) errors.push("schema blocker: public.activities is missing " + column);
  for (const column of OAUTH_COLUMNS) if (!(columns["private.oauth_states"] ?? []).includes(column)) errors.push("schema blocker: private.oauth_states is missing " + column);

  const assumptions = inventory.schema?.assumptions ?? {};
  const assumptionNames = new Set(Object.keys(assumptions));
  const preActivation = mode === "cohort-user" || mode === "cohort-internal";
  const requiredCallerAssumption = preActivation
    ? PRE_ACTIVATION_CALLER_ASSUMPTION
    : POST_ACTIVATION_CALLER_ASSUMPTION;
  const requiredAssumptions = new Set([...REQUIRED_SCHEMA_ASSUMPTIONS, requiredCallerAssumption]);
  const allowedAssumptions = new Set([
    ...REQUIRED_SCHEMA_ASSUMPTIONS,
    PRE_ACTIVATION_CALLER_ASSUMPTION,
    POST_ACTIVATION_CALLER_ASSUMPTION,
  ]);
  errors.push(...setDifference(requiredAssumptions, assumptionNames).map((name) => "schema assumption missing: " + name));
  errors.push(...setDifference(assumptionNames, allowedAssumptions).map((name) => "unexpected schema assumption: " + name));
  for (const name of REQUIRED_SCHEMA_ASSUMPTIONS) if (assumptions[name] !== true) errors.push("schema assumption failed: " + name);
  if (assumptions[requiredCallerAssumption] !== true) errors.push("schema assumption failed: " + requiredCallerAssumption);

  const rpcInventory = inventory.privilegedRpcs ?? [];
  const rpcSignatures = rpcInventory.map((rpc) => rpc.signature);
  if (new Set(rpcSignatures).size !== rpcSignatures.length) errors.push("privileged RPC inventory contains duplicate signatures");
  const actualRpcSignatures = new Set(rpcSignatures);
  const expectedRpcSignatures = new Set(PRIVILEGED_RPC_SIGNATURES);
  errors.push(...setDifference(expectedRpcSignatures, actualRpcSignatures).map((signature) => "privileged RPC inventory missing " + signature));
  errors.push(...setDifference(actualRpcSignatures, expectedRpcSignatures).map((signature) => "privileged RPC inventory unexpected " + signature));
  for (const rpc of rpcInventory) {
    if (typeof rpc.exists !== "boolean" || typeof rpc.anonExecute !== "boolean" ||
      typeof rpc.authenticatedExecute !== "boolean" || typeof rpc.serviceRoleExecute !== "boolean") {
      errors.push(rpc.signature + ": privileged RPC signature/grant data is incomplete");
      continue;
    }
    if (!rpc.exists) errors.push(rpc.signature + ": protected RPC signature does not exist");
    if (rpc.anonExecute) errors.push(rpc.signature + ": anon retains EXECUTE on protected RPC");
    if (!rpc.authenticatedExecute) errors.push(rpc.signature + ": authenticated EXECUTE grant is missing");
    if (!rpc.serviceRoleExecute) errors.push(rpc.signature + ": service_role EXECUTE grant is missing");
  }

  const serviceOnlyInventory = inventory.serviceOnlyRpcs ?? [];
  const serviceOnlySignatures = serviceOnlyInventory.map((rpc) => rpc.signature);
  if (new Set(serviceOnlySignatures).size !== serviceOnlySignatures.length) errors.push("service-only RPC inventory contains duplicate signatures");
  const actualServiceOnlySignatures = new Set(serviceOnlySignatures);
  const expectedServiceOnlySignatures = new Set(SERVICE_ONLY_RPC_SIGNATURES.map((rpc) => rpc.signature));
  errors.push(...setDifference(expectedServiceOnlySignatures, actualServiceOnlySignatures).map((signature) => "service-only RPC inventory missing " + signature));
  errors.push(...setDifference(actualServiceOnlySignatures, expectedServiceOnlySignatures).map((signature) => "service-only RPC inventory unexpected " + signature));
  const expectedServiceOnlyBySignature = new Map(SERVICE_ONLY_RPC_SIGNATURES.map((rpc) => [rpc.signature, rpc.category]));
  for (const rpc of serviceOnlyInventory) {
    if (rpc.category !== expectedServiceOnlyBySignature.get(rpc.signature)) errors.push(rpc.signature + ": service-only RPC category mismatch");
    if (typeof rpc.anonExecute !== "boolean" || typeof rpc.authenticatedExecute !== "boolean" ||
      typeof rpc.serviceRoleExecute !== "boolean") {
      errors.push(rpc.signature + ": service-only RPC role grant data is incomplete");
      continue;
    }
    if (rpc.anonExecute) errors.push(rpc.signature + ": anon must not have EXECUTE on service-only RPC");
    if (rpc.authenticatedExecute) errors.push(rpc.signature + ": authenticated must not have EXECUTE on service-only RPC");
    if (!rpc.serviceRoleExecute) errors.push(rpc.signature + ": service_role EXECUTE grant is missing on service-only RPC");
  }

  errors.push(...comparePairs("cron inventory", (inventory.cronTargets ?? []).map((entry) => [entry.jobName, entry.target]), EXPECTED_CRON as Array<[string, string]>));
  errors.push(...comparePairs("trigger inventory", (inventory.triggerTargets ?? []).map((entry) => [entry.triggerName, entry.target]), preActivation ? [] : EXPECTED_TRIGGERS as Array<[string, string]>));
  }

  return { mode, errors: sorted(new Set(errors)), comparisons };
}

async function readTree(root: string, prefix = ""): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  try {
    for await (const entry of Deno.readDir(root)) {
      const relative = normalizePath(prefix + "/" + entry.name);
      const absolute = root + "/" + entry.name;
      if (entry.isDirectory) {
        for (const [path, content] of await readTree(absolute, relative)) files.set(path, content);
      } else if (entry.isFile) {
        files.set(relative, await Deno.readTextFile(absolute));
      }
    }
  } catch {
    return files;
  }
  return files;
}

async function readRepository(root: string): Promise<RepositorySnapshot> {
  const configText = await Deno.readTextFile(root + "/supabase/config.toml");
  const config = parseConfig(configText);
  const sourceDirectories = new Set<string>();
  for await (const entry of Deno.readDir(root + "/supabase/functions")) {
    if (entry.isDirectory && !entry.name.startsWith("_")) sourceDirectories.add(entry.name);
  }
  const allFiles = await readTree(root + "/supabase", "supabase");
  const bundleHashes = new Map<string, string>();
  const bundleErrors: string[] = [];
  for (const entry of FUNCTION_MANIFEST.filter((item) => item.classification === "expected-active")) {
    const functionConfig = config.get(entry.slug);
    const entrypoint = normalizePath(functionConfig?.entrypoint ?? "supabase/functions/" + entry.slug + "/index.ts");
    const extras = functionConfig?.importMap ? [normalizePath("supabase/" + functionConfig.importMap)] : [];
    const bundle = await buildBundleHash(allFiles, entrypoint, extras);
    bundleErrors.push(...bundle.errors.map((error) => entry.slug + ": " + error));
    if (bundle.hash) bundleHashes.set(entry.slug, bundle.hash);
  }

  const archives = new Map<string, {
    bundleHash?: string;
    secretSafe: boolean;
    fileCount: number;
    verifyJwt?: boolean;
    restorePolicy?: string;
  }>();
  const archiveRoot = root + "/supabase/retired-functions";
  try {
    for await (const entry of Deno.readDir(archiveRoot)) {
      if (!entry.isDirectory) continue;
      const files = await readTree(archiveRoot + "/" + entry.name + "/bundle");
      let metadata: Record<string, unknown> = {};
      try {
        metadata = JSON.parse(await Deno.readTextFile(archiveRoot + "/" + entry.name + "/archive.json"));
      } catch {
        // Required metadata fields below fail closed.
      }
      let secretSafe = true;
      for (const content of files.values()) {
        if (SECRET_PATTERNS.some(([, pattern]) => pattern.test(content))) secretSafe = false;
      }
      archives.set(entry.name, {
        bundleHash: files.size > 0 ? await hashFiles(files) : undefined,
        secretSafe,
        fileCount: files.size,
        verifyJwt: typeof metadata.verify_jwt === "boolean" ? metadata.verify_jwt : undefined,
        restorePolicy: typeof metadata.restore_policy === "string" ? metadata.restore_policy : undefined,
      });
    }
  } catch {
    // Exact archive coverage below reports every missing archive.
  }

  return {
    sourceDirectories,
    config,
    bundleHashes,
    bundleErrors,
    migrationSource: await Deno.readTextFile(root + "/supabase/migrations/20260824172420_add_runsignup_credentials_to_athletes.sql"),
    workflowSource: await Deno.readTextFile(root + "/.github/workflows/deploy-functions.yml"),
    archives,
  };
}

async function attachRemoteBundleHashes(
  inventory: DeploymentInventory,
  remoteRoot: string,
): Promise<void> {
  for (const fn of inventory.functions) {
    const files = await readTree(remoteRoot + "/" + fn.slug + "/supabase/functions");
    fn.bundle_sha256 = files.size > 0 ? await hashFiles(files) : "";
  }
}

const PRIVILEGED_RPC_VALUES_SQL = PRIVILEGED_RPC_SIGNATURES
  .map((signature) => "('" + signature.replaceAll("'", "''") + "')")
  .join(",");
const SERVICE_ONLY_RPC_VALUES_SQL = SERVICE_ONLY_RPC_SIGNATURES
  .map((rpc) => "('" + rpc.signature.replaceAll("'", "''") + "','" + rpc.category + "')")
  .join(",");

const LIVE_INVENTORY_SQL = [
  "select 'migration'::text as kind, version::text as key, null::text as value, true as passed from supabase_migrations.schema_migrations",
  "union all select 'column', table_schema || '.' || table_name, column_name, true from information_schema.columns where (table_schema, table_name) in (('public','profiles'),('public','athletes'),('public','activities'),('private','oauth_states'))",
  "union all select 'cron', coalesce(jobname, jobid::text), (regexp_match(command, '/functions/v1/([a-z0-9-]+)'))[1], true from cron.job where command ~ '/functions/v1/[a-z0-9-]+'",
  "union all select 'trigger', tg.tgname || ':' || n.nspname || '.' || c.relname, (regexp_match(pg_get_functiondef(p.oid), '/functions/v1/([a-z0-9-]+)'))[1], true from pg_trigger tg join pg_class c on c.oid=tg.tgrelid join pg_namespace n on n.oid=c.relnamespace join pg_proc p on p.oid=tg.tgfoid where not tg.tgisinternal and pg_get_functiondef(p.oid) ~ '/functions/v1/[a-z0-9-]+'",
  "union all select 'assumption','live_view_definitions_match',null, (select count(*)=4 from (values ('activity_summary','3f91ffc93cc5cd952cc9873de6c5dc63'),('conversation_summaries','2b46d7b0aafbacf2b8f044214d1f6ba3'),('monthly_activity_stats','ed5bab41993ca187a0a25c2098ebf9c2'),('recent_journal_entries','b9a0389d9cedcc19f11f70776d33ee23')) expected(view_name,definition_md5) where to_regclass('public.'||expected.view_name) is not null and md5(pg_get_viewdef(to_regclass('public.'||expected.view_name)))=expected.definition_md5)",
  "union all select 'assumption','profiles_security_invoker_and_scoped',null, exists(select 1 from pg_class c where c.oid='public.profiles'::regclass and 'security_invoker=true'=any(coalesce(c.reloptions,array[]::text[]))) and not has_table_privilege('anon','public.profiles','select') and has_table_privilege('authenticated','public.profiles','select')",
  "union all select 'assumption','user_views_security_invoker_and_scoped',null, (select bool_and('security_invoker=true'=any(coalesce(c.reloptions,array[]::text[])) and not has_table_privilege('anon','public.'||c.relname,'select') and has_table_privilege('authenticated','public.'||c.relname,'select')) from pg_class c where c.oid in ('public.activity_summary'::regclass,'public.conversation_summaries'::regclass,'public.monthly_activity_stats'::regclass,'public.recent_journal_entries'::regclass))",
  "union all select 'assumption','analytics_views_service_only',null, (select bool_and(not has_table_privilege('anon','public.'||c.relname,'select') and not has_table_privilege('authenticated','public.'||c.relname,'select') and has_table_privilege('service_role','public.'||c.relname,'select')) from pg_class c where c.oid in ('public.analytics_activity_funnel'::regclass,'public.analytics_activity_hours'::regclass,'public.analytics_audio_coaching'::regclass,'public.analytics_daily_summary'::regclass,'public.analytics_user_engagement'::regclass))",
  "union all select 'assumption','weekly_training_plans_owner_scoped',null, not exists(select 1 from pg_policies where schemaname='public' and tablename='weekly_training_plans' and policyname='Authenticated read access') and exists(select 1 from pg_policies where schemaname='public' and tablename='weekly_training_plans' and policyname='Users can read own plans')",
  `union all select 'privileged_rpc',v.signature,json_build_object('exists',to_regprocedure(v.signature) is not null,'anon_execute',case when to_regprocedure(v.signature) is null then null else has_function_privilege('anon',v.signature,'execute') end,'authenticated_execute',case when to_regprocedure(v.signature) is null then null else has_function_privilege('authenticated',v.signature,'execute') end,'service_role_execute',case when to_regprocedure(v.signature) is null then null else has_function_privilege('service_role',v.signature,'execute') end)::text,true from (values ${PRIVILEGED_RPC_VALUES_SQL}) v(signature)`,
  `union all select 'assumption','privileged_rpcs_anon_revoked',null,coalesce((select bool_and(to_regprocedure(v.signature) is not null and not has_function_privilege('anon',v.signature,'execute')) from (values ${PRIVILEGED_RPC_VALUES_SQL}) v(signature)),false)`,
  "union all select 'assumption','athlete_rpcs_owner_guarded',null, exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname='current_user_owns_athlete')",
  "union all select 'assumption','internal_delivery_schema',null, (select count(*)=5 from information_schema.columns where table_schema='public' and table_name='alert_deliveries' and column_name in ('attempt_count','processing_started_at','claim_generation','lease_expires_at','idempotency_key'))",
  `union all select 'service_only_rpc',v.signature,json_build_object('category',v.category,'anon_execute',case when to_regprocedure(v.signature) is null then null else has_function_privilege('anon',v.signature,'execute') end,'authenticated_execute',case when to_regprocedure(v.signature) is null then null else has_function_privilege('authenticated',v.signature,'execute') end,'service_role_execute',case when to_regprocedure(v.signature) is null then null else has_function_privilege('service_role',v.signature,'execute') end)::text,true from (values ${SERVICE_ONLY_RPC_VALUES_SQL}) v(signature,category)`,
  `union all select 'assumption','internal_job_rpcs_service_only',null,coalesce((select bool_and(case when to_regprocedure(v.signature) is null then false else not has_function_privilege('anon',v.signature,'execute') and not has_function_privilege('authenticated',v.signature,'execute') and has_function_privilege('service_role',v.signature,'execute') end) from (values ${SERVICE_ONLY_RPC_VALUES_SQL}) v(signature,category) where v.category='delivery'),false)`,
  "union all select 'assumption','internal_callers_inactive',null, not exists(select 1 from cron.job where active and jobname in ('daily-research-brief','fetch-daily-articles','check-conditions-job','process-deliveries-job','sync-race-directory-job')) and not exists(select 1 from pg_trigger tg join pg_class c on c.oid=tg.tgrelid join pg_namespace n on n.oid=c.relnamespace where not tg.tgisinternal and n.nspname='public' and c.relname='activities' and tg.tgname in ('activity-insert-notification','on_activity_insert','runaway_activity_insert_internal'))",
  "union all select 'assumption','internal_callers_use_dedicated_secret',null, to_regprocedure('private.require_internal_job_secret()') is not null and (select count(*)=5 from cron.job where jobname in ('daily-research-brief','fetch-daily-articles','check-conditions-job','process-deliveries-job','sync-race-directory-job') and command like '%X-Runaway-Internal-Secret%' and command not like '%Authorization%') and (select count(*)=3 from cron.job where active and jobname in ('daily-research-brief','fetch-daily-articles','check-conditions-job')) and (select count(*)=2 from cron.job where not active and jobname in ('process-deliveries-job','sync-race-directory-job')) and (select count(*)=1 from pg_trigger tg join pg_class c on c.oid=tg.tgrelid join pg_namespace n on n.oid=c.relnamespace where not tg.tgisinternal and n.nspname='public' and c.relname='activities' and tg.tgname='runaway_activity_insert_internal')",
  "union all select 'assumption','oauth_states_secure',null, to_regclass('private.oauth_states') is not null and (select relrowsecurity from pg_class where oid='private.oauth_states'::regclass)",
  `union all select 'assumption','oauth_state_rpcs_service_only',null,coalesce((select bool_and(case when to_regprocedure(v.signature) is null then false else not has_function_privilege('anon',v.signature,'execute') and not has_function_privilege('authenticated',v.signature,'execute') and has_function_privilege('service_role',v.signature,'execute') end) from (values ${SERVICE_ONLY_RPC_VALUES_SQL}) v(signature,category) where v.category='oauth-state'),false)`,
  "union all select 'assumption','garmin_oauth_tokens_service_only',null, not has_table_privilege('anon','public.garmin_oauth_tokens','select') and not has_table_privilege('authenticated','public.garmin_oauth_tokens','select')",
  "union all select 'assumption','runsignup_credentials_on_athletes',null, (select count(*)=3 from information_schema.columns where table_schema='public' and table_name='athletes' and column_name in ('runsignup_access_token','runsignup_refresh_token','runsignup_token_expires_at'))",
  "union all select 'assumption','profiles_credential_free',null, not exists(select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name in ('runsignup_access_token','runsignup_refresh_token','runsignup_token_expires_at'))",
  "union all select 'assumption','activities_client_operation_id_contract',null, exists(select 1 from information_schema.columns where table_schema='public' and table_name='activities' and column_name='client_operation_id' and data_type='uuid' and is_nullable='YES') and exists(select 1 from pg_constraint c where c.conrelid='public.activities'::regclass and c.contype='u' and (select array_agg(a.attname order by keys.ordinality) from unnest(c.conkey) with ordinality keys(attnum,ordinality) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=keys.attnum)=array['athlete_id','client_operation_id']::name[]) and (select relrowsecurity from pg_class where oid='public.activities'::regclass) and (select count(*)=4 from pg_policies where schemaname='public' and tablename='activities' and policyname in ('Users can view own activities','Users can insert own activities','Users can update own activities','Users can delete own activities') and cmd in ('SELECT','INSERT','UPDATE','DELETE') and 'authenticated'=any(roles))",
].join("\n");

async function fetchLiveInventory(
  projectRef: string,
  accessToken: string,
): Promise<DeploymentInventory> {
  const headers = { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" };
  const [functionResponse, schemaResponse] = await Promise.all([
    fetch("https://api.supabase.com/v1/projects/" + projectRef + "/functions", { headers }),
    fetch("https://api.supabase.com/v1/projects/" + projectRef + "/database/query", {
      method: "POST",
      headers,
      body: JSON.stringify({ query: LIVE_INVENTORY_SQL }),
    }),
  ]);
  if (!functionResponse.ok) throw new Error("function inventory request failed: HTTP " + functionResponse.status);
  if (!schemaResponse.ok) throw new Error("schema inventory request failed: HTTP " + schemaResponse.status);
  const functionBody = await functionResponse.json();
  const rows = await schemaResponse.json() as Array<{ kind: string; key: string; value: string | null; passed: boolean }>;
  const rawFunctions = Array.isArray(functionBody) ? functionBody : functionBody.functions;
  const inventory: DeploymentInventory = {
    projectRef,
    functions: rawFunctions.map((fn: Record<string, unknown>) => ({
      slug: String(fn.slug ?? ""),
      status: String(fn.status ?? ""),
      verify_jwt: fn.verify_jwt === true,
      ezbr_sha256: String(fn.ezbr_sha256 ?? ""),
      bundle_sha256: "",
    })),
    migrations: [],
    schema: { columns: {}, assumptions: {} },
    cronTargets: [],
    triggerTargets: [],
    privilegedRpcs: [],
    serviceOnlyRpcs: [],
  };
  for (const row of rows) {
    if (row.kind === "migration") inventory.migrations.push({ version: row.key });
    else if (row.kind === "column") (inventory.schema.columns[row.key] ??= []).push(String(row.value));
    else if (row.kind === "assumption") inventory.schema.assumptions[row.key] = row.passed === true;
    else if (row.kind === "cron") inventory.cronTargets.push({ jobName: row.key, target: String(row.value) });
    else if (row.kind === "trigger") inventory.triggerTargets.push({ triggerName: row.key, target: String(row.value) });
    else if (row.kind === "privileged_rpc") {
      const grants = JSON.parse(String(row.value)) as Record<string, unknown>;
      inventory.privilegedRpcs.push({
        signature: row.key,
        exists: grants.exists === true,
        anonExecute: grants.anon_execute as boolean,
        authenticatedExecute: grants.authenticated_execute as boolean,
        serviceRoleExecute: grants.service_role_execute as boolean,
      });
    }
    else if (row.kind === "service_only_rpc") {
      const grants = JSON.parse(String(row.value)) as Record<string, unknown>;
      inventory.serviceOnlyRpcs.push({
        signature: row.key,
        category: grants.category as "delivery" | "oauth-state",
        anonExecute: grants.anon_execute as boolean,
        authenticatedExecute: grants.authenticated_execute as boolean,
        serviceRoleExecute: grants.service_role_execute as boolean,
      });
    }
  }
  return inventory;
}

function argument(name: string): string | undefined {
  const index = Deno.args.indexOf(name);
  return index >= 0 ? Deno.args[index + 1] : undefined;
}

async function main(): Promise<number> {
  const mode = (argument("--mode") ?? "deploy") as AuditMode;
  if (!["deploy", "cohort-user", "cohort-internal", "cohort-oauth", "pre", "post"].includes(mode)) throw new Error("invalid --mode");
  const remoteRoot = argument("--remote-bundles");
  if (!remoteRoot) throw new Error("--remote-bundles is required so complete live bundle hashes cannot be omitted");
  const inventoryPath = argument("--inventory");
  let inventory: DeploymentInventory;
  if (inventoryPath) {
    inventory = JSON.parse(await Deno.readTextFile(inventoryPath));
  } else {
    const projectRef = Deno.env.get("SUPABASE_PROJECT_ID");
    const accessToken = Deno.env.get("SUPABASE_ACCESS_TOKEN");
    if (!projectRef || !accessToken) throw new Error("SUPABASE_PROJECT_ID and SUPABASE_ACCESS_TOKEN are required");
    inventory = await fetchLiveInventory(projectRef, accessToken);
  }
  await attachRemoteBundleHashes(inventory, remoteRoot);
  const report = await auditDeployment(inventory, await readRepository(Deno.cwd()), mode);
  console.log(JSON.stringify(report, null, 2));
  return report.errors.length === 0 ? 0 : 1;
}

if (import.meta.main) Deno.exit(await main());

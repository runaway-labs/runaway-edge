export type AuditMode = "deploy" | "pre" | "post";
export type Classification = "expected-active" | "approved-retirement" | "unknown-blocker";
export type AuthClass = "user" | "provider" | "internal" | "admin";

export interface ManifestEntry {
  slug: string;
  classification: Classification;
  authClass?: AuthClass;
  verifyJwt?: boolean;
  baselineBundleSha256?: string | null;
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
  baselineBundleSha256,
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

const unknown = (
  slug: string,
  baselineBundleSha256: string,
): ManifestEntry => ({
  slug,
  classification: "unknown-blocker",
  baselineBundleSha256,
});

export const FUNCTION_MANIFEST: ManifestEntry[] = [
  active("activity-observations", "user", true, "b9bfe3782facd00094f1ab5af45a72e24c81f698d3e35824d2267ac0e72f2e7f"),
  active("backfill-splits", "user", true, null),
  active("breakthrough-milestones", "internal", false, "888ac6dcb0c414aede7873b709965e031f349fbd58dbe62116a925bef39560cb"),
  active("chat", "user", true, "70c008cc141f5ef568e6c506221ca9222441be310cbcccdc9eeb244b47060dbb"),
  active("check-conditions", "internal", false, "e1b100087c661a7f1e92f4fd13034d68b1d7aa7a594362c773db555c1287b1ac"),
  active("check-hooks", "admin", true, "526a39f2ff602556faa12081460589a3074d3ed4b9beff7661392b70c3fd4f55"),
  active("check-hooks2", "admin", true, "770ba16d79687ae3c63a88b7955abcba17a1c50d7eb439a3430f7f6648553a54"),
  active("check-milestones", "user", true, null),
  active("check-webhook-config", "admin", true, "86e65a0bf88ba42834150d1fe6e3bbb2a6f99a20815dfce3be4b784d4505a3ea"),
  active("classify-races", "user", true, "4c5c59fa66f41528fecc4fe01e5d503ed0a1514b853917dcde286127ef2faf90"),
  active("comprehensive-analysis", "user", true, "3f035893295ae47df46e30173fe95ed2d3dcbd5d43120a0e3816d01296ebd606"),
  active("daily-brief", "user", true, "c733dd5adf6614a1dcf0db1a7cd6d77a0fa74841aca292f053d994c48efdbe7a"),
  active("daily-research-brief", "internal", false, "11c55026cac01272afbf8fb9474b0f14e35a3602fc3125c7301adfa06e26527a"),
  active("delete-account", "user", true, "0ae25d7d82a8ddb157e10342778a1a68b7876b83495f8e6e830e8d8ba6f27841"),
  active("disconnect", "user", true, "dafcced0a2cb32d68e1cb46f36ceac285ce50c30e1e88eab57ca44ad4bef5f77"),
  active("feedback-workout", "user", true, null),
  active("fetch-daily-articles", "internal", false, "022ab14b111933dd43e0a811afd548c2d05ca0d2e5297d87fcc68ab80005f406"),
  active("garmin-auth", "user", true, "93cde8296b27a00dc20ce7c86301787a3f4126d0f41ed826a6364b37fcd78c79"),
  active("garmin-callback", "provider", false, "a35662afdfed12871125e62c798f8afe88c37017fcc15f923bf66e5fd19e83cc"),
  active("garmin-stats", "user", true, "0f06bbd2ffcd589ccdf49ec2414a081a05fed9e84eb50610b96a0501a67be73a"),
  active("garmin-webhook", "provider", false, "9cd453a7e1e4c338a10cab41ba7bd4589fb406f2a5e138aadeae60a25630eece"),
  active("generate-run-cues", "user", true, null),
  active("generate-training-plan", "user", true, "8b58241dcefd400b1e9ff1ee9c8e2726fd54f96a1aac55a05b66cf03da360393"),
  active("get-race-course", "user", true, "5de8533a886e88ee727ae051046c87579396faf8aecc06aa08ff38b7df81acfd"),
  active("goal-assessment", "user", true, "0df9206c1d21b452c63fa7d0faa78bc4fa900ddddd2787a19ff199aef6321c92"),
  active("identity-profile", "user", true, null),
  active("import-runners", "admin", true, "b153018260f080d3f56d268b428036da81a9ecfa54ecc7f842bb42db7bd0eda8"),
  active("job-status", "user", true, "2938dc323f7c66fa5f30b954fc4f519a102c0c64d968ada64f7d0f7784f79536"),
  active("journal", "user", true, "4bfab588eaff6ae3c7b298cfbf9fa2dd24ee895372e6086cbb9c42fcff0421b4"),
  active("max-data", "user", true, "651d271502219ad5d10eb1f2c5382869370f007e60ed8568223082391e708efd"),
  active("micro-wins", "user", true, "20f232b9e858f80d55bfd179b33e19180597c4577a36ed8aa19f88694039ad83"),
  active("notify-activity-insert", "internal", false, "c039c104017e1ca8fde783806fe80f1e516e9e5b24bdabff8ec17d87c866c3d2"),
  active("oauth-callback", "provider", false, "380bab0734d05611e66f460b665d3c1a59a33884a6ab2a61e23d1b68f750ee24"),
  active("process-deliveries", "internal", false, "73108db1c26e84d5f6be9b8770d976f02b75e2baa04f098836ad3ef999e30ca5"),
  active("regenerate-training-plan", "user", true, "a958c6089b2c9a8a8e27b649c7c1ab5c924923fbc3cdcb0f2a12baeb33202e15"),
  active("send-alert", "admin", true, "e903b41201848979ecb88d08061a1a5ce53483f3ae5c87757c569523dc3444ba"),
  active("strava-auth", "user", true, "ca20a247f3e8ed11bb0b985281445b9790f41adf4c77589a97fdab69621e9ee1"),
  active("strava-webhook", "provider", false, "d19f5ec737b73802e15b6f4d527f13965287da361b1387d467e1a92608a51272"),
  active("sync-beta", "user", true, "e900a24c42f9480068d1371e580e808a28c1fd1b1214071592d7426c94183ecd"),
  active("sync-race-directory", "internal", false, "46a365262ecece6644f8a9467d51459a877518d2336a184aba0cff9850fa291a"),
  active("training-plan", "user", true, "01b12e6492d3f3f425d1d9d20be69910eff9e626e27fb0aef1a5c0fae7c1e8b0"),
  active("user-races", "user", true, "c827ed7b5e3da374a79c3f6e4efe7dcab4a4cc88ed5302787917630f48a9d215"),
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
  unknown("twin-engine", "7ae504e861032806e3f23cec1e0bb5090ec8f9075a8034c23354ae61f8911d57"),
  unknown("ultratracker", "42421ceb4fa6c554ad009df99ae87e9c7dbfac2a2bdf37cf696cbad6ccd373f7"),
  unknown("upload-race-course", "2634990ba81632a3292cd3680fc095695ddee75c9183d31d4f928e16cd880c4b"),
];

export const REQUIRED_MIGRATIONS = [
  "20260824135752",
  "20260824153216",
  "20260824162713",
  "20260824172420",
];

export const REQUIRED_SCHEMA_ASSUMPTIONS = [
  "profiles_security_invoker_and_scoped",
  "user_views_security_invoker_and_scoped",
  "analytics_views_service_only",
  "weekly_training_plans_owner_scoped",
  "privileged_rpcs_anon_revoked",
  "athlete_rpcs_owner_guarded",
  "internal_delivery_schema",
  "internal_job_rpcs_service_only",
  "internal_callers_use_dedicated_secret",
  "oauth_states_secure",
  "oauth_state_rpcs_service_only",
  "garmin_oauth_tokens_service_only",
  "runsignup_credentials_on_athletes",
  "profiles_credential_free",
];

const PROFILE_COLUMNS = [
  "id", "email", "full_name", "organization_name", "phone", "created_at", "updated_at",
];
const RUNSIGNUP_COLUMNS = [
  "runsignup_access_token", "runsignup_refresh_token", "runsignup_token_expires_at",
];
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
  ["on_activity_insert:public.activities", "notify-activity-insert"],
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
  if (!source.includes("--mode deploy")) errors.push("workflow must use the pre-deploy audit mode");
  if (!source.includes("npx --yes deno test")) errors.push("workflow is missing audit tests");
  return errors;
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

    if (mode === "deploy") {
      if (entry.classification === "expected-active" && entry.baselineBundleSha256 && deployed.bundle_sha256 !== entry.baselineBundleSha256) {
        errors.push(entry.slug + ": reviewed live baseline bundle hash mismatch");
      }
      if (entry.classification === "approved-retirement" && deployed.bundle_sha256 !== entry.archiveBundleSha256) {
        errors.push(entry.slug + ": live retirement bundle does not match recoverable archive");
      }
    } else if (entry.classification === "expected-active") {
      if (deployed.verify_jwt !== entry.verifyJwt) errors.push(entry.slug + ": deployed verify_jwt=" + deployed.verify_jwt + ", expected " + entry.verifyJwt);
      const localHash = repository.bundleHashes.get(entry.slug);
      if (!localHash || deployed.bundle_sha256 !== localHash) errors.push(entry.slug + ": deployed bundle does not match local deployable bundle");
    } else if (entry.classification === "approved-retirement" && mode === "pre") {
      if (deployed.bundle_sha256 !== entry.archiveBundleSha256) errors.push(entry.slug + ": pre-retirement live bundle does not match archive");
    }
    if (entry.classification === "approved-retirement" && deployed.verify_jwt !== entry.verifyJwt) {
      errors.push(entry.slug + ": retirement deployed verify_jwt=" + deployed.verify_jwt + ", expected reviewed flag " + entry.verifyJwt);
    }
  }

  const migrationVersions = new Set((inventory.migrations ?? []).map((entry) => entry.version));
  for (const version of REQUIRED_MIGRATIONS) if (!migrationVersions.has(version)) errors.push("schema blocker: migration " + version + " is not applied");

  const columns = inventory.schema?.columns ?? {};
  const profileColumns = new Set(columns["public.profiles"] ?? []);
  if (profileColumns.size !== PROFILE_COLUMNS.length || PROFILE_COLUMNS.some((column) => !profileColumns.has(column))) errors.push("schema blocker: public.profiles columns do not exactly match the credential-free contract");
  for (const column of RUNSIGNUP_COLUMNS) if (!(columns["public.athletes"] ?? []).includes(column)) errors.push("schema blocker: public.athletes is missing " + column);
  for (const column of OAUTH_COLUMNS) if (!(columns["private.oauth_states"] ?? []).includes(column)) errors.push("schema blocker: private.oauth_states is missing " + column);

  const assumptions = inventory.schema?.assumptions ?? {};
  const assumptionNames = new Set(Object.keys(assumptions));
  const requiredAssumptions = new Set(REQUIRED_SCHEMA_ASSUMPTIONS);
  errors.push(...setDifference(requiredAssumptions, assumptionNames).map((name) => "schema assumption missing: " + name));
  errors.push(...setDifference(assumptionNames, requiredAssumptions).map((name) => "unexpected schema assumption: " + name));
  for (const name of REQUIRED_SCHEMA_ASSUMPTIONS) if (assumptions[name] !== true) errors.push("schema assumption failed: " + name);

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

  errors.push(...comparePairs("cron inventory", (inventory.cronTargets ?? []).map((entry) => [entry.jobName, entry.target]), EXPECTED_CRON as Array<[string, string]>));
  errors.push(...comparePairs("trigger inventory", (inventory.triggerTargets ?? []).map((entry) => [entry.triggerName, entry.target]), EXPECTED_TRIGGERS as Array<[string, string]>));

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

const LIVE_INVENTORY_SQL = [
  "select 'migration'::text as kind, version::text as key, null::text as value, true as passed from supabase_migrations.schema_migrations",
  "union all select 'column', table_schema || '.' || table_name, column_name, true from information_schema.columns where (table_schema, table_name) in (('public','profiles'),('public','athletes'),('private','oauth_states'))",
  "union all select 'cron', coalesce(jobname, jobid::text), (regexp_match(command, '/functions/v1/([a-z0-9-]+)'))[1], true from cron.job where command ~ '/functions/v1/[a-z0-9-]+'",
  "union all select 'trigger', tg.tgname || ':' || n.nspname || '.' || c.relname, (regexp_match(pg_get_functiondef(p.oid), '/functions/v1/([a-z0-9-]+)'))[1], true from pg_trigger tg join pg_class c on c.oid=tg.tgrelid join pg_namespace n on n.oid=c.relnamespace join pg_proc p on p.oid=tg.tgfoid where not tg.tgisinternal and pg_get_functiondef(p.oid) ~ '/functions/v1/[a-z0-9-]+'",
  "union all select 'assumption','profiles_security_invoker_and_scoped',null, exists(select 1 from pg_class c where c.oid='public.profiles'::regclass and 'security_invoker=true'=any(coalesce(c.reloptions,array[]::text[]))) and not has_table_privilege('anon','public.profiles','select') and has_table_privilege('authenticated','public.profiles','select')",
  "union all select 'assumption','user_views_security_invoker_and_scoped',null, (select bool_and('security_invoker=true'=any(coalesce(c.reloptions,array[]::text[])) and not has_table_privilege('anon','public.'||c.relname,'select') and has_table_privilege('authenticated','public.'||c.relname,'select')) from pg_class c where c.oid in ('public.activity_summary'::regclass,'public.conversation_summaries'::regclass,'public.monthly_activity_stats'::regclass,'public.recent_journal_entries'::regclass))",
  "union all select 'assumption','analytics_views_service_only',null, (select bool_and(not has_table_privilege('anon','public.'||c.relname,'select') and not has_table_privilege('authenticated','public.'||c.relname,'select') and has_table_privilege('service_role','public.'||c.relname,'select')) from pg_class c where c.oid in ('public.analytics_activity_funnel'::regclass,'public.analytics_activity_hours'::regclass,'public.analytics_audio_coaching'::regclass,'public.analytics_daily_summary'::regclass,'public.analytics_user_engagement'::regclass))",
  "union all select 'assumption','weekly_training_plans_owner_scoped',null, not exists(select 1 from pg_policies where schemaname='public' and tablename='weekly_training_plans' and policyname='Authenticated read access') and exists(select 1 from pg_policies where schemaname='public' and tablename='weekly_training_plans' and policyname='Users can read own plans')",
  `union all select 'privileged_rpc',v.signature,json_build_object('exists',to_regprocedure(v.signature) is not null,'anon_execute',case when to_regprocedure(v.signature) is null then null else has_function_privilege('anon',v.signature,'execute') end,'authenticated_execute',case when to_regprocedure(v.signature) is null then null else has_function_privilege('authenticated',v.signature,'execute') end,'service_role_execute',case when to_regprocedure(v.signature) is null then null else has_function_privilege('service_role',v.signature,'execute') end)::text,true from (values ${PRIVILEGED_RPC_VALUES_SQL}) v(signature)`,
  `union all select 'assumption','privileged_rpcs_anon_revoked',null,coalesce((select bool_and(to_regprocedure(v.signature) is not null and not has_function_privilege('anon',v.signature,'execute')) from (values ${PRIVILEGED_RPC_VALUES_SQL}) v(signature)),false)`,
  "union all select 'assumption','athlete_rpcs_owner_guarded',null, exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname='current_user_owns_athlete')",
  "union all select 'assumption','internal_delivery_schema',null, (select count(*)=5 from information_schema.columns where table_schema='public' and table_name='alert_deliveries' and column_name in ('attempt_count','processing_started_at','claim_generation','lease_expires_at','idempotency_key'))",
  "union all select 'assumption','internal_job_rpcs_service_only',null, to_regprocedure('public.claim_pending_deliveries(integer)') is not null and not has_function_privilege('anon','public.claim_pending_deliveries(integer)','execute')",
  "union all select 'assumption','internal_callers_use_dedicated_secret',null, to_regprocedure('private.require_internal_job_secret()') is not null and (select count(*)=5 from cron.job where command like '%X-Runaway-Internal-Secret%')",
  "union all select 'assumption','oauth_states_secure',null, to_regclass('private.oauth_states') is not null and (select relrowsecurity from pg_class where oid='private.oauth_states'::regclass)",
  "union all select 'assumption','oauth_state_rpcs_service_only',null, to_regprocedure('public.create_oauth_state(text,text,uuid,bigint,text,timestamptz)') is not null and not has_function_privilege('anon','public.create_oauth_state(text,text,uuid,bigint,text,timestamptz)','execute')",
  "union all select 'assumption','garmin_oauth_tokens_service_only',null, not has_table_privilege('anon','public.garmin_oauth_tokens','select') and not has_table_privilege('authenticated','public.garmin_oauth_tokens','select')",
  "union all select 'assumption','runsignup_credentials_on_athletes',null, (select count(*)=3 from information_schema.columns where table_schema='public' and table_name='athletes' and column_name in ('runsignup_access_token','runsignup_refresh_token','runsignup_token_expires_at'))",
  "union all select 'assumption','profiles_credential_free',null, not exists(select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name in ('runsignup_access_token','runsignup_refresh_token','runsignup_token_expires_at'))",
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
  }
  return inventory;
}

function argument(name: string): string | undefined {
  const index = Deno.args.indexOf(name);
  return index >= 0 ? Deno.args[index + 1] : undefined;
}

async function main(): Promise<number> {
  const mode = (argument("--mode") ?? "deploy") as AuditMode;
  if (!["deploy", "pre", "post"].includes(mode)) throw new Error("invalid --mode");
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

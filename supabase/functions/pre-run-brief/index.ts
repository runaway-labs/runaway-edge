// Supabase Edge Function: pre-run-brief
// Generates 6-8 personalized coaching cues for an athlete's upcoming run.
// Cues are pre-generated (no mid-run network calls) and validated against
// a numeric whitelist to prevent hallucinated stats.
//
// See: PRD v1.1 §5.1 (FR-1, FR-2, FR-3) and §5.2 (FR-4 decisions).

import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import {
  ActivityRow,
  AIProfileRow,
  AthleteContext,
  AthleteRow,
  CoachingCue,
  GoalRow,
  OnboardingRow,
  PersonalBestRow,
  PreRunBriefRequest,
  PreRunBriefResponse,
  RestDayRow,
} from "./types.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const ANTHROPIC_MODEL = "claude-sonnet-4-5";
const MAX_CONTEXT_TOKENS_APPROX = 2000;
const MAX_OUTPUT_TOKENS = 2000;
const RECENT_ACTIVITIES_DAYS = 14;
const RECENT_ACTIVITIES_LIMIT = 30;
const REST_DAYS_LOOKBACK_DAYS = 7;
const VALIDATION_MAX_RETRIES = 1;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = (await req.json()) as PreRunBriefRequest;
    const validationError = validateRequest(body);
    if (validationError) {
      return errorResponse(400, "INVALID_REQUEST", validationError);
    }

    const supabase = createSupabaseAdmin();
    const context = await assembleAthleteContext(supabase, body.athlete_id);
    const result = await generateBrief(context, body);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("pre-run-brief error:", error);
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      error instanceof Error ? error.message : "unknown error",
    );
  }
});

// ---------- Request handling ----------

function validateRequest(body: PreRunBriefRequest): string | null {
  if (!body.athlete_id || typeof body.athlete_id !== "number") {
    return "athlete_id (number) is required";
  }
  if (
    body.planned_distance !== undefined &&
    (typeof body.planned_distance !== "number" || body.planned_distance <= 0)
  ) {
    return "planned_distance must be a positive number (miles)";
  }
  return null;
}

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function createSupabaseAdmin(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ---------- Context assembly ----------

async function assembleAthleteContext(
  supabase: SupabaseClient,
  athleteId: number,
): Promise<AthleteContext> {
  const recentCutoff = daysAgoIso(RECENT_ACTIVITIES_DAYS);
  const restCutoff = daysAgoIso(REST_DAYS_LOOKBACK_DAYS);

  const [
    athleteRes,
    activitiesRes,
    aiProfileRes,
    onboardingRes,
    goalsRes,
    restDaysRes,
    pbsRes,
  ] = await Promise.all([
    supabase
      .from("athletes")
      .select("id, first_name, last_name, garmin_fitness_stats, health_consent_status")
      .eq("id", athleteId)
      .maybeSingle(),
    supabase
      .from("activities")
      .select(
        "id, athlete_id, activity_date, distance, moving_time, average_speed, average_heart_rate, elevation_gain, perceived_exertion, training_load, activity_types(id, name)",
      )
      .eq("athlete_id", athleteId)
      .gte("activity_date", recentCutoff)
      .order("activity_date", { ascending: false })
      .limit(RECENT_ACTIVITIES_LIMIT),
    supabase
      .from("athlete_ai_profiles")
      .select("athlete_id, core_memory, preferences, version")
      .eq("athlete_id", athleteId)
      .maybeSingle(),
    supabase
      .from("athlete_onboarding")
      .select("athlete_id, coach_personality, experience_level")
      .eq("athlete_id", athleteId)
      .maybeSingle(),
    supabase
      .from("running_goals")
      .select("id, athlete_id, goal_type, target_value, deadline, current_progress")
      .eq("athlete_id", athleteId)
      .eq("is_active", true),
    supabase
      .from("rest_days")
      .select("date, recovery_benefit")
      .eq("athlete_id", athleteId)
      .gte("date", restCutoff)
      .order("date", { ascending: false }),
    supabase
      .from("athlete_personal_bests")
      .select("distance_label, time_seconds")
      .eq("athlete_id", athleteId),
  ]);

  const context: AthleteContext = {
    athlete: (athleteRes.data as AthleteRow | null) ?? null,
    recent_activities: (activitiesRes.data as ActivityRow[] | null) ?? [],
    ai_profile: (aiProfileRes.data as AIProfileRow | null) ?? null,
    onboarding: (onboardingRes.data as OnboardingRow | null) ?? null,
    goals: (goalsRes.data as GoalRow[] | null) ?? [],
    rest_days_recent: (restDaysRes.data as RestDayRow[] | null) ?? [],
    personal_bests: (pbsRes.data as PersonalBestRow[] | null) ?? [],
    numeric_whitelist: new Set<string>(),
  };

  buildNumericWhitelist(context);
  return context;
}

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

// Build the numeric whitelist for hallucination validation.
// Any number the model is allowed to reference must end up in this set.
function buildNumericWhitelist(context: AthleteContext): void {
  const wl = context.numeric_whitelist;

  // Always-allowed small numerics (counts, ordinals, mile markers up to 30).
  for (let i = 0; i <= 30; i++) wl.add(String(i));

  // Recent activity stats — pace, distance, HR.
  for (const a of context.recent_activities) {
    const km = a.distance / 1000;
    const miles = km * 0.621371;
    wl.add(miles.toFixed(1));
    wl.add(miles.toFixed(2));
    wl.add(km.toFixed(1));
    if (a.average_heart_rate) wl.add(String(Math.round(a.average_heart_rate)));
    const paceSecPerMile = a.average_speed > 0 ? 1609.34 / a.average_speed : 0;
    if (paceSecPerMile > 0) wl.add(formatPace(paceSecPerMile));
    if (a.elevation_gain) wl.add(String(Math.round(a.elevation_gain)));
  }

  // Goals.
  for (const g of context.goals) {
    if (g.target_value != null) wl.add(String(g.target_value));
    if (g.current_progress != null) wl.add(String(g.current_progress));
  }

  // Personal bests.
  for (const pb of context.personal_bests) {
    wl.add(formatTime(pb.time_seconds));
  }

  // Rest day count.
  wl.add(String(context.rest_days_recent.length));

  // Days since last run.
  const dsl = daysSinceLastRun(context.recent_activities);
  if (dsl !== null) wl.add(String(dsl));
}

function daysSinceLastRun(activities: ActivityRow[]): number | null {
  if (activities.length === 0) return null;
  const last = new Date(activities[0].activity_date);
  const ms = Date.now() - last.getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

function formatPace(secPerMile: number): string {
  const total = Math.round(secPerMile);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function formatTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------- Brief generation ----------

async function generateBrief(
  context: AthleteContext,
  request: PreRunBriefRequest,
): Promise<PreRunBriefResponse> {
  const systemPrompt = buildSystemPrompt(context);
  const userPrompt = buildUserPrompt(context, request);

  let cues: CoachingCue[] | null = null;
  let usedFallback = false;
  let retries = 0;

  for (let attempt = 0; attempt <= VALIDATION_MAX_RETRIES; attempt++) {
    const candidates = await callClaude(systemPrompt, userPrompt);
    const validation = validateCues(candidates, context);
    if (validation.ok) {
      cues = validation.cues;
      retries = attempt;
      break;
    }
    console.warn(
      `pre-run-brief validation failed (attempt ${attempt + 1}):`,
      validation.reason,
    );
    retries = attempt + 1;
  }

  if (!cues) {
    cues = buildFallbackCues(context, request);
    usedFallback = true;
  }

  return {
    cues,
    context_summary: {
      activities_count: context.recent_activities.length,
      has_ai_profile: context.ai_profile !== null,
      days_since_last_run: daysSinceLastRun(context.recent_activities),
      used_fallback: usedFallback,
      validation_retries: retries,
    },
    generated_at: new Date().toISOString(),
  };
}

function buildSystemPrompt(context: AthleteContext): string {
  const personality = context.onboarding?.coach_personality ?? "balanced";
  const experience = context.onboarding?.experience_level ?? "intermediate";
  const name = context.athlete?.first_name ?? "the athlete";

  return [
    "You are an expert running coach generating short audio coaching cues for an athlete's upcoming run.",
    "",
    "RULES:",
    "1. Generate 6-8 cues as a JSON array, no prose around it.",
    "2. Each cue is 1-2 short sentences, suitable for text-to-speech delivery during a run.",
    "3. Reference specific data points from the athlete context — but ONLY values listed in the ALLOWED_NUMBERS list. Never invent numbers.",
    "4. If a fact is not in the allowed list, do not state it numerically.",
    `5. Tone: ${personality}. Coaching language matches a ${experience} runner.`,
    "6. Cues must be timed via trigger_type and trigger_value (mile markers, time elapsed, HR zone changes, run_start, run_end).",
    "7. Output strictly valid JSON. No markdown fences, no commentary.",
    "",
    `Athlete name: ${name}.`,
  ].join("\n");
}

function buildUserPrompt(context: AthleteContext, request: PreRunBriefRequest): string {
  const allowedNumbers = Array.from(context.numeric_whitelist).slice(0, 200);
  const lines: string[] = [];

  lines.push("CONTEXT:");
  lines.push(`- Recent activities (last ${RECENT_ACTIVITIES_DAYS} days): ${context.recent_activities.length}`);

  const dsl = daysSinceLastRun(context.recent_activities);
  if (dsl !== null) lines.push(`- Days since last run: ${dsl}`);
  if (context.rest_days_recent.length > 0) {
    lines.push(`- Rest days in last ${REST_DAYS_LOOKBACK_DAYS} days: ${context.rest_days_recent.length}`);
  }

  if (context.recent_activities.length > 0) {
    lines.push("- Recent runs (most recent first):");
    for (const a of context.recent_activities.slice(0, 8)) {
      lines.push(`  - ${formatActivitySummary(a)}`);
    }
  }

  if (context.personal_bests.length > 0) {
    lines.push("- Personal bests:");
    for (const pb of context.personal_bests) {
      lines.push(`  - ${pb.distance_label}: ${formatTime(pb.time_seconds)}`);
    }
  }

  if (context.goals.length > 0) {
    lines.push("- Active goals:");
    for (const g of context.goals) {
      const target = g.target_value != null ? ` target ${g.target_value}` : "";
      const deadline = g.deadline ? ` by ${g.deadline}` : "";
      lines.push(`  - ${g.goal_type}${target}${deadline}`);
    }
  }

  if (request.planned_distance) {
    lines.push(`- Planned distance today: ${request.planned_distance} miles`);
  }

  lines.push("");
  lines.push("ALLOWED_NUMBERS (only reference these numerically):");
  lines.push(allowedNumbers.join(", "));
  lines.push("");
  lines.push("Generate the JSON array of 6-8 cues now.");

  return lines.join("\n");
}

function formatActivitySummary(a: ActivityRow): string {
  const date = new Date(a.activity_date).toISOString().slice(0, 10);
  const miles = ((a.distance / 1000) * 0.621371).toFixed(2);
  const paceSec = a.average_speed > 0 ? 1609.34 / a.average_speed : 0;
  const pace = paceSec > 0 ? `${formatPace(paceSec)}/mi` : "—";
  const hr = a.average_heart_rate ? `, ${Math.round(a.average_heart_rate)} bpm avg` : "";
  return `${date}: ${miles} mi @ ${pace}${hr}`;
}

// ---------- Claude API ----------

async function callClaude(systemPrompt: string, userPrompt: string): Promise<unknown[]> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text: string = data?.content?.[0]?.text ?? "";
  return parseCueJson(text);
}

function parseCueJson(text: string): unknown[] {
  // Strip ```json fences if the model adds them despite instruction.
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) {
    throw new Error("Claude response was not a JSON array");
  }
  return parsed;
}

// ---------- Validation ----------

interface ValidationResult {
  ok: boolean;
  cues: CoachingCue[];
  reason?: string;
}

// Match in order of specificity: pace/time formats (8:42, 1:23:45) first, then
// decimals (5.71), then bare integers. Order matters — without it, "5.5" would
// match as bare "5" and the validator would miss decimal hallucinations.
const NUMERIC_TOKEN_RE = /\b\d{1,3}(?::\d{2}){1,2}\b|\b\d+\.\d+\b|\b\d+\b/g;

function validateCues(candidates: unknown[], context: AthleteContext): ValidationResult {
  if (candidates.length < 4 || candidates.length > 10) {
    return { ok: false, cues: [], reason: `expected 4-10 cues, got ${candidates.length}` };
  }

  const validated: CoachingCue[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const shaped = shapeCue(candidates[i], i);
    if (!shaped) {
      return { ok: false, cues: [], reason: `cue ${i} shape invalid` };
    }
    const numericMiss = findHallucinatedNumber(shaped.script, shaped.trigger_value, context);
    if (numericMiss !== null) {
      return {
        ok: false,
        cues: [],
        reason: `cue ${i} references unknown number "${numericMiss}"`,
      };
    }
    validated.push(shaped);
  }
  return { ok: true, cues: validated };
}

function shapeCue(raw: unknown, index: number): CoachingCue | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const trigger_type = r.trigger_type as CoachingCue["trigger_type"];
  if (!isValidTriggerType(trigger_type)) return null;

  const script = typeof r.script === "string" ? r.script.trim() : "";
  if (script.length === 0 || script.length > 280) return null;

  const tone = isValidTone(r.tone) ? (r.tone as CoachingCue["tone"]) : "informational";
  const priority = isValidPriority(r.priority) ? (r.priority as CoachingCue["priority"]) : 3;

  const trigger_value = typeof r.trigger_value === "number" ? r.trigger_value : null;
  const conditions = shapeConditions(r.conditions);

  return {
    id: typeof r.id === "string" ? r.id : `cue-${index}-${crypto.randomUUID().slice(0, 8)}`,
    trigger_type,
    trigger_value,
    script,
    tone,
    priority,
    conditions,
  };
}

function shapeConditions(raw: unknown): CoachingCue["conditions"] {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    min_hr: typeof r.min_hr === "number" ? r.min_hr : null,
    max_hr: typeof r.max_hr === "number" ? r.max_hr : null,
    pace_delta_threshold:
      typeof r.pace_delta_threshold === "number" ? r.pace_delta_threshold : null,
  };
}

function isValidTriggerType(v: unknown): v is CoachingCue["trigger_type"] {
  return (
    v === "distance_mile" ||
    v === "time_elapsed" ||
    v === "hr_zone_change" ||
    v === "run_start" ||
    v === "run_end" ||
    v === "custom"
  );
}

function isValidTone(v: unknown): boolean {
  return v === "motivational" || v === "tactical" || v === "informational" || v === "warning";
}

function isValidPriority(v: unknown): boolean {
  return v === 1 || v === 2 || v === 3 || v === 4 || v === 5;
}

// Returns the offending number string, or null if every numeric token in
// `script` is in the whitelist. The cue's own trigger_value is always allowed
// (it appears naturally in time/distance announcements like "Two miles").
function findHallucinatedNumber(
  script: string,
  triggerValue: number | null,
  context: AthleteContext,
): string | null {
  const tokens = script.match(NUMERIC_TOKEN_RE) ?? [];
  for (const tok of tokens) {
    if (context.numeric_whitelist.has(tok)) continue;
    // Match decimal forms like "2.0" → "2" or "5.5" → "5.5"
    if (context.numeric_whitelist.has(tok.replace(/\.0+$/, ""))) continue;
    if (triggerValue !== null) {
      if (tok === String(triggerValue)) continue;
      if (tok === triggerValue.toFixed(1)) continue;
    }
    return tok;
  }
  return null;
}

// ---------- Fallback cues ----------

function buildFallbackCues(
  context: AthleteContext,
  request: PreRunBriefRequest,
): CoachingCue[] {
  const personality = context.onboarding?.coach_personality ?? "balanced";
  const planned = request.planned_distance ?? null;

  const cues: CoachingCue[] = [
    {
      id: `fallback-${crypto.randomUUID().slice(0, 8)}`,
      trigger_type: "run_start",
      trigger_value: null,
      script:
        personality === "gentle"
          ? "Take it easy on the first mile. Settle into your breath and let your body warm up."
          : "Start steady. Let the first mile come to you, then build.",
      tone: "motivational",
      priority: 1,
      conditions: { min_hr: null, max_hr: null, pace_delta_threshold: null },
    },
    {
      id: `fallback-${crypto.randomUUID().slice(0, 8)}`,
      trigger_type: "distance_mile",
      trigger_value: 1,
      script: "One mile in. Check your form — relax your shoulders, stay tall.",
      tone: "tactical",
      priority: 2,
      conditions: { min_hr: null, max_hr: null, pace_delta_threshold: null },
    },
    {
      id: `fallback-${crypto.randomUUID().slice(0, 8)}`,
      trigger_type: "time_elapsed",
      trigger_value: 600,
      script: "Ten minutes deep. Trust your training and stay smooth.",
      tone: "motivational",
      priority: 3,
      conditions: { min_hr: null, max_hr: null, pace_delta_threshold: null },
    },
    {
      id: `fallback-${crypto.randomUUID().slice(0, 8)}`,
      trigger_type: "distance_mile",
      trigger_value: planned ? Math.max(1, planned - 1) : 3,
      script: "You're in the back half now. Keep the turnover, hold your form.",
      tone: "tactical",
      priority: 2,
      conditions: { min_hr: null, max_hr: null, pace_delta_threshold: null },
    },
    {
      id: `fallback-${crypto.randomUUID().slice(0, 8)}`,
      trigger_type: "run_end",
      trigger_value: null,
      script: "Strong finish. Cool down, hydrate, and log how that felt.",
      tone: "motivational",
      priority: 1,
      conditions: { min_hr: null, max_hr: null, pace_delta_threshold: null },
    },
  ];

  return cues;
}

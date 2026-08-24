// Supabase Edge Function: backfill-training-zones
// Computes a 5-zone HR model from an athlete's activity history and writes
// it to the training_zones table. This is a parallel-track dependency for
// the audio coach feature (PRD v1.1 FR-8) — HR-zone coaching cannot fire
// until each athlete has populated training zones.
//
// Algorithm:
//   1. Find max HR observed in activities (last ~365 days), preferring
//      activities.max_heart_rate, falling back to garmin_fitness_stats max,
//      then to age-predicted 220-age, then to a sane default (190).
//   2. Apply USAT-style 5-zone percentages of max HR (50/60/70/80/90/100).
//   3. Upsert zone rows for zone_type='hr' (delete + insert per athlete).
//
// Athletes can override zones via the iOS settings UI later; this function
// only writes zones that don't already exist (or replaces them when the
// `force` flag is set).

import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const ZONE_PERCENTS: Array<[number, number, number]> = [
  [1, 0.50, 0.60],
  [2, 0.60, 0.70],
  [3, 0.70, 0.80],
  [4, 0.80, 0.90],
  [5, 0.90, 1.00],
];
const ZONE_TYPE_HR = "hr";
const DEFAULT_MAX_HR = 190;
const ACTIVITY_LOOKBACK_DAYS = 365;

interface BackfillRequest {
  athlete_id: number;
  age?: number; // optional override for age-predicted max HR
  force?: boolean; // overwrite existing zones
}

interface ZoneRow {
  athlete_id: number;
  zone_type: string;
  zone_number: number;
  min_value: number;
  max_value: number;
}

interface BackfillResponse {
  athlete_id: number;
  zones_written: number;
  max_hr_used: number;
  source: "observed_activity" | "garmin_fitness_stats" | "age_predicted" | "default";
  skipped_existing: boolean;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = (await req.json()) as BackfillRequest;
    const validationError = validateRequest(body);
    if (validationError) {
      return errorResponse(400, "INVALID_REQUEST", validationError);
    }

    const supabase = createSupabaseAdmin();
    const result = await backfillZones(supabase, body);
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("backfill-training-zones error:", error);
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      error instanceof Error ? error.message : "unknown error",
    );
  }
});

function validateRequest(body: BackfillRequest): string | null {
  if (!body.athlete_id || typeof body.athlete_id !== "number") {
    return "athlete_id (number) is required";
  }
  if (body.age !== undefined && (typeof body.age !== "number" || body.age <= 0 || body.age > 120)) {
    return "age must be 1-120 if provided";
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

async function backfillZones(
  supabase: SupabaseClient,
  request: BackfillRequest,
): Promise<BackfillResponse> {
  const force = request.force ?? false;

  if (!force) {
    const { data: existing } = await supabase
      .from("training_zones")
      .select("id")
      .eq("athlete_id", request.athlete_id)
      .eq("zone_type", ZONE_TYPE_HR)
      .limit(1);
    if (existing && existing.length > 0) {
      return {
        athlete_id: request.athlete_id,
        zones_written: 0,
        max_hr_used: 0,
        source: "default",
        skipped_existing: true,
      };
    }
  }

  const { maxHr, source } = await deriveMaxHr(supabase, request);
  const rows = buildZoneRows(request.athlete_id, maxHr);

  if (force) {
    await supabase
      .from("training_zones")
      .delete()
      .eq("athlete_id", request.athlete_id)
      .eq("zone_type", ZONE_TYPE_HR);
  }

  const { error: insertError } = await supabase.from("training_zones").insert(rows);
  if (insertError) {
    throw new Error(`Failed to insert zones: ${insertError.message}`);
  }

  return {
    athlete_id: request.athlete_id,
    zones_written: rows.length,
    max_hr_used: maxHr,
    source,
    skipped_existing: false,
  };
}

async function deriveMaxHr(
  supabase: SupabaseClient,
  request: BackfillRequest,
): Promise<{ maxHr: number; source: BackfillResponse["source"] }> {
  const cutoff = daysAgoIso(ACTIVITY_LOOKBACK_DAYS);

  const { data: activityMax } = await supabase
    .from("activities")
    .select("max_heart_rate")
    .eq("athlete_id", request.athlete_id)
    .gte("activity_date", cutoff)
    .not("max_heart_rate", "is", null)
    .order("max_heart_rate", { ascending: false })
    .limit(1);

  const observed = activityMax?.[0]?.max_heart_rate;
  if (typeof observed === "number" && observed > 100 && observed < 230) {
    return { maxHr: observed, source: "observed_activity" };
  }

  const { data: athlete } = await supabase
    .from("athletes")
    .select("garmin_fitness_stats")
    .eq("id", request.athlete_id)
    .maybeSingle();

  const garminMax = readGarminMaxHr(athlete?.garmin_fitness_stats);
  if (garminMax !== null) {
    return { maxHr: garminMax, source: "garmin_fitness_stats" };
  }

  if (request.age && request.age > 0) {
    return { maxHr: 220 - request.age, source: "age_predicted" };
  }

  return { maxHr: DEFAULT_MAX_HR, source: "default" };
}

function readGarminMaxHr(stats: unknown): number | null {
  if (!stats || typeof stats !== "object") return null;
  const s = stats as Record<string, unknown>;
  const candidate = s.max_heart_rate ?? s.maxHeartRate ?? s.max_hr;
  if (typeof candidate === "number" && candidate > 100 && candidate < 230) {
    return candidate;
  }
  return null;
}

function buildZoneRows(athleteId: number, maxHr: number): ZoneRow[] {
  return ZONE_PERCENTS.map(([zone, lo, hi]) => ({
    athlete_id: athleteId,
    zone_type: ZONE_TYPE_HR,
    zone_number: zone,
    min_value: Math.round(maxHr * lo),
    max_value: Math.round(maxHr * hi),
  }));
}

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

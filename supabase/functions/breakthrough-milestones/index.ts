// breakthrough-milestones: Detects quality breakthrough moments in an athlete's run history.
// Called internally (fire-and-forget) by notify-activity-insert after each new activity.
// No JWT verification needed — uses service-role key from caller.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPush } from "../_shared/apns.ts";
import { createBreakthroughMilestonesHandler } from "./handler.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Activity {
  id: number;
  name: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  average_speed: number;
  average_heartrate: number | null;
  suffer_score: number | null;
  elevation_gain: number;
  pr_count: number;
  activity_date: string;
  activity_types: { name: string } | null;
}

interface BreakthroughDetected {
  is_breakthrough: true;
  type: string;
  title: string;
  coach_message: string;
}

interface NoBreakthrough {
  is_breakthrough: false;
}

type ClaudeResult = BreakthroughDetected | NoBreakthrough;

const METERS_PER_MILE = 1609.34;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function paceSecPerMile(avgSpeed: number): number {
  return avgSpeed > 0 ? METERS_PER_MILE / avgSpeed : Infinity;
}

function formatPace(secPerMile: number): string {
  if (!isFinite(secPerMile)) return "N/A";
  const mins = Math.floor(secPerMile / 60);
  const secs = Math.round(secPerMile % 60);
  return `${mins}:${String(secs).padStart(2, "0")}/mi`;
}

async function fetchActivity(
  supabase: ReturnType<typeof createClient>,
  activityId: number,
): Promise<Activity | null> {
  const { data } = await supabase
    .from("activities")
    .select(
      "id, name, distance, moving_time, elapsed_time, average_speed, average_heartrate, suffer_score, elevation_gain, pr_count, activity_date, activity_types(name)",
    )
    .eq("id", activityId)
    .single();
  return data as Activity | null;
}

async function fetchRunHistory(
  supabase: ReturnType<typeof createClient>,
  athleteId: number,
  excludeId: number,
): Promise<Activity[]> {
  const { data } = await supabase
    .from("activities")
    .select(
      "id, name, distance, moving_time, elapsed_time, average_speed, average_heartrate, suffer_score, elevation_gain, pr_count, activity_date, activity_types(name)",
    )
    .eq("athlete_id", athleteId)
    .neq("id", excludeId)
    .order("activity_date", { ascending: true });
  return (data ?? []) as Activity[];
}

async function isAlreadyProcessed(
  supabase: ReturnType<typeof createClient>,
  activityId: number,
): Promise<boolean> {
  const { data } = await supabase
    .from("activity_insights")
    .select("activity_id")
    .eq("activity_id", activityId)
    .eq("insight_type", "breakthrough_milestone")
    .maybeSingle();
  return data !== null;
}

interface Signals {
  isLongestEver: boolean;
  maxPrevMiles: string;
  isFastestEver: boolean;
  prevFastestPace: string;
  isComeback: boolean;
  dayGap: number;
  finishRatio: string;
  isNoStops: boolean;
  timeDiff: number;
  avgPrevTimeDiff: string;
  crossedThreshold: number | null;
  isStrongFinish: boolean;
}

function computeSignals(current: Activity, history: Activity[]): Signals {
  const currentMiles = current.distance / METERS_PER_MILE;
  const prevMiles = history.map((a) => a.distance / METERS_PER_MILE);
  const maxPrevMiles = prevMiles.length > 0 ? Math.max(...prevMiles) : 0;
  const isLongestEver = history.length > 0 && currentMiles > maxPrevMiles + 0.25;

  const currentPace = paceSecPerMile(current.average_speed);
  const prevPaces = history
    .filter((a) => a.distance >= 3 * METERS_PER_MILE && a.average_speed > 0)
    .map((a) => paceSecPerMile(a.average_speed));
  const prevFastestPaceSec = prevPaces.length > 0 ? Math.min(...prevPaces) : Infinity;
  const isFastestEver =
    currentMiles >= 3 &&
    isFinite(currentPace) &&
    isFinite(prevFastestPaceSec) &&
    currentPace < prevFastestPaceSec;

  const sorted = [...history].sort(
    (a, b) => new Date(b.activity_date).getTime() - new Date(a.activity_date).getTime(),
  );
  const lastDate = sorted[0] ? new Date(sorted[0].activity_date) : null;
  const dayGap = lastDate
    ? (new Date(current.activity_date).getTime() - lastDate.getTime()) / 86400000
    : 0;
  const finishRatio =
    current.elapsed_time > 0 ? current.moving_time / current.elapsed_time : 0;
  const isComeback = dayGap >= 14 && finishRatio > 0.9;

  const timeDiff = current.elapsed_time - current.moving_time;
  const similar = history.filter((a) => {
    const mi = a.distance / METERS_PER_MILE;
    return mi >= currentMiles * 0.85 && mi <= currentMiles * 1.15;
  });
  const avgPrevTimeDiff =
    similar.length > 0
      ? similar.reduce((s, a) => s + (a.elapsed_time - a.moving_time), 0) / similar.length
      : null;
  const isNoStops =
    timeDiff < 60 && avgPrevTimeDiff !== null && timeDiff < avgPrevTimeDiff;

  const THRESHOLDS = [3.1, 6.2, 10, 13.1, 26.2];
  const crossedThreshold =
    THRESHOLDS.find(
      (t) => currentMiles >= t && !history.some((a) => a.distance / METERS_PER_MILE >= t),
    ) ?? null;

  const historyScores = history
    .filter((a) => a.suffer_score != null)
    .map((a) => a.suffer_score as number)
    .sort((a, b) => a - b);
  const top25Threshold =
    historyScores.length >= 4
      ? historyScores[Math.floor(historyScores.length * 0.75)]
      : null;
  const isStrongFinish =
    top25Threshold !== null &&
    (current.suffer_score ?? 0) >= top25Threshold &&
    (current.pr_count ?? 0) > 0;

  return {
    isLongestEver,
    maxPrevMiles: maxPrevMiles.toFixed(2),
    isFastestEver,
    prevFastestPace: formatPace(prevFastestPaceSec),
    isComeback,
    dayGap: Math.round(dayGap),
    finishRatio: finishRatio.toFixed(2),
    isNoStops,
    timeDiff,
    avgPrevTimeDiff: avgPrevTimeDiff != null ? avgPrevTimeDiff.toFixed(0) : "N/A",
    crossedThreshold: crossedThreshold ?? null,
    isStrongFinish,
  };
}

function formatHistoryLines(history: Activity[]): string {
  return history
    .slice(-50)
    .map((a) => {
      const mi = (a.distance / METERS_PER_MILE).toFixed(2);
      const pace = formatPace(paceSecPerMile(a.average_speed));
      const hr = a.average_heartrate ? `, HR ${Math.round(a.average_heartrate)}` : "";
      const pr = (a.pr_count ?? 0) > 0 ? `, ${a.pr_count} PR` : "";
      const type = a.activity_types?.name ?? "Run";
      return `${a.activity_date}: "${a.name}" — ${mi}mi @ ${pace}${hr}${pr} (${type})`;
    })
    .join("\n");
}

function buildPrompt(current: Activity, history: Activity[], signals: Signals): string {
  const mi = (current.distance / METERS_PER_MILE).toFixed(2);
  const pace = formatPace(paceSecPerMile(current.average_speed));
  const type = current.activity_types?.name ?? "Run";

  return `You are the Runaway coach. You've watched this athlete's entire running history. Decide if this run is a genuine breakthrough — a moment where something shifted. Not every run qualifies. Be selective. When you find one, name it and say something true about it in the coach's voice: direct, specific, no fluff, believes in them more than they believe in themselves.

TODAY'S RUN:
Name: "${current.name}" (${type})
Distance: ${mi} miles | Pace: ${pace}
Moving: ${Math.round(current.moving_time / 60)} min | Elapsed: ${Math.round(current.elapsed_time / 60)} min
HR: ${current.average_heartrate ?? "N/A"} | Suffer: ${current.suffer_score ?? "N/A"} | PRs: ${current.pr_count ?? 0}
Date: ${current.activity_date}

PRE-COMPUTED SIGNALS (verified against full history — trust these):
- longest_ever: ${signals.isLongestEver} (prev max: ${signals.maxPrevMiles}mi)
- fastest_ever (3+ mi): ${signals.isFastestEver} (prev fastest: ${signals.prevFastestPace})
- comeback (14+ day gap): ${signals.isComeback} (gap: ${signals.dayGap} days, finish ratio: ${signals.finishRatio})
- no_stops (elapsed−moving < 60s): ${signals.isNoStops} (diff: ${signals.timeDiff}s, prev similar avg: ${signals.avgPrevTimeDiff}s)
- distance_threshold crossed: ${signals.crossedThreshold ?? "none"}
- strong_finish (top 25% suffer + PR): ${signals.isStrongFinish}

HISTORY (oldest → newest, last 50 runs):
${formatHistoryLines(history)}

RULES:
- Pick at most ONE type. Multiple true signals? Pick the most significant.
- Only declare a breakthrough if the signal is true AND it feels like a real shift.
- coach_message: under 3 sentences, specific to the numbers, no generic praise.
- If nothing genuinely qualifies, return { "is_breakthrough": false }.

Respond ONLY with JSON — no explanation, no markdown:
{ "is_breakthrough": true, "type": "longest_ever", "title": "Furthest You've Ever Gone", "coach_message": "..." }
OR
{ "is_breakthrough": false }`;
}

async function callClaude(
  current: Activity,
  history: Activity[],
  signals: Signals,
): Promise<ClaudeResult> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 400,
      messages: [{ role: "user", content: buildPrompt(current, history, signals) }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API error: ${res.status}`);

  const data = await res.json();
  let text = (data.content[0].text as string).trim();
  if (text.includes("```")) {
    text = text.split("```")[1].replace("json", "").trim().split("```")[0].trim();
  }

  try {
    return JSON.parse(text) as ClaudeResult;
  } catch {
    return { is_breakthrough: false };
  }
}

async function saveBreakthrough(
  supabase: ReturnType<typeof createClient>,
  activityId: number,
  activityDate: string,
  result: BreakthroughDetected,
): Promise<void> {
  await supabase.from("activity_insights").upsert(
    {
      activity_id: activityId,
      insight_type: "breakthrough_milestone",
      insight_data: {
        type: result.type,
        title: result.title,
        coach_message: result.coach_message,
        detected_at: new Date().toISOString(),
        activity_date: activityDate,
      },
    },
    { onConflict: "activity_id,insight_type" },
  );
}

async function sendBreakthroughPush(
  supabase: ReturnType<typeof createClient>,
  athleteId: number,
  activityId: number,
  result: BreakthroughDetected,
): Promise<void> {
  const { data: athlete } = await supabase
    .from("athletes")
    .select("apns_token")
    .eq("id", athleteId)
    .single();

  if (!athlete?.apns_token) return;

  await sendPush(athlete.apns_token, {
    title: result.title,
    body: result.coach_message,
    data: {
      sync_type: "breakthrough",
      activity_id: String(activityId),
      milestone_type: result.type,
    },
  });
}

export const handler = createBreakthroughMilestonesHandler(async (req) => {
  try {
    const body = await req.json() as { athlete_id?: number; activity_id?: number };
    const { athlete_id, activity_id } = body;

    if (!athlete_id || !activity_id) {
      return jsonResponse({ error: "athlete_id and activity_id are required" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    if (await isAlreadyProcessed(supabase, activity_id)) {
      return jsonResponse({ processed: true, breakthrough: false });
    }

    const activity = await fetchActivity(supabase, activity_id);
    if (!activity) return jsonResponse({ error: "Activity not found" }, 404);

    const history = await fetchRunHistory(supabase, athlete_id, activity_id);
    const signals = computeSignals(activity, history);
    const result = await callClaude(activity, history, signals);

    if (!result.is_breakthrough) {
      return jsonResponse({ processed: true, breakthrough: false });
    }

    await saveBreakthrough(supabase, activity_id, activity.activity_date, result);
    await sendBreakthroughPush(supabase, athlete_id, activity_id, result);

    return jsonResponse({ processed: true, breakthrough: true, type: result.type });
  } catch (err) {
    console.error("breakthrough-milestones error:", err);
    return jsonResponse(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}, { headers: corsHeaders });

if (import.meta.main) {
  Deno.serve(handler);
}

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

type BreakthroughResult = BreakthroughDetected | NoBreakthrough;

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

function detectBreakthrough(current: Activity, signals: Signals): BreakthroughResult {
  const miles = (current.distance / METERS_PER_MILE).toFixed(2);
  if (signals.isLongestEver) return { is_breakthrough: true, type: "longest_ever", title: "Furthest You Have Gone", coach_message: miles + " miles moved your distance ceiling beyond " + signals.maxPrevMiles + "." };
  if (signals.isFastestEver) return { is_breakthrough: true, type: "fastest_ever", title: "A New Pace Standard", coach_message: formatPace(paceSecPerMile(current.average_speed)) + " is your fastest recorded pace over at least three miles." };
  if (signals.crossedThreshold) return { is_breakthrough: true, type: "distance_threshold", title: "New Distance Territory", coach_message: "You crossed " + signals.crossedThreshold + " miles for the first time." };
  if (signals.isComeback) return { is_breakthrough: true, type: "comeback", title: "The Return", coach_message: "You returned after " + signals.dayGap + " days away and completed the session." };
  if (signals.isNoStops) return { is_breakthrough: true, type: "no_stops", title: "Continuous Start to Finish", coach_message: "Only " + signals.timeDiff + " seconds separated elapsed and moving time." };
  if (signals.isStrongFinish) return { is_breakthrough: true, type: "strong_finish", title: "Pressure Produced Progress", coach_message: "A high-effort run produced " + current.pr_count + " personal record(s)." };
  return { is_breakthrough: false };
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
    const result = detectBreakthrough(activity, signals);

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

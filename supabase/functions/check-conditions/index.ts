// Pre-Race Alerts MVP: Check Conditions Edge Function
// Monitors weather/AQI for races in next 48h and triggers automatic alerts

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { corsHeaders, handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { getCurrentWeather } from "../_shared/weather-api.ts";
import { getCurrentAqi } from "../_shared/aqi-api.ts";
import {
  internalAuthErrorResponse,
  requireInternal,
} from "../_shared/require-internal.ts";
import {
  evaluateAllThresholds,
  getTriggeredThresholds,
  generateAlertMessage,
} from "../_shared/threshold-evaluator.ts";
import {
  Race,
  AlertThreshold,
  WeatherConditions,
  Runner,
  AlertDelivery,
} from "../_shared/types.ts";

// Cooldown period to prevent alert spam (1 hour)
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    requireInternal(req);
  } catch (error) {
    return internalAuthErrorResponse(error, corsHeaders);
  }

  try {
    const supabase = getSupabaseAdmin();

    // Get races happening in the next 48 hours with active status
    const now = new Date();
    const in48Hours = new Date(now.getTime() + 48 * 60 * 60 * 1000);

    const { data: races, error: racesError } = await supabase
      .from("races")
      .select("*")
      .eq("status", "upcoming")
      .gte("race_date", now.toISOString().split("T")[0])
      .lte("race_date", in48Hours.toISOString().split("T")[0]);

    if (racesError) {
      console.error("Error fetching races:", racesError);
      return errorResponse("Failed to fetch races", 500);
    }

    if (!races || races.length === 0) {
      return jsonResponse({
        success: true,
        message: "No upcoming races in next 48 hours",
        races_checked: 0,
      });
    }

    console.log(`Checking conditions for ${races.length} upcoming races`);

    const results = {
      races_checked: races.length,
      alerts_triggered: 0,
      condition_checks: 0,
      errors: [] as string[],
    };

    // Process each race
    for (const race of races as Race[]) {
      try {
        await processRace(supabase, race, results);
      } catch (error) {
        console.error(`Error processing race ${race.id}:`, error);
        results.errors.push(`Race ${race.name}: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }

    return jsonResponse({
      success: true,
      ...results,
      errors: results.errors.length > 0 ? results.errors : undefined,
    });
  } catch (error) {
    console.error("Error in check-conditions:", error);
    return errorResponse(
      error instanceof Error ? error.message : "Internal server error",
      500
    );
  }
});

async function processRace(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  race: Race,
  results: { alerts_triggered: number; condition_checks: number; errors: string[] }
) {
  // Fetch active thresholds for this race
  const { data: thresholds, error: thresholdsError } = await supabase
    .from("alert_thresholds")
    .select("*")
    .eq("race_id", race.id)
    .eq("is_active", true);

  if (thresholdsError) {
    throw new Error(`Failed to fetch thresholds: ${thresholdsError.message}`);
  }

  if (!thresholds || thresholds.length === 0) {
    console.log(`Race ${race.name}: No active thresholds configured`);
    return;
  }

  // Fetch weather and AQI data
  const [weatherData, aqiData] = await Promise.all([
    getCurrentWeather(race.latitude, race.longitude),
    getCurrentAqi(race.latitude, race.longitude),
  ]);

  if (!weatherData) {
    results.errors.push(`Race ${race.name}: Failed to fetch weather data`);
    return;
  }

  // Combine conditions (use 0 for AQI if unavailable)
  const conditions: WeatherConditions = {
    temperature: weatherData.temperature,
    aqi: aqiData?.aqi ?? 0,
    wind_speed: weatherData.wind_speed,
    precipitation_chance: weatherData.precipitation_chance,
    fetched_at: new Date().toISOString(),
  };

  // Evaluate thresholds
  const evaluationResults = evaluateAllThresholds(thresholds as AlertThreshold[], conditions);
  const triggeredResults = getTriggeredThresholds(thresholds as AlertThreshold[], conditions);

  // Log condition check
  const { error: checkError } = await supabase.from("condition_checks").insert({
    race_id: race.id,
    weather_data: weatherData,
    aqi_data: aqiData,
    thresholds_evaluated: thresholds,
    thresholds_triggered: triggeredResults.map((r) => r.threshold),
    alert_created: false,
  });

  if (checkError) {
    console.error(`Error logging condition check for race ${race.id}:`, checkError);
  }

  results.condition_checks++;

  // Check if any thresholds were triggered
  if (triggeredResults.length === 0) {
    console.log(`Race ${race.name}: No thresholds triggered`);
    return;
  }

  console.log(`Race ${race.name}: ${triggeredResults.length} threshold(s) triggered`);

  // Check cooldown - don't send another automatic alert within 1 hour
  const cooldownTime = new Date(Date.now() - ALERT_COOLDOWN_MS).toISOString();

  const { data: recentAlerts, error: recentError } = await supabase
    .from("alerts")
    .select("id")
    .eq("race_id", race.id)
    .eq("alert_type", "automatic")
    .gte("created_at", cooldownTime)
    .limit(1);

  if (recentError) {
    console.error(`Error checking recent alerts for race ${race.id}:`, recentError);
  }

  if (recentAlerts && recentAlerts.length > 0) {
    console.log(`Race ${race.name}: Skipping alert due to cooldown`);
    return;
  }

  // Generate alert message
  const { subject, message } = generateAlertMessage(triggeredResults, conditions);

  // Create alert
  const { data: alert, error: alertError } = await supabase
    .from("alerts")
    .insert({
      race_id: race.id,
      alert_type: "automatic",
      triggered_by_threshold_id: triggeredResults[0].threshold.id,
      subject,
      message,
      conditions_snapshot: conditions,
    })
    .select("id")
    .single();

  if (alertError || !alert) {
    throw new Error(`Failed to create alert: ${alertError?.message}`);
  }

  // Update the condition check with alert reference
  await supabase
    .from("condition_checks")
    .update({ alert_created: true, alert_id: alert.id })
    .eq("race_id", race.id)
    .order("created_at", { ascending: false })
    .limit(1);

  // Fetch runners for this race
  const { data: runners, error: runnersError } = await supabase
    .from("runners")
    .select("id, name, email, phone, notification_preferences")
    .eq("race_id", race.id);

  if (runnersError) {
    throw new Error(`Failed to fetch runners: ${runnersError.message}`);
  }

  if (!runners || runners.length === 0) {
    console.log(`Race ${race.name}: No runners to notify`);
    results.alerts_triggered++;
    return;
  }

  // Queue deliveries
  const deliveries = createDeliveries(alert.id, runners as Runner[]);

  if (deliveries.length > 0) {
    const { error: deliveryError } = await supabase
      .from("alert_deliveries")
      .insert(deliveries);

    if (deliveryError) {
      console.error(`Error creating deliveries for race ${race.id}:`, deliveryError);
    }
  }

  console.log(`Race ${race.name}: Alert created, ${deliveries.length} deliveries queued`);
  results.alerts_triggered++;
}

// Create delivery records for all runners
function createDeliveries(
  alertId: string,
  runners: Runner[]
): Omit<AlertDelivery, "id" | "created_at" | "updated_at" | "sent_at" | "provider_message_id" | "error_message" | "idempotency_key" | "attempt_count" | "processing_started_at">[] {
  const deliveries: Omit<AlertDelivery, "id" | "created_at" | "updated_at" | "sent_at" | "provider_message_id" | "error_message" | "idempotency_key" | "attempt_count" | "processing_started_at">[] = [];

  for (const runner of runners) {
    const prefs = runner.notification_preferences;

    if (prefs.sms && runner.phone) {
      deliveries.push({
        alert_id: alertId,
        runner_id: runner.id,
        channel: "sms",
        recipient: runner.phone,
        status: "pending",
      });
    }

    if (prefs.email && runner.email) {
      deliveries.push({
        alert_id: alertId,
        runner_id: runner.id,
        channel: "email",
        recipient: runner.email,
        status: "pending",
      });
    }
  }

  return deliveries;
}

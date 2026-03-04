// Pre-Race Alerts MVP: Send Alert Edge Function
// Race director sends manual alert to all runners

import { getSupabaseAdmin, getUserFromAuth } from "../_shared/supabase-client.ts";
import { handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { SendAlertRequest, SendAlertResponse, Runner, Alert, AlertDelivery } from "../_shared/types.ts";

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  // Only accept POST requests
  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    // Verify authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return errorResponse("Missing authorization header", 401);
    }

    const user = await getUserFromAuth(authHeader);
    if (!user) {
      return errorResponse("Invalid or expired token", 401);
    }

    // Parse request body
    const body: SendAlertRequest = await req.json();

    if (!body.race_id || !body.subject || !body.message) {
      return errorResponse("Missing required fields: race_id, subject, message");
    }

    // Validate message length
    if (body.subject.length > 100) {
      return errorResponse("Subject must be 100 characters or less");
    }

    if (body.message.length > 1000) {
      return errorResponse("Message must be 1000 characters or less");
    }

    const supabase = getSupabaseAdmin();

    // Verify the user owns this race
    const { data: race, error: raceError } = await supabase
      .from("races")
      .select("id, name, race_date, director_id")
      .eq("id", body.race_id)
      .single();

    if (raceError || !race) {
      return errorResponse("Race not found", 404);
    }

    if (race.director_id !== user.id) {
      return errorResponse("Not authorized to send alerts for this race", 403);
    }

    // Get all runners for this race
    const { data: runners, error: runnersError } = await supabase
      .from("runners")
      .select("id, name, email, phone, notification_preferences")
      .eq("race_id", body.race_id);

    if (runnersError) {
      console.error("Error fetching runners:", runnersError);
      return errorResponse("Failed to fetch runners", 500);
    }

    if (!runners || runners.length === 0) {
      return errorResponse("No runners found for this race. Import runners first.");
    }

    // Create the alert record
    const { data: alert, error: alertError } = await supabase
      .from("alerts")
      .insert({
        race_id: body.race_id,
        alert_type: "manual",
        subject: body.subject,
        message: body.message,
      })
      .select("id")
      .single();

    if (alertError || !alert) {
      console.error("Error creating alert:", alertError);
      return errorResponse("Failed to create alert", 500);
    }

    // Queue deliveries for all runners
    const deliveries = createDeliveries(alert.id, runners as Runner[]);

    if (deliveries.length === 0) {
      // No deliveries to queue (all runners have disabled notifications)
      // Still return success since alert was created
      const response: SendAlertResponse = {
        success: true,
        alert_id: alert.id,
        deliveries_queued: 0,
      };
      return jsonResponse(response);
    }

    // Bulk insert deliveries
    const { error: deliveryError } = await supabase
      .from("alert_deliveries")
      .insert(deliveries);

    if (deliveryError) {
      console.error("Error creating deliveries:", deliveryError);
      // Alert was created, but deliveries failed
      return errorResponse("Alert created but failed to queue deliveries", 500);
    }

    const response: SendAlertResponse = {
      success: true,
      alert_id: alert.id,
      deliveries_queued: deliveries.length,
    };

    return jsonResponse(response);
  } catch (error) {
    console.error("Error in send-alert:", error);
    return errorResponse(
      error instanceof Error ? error.message : "Internal server error",
      500
    );
  }
});

// Create delivery records for all runners based on their notification preferences
function createDeliveries(
  alertId: string,
  runners: Runner[]
): Omit<AlertDelivery, "id" | "created_at" | "updated_at" | "sent_at" | "provider_message_id" | "error_message">[] {
  const deliveries: Omit<AlertDelivery, "id" | "created_at" | "updated_at" | "sent_at" | "provider_message_id" | "error_message">[] = [];

  for (const runner of runners) {
    const prefs = runner.notification_preferences;

    // Create SMS delivery if enabled and phone exists
    if (prefs.sms && runner.phone) {
      deliveries.push({
        alert_id: alertId,
        runner_id: runner.id,
        channel: "sms",
        recipient: runner.phone,
        status: "pending",
      });
    }

    // Create email delivery if enabled and email exists
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

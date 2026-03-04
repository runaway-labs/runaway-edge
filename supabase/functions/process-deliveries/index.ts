// Pre-Race Alerts MVP: Process Deliveries Edge Function
// Picks up pending SMS/email notifications and sends them

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { sendSms, formatAlertSms } from "../_shared/twilio.ts";
import { sendEmail, formatAlertEmail } from "../_shared/resend.ts";
import { AlertDelivery, Alert, Race, DeliveryResult } from "../_shared/types.ts";

// Process up to this many deliveries per invocation
const BATCH_SIZE = 50;

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const supabase = getSupabaseAdmin();

    // Fetch pending deliveries with alert and race info
    const { data: deliveries, error: fetchError } = await supabase
      .from("alert_deliveries")
      .select(`
        id,
        alert_id,
        runner_id,
        channel,
        recipient,
        status,
        alerts!inner (
          id,
          subject,
          message,
          race_id,
          races!inner (
            id,
            name,
            race_date
          )
        )
      `)
      .eq("status", "pending")
      .limit(BATCH_SIZE);

    if (fetchError) {
      console.error("Error fetching deliveries:", fetchError);
      return errorResponse("Failed to fetch pending deliveries", 500);
    }

    if (!deliveries || deliveries.length === 0) {
      return jsonResponse({
        success: true,
        processed: 0,
        message: "No pending deliveries",
      });
    }

    console.log(`Processing ${deliveries.length} pending deliveries`);

    // Process each delivery
    const results = {
      sent: 0,
      failed: 0,
      errors: [] as string[],
    };

    for (const delivery of deliveries) {
      // Type assertion for nested data
      const alert = delivery.alerts as unknown as Alert & { races: Race };
      const race = alert.races;

      let result: DeliveryResult;

      if (delivery.channel === "sms") {
        // Send SMS
        const smsBody = formatAlertSms(race.name, alert.subject, alert.message);
        result = await sendSms(delivery.recipient, smsBody);
      } else {
        // Send email
        const { subject, body } = formatAlertEmail(
          race.name,
          race.race_date,
          alert.subject,
          alert.message
        );
        result = await sendEmail(delivery.recipient, subject, body);
      }

      // Update delivery status
      const updateData: Partial<AlertDelivery> = {
        status: result.success ? "sent" : "failed",
        sent_at: result.success ? new Date().toISOString() : null,
        provider_message_id: result.provider_message_id ?? null,
        error_message: result.error ?? null,
      };

      const { error: updateError } = await supabase
        .from("alert_deliveries")
        .update(updateData)
        .eq("id", delivery.id);

      if (updateError) {
        console.error(`Error updating delivery ${delivery.id}:`, updateError);
      }

      if (result.success) {
        results.sent++;
      } else {
        results.failed++;
        results.errors.push(`${delivery.channel} to ${delivery.recipient}: ${result.error}`);
      }
    }

    console.log(`Processed: ${results.sent} sent, ${results.failed} failed`);

    return jsonResponse({
      success: true,
      processed: deliveries.length,
      sent: results.sent,
      failed: results.failed,
      errors: results.errors.length > 0 ? results.errors : undefined,
    });
  } catch (error) {
    console.error("Error in process-deliveries:", error);
    return errorResponse(
      error instanceof Error ? error.message : "Internal server error",
      500
    );
  }
});

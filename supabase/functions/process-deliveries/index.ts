// Pre-Race Alerts MVP: Process Deliveries Edge Function
// Picks up pending SMS/email notifications and sends them

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { corsHeaders, handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { sendSms, formatAlertSms } from "../_shared/twilio.ts";
import { sendEmail, formatAlertEmail } from "../_shared/resend.ts";
import { AlertDelivery, Alert, Race, DeliveryResult } from "../_shared/types.ts";
import {
  internalAuthErrorResponse,
  requireInternal,
} from "../_shared/require-internal.ts";

// Process up to this many deliveries per invocation
const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 3;

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

    const { data: deliveries, error: fetchError } = await supabase.rpc(
      "claim_pending_deliveries",
      { batch_size: BATCH_SIZE },
    );

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

    console.log(`Processing ${deliveries.length} claimed deliveries`);

    const alertIds = [...new Set(deliveries.map((delivery) => delivery.alert_id))];
    const { data: alerts, error: alertsError } = await supabase
      .from("alerts")
      .select(`
        id,
        subject,
        message,
        race_id,
        races!inner (
          id,
          name,
          race_date
        )
      `)
      .in("id", alertIds);

    if (alertsError) {
      console.error("Error fetching claimed delivery context:", alertsError);
    }

    const alertsById = new Map(
      (alerts ?? []).map((alert) => [alert.id, alert as unknown as Alert & { races: Race }]),
    );

    // Process each delivery
    const results = {
      sent: 0,
      retryable: 0,
      failed: 0,
      errors: [] as string[],
    };

    for (const delivery of deliveries) {
      const alert = alertsById.get(delivery.alert_id);
      const race = alert?.races;

      let result: DeliveryResult;

      if (!alert || !race) {
        result = {
          success: false,
          error: "Delivery context unavailable",
          retryable: true,
        };
      } else if (delivery.channel === "sms") {
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
        result = await sendEmail(
          delivery.recipient,
          subject,
          body,
          delivery.idempotency_key,
        );
      }

      const canRetry =
        delivery.channel === "email" &&
        result.retryable !== false &&
        delivery.attempt_count < MAX_ATTEMPTS;
      const nextStatus = result.success ? "sent" : canRetry ? "retryable" : "failed";

      const updateData: Partial<AlertDelivery> = {
        status: nextStatus,
        sent_at: result.success ? new Date().toISOString() : null,
        provider_message_id: result.provider_message_id ?? null,
        error_message: result.error ?? null,
        processing_started_at: null,
      };

      const { error: updateError } = await supabase
        .from("alert_deliveries")
        .update(updateData)
        .eq("id", delivery.id)
        .eq("status", "processing");

      if (updateError) {
        console.error(`Error updating delivery ${delivery.id}:`, updateError);
      }

      if (result.success) {
        results.sent++;
      } else if (canRetry) {
        results.retryable++;
        results.errors.push(`${delivery.channel} delivery ${delivery.id}: ${result.error}`);
      } else {
        results.failed++;
        results.errors.push(`${delivery.channel} delivery ${delivery.id}: ${result.error}`);
      }
    }

    console.log(
      `Processed: ${results.sent} sent, ${results.retryable} retryable, ${results.failed} failed`,
    );

    return jsonResponse({
      success: true,
      processed: deliveries.length,
      sent: results.sent,
      retryable: results.retryable,
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

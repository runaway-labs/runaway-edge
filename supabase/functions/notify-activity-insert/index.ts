// notify-activity-insert: Database webhook — fires when a new activity is inserted.
// Sends an APNs push notification to the athlete's device.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPush } from "../_shared/apns.ts";
import { createNotifyActivityInsertHandler } from "./handler.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export const handler = createNotifyActivityInsertHandler(async (req) => {
  try {
    const payload = await req.json();
    const { record } = payload;

    if (!record) {
      return new Response(JSON.stringify({ error: "No record in payload" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`🏃 New activity: ${record.id}, athlete: ${record.athlete_id}`);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: athlete, error } = await supabase
      .from("athletes")
      .select("apns_token")
      .eq("id", record.athlete_id)
      .single();

    if (error) {
      console.error("❌ Error fetching athlete:", error);
      return new Response(JSON.stringify({ error: "Failed to fetch athlete" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!athlete?.apns_token) {
      console.log("⚠️ No APNs token for athlete:", record.athlete_id);
      return new Response(JSON.stringify({ message: "No APNs token for athlete" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const activityName = record.name || record.type || "Activity";
    const distanceMi = record.distance
      ? `${(record.distance * 0.000621371).toFixed(2)} miles`
      : null;
    const body = distanceMi
      ? `${activityName} · ${distanceMi} synced`
      : `${activityName} synced`;

    await sendPush(athlete.apns_token, {
      title: "Activity Synced",
      body,
      data: {
        sync_type: "new_activity",
        activity_id: String(record.id),
      },
    });

    console.log("✅ APNs notification sent");

    // Fire-and-forget: check for breakthrough milestones without blocking response
    const breakthroughUrl =
      `${Deno.env.get("SUPABASE_URL")}/functions/v1/breakthrough-milestones`;
    fetch(breakthroughUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Runaway-Internal-Secret": Deno.env.get("INTERNAL_JOB_SECRET")!,
      },
      body: JSON.stringify({ athlete_id: record.athlete_id, activity_id: record.id }),
    }).catch((err) => console.error("❌ Breakthrough trigger failed:", err));

    return new Response(JSON.stringify({ success: true, body }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("❌ Error:", err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}, { headers: corsHeaders });

if (import.meta.main) {
  Deno.serve(handler);
}

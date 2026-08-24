import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { athlete_id } = await req.json();
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 1. Fetch Data
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const dateStr = thirtyDaysAgo.toISOString().split('T')[0];

    const { data: activities } = await supabase
      .from("activities")
      .select("distance, moving_time, average_heart_rate, activity_date, relative_effort")
      .eq("athlete_id", athlete_id)
      .gte("activity_date", dateStr);

    const { data: biometrics } = await supabase
      .from("athlete_biometrics")
      .select("*")
      .eq("athlete_id", athlete_id)
      .gte("entry_date", dateStr)
      .order("entry_date", { ascending: false });

    // 2. Logic: Calculate Load
    // Relative Effort is our proxy for TSS here
    const getLoad = (days: number) => {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      return activities?.filter(a => new Date(a.activity_date) >= cutoff)
        .reduce((sum, a) => sum + (a.relative_effort || 0), 0) || 0;
    };

    const acuteLoad = getLoad(7);
    const chronicLoad = getLoad(28) / 4;
    const acwr = chronicLoad > 0 ? acuteLoad / chronicLoad : 1.0;

    // 3. Logic: Biometric Recovery
    const latestBiometric = biometrics?.[0];
    const avgHrv = biometrics?.reduce((sum, b) => sum + (Number(b.hrv_ms) || 0), 0) / (biometrics?.length || 1);
    const hrvTrend = latestBiometric?.hrv_ms && avgHrv > 0 ? (Number(latestBiometric.hrv_ms) / avgHrv) : 1.0;

    // 4. Twin Insights Generation
    let status = "stable";
    let message = "The Twin is observing your trajectory.";
    let action = "Maintain current momentum.";

    if (acwr > 1.3) {
      status = "overreaching";
      message = "You are flirting with the edge. Your load is 30% higher than your 4-week average.";
      action = "Consider a micro-commitment of 20 mins easy today.";
    } else if (hrvTrend < 0.9) {
      status = "strained";
      message = "Your heart rate variability is dropping. Your body is working harder to maintain homeostasis.";
      action = "Priority: High-quality sleep. Cut the intensity tomorrow.";
    } else if (acwr > 1.1 && hrvTrend > 1.05) {
      status = "productive";
      message = "Perfect absorption. You're increasing load and your recovery is keeping pace.";
      action = "Green light for the long run.";
    }

    return new Response(JSON.stringify({
      acwr: Math.round(acwr * 100) / 100,
      hrv_trend: Math.round(hrvTrend * 100) / 100,
      readiness: latestBiometric?.readiness_score || 70,
      twin_status: status,
      insight: {
        message,
        action
      }
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
});

import { handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";

Deno.serve(async (req: Request) => {
  const corsRes = handleCors(req);
  if (corsRes) return corsRes;

  try {
    if (req.method !== "POST") return errorResponse("Method not allowed", 405);

    const body = await req.json();
    const { runsignup_race_id, event_id, polyline, elevation_data, source } = body;

    if (!runsignup_race_id || !event_id || !polyline) {
      return errorResponse("Missing required fields", 400);
    }

    const admin = getSupabaseAdmin();
    
    const { data, error } = await admin
      .from("race_courses")
      .upsert({
        runsignup_race_id,
        event_id,
        polyline,
        elevation_data,
        source: source || 'user_upload',
        updated_at: new Date().toISOString()
      }, { onConflict: 'runsignup_race_id,event_id' })
      .select()
      .single();

    if (error) throw error;

    return jsonResponse({ success: true, course: data });

  } catch (err) {
    return errorResponse(err.message, 500);
  }
});

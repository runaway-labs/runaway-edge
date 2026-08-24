import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(url!, key!);

  // Get the St. Louis Marathon course
  const { data: course, error } = await supabase
    .from("race_courses")
    .select("*")
    .eq("runsignup_race_id", 81794)
    .single();

  if (error || !course) return new Response(JSON.stringify({ error: "Course not found" }), { status: 404 });

  return new Response(JSON.stringify({ polyline: course.polyline }), {
    headers: { "Content-Type": "application/json" }
  });
});

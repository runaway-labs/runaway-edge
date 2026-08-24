import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(url!, key!);

  const { data, error } = await supabase
    .from("race_directory")
    .select("name, source_race_id, next_date, raw_data")
    .ilike("name", "%St. Louis Marathon%")
    .limit(1);
  
  return new Response(JSON.stringify({ success: !error, error, data }), {
    headers: { "Content-Type": "application/json" }
  });
});

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(url!, key!);

  // Inspect the tables we care about
  const tableNames = ['athletes', 'activities', 'athlete_races', 'race_courses', 'goals', 'daily_commitments'];
  const audit: any = {};

  for (const table of tableNames) {
    const { data, error } = await supabase.from(table).select('*').limit(1);
    if (!error && data.length > 0) {
      audit[table] = Object.keys(data[0]);
    } else if (error) {
      audit[table] = { error: error.message };
    } else {
      audit[table] = "Empty Table";
    }
  }

  return new Response(JSON.stringify(audit), { headers: { "Content-Type": "application/json" } });
});

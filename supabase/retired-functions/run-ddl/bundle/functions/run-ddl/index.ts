import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const results: string[] = []

  const statements = [
    "ALTER TABLE activities ADD COLUMN IF NOT EXISTS twin_observation TEXT;",
    "ALTER TABLE athlete_ai_profiles ADD COLUMN IF NOT EXISTS micro_wins JSONB;",
    "ALTER TABLE athlete_ai_profiles ADD COLUMN IF NOT EXISTS micro_wins_generated_at TIMESTAMPTZ;",
  ]

  for (const sql of statements) {
    const { error } = await supabase.rpc('exec_raw', { sql }).catch(() => ({ error: null }))
    // Try direct via postgres extension
    try {
      const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/rest/v1/rpc/exec_raw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`, 'apikey': Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')! },
        body: JSON.stringify({ sql })
      })
      results.push(`${sql.slice(0,50)}: ${res.status}`)
    } catch (e) {
      results.push(`${sql.slice(0,50)}: error`)
    }
  }

  return new Response(JSON.stringify({ results }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
})

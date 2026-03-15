import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // Query supabase_functions schema for hooks
  const { data: hooks, error: hooksErr } = await supabase
    .schema('supabase_functions')
    .from('hooks')
    .select('*')
    .limit(20)

  return new Response(JSON.stringify({ hooks, hooksErr }), {
    headers: { 'Content-Type': 'application/json' }
  })
})

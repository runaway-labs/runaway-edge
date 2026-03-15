import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // Check if any hooks/triggers exist on activities table
  const { data, error } = await supabase.from('pg_trigger').select('*').limit(5)
  
  // Also check net (webhook) extension
  const { data: hooks, error: hooksErr } = await supabase.rpc('get_hooks') 

  return new Response(JSON.stringify({ data, error, hooks, hooksErr }), {
    headers: { 'Content-Type': 'application/json' }
  })
})

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const { data, error } = await supabase.rpc('get_cron_jobs')
  
  if (error) {
    // If RPC doesn't exist, try direct query on cron schema
    const { data: directData, error: directError } = await supabase
      .from('cron.job')
      .select('*')
    
    return new Response(JSON.stringify({ data: directData, error: directError }), {
      headers: { 'Content-Type': 'application/json' }
    })
  }

  return new Response(JSON.stringify({ data }), {
    headers: { 'Content-Type': 'application/json' }
  })
})

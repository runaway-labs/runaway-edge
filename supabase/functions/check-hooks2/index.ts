import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // Raw SQL to check database webhooks
  const { data, error } = await supabase.rpc('query_hooks')
  
  if (error) {
    // Try via information_schema trigger query
    const res = await fetch(
      Deno.env.get('SUPABASE_DB_URL')! + '/query',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: "SELECT * FROM information_schema.triggers WHERE event_object_table = 'activities'" })
      }
    )
    return new Response(JSON.stringify({ directError: error, res: await res.text() }), {
      headers: { 'Content-Type': 'application/json' }
    })
  }
  
  return new Response(JSON.stringify({ data }), {
    headers: { 'Content-Type': 'application/json' }
  })
})

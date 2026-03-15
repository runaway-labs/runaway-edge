// Research brief disabled per user request
Deno.serve(async (req) => {
  return new Response(JSON.stringify({ 
    success: true, 
    message: "Daily Research Brief disabled by user request." 
  }), {
    headers: { 'Content-Type': 'application/json' }
  })
})

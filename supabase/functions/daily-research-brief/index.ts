// Research brief disabled per user request
import {
  internalAuthErrorResponse,
  requireInternal,
} from "../_shared/require-internal.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok");
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    requireInternal(req);
  } catch (error) {
    return internalAuthErrorResponse(error);
  }

  return new Response(JSON.stringify({ 
    success: true, 
    message: "Daily Research Brief disabled by user request." 
  }), {
    headers: { 'Content-Type': 'application/json' }
  })
})

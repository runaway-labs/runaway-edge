// Research brief disabled per user request
import { createDailyResearchBriefHandler } from "./handler.ts";

export const handler = createDailyResearchBriefHandler(async (_req) => {
  return new Response(JSON.stringify({ 
    success: true, 
    message: "Daily Research Brief disabled by user request." 
  }), {
    headers: { 'Content-Type': 'application/json' }
  })
});

if (import.meta.main) {
  Deno.serve(handler);
}

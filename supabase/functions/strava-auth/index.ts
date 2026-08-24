// Supabase Edge Function: strava-auth
// Initiate a Strava OAuth flow for the authenticated athlete.

import { corsHeaders } from "../_shared/cors.ts";
import { createOAuthState } from "../_shared/oauth-state.ts";
import { HttpError, requireUser } from "../_shared/require-user.ts";

const WEB_REDIRECT_ORIGINS = new Set([
  "http://localhost:3000",
  "https://localhost:3000",
  "https://runaway-web-203308554831.us-central1.run.app",
]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function safeRedirect(rawRedirect: unknown): string {
  const fallback = "runaway://strava-connected";
  if (rawRedirect == null || rawRedirect === "") return fallback;
  if (typeof rawRedirect !== "string") {
    throw new HttpError(400, "INVALID_REDIRECT_URL", "The redirect URL is not allowed");
  }

  try {
    const redirect = new URL(rawRedirect);
    if (redirect.protocol === "runaway:" && redirect.hostname === "strava-connected") return fallback;
    if (WEB_REDIRECT_ORIGINS.has(redirect.origin)) return redirect.toString();
  } catch {
    // Normalize malformed and unapproved targets to the same safe error.
  }

  throw new HttpError(400, "INVALID_REDIRECT_URL", "The redirect URL is not allowed");
}

async function requestedRedirect(req: Request): Promise<unknown> {
  if (req.method === "GET") return new URL(req.url).searchParams.get("web_redirect_url");

  try {
    const body = await req.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return (body as Record<string, unknown>).web_redirect_url;
  } catch {
    throw new HttpError(400, "INVALID_REQUEST", "A valid JSON request body is required");
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "GET" && req.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  try {
    const user = await requireUser(req);
    const redirectUrl = safeRedirect(await requestedRedirect(req));
    const clientId = Deno.env.get("STRAVA_CLIENT_ID")?.trim();
    const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim();
    if (!clientId || !supabaseUrl) throw new Error("STRAVA_AUTH_NOT_CONFIGURED");

    const state = await createOAuthState({
      provider: "strava",
      authUserId: user.authUserId,
      redirectUrl,
    });
    const authorizationUrl = new URL("https://www.strava.com/oauth/authorize");
    authorizationUrl.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${supabaseUrl}/functions/v1/oauth-callback`,
      response_type: "code",
      approval_prompt: "auto",
      scope: "activity:read_all,profile:read_all",
      state,
    }).toString();

    return jsonResponse({ success: true, authorization_url: authorizationUrl.toString() });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse({ success: false, error: error.message, code: error.code }, error.status);
    }
    console.error("STRAVA_AUTH_INITIATION_FAILED");
    return jsonResponse({ success: false, error: "Unable to start Strava connection" }, 500);
  }
});

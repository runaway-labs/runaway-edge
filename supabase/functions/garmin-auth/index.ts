// Supabase Edge Function: garmin-auth
// Initiate a Garmin OAuth 2.0 PKCE flow for the authenticated athlete.

import { corsHeaders } from "../_shared/cors.ts";
import { createOAuthState, hashOAuthState } from "../_shared/oauth-state.ts";
import { HttpError, requireUser } from "../_shared/require-user.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";

const WEB_REDIRECT_ORIGINS = new Set([
  "http://localhost:3000",
  "https://localhost:3000",
  "https://runaway-web-203308554831.us-central1.run.app",
]);

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function safeRedirect(rawRedirect: unknown): string {
  const fallback = "runaway://garmin-connected";
  if (rawRedirect == null || rawRedirect === "") return fallback;
  if (typeof rawRedirect !== "string") {
    throw new HttpError(400, "INVALID_REDIRECT_URL", "The redirect URL is not allowed");
  }

  try {
    const redirect = new URL(rawRedirect);
    if (redirect.protocol === "runaway:" && redirect.hostname === "garmin-connected") return fallback;
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
    const clientId = Deno.env.get("GARMIN_CONSUMER_KEY")?.trim();
    const clientSecret = Deno.env.get("GARMIN_CONSUMER_SECRET")?.trim();
    const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim();
    if (!clientId || !clientSecret || !supabaseUrl) throw new Error("GARMIN_AUTH_NOT_CONFIGURED");

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const state = await createOAuthState({
      provider: "garmin",
      authUserId: user.authUserId,
      redirectUrl,
    });
    const stateHash = await hashOAuthState(state);
    const { error: verifierError } = await getSupabaseAdmin()
      .from("garmin_oauth_tokens")
      .upsert({
        oauth_token: stateHash,
        token_secret: codeVerifier,
        auth_user_id: user.authUserId,
        web_redirect_url: null,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      }, { onConflict: "oauth_token" });
    if (verifierError) throw new Error("GARMIN_PKCE_STORAGE_FAILED");

    const authorizationUrl = new URL("https://connect.garmin.com/oauth2Confirm");
    authorizationUrl.search = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: `${supabaseUrl}/functions/v1/garmin-callback`,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();

    return jsonResponse({
      success: true,
      authorization_url: authorizationUrl.toString(),
      oauth_token: state,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse({ success: false, error: error.message, code: error.code }, error.status);
    }
    console.error("GARMIN_AUTH_INITIATION_FAILED");
    return jsonResponse({ success: false, error: "Unable to start Garmin connection" }, 500);
  }
});

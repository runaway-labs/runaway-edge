// Supabase Edge Function: garmin-callback
// Handle Garmin OAuth 2.0 PKCE callbacks after consuming server-side state.

import { corsHeaders } from "../_shared/cors.ts";
import { consumeOAuthState, hashOAuthState, OAuthStateError } from "../_shared/oauth-state.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function redirectResponse(redirectUrl: string, success: boolean): Response {
  const target = new URL(redirectUrl);
  if (target.protocol === "runaway:") {
    target.searchParams.set("success", String(success));
  } else {
    target.searchParams.set("garmin", success ? "connected" : "error");
  }
  if (!success) target.searchParams.set("error", "Connection failed. Please try again.");

  return new Response(null, {
    status: 302,
    headers: { ...corsHeaders, Location: target.toString() },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  let trustedRedirect: string | null = null;
  try {
    const requestUrl = new URL(req.url);
    const state = requestUrl.searchParams.get("state");
    if (!state) throw new OAuthStateError();

    const consumed = await consumeOAuthState({ provider: "garmin", state });
    trustedRedirect = consumed.redirectUrl;

    if (requestUrl.searchParams.has("error")) return redirectResponse(trustedRedirect, false);
    const code = requestUrl.searchParams.get("code");
    if (!code) return redirectResponse(trustedRedirect, false);

    const clientId = Deno.env.get("GARMIN_CONSUMER_KEY")?.trim();
    const clientSecret = Deno.env.get("GARMIN_CONSUMER_SECRET")?.trim();
    const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim();
    if (!clientId || !clientSecret || !supabaseUrl) throw new Error("GARMIN_CALLBACK_NOT_CONFIGURED");

    const stateHash = await hashOAuthState(state);
    const admin = getSupabaseAdmin();
    const { data: pkce, error: pkceError } = await admin
      .from("garmin_oauth_tokens")
      .select("token_secret")
      .eq("oauth_token", stateHash)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (pkceError || !pkce || typeof pkce.token_secret !== "string") {
      console.error("GARMIN_PKCE_LOOKUP_FAILED");
      return redirectResponse(trustedRedirect, false);
    }
    await admin.from("garmin_oauth_tokens").delete().eq("oauth_token", stateHash);

    const tokenResponse = await fetch("https://diauth.garmin.com/di-oauth2-service/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: pkce.token_secret,
        redirect_uri: `${supabaseUrl}/functions/v1/garmin-callback`,
      }).toString(),
    });
    if (!tokenResponse.ok) {
      console.error("GARMIN_TOKEN_EXCHANGE_FAILED", { status: tokenResponse.status });
      return redirectResponse(trustedRedirect, false);
    }

    const tokenData = await tokenResponse.json() as Record<string, unknown>;
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    const expiresIn = tokenData.expires_in;
    if (
      typeof accessToken !== "string" ||
      (refreshToken !== undefined && typeof refreshToken !== "string") ||
      (expiresIn !== undefined && typeof expiresIn !== "number")
    ) {
      console.error("GARMIN_TOKEN_RESPONSE_INVALID");
      return redirectResponse(trustedRedirect, false);
    }

    const now = new Date();
    const credentials = {
      garmin_access_token: accessToken,
      garmin_refresh_token: typeof refreshToken === "string" ? refreshToken : null,
      garmin_token_expires_at: typeof expiresIn === "number"
        ? new Date(now.getTime() + expiresIn * 1000).toISOString()
        : null,
      garmin_connected: true,
      garmin_connected_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    const { data: linkedAthlete, error: updateError } = await admin
      .from("athletes")
      .update(credentials)
      .eq("auth_user_id", consumed.authUserId)
      .select("id")
      .maybeSingle();

    if (updateError || !linkedAthlete) {
      const { error: fallbackError } = await admin.from("garmin_connections").upsert({
        auth_user_id: consumed.authUserId,
        access_token: accessToken,
        refresh_token: typeof refreshToken === "string" ? refreshToken : null,
        expires_at: credentials.garmin_token_expires_at,
        connected_at: now.toISOString(),
      }, { onConflict: "auth_user_id" });
      if (fallbackError) {
        console.error("GARMIN_CREDENTIAL_STORAGE_FAILED");
        return redirectResponse(trustedRedirect, false);
      }
    }

    return redirectResponse(trustedRedirect, true);
  } catch (error) {
    if (error instanceof OAuthStateError) {
      return jsonResponse({ success: false, error: "OAuth session is invalid or expired" }, 400);
    }
    console.error("GARMIN_OAUTH_CALLBACK_FAILED");
    if (trustedRedirect) return redirectResponse(trustedRedirect, false);
    return jsonResponse({ success: false, error: "Connection failed. Please try again." }, 500);
  }
});

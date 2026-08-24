// Supabase Edge Function: oauth-callback
// Handle Strava OAuth callbacks after consuming server-side state.

import { corsHeaders } from "../_shared/cors.ts";
import { consumeOAuthState, OAuthStateError } from "../_shared/oauth-state.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function redirectResponse(redirectUrl: string, success: boolean, athleteId?: number): Response {
  const target = new URL(redirectUrl);
  if (target.protocol === "runaway:") {
    target.searchParams.set("success", String(success));
    if (success && athleteId !== undefined) target.searchParams.set("athlete_id", String(athleteId));
  } else {
    target.searchParams.set("strava", success ? "connected" : "error");
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

    const consumed = await consumeOAuthState({ provider: "strava", state });
    trustedRedirect = consumed.redirectUrl;

    if (requestUrl.searchParams.has("error")) return redirectResponse(trustedRedirect, false);
    const code = requestUrl.searchParams.get("code");
    if (!code) return redirectResponse(trustedRedirect, false);

    const clientId = Deno.env.get("STRAVA_CLIENT_ID")?.trim();
    const clientSecret = Deno.env.get("STRAVA_CLIENT_SECRET")?.trim();
    if (!clientId || !clientSecret) throw new Error("STRAVA_CALLBACK_NOT_CONFIGURED");

    const tokenResponse = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
      }),
    });
    if (!tokenResponse.ok) {
      console.error("STRAVA_TOKEN_EXCHANGE_FAILED", { status: tokenResponse.status });
      return redirectResponse(trustedRedirect, false);
    }

    const tokenData = await tokenResponse.json() as Record<string, unknown>;
    const athlete = tokenData.athlete as Record<string, unknown> | undefined;
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    const expiresAt = tokenData.expires_at;
    const providerAthleteId = Number(athlete?.id);
    if (
      typeof accessToken !== "string" ||
      typeof refreshToken !== "string" ||
      typeof expiresAt !== "number" ||
      !athlete ||
      !Number.isSafeInteger(providerAthleteId)
    ) {
      console.error("STRAVA_TOKEN_RESPONSE_INVALID");
      return redirectResponse(trustedRedirect, false);
    }

    const now = new Date().toISOString();
    const { data: linkedAthlete, error: updateError } = await getSupabaseAdmin()
      .from("athletes")
      .update({
        strava_athlete_id: providerAthleteId,
        first_name: typeof athlete.firstname === "string" ? athlete.firstname : null,
        last_name: typeof athlete.lastname === "string" ? athlete.lastname : null,
        email: typeof athlete.email === "string" ? athlete.email : null,
        sex: typeof athlete.sex === "string" ? athlete.sex : null,
        weight: typeof athlete.weight === "number" ? athlete.weight : 0,
        city: typeof athlete.city === "string" ? athlete.city : null,
        state: typeof athlete.state === "string" ? athlete.state : null,
        country: typeof athlete.country === "string" ? athlete.country : null,
        premium: athlete.premium === true,
        access_token: accessToken,
        refresh_token: refreshToken,
        token_expires_at: new Date(expiresAt * 1000).toISOString(),
        strava_connected: true,
        strava_connected_at: now,
        updated_at: now,
      })
      .eq("auth_user_id", consumed.authUserId)
      .select("id")
      .maybeSingle();

    if (updateError || !linkedAthlete) {
      console.error("STRAVA_CREDENTIAL_STORAGE_FAILED");
      return redirectResponse(trustedRedirect, false);
    }

    return redirectResponse(trustedRedirect, true, providerAthleteId);
  } catch (error) {
    if (error instanceof OAuthStateError) {
      return jsonResponse({ success: false, error: "OAuth session is invalid or expired" }, 400);
    }
    console.error("STRAVA_OAUTH_CALLBACK_FAILED");
    if (trustedRedirect) return redirectResponse(trustedRedirect, false);
    return jsonResponse({ success: false, error: "Connection failed. Please try again." }, 500);
  }
});

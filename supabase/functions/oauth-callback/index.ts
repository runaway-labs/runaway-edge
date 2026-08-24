// Supabase Edge Function: oauth-callback
// Handle Strava OAuth callbacks after consuming server-side state.

import { corsHeaders } from "../_shared/cors.ts";
import {
  createOAuthCallbackHandler,
  scopeCredentialWrite,
  type CredentialScopeQuery,
} from "../_shared/oauth-handler.ts";
import { consumeOAuthState } from "../_shared/oauth-state.ts";
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

interface StravaCredentialPayload {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  providerAthleteId: number;
  athlete: Record<string, unknown>;
}

Deno.serve(createOAuthCallbackHandler<StravaCredentialPayload>({
  provider: "strava",
  consumeState: consumeOAuthState,
  exchangeCode: async ({ code }) => {
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
      throw new Error("STRAVA_TOKEN_EXCHANGE_FAILED");
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
      throw new Error("STRAVA_TOKEN_RESPONSE_INVALID");
    }

    return { accessToken, refreshToken, expiresAt, providerAthleteId, athlete };
  },
  writeCredentials: async (token, binding) => {
    const now = new Date().toISOString();
    const query = getSupabaseAdmin()
      .from("athletes")
      .update({
        strava_athlete_id: token.providerAthleteId,
        first_name: typeof token.athlete.firstname === "string" ? token.athlete.firstname : null,
        last_name: typeof token.athlete.lastname === "string" ? token.athlete.lastname : null,
        email: typeof token.athlete.email === "string" ? token.athlete.email : null,
        sex: typeof token.athlete.sex === "string" ? token.athlete.sex : null,
        weight: typeof token.athlete.weight === "number" ? token.athlete.weight : 0,
        city: typeof token.athlete.city === "string" ? token.athlete.city : null,
        state: typeof token.athlete.state === "string" ? token.athlete.state : null,
        country: typeof token.athlete.country === "string" ? token.athlete.country : null,
        premium: token.athlete.premium === true,
        access_token: token.accessToken,
        refresh_token: token.refreshToken,
        token_expires_at: new Date(token.expiresAt * 1000).toISOString(),
        strava_connected: true,
        strava_connected_at: now,
        updated_at: now,
      });
    scopeCredentialWrite(query as unknown as CredentialScopeQuery, binding);
    const { data: linkedAthlete, error: updateError } = await query
      .select("id")
      .maybeSingle();

    if (updateError || !linkedAthlete) {
      console.error("STRAVA_CREDENTIAL_STORAGE_FAILED");
      throw new Error("STRAVA_CREDENTIAL_STORAGE_FAILED");
    }
  },
  successResponse: (token, binding) =>
    redirectResponse(binding.redirectUrl, true, token.providerAthleteId),
  deniedResponse: (binding) => redirectResponse(binding.redirectUrl, false),
  failureResponse: (binding) => redirectResponse(binding.redirectUrl, false),
  invalidStateResponse: () =>
    jsonResponse({ success: false, error: "OAuth session is invalid or expired" }, 400),
  optionsResponse: () => new Response(null, { headers: corsHeaders }),
}));

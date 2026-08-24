// Supabase Edge Function: garmin-callback
// Handle Garmin OAuth 2.0 PKCE callbacks after consuming server-side state.

import { corsHeaders } from "../_shared/cors.ts";
import {
  createOAuthCallbackHandler,
  scopeCredentialWrite,
  type CredentialScopeQuery,
} from "../_shared/oauth-handler.ts";
import { consumeOAuthState, hashOAuthState } from "../_shared/oauth-state.ts";
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

interface GarminCredentialPayload {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
}

Deno.serve(createOAuthCallbackHandler<GarminCredentialPayload>({
  provider: "garmin",
  consumeState: consumeOAuthState,
  exchangeCode: async ({ code, state }) => {
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
      throw new Error("GARMIN_PKCE_LOOKUP_FAILED");
    }
    const { error: deleteError } = await admin
      .from("garmin_oauth_tokens")
      .delete()
      .eq("oauth_token", stateHash);
    if (deleteError) throw new Error("GARMIN_PKCE_DELETE_FAILED");

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
      throw new Error("GARMIN_TOKEN_EXCHANGE_FAILED");
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
      throw new Error("GARMIN_TOKEN_RESPONSE_INVALID");
    }

    return {
      accessToken,
      refreshToken: typeof refreshToken === "string" ? refreshToken : null,
      expiresIn: typeof expiresIn === "number" ? expiresIn : null,
    };
  },
  writeCredentials: async (token, binding) => {
    const now = new Date();
    const credentials = {
      garmin_access_token: token.accessToken,
      garmin_refresh_token: token.refreshToken,
      garmin_token_expires_at: token.expiresIn !== null
        ? new Date(now.getTime() + token.expiresIn * 1000).toISOString()
        : null,
      garmin_connected: true,
      garmin_connected_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    const query = getSupabaseAdmin()
      .from("athletes")
      .update(credentials);
    scopeCredentialWrite(query as unknown as CredentialScopeQuery, binding);
    const { data: linkedAthlete, error: updateError } = await query
      .select("id")
      .maybeSingle();

    if (updateError || !linkedAthlete) {
      console.error("GARMIN_CREDENTIAL_STORAGE_FAILED");
      throw new Error("GARMIN_CREDENTIAL_STORAGE_FAILED");
    }
  },
  successResponse: (_token, binding) => redirectResponse(binding.redirectUrl, true),
  deniedResponse: (binding) => redirectResponse(binding.redirectUrl, false),
  failureResponse: (binding) => redirectResponse(binding.redirectUrl, false),
  invalidStateResponse: () =>
    jsonResponse({ success: false, error: "OAuth session is invalid or expired" }, 400),
  optionsResponse: () => new Response(null, { headers: corsHeaders }),
}));

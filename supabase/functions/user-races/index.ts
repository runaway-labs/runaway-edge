// User Races: Fetches the authenticated user's registered races from RunSignUp
// Requires the user to have linked their RunSignUp account via OAuth2.
//
// Routes:
//   GET  /user-races              — fetch registered races using stored RunSignUp token
//   POST /user-races?action=token — exchange an OAuth2 authorization code for tokens

import { corsHeaders } from "../_shared/cors.ts";
import {
  resolveUserEndpointDependencies,
  userGuardErrorResponse,
  type UserEndpointDependencies,
} from "../_shared/user-endpoint.ts";

const RUNSIGNUP_API_URL = "https://runsignup.com/rest/user/registered-races";
const RUNSIGNUP_TOKEN_URL = "https://api.runsignup.com/rest/v2/auth/auth-code-redemption.json";
const RUNSIGNUP_REFRESH_URL = "https://api.runsignup.com/rest/v2/auth/refresh-token.json";

// Base64-encode the client secret as required by RunSignUp token endpoint
function encodeSecret(secret: string): string {
  return btoa(secret);
}

// Exchange an authorization code for access + refresh tokens
async function exchangeCode(
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: encodeSecret(clientSecret),
    redirect_uri: redirectUri,
  });

  const res = await fetchImpl(RUNSIGNUP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error_description || data.error || `Token exchange failed (${res.status})`);
  }

  return data;
}

// Refresh an expired access token
async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: encodeSecret(clientSecret),
  });

  const res = await fetchImpl(RUNSIGNUP_REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error_description || data.error || `Token refresh failed (${res.status})`);
  }

  return data;
}

// Fetch registered races from RunSignUp using a user-scoped access token
async function fetchRegisteredRaces(accessToken: string, fetchImpl: typeof fetch) {
  const res = await fetchImpl(`${RUNSIGNUP_API_URL}?format=json`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error(`RunSignUp API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(data.error.error_msg || JSON.stringify(data.error));
  }

  return data;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

interface UserRacesDependencies extends UserEndpointDependencies {
  fetch: typeof fetch;
  getEnv: (name: string) => string | undefined;
}

export function createHandler(overrides: Partial<UserRacesDependencies> = {}) {
  const userDeps = resolveUserEndpointDependencies(overrides);
  const deps: UserRacesDependencies = {
    ...userDeps,
    fetch: overrides.fetch ?? globalThis.fetch,
    getEnv: overrides.getEnv ?? ((name) => Deno.env.get(name)),
  };

  return async (req: Request) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

  try {
    const context = await deps.requireUser(req);
    const url = new URL(req.url);

    if (req.method === "POST" && url.searchParams.get("action") !== "token") {
      return errorResponse("Invalid action", 400);
    }

    if (req.method !== "GET" && req.method !== "POST") {
      return errorResponse("Method not allowed", 405);
    }

    const clientId = deps.getEnv("RUNSIGNUP_API_KEY");
    const clientSecret = deps.getEnv("RUNSIGNUP_API_SECRET");

    if (!clientId || !clientSecret) {
      return errorResponse("Missing RunSignUp API credentials", 500);
    }

    const supabase = deps.getAdmin();

    // POST: Exchange OAuth2 authorization code for tokens and store them
    if (req.method === "POST") {
      const body = await req.json();
      const { code, redirect_uri } = body;

      if (!code || !redirect_uri) {
        return errorResponse("Missing code or redirect_uri", 400);
      }

      const tokens = await exchangeCode(code, redirect_uri, clientId, clientSecret, deps.fetch);

      // Credentials are service-only athlete data, never profile-view data.
      const { error: updateError } = await supabase
        .from("athletes")
        .update({
          runsignup_access_token: tokens.access_token,
          runsignup_refresh_token: tokens.refresh_token,
          runsignup_token_expires_at: new Date(
            Date.now() + tokens.expires_in * 1000
          ).toISOString(),
        })
        .eq("id", context.athleteId);

      if (updateError) {
        return errorResponse(`Failed to store tokens: ${updateError.message}`, 500);
      }

      return jsonResponse({ success: true, connected: true });
    }

    // Retrieve stored RunSignUp tokens for this user
    const { data: profile, error: profileError } = await supabase
      .from("athletes")
      .select("runsignup_access_token, runsignup_refresh_token, runsignup_token_expires_at")
      .eq("id", context.athleteId)
      .single();

    if (profileError || !profile?.runsignup_access_token) {
      return jsonResponse({
        connected: false,
        error: "RunSignUp account not linked. Complete OAuth flow to connect.",
        authorize_url: `https://runsignup.com/Profile/OAuth2/RequestGrant?response_type=code&client_id=${clientId}&scope=rsu_api_read`,
      }, 200);
    }

    let accessToken = profile.runsignup_access_token;

    // Refresh token if expired
    if (
      profile.runsignup_token_expires_at &&
      new Date(profile.runsignup_token_expires_at) < new Date()
    ) {
      try {
        const refreshed = await refreshAccessToken(
          profile.runsignup_refresh_token,
          clientId,
          clientSecret,
          deps.fetch,
        );

        accessToken = refreshed.access_token;

        await supabase
          .from("athletes")
          .update({
            runsignup_access_token: refreshed.access_token,
            runsignup_refresh_token: refreshed.refresh_token ?? profile.runsignup_refresh_token,
            runsignup_token_expires_at: new Date(
              Date.now() + refreshed.expires_in * 1000
            ).toISOString(),
          })
          .eq("id", context.athleteId);
      } catch {
        // Refresh failed — user needs to re-authorize
        return jsonResponse({
          connected: false,
          error: "RunSignUp token expired. Please re-authorize.",
          authorize_url: `https://runsignup.com/Profile/OAuth2/RequestGrant?response_type=code&client_id=${clientId}&scope=rsu_api_read`,
        }, 200);
      }
    }

    const races = await fetchRegisteredRaces(accessToken, deps.fetch);

    return jsonResponse({ connected: true, ...races });
  } catch (error) {
    const guardResponse = userGuardErrorResponse(error, corsHeaders);
    if (guardResponse) return guardResponse;

    console.error("Error in user-races:", error);
    return errorResponse("Internal server error", 500);
  }
  };
}

if (import.meta.main) {
  Deno.serve(createHandler());
}

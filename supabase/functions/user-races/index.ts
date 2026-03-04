// User Races: Fetches the authenticated user's registered races from RunSignUp
// Requires the user to have linked their RunSignUp account via OAuth2.
//
// Routes:
//   GET  /user-races              — fetch registered races using stored RunSignUp token
//   POST /user-races?action=token — exchange an OAuth2 authorization code for tokens

import { handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { getUserFromAuth, getSupabaseAdmin } from "../_shared/supabase-client.ts";

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
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: encodeSecret(clientSecret),
    redirect_uri: redirectUri,
  });

  const res = await fetch(RUNSIGNUP_TOKEN_URL, {
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
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: encodeSecret(clientSecret),
  });

  const res = await fetch(RUNSIGNUP_REFRESH_URL, {
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
async function fetchRegisteredRaces(accessToken: string) {
  const res = await fetch(`${RUNSIGNUP_API_URL}?format=json`, {
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

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    // Verify the user is authenticated with Supabase
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return errorResponse("Missing authorization header", 401);
    }

    const user = await getUserFromAuth(authHeader);
    if (!user) {
      return errorResponse("Unauthorized", 401);
    }

    const clientId = Deno.env.get("RUNSIGNUP_API_KEY");
    const clientSecret = Deno.env.get("RUNSIGNUP_API_SECRET");

    if (!clientId || !clientSecret) {
      return errorResponse("Missing RunSignUp API credentials", 500);
    }

    const supabase = getSupabaseAdmin();
    const url = new URL(req.url);

    // POST: Exchange OAuth2 authorization code for tokens and store them
    if (req.method === "POST") {
      const action = url.searchParams.get("action");
      if (action !== "token") {
        return errorResponse("Invalid action", 400);
      }

      const body = await req.json();
      const { code, redirect_uri } = body;

      if (!code || !redirect_uri) {
        return errorResponse("Missing code or redirect_uri", 400);
      }

      const tokens = await exchangeCode(code, redirect_uri, clientId, clientSecret);

      // Store tokens in the profiles table
      const { error: updateError } = await supabase
        .from("profiles")
        .update({
          runsignup_access_token: tokens.access_token,
          runsignup_refresh_token: tokens.refresh_token,
          runsignup_token_expires_at: new Date(
            Date.now() + tokens.expires_in * 1000
          ).toISOString(),
        })
        .eq("id", user.id);

      if (updateError) {
        return errorResponse(`Failed to store tokens: ${updateError.message}`, 500);
      }

      return jsonResponse({ success: true, connected: true });
    }

    // GET: Fetch registered races using stored token
    if (req.method !== "GET") {
      return errorResponse("Method not allowed", 405);
    }

    // Retrieve stored RunSignUp tokens for this user
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("runsignup_access_token, runsignup_refresh_token, runsignup_token_expires_at")
      .eq("id", user.id)
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
        );

        accessToken = refreshed.access_token;

        await supabase
          .from("profiles")
          .update({
            runsignup_access_token: refreshed.access_token,
            runsignup_refresh_token: refreshed.refresh_token ?? profile.runsignup_refresh_token,
            runsignup_token_expires_at: new Date(
              Date.now() + refreshed.expires_in * 1000
            ).toISOString(),
          })
          .eq("id", user.id);
      } catch {
        // Refresh failed — user needs to re-authorize
        return jsonResponse({
          connected: false,
          error: "RunSignUp token expired. Please re-authorize.",
          authorize_url: `https://runsignup.com/Profile/OAuth2/RequestGrant?response_type=code&client_id=${clientId}&scope=rsu_api_read`,
        }, 200);
      }
    }

    const races = await fetchRegisteredRaces(accessToken);

    return jsonResponse({ connected: true, ...races });
  } catch (error) {
    console.error("Error in user-races:", error);
    return errorResponse(
      error instanceof Error ? error.message : "Internal server error",
      500
    );
  }
});

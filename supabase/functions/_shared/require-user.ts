import { getSupabaseClient } from "./supabase-client.ts";

export interface UserContext {
  authUserId: string;
  athleteId: number;
  authorization: string;
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

interface AuthenticatedUser {
  id: string;
}

interface AuthUserResult {
  data: { user: AuthenticatedUser | null };
  error: unknown;
}

interface AthleteLookupResult {
  data: { id: number } | null;
  error: unknown;
}

export interface UserGuardClient {
  auth: {
    getUser(accessToken: string): Promise<AuthUserResult>;
  };
  from(table: "athletes"): {
    select(columns: "id"): {
      eq(column: "auth_user_id", authUserId: string): {
        maybeSingle(): Promise<AthleteLookupResult>;
      };
    };
  };
}

export type UserGuardClientFactory = (authorization: string) => UserGuardClient;

function getBearerToken(req: Request): { authorization: string; accessToken: string } {
  const authorization = req.headers.get("Authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);

  if (!authorization || !match || !match[1].trim()) {
    throw new HttpError(401, "MISSING_AUTHORIZATION", "A bearer token is required");
  }

  return { authorization, accessToken: match[1].trim() };
}

export function createRequireUser(createClient: UserGuardClientFactory) {
  return async function requireUser(
    req: Request,
    requestedAthleteId?: number | null,
  ): Promise<UserContext> {
    const { authorization, accessToken } = getBearerToken(req);
    const client = createClient(authorization);
    const { data: authData, error: authError } = await client.auth.getUser(accessToken);

    if (authError || !authData.user) {
      throw new HttpError(401, "INVALID_TOKEN", "The bearer token is invalid");
    }

    const { data: athlete, error: athleteError } = await client
      .from("athletes")
      .select("id")
      .eq("auth_user_id", authData.user.id)
      .maybeSingle();

    if (athleteError) {
      throw new HttpError(500, "ATHLETE_LOOKUP_FAILED", "Unable to resolve the authenticated athlete");
    }

    if (!athlete) {
      throw new HttpError(403, "ATHLETE_NOT_FOUND", "No athlete is linked to this user");
    }

    if (requestedAthleteId != null && requestedAthleteId !== athlete.id) {
      throw new HttpError(403, "ATHLETE_MISMATCH", "The requested athlete does not match the authenticated user");
    }

    return {
      authUserId: authData.user.id,
      athleteId: athlete.id,
      authorization,
    };
  };
}

export const requireUser = createRequireUser((authorization) =>
  getSupabaseClient(authorization) as unknown as UserGuardClient,
);

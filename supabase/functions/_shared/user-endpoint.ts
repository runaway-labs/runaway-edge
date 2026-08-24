import { getSupabaseAdmin } from "./supabase-client.ts";
import {
  HttpError,
  requireUser,
  type UserContext,
} from "./require-user.ts";

export type RequireUser = (
  req: Request,
  requestedAthleteId?: number | null,
) => Promise<UserContext>;

export interface UserEndpointDependencies {
  requireUser: RequireUser;
  getAdmin: () => any;
}

export function resolveUserEndpointDependencies(
  overrides: Partial<UserEndpointDependencies> = {},
): UserEndpointDependencies {
  return {
    requireUser: overrides.requireUser ?? requireUser,
    getAdmin: overrides.getAdmin ?? getSupabaseAdmin,
  };
}

export function parseLegacyAthleteId(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const athleteId = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(athleteId) && athleteId > 0 ? athleteId : null;
}

export function userGuardErrorResponse(
  error: unknown,
  headers: Record<string, string>,
): Response | null {
  if (!(error instanceof HttpError)) {
    return null;
  }

  return new Response(
    JSON.stringify({
      error: {
        code: error.code,
        message: error.message,
      },
    }),
    {
      status: error.status,
      headers: { ...headers, "Content-Type": "application/json" },
    },
  );
}

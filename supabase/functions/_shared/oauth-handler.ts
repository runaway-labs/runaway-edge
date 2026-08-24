import type { OAuthProvider } from "./oauth-state.ts";

export interface OAuthBinding {
  authUserId: string;
  athleteId: number;
  redirectUrl: string;
}

export interface CredentialScopeQuery {
  eq(column: string, value: unknown): CredentialScopeQuery;
}

export function scopeCredentialWrite(
  query: CredentialScopeQuery,
  binding: OAuthBinding,
): void {
  query
    .eq("id", binding.athleteId)
    .eq("auth_user_id", binding.authUserId);
}

export function createOAuthInitiationHandler(dependencies: {
  requireUser(req: Request): Promise<{ authUserId: string; athleteId: number }>;
  begin(req: Request, user: { authUserId: string; athleteId: number }): Promise<Response>;
  errorResponse(error: unknown): Response;
  methodNotAllowedResponse(): Response;
  optionsResponse?(): Response;
}) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return dependencies.optionsResponse?.() ?? new Response(null);
    }
    if (req.method !== "GET" && req.method !== "POST") {
      return dependencies.methodNotAllowedResponse();
    }

    try {
      const user = await dependencies.requireUser(req);
      return await dependencies.begin(req, user);
    } catch (error) {
      return dependencies.errorResponse(error);
    }
  };
}

export function createOAuthCallbackHandler<Token>(dependencies: {
  provider: OAuthProvider;
  consumeState(input: { provider: OAuthProvider; state: string }): Promise<OAuthBinding>;
  exchangeCode(input: { code: string; state: string; binding: OAuthBinding }): Promise<Token>;
  writeCredentials(token: Token, binding: OAuthBinding): Promise<void>;
  successResponse(token: Token, binding: OAuthBinding): Response;
  deniedResponse(binding: OAuthBinding): Response;
  failureResponse(binding: OAuthBinding): Response;
  invalidStateResponse(): Response;
  optionsResponse?(): Response;
}) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return dependencies.optionsResponse?.() ?? new Response(null);
    }

    const requestUrl = new URL(req.url);
    const state = requestUrl.searchParams.get("state");
    if (!state) return dependencies.invalidStateResponse();

    let binding: OAuthBinding;
    try {
      binding = await dependencies.consumeState({ provider: dependencies.provider, state });
    } catch {
      return dependencies.invalidStateResponse();
    }

    if (requestUrl.searchParams.has("error")) {
      return dependencies.deniedResponse(binding);
    }

    const code = requestUrl.searchParams.get("code");
    if (!code) return dependencies.failureResponse(binding);

    try {
      const token = await dependencies.exchangeCode({ code, state, binding });
      await dependencies.writeCredentials(token, binding);
      return dependencies.successResponse(token, binding);
    } catch {
      return dependencies.failureResponse(binding);
    }
  };
}

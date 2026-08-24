export type OAuthProvider = "strava" | "garmin";

const OAUTH_STATE_BYTES = 32;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface OAuthStateRpcClient {
  rpc(
    functionName: "create_oauth_state" | "consume_oauth_state",
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: unknown }>;
}

export interface OAuthStateDependencies {
  getClient(): OAuthStateRpcClient | Promise<OAuthStateRpcClient>;
  randomBytes?(length: number): Uint8Array;
  now?(): Date;
}

export interface OAuthStateService {
  createOAuthState(input: {
    provider: OAuthProvider;
    authUserId: string;
    redirectUrl: string;
  }): Promise<string>;
  consumeOAuthState(input: {
    provider: OAuthProvider;
    state: string;
  }): Promise<{ authUserId: string; redirectUrl: string }>;
}

export class OAuthStateError extends Error {
  readonly status = 400;
  readonly code = "INVALID_OAUTH_STATE";

  constructor() {
    super("OAuth session is invalid or expired");
    this.name = "OAuthStateError";
  }
}

function secureRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validProvider(provider: unknown): provider is OAuthProvider {
  return provider === "strava" || provider === "garmin";
}

function validAuthUserId(value: string): boolean {
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
}

export async function hashOAuthState(state: string): Promise<string> {
  if (!OAUTH_STATE_PATTERN.test(state)) throw new OAuthStateError();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state));
  return hexEncode(new Uint8Array(digest));
}

export function createOAuthStateService(
  dependencies: OAuthStateDependencies,
): OAuthStateService {
  const randomBytes = dependencies.randomBytes ?? secureRandomBytes;
  const now = dependencies.now ?? (() => new Date());

  return {
    async createOAuthState(input) {
      if (
        !validProvider(input.provider) ||
        !validAuthUserId(input.authUserId) ||
        !input.redirectUrl ||
        input.redirectUrl.length > 2048
      ) {
        throw new OAuthStateError();
      }

      const bytes = randomBytes(OAUTH_STATE_BYTES);
      if (bytes.length !== OAUTH_STATE_BYTES) throw new OAuthStateError();

      const state = base64UrlEncode(bytes);
      const stateHash = await hashOAuthState(state);

      try {
        const client = await dependencies.getClient();
        const { error } = await client.rpc("create_oauth_state", {
          p_state_hash: stateHash,
          p_provider: input.provider,
          p_auth_user_id: input.authUserId,
          p_redirect_url: input.redirectUrl,
          p_expires_at: new Date(now().getTime() + OAUTH_STATE_TTL_MS).toISOString(),
        });
        if (error) throw new OAuthStateError();
      } catch (error) {
        if (error instanceof OAuthStateError) throw error;
        throw new OAuthStateError();
      }

      return state;
    },
    async consumeOAuthState(input) {
      if (!validProvider(input.provider) || !OAUTH_STATE_PATTERN.test(input.state)) {
        throw new OAuthStateError();
      }

      const stateHash = await hashOAuthState(input.state);

      try {
        const client = await dependencies.getClient();
        const { data, error } = await client.rpc("consume_oauth_state", {
          p_provider: input.provider,
          p_state_hash: stateHash,
        });
        if (error || !Array.isArray(data) || data.length !== 1) throw new OAuthStateError();

        const row = data[0] as Record<string, unknown>;
        if (typeof row.auth_user_id !== "string" || typeof row.redirect_url !== "string") {
          throw new OAuthStateError();
        }

        return {
          authUserId: row.auth_user_id,
          redirectUrl: row.redirect_url,
        };
      } catch (error) {
        if (error instanceof OAuthStateError) throw error;
        throw new OAuthStateError();
      }
    },
  };
}

const defaultService = createOAuthStateService({
  async getClient() {
    const { getSupabaseAdmin } = await import("./supabase-client.ts");
    return getSupabaseAdmin() as unknown as OAuthStateRpcClient;
  },
});

export const createOAuthState = defaultService.createOAuthState;
export const consumeOAuthState = defaultService.consumeOAuthState;

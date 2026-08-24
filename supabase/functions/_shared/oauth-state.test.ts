import {
  createOAuthStateService,
  OAuthStateError,
  type OAuthStateRpcClient,
  type OAuthStateService,
} from "./oauth-state.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

async function expectInvalidState(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    assert(error instanceof OAuthStateError, "expected a normalized OAuthStateError");
    assertEquals(error.status, 400);
    assertEquals(error.code, "INVALID_OAUTH_STATE");
    assertEquals(error.message, "OAuth session is invalid or expired");
    return;
  }

  throw new Error("expected OAuth state rejection");
}

interface StoredState {
  stateHash: string;
  provider: string;
  authUserId: string;
  athleteId: number;
  redirectUrl: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

class InMemoryOAuthStateRpc implements OAuthStateRpcClient {
  readonly states = new Map<string, StoredState>();
  readonly rpcNames: string[] = [];
  private readonly now: () => Date;

  constructor(now: () => Date) {
    this.now = now;
  }

  async rpc(functionName: "create_oauth_state" | "consume_oauth_state", args: Record<string, unknown>) {
    this.rpcNames.push(functionName);

    if (functionName === "create_oauth_state") {
      const stateHash = String(args.p_state_hash);
      this.states.set(stateHash, {
        stateHash,
        provider: String(args.p_provider),
        authUserId: String(args.p_auth_user_id),
        athleteId: Number(args.p_athlete_id),
        redirectUrl: String(args.p_redirect_url),
        expiresAt: new Date(String(args.p_expires_at)),
        consumedAt: null,
      });
      return { data: null, error: null };
    }

    const state = this.states.get(String(args.p_state_hash));
    if (
      !state ||
      state.provider !== args.p_provider ||
      state.consumedAt !== null ||
      state.expiresAt.getTime() <= this.now().getTime()
    ) {
      return { data: [], error: null };
    }

    state.consumedAt = this.now();
    return {
      data: [{
        auth_user_id: state.authUserId,
        athlete_id: state.athleteId,
        redirect_url: state.redirectUrl,
      }],
      error: null,
    };
  }
}

function fixture() {
  let currentTime = new Date("2026-08-24T12:00:00.000Z");
  const database = new InMemoryOAuthStateRpc(() => currentTime);
  const randomBytes = Uint8Array.from({ length: 32 }, (_, index) => index);
  const service: OAuthStateService = createOAuthStateService({
    getClient: () => database,
    randomBytes: (length) => {
      assertEquals(length, 32, "OAuth state must use 32 random bytes");
      return randomBytes.slice();
    },
    now: () => currentTime,
  });

  return {
    database,
    service,
    setTime(value: string) {
      currentTime = new Date(value);
    },
  };
}

Deno.test("createOAuthState returns 32 random bytes as opaque base64url and persists only its SHA-256 digest", async () => {
  const { database, service } = fixture();

  const state = await service.createOAuthState({
    provider: "strava",
    authUserId: "11111111-1111-1111-1111-111111111111",
    athleteId: 101,
    redirectUrl: "runaway://strava-connected",
  });

  assertEquals(state, "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
  assert(!JSON.stringify([...database.states.values()]).includes(state), "plaintext state must not be persisted");
  assertEquals([...database.states.keys()], [
    "ea866a757e4c38babfa8127cbe9a409d3e1f93a00ff1488ff735fcf917afffd0",
  ]);
  assertEquals([...database.states.values()][0], {
    stateHash: "ea866a757e4c38babfa8127cbe9a409d3e1f93a00ff1488ff735fcf917afffd0",
    provider: "strava",
    authUserId: "11111111-1111-1111-1111-111111111111",
    athleteId: 101,
    redirectUrl: "runaway://strava-connected",
    expiresAt: new Date("2026-08-24T12:10:00.000Z"),
    consumedAt: null,
  });
});

Deno.test("consumeOAuthState returns the server-bound user and redirect exactly once", async () => {
  const { service } = fixture();
  const state = await service.createOAuthState({
    provider: "strava",
    authUserId: "11111111-1111-1111-1111-111111111111",
    athleteId: 101,
    redirectUrl: "https://runaway-web-203308554831.us-central1.run.app/settings",
  });

  assertEquals(await service.consumeOAuthState({ provider: "strava", state }), {
    authUserId: "11111111-1111-1111-1111-111111111111",
    athleteId: 101,
    redirectUrl: "https://runaway-web-203308554831.us-central1.run.app/settings",
  });
  await expectInvalidState(() => service.consumeOAuthState({ provider: "strava", state }));
});

Deno.test("consumeOAuthState rejects missing and altered state before database access", async () => {
  const { database, service } = fixture();

  await expectInvalidState(() => service.consumeOAuthState({ provider: "strava", state: "" }));
  await expectInvalidState(() => service.consumeOAuthState({ provider: "strava", state: "not-base64url" }));
  assertEquals(database.rpcNames, []);
});

Deno.test("consumeOAuthState rejects an expired state", async () => {
  const { service, setTime } = fixture();
  const state = await service.createOAuthState({
    provider: "strava",
    authUserId: "11111111-1111-1111-1111-111111111111",
    athleteId: 101,
    redirectUrl: "runaway://strava-connected",
  });
  setTime("2026-08-24T12:10:00.000Z");

  await expectInvalidState(() => service.consumeOAuthState({ provider: "strava", state }));
});

Deno.test("consumeOAuthState rejects a provider mismatch without consuming the valid provider state", async () => {
  const { service } = fixture();
  const state = await service.createOAuthState({
    provider: "garmin",
    authUserId: "11111111-1111-1111-1111-111111111111",
    athleteId: 101,
    redirectUrl: "runaway://garmin-connected",
  });

  await expectInvalidState(() => service.consumeOAuthState({ provider: "strava", state }));
  assertEquals(await service.consumeOAuthState({ provider: "garmin", state }), {
    authUserId: "11111111-1111-1111-1111-111111111111",
    athleteId: 101,
    redirectUrl: "runaway://garmin-connected",
  });
});

Deno.test("distinct OAuth state values remain bound to their verified users", async () => {
  let nextByte = 0;
  const now = new Date("2026-08-24T12:00:00.000Z");
  const database = new InMemoryOAuthStateRpc(() => now);
  const service = createOAuthStateService({
    getClient: () => database,
    randomBytes: () => new Uint8Array(32).fill(nextByte++),
    now: () => now,
  });
  const stateA = await service.createOAuthState({
    provider: "strava",
    authUserId: "11111111-1111-1111-1111-111111111111",
    athleteId: 101,
    redirectUrl: "runaway://strava-connected",
  });
  const stateB = await service.createOAuthState({
    provider: "strava",
    authUserId: "22222222-2222-2222-2222-222222222222",
    athleteId: 202,
    redirectUrl: "https://runaway-web-203308554831.us-central1.run.app/settings",
  });

  assertEquals((await service.consumeOAuthState({ provider: "strava", state: stateA })).authUserId,
    "11111111-1111-1111-1111-111111111111");
  assertEquals(await service.consumeOAuthState({ provider: "strava", state: stateB }), {
    authUserId: "22222222-2222-2222-2222-222222222222",
    athleteId: 202,
    redirectUrl: "https://runaway-web-203308554831.us-central1.run.app/settings",
  });
});

Deno.test("concurrent consumption has exactly one winner", async () => {
  const { service } = fixture();
  const state = await service.createOAuthState({
    provider: "garmin",
    authUserId: "11111111-1111-1111-1111-111111111111",
    athleteId: 101,
    redirectUrl: "runaway://garmin-connected",
  });

  const results = await Promise.allSettled([
    service.consumeOAuthState({ provider: "garmin", state }),
    service.consumeOAuthState({ provider: "garmin", state }),
  ]);

  assertEquals(results.filter((result) => result.status === "fulfilled").length, 1);
  assertEquals(results.filter((result) => result.status === "rejected").length, 1);
  assert(results.some((result) => result.status === "rejected" && result.reason instanceof OAuthStateError),
    "the losing consumer must receive a normalized rejection");
});

Deno.test("database failures are sanitized without leaking provider or state details", async () => {
  const service = createOAuthStateService({
    getClient: () => ({
      rpc: async () => ({ data: null, error: { message: "raw database body with secret-state" } }),
    }),
    randomBytes: () => new Uint8Array(32),
    now: () => new Date("2026-08-24T12:00:00.000Z"),
  });

  await expectInvalidState(() => service.createOAuthState({
    provider: "garmin",
    authUserId: "11111111-1111-1111-1111-111111111111",
    athleteId: 101,
    redirectUrl: "runaway://garmin-connected",
  }));
});

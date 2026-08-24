import {
  createRequireUser,
  HttpError,
  type UserGuardClient,
  type UserGuardClientFactory,
} from "./require-user.ts";

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

async function expectHttpError(
  action: () => Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof HttpError)) {
      throw error;
    }

    assertEquals(error.status, status);
    assertEquals(error.code, code);
    return;
  }

  throw new Error(`Expected HttpError ${status} ${code}`);
}

function request(authorization?: string): Request {
  return new Request("https://example.test", {
    headers: authorization ? { Authorization: authorization } : undefined,
  });
}

function clientFactory(options: {
  user?: { id: string } | null;
  authError?: unknown;
  athlete?: { id: number } | null;
  athleteError?: unknown;
} = {}): UserGuardClientFactory {
  return () => {
    const client: UserGuardClient = {
      auth: {
        getUser: async () => ({
          data: { user: options.user ?? { id: "auth-user-1" } },
          error: options.authError ?? null,
        }),
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: options.athlete === undefined ? { id: 42 } : options.athlete,
              error: options.athleteError ?? null,
            }),
          }),
        }),
      }),
    };

    return client;
  };
}

Deno.test("requireUser rejects a missing Authorization header before creating a client", async () => {
  let clientCalls = 0;
  const requireUser = createRequireUser(() => {
    clientCalls += 1;
    throw new Error("client should not be created");
  });

  await expectHttpError(() => requireUser(request()), 401, "MISSING_AUTHORIZATION");
  assertEquals(clientCalls, 0);
});

Deno.test("requireUser rejects an invalid bearer token", async () => {
  const requireUser = createRequireUser(clientFactory({ authError: new Error("invalid"), user: null }));

  await expectHttpError(() => requireUser(request("Bearer invalid-token")), 401, "INVALID_TOKEN");
});

Deno.test("requireUser rejects a user without an athlete record", async () => {
  const requireUser = createRequireUser(clientFactory({ athlete: null }));

  await expectHttpError(() => requireUser(request("Bearer valid-token")), 403, "ATHLETE_NOT_FOUND");
});

Deno.test("requireUser rejects a requested athlete that differs from the authenticated athlete", async () => {
  const requireUser = createRequireUser(clientFactory({ athlete: { id: 42 } }));

  await expectHttpError(() => requireUser(request("Bearer valid-token"), 99), 403, "ATHLETE_MISMATCH");
});

Deno.test("requireUser returns the verified user and matching athlete context", async () => {
  const requireUser = createRequireUser(clientFactory({
    user: { id: "auth-user-1" },
    athlete: { id: 42 },
  }));

  const context = await requireUser(request("Bearer valid-token"), 42);

  assertEquals(context, {
    authUserId: "auth-user-1",
    athleteId: 42,
    authorization: "Bearer valid-token",
  });
});

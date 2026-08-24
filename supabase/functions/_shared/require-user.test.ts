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
  message?: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof HttpError)) {
      throw error;
    }

    assertEquals(error.status, status);
    assertEquals(error.code, code);
    if (message !== undefined) {
      assertEquals(error.message, message);
    }
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
  authRejection?: unknown;
  athlete?: { id: number } | null;
  athleteError?: unknown;
  athleteRejection?: unknown;
} = {}): UserGuardClientFactory {
  return () => {
    const client: UserGuardClient = {
      auth: {
        getUser: async () => {
          if (options.authRejection !== undefined) {
            throw options.authRejection;
          }

          return {
            data: { user: options.user ?? { id: "auth-user-1" } },
            error: options.authError ?? null,
          };
        },
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              if (options.athleteRejection !== undefined) {
                throw options.athleteRejection;
              }

              return {
                data: options.athlete === undefined ? { id: 42 } : options.athlete,
                error: options.athleteError ?? null,
              };
            },
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

Deno.test("requireUser normalizes a returned athlete lookup error", async () => {
  const requireUser = createRequireUser(clientFactory({
    athleteError: { code: "UPSTREAM_FAILURE", details: "private upstream details" },
  }));

  await expectHttpError(
    () => requireUser(request("Bearer secret-token")),
    500,
    "ATHLETE_LOOKUP_FAILED",
    "Unable to resolve the authenticated athlete",
  );
});

Deno.test("requireUser normalizes a duplicate-row maybeSingle error", async () => {
  const requireUser = createRequireUser(clientFactory({
    athleteError: { code: "PGRST116", details: "Results contain 2 rows" },
  }));

  await expectHttpError(
    () => requireUser(request("Bearer secret-token")),
    500,
    "ATHLETE_LOOKUP_FAILED",
    "Unable to resolve the authenticated athlete",
  );
});

Deno.test("requireUser normalizes a rejected Auth request", async () => {
  const requireUser = createRequireUser(clientFactory({
    authRejection: new Error("network failure for secret-token"),
  }));

  await expectHttpError(
    () => requireUser(request("Bearer secret-token")),
    500,
    "AUTH_LOOKUP_FAILED",
    "Unable to verify the bearer token",
  );
});

Deno.test("requireUser normalizes a rejected athlete query", async () => {
  const requireUser = createRequireUser(clientFactory({
    athleteRejection: new Error("database failure for secret-token"),
  }));

  await expectHttpError(
    () => requireUser(request("Bearer secret-token")),
    500,
    "ATHLETE_LOOKUP_FAILED",
    "Unable to resolve the authenticated athlete",
  );
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

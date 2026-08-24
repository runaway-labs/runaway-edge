import { HttpError } from "../_shared/require-user.ts";
import type { RequireUser } from "../_shared/user-endpoint.ts";
import { createHandler as createBackfillSplitsHandler } from "../backfill-splits/index.ts";
import { createHandler as createCheckMilestonesHandler } from "../check-milestones/index.ts";
import { createHandler as createFeedbackWorkoutHandler } from "../feedback-workout/index.ts";
import { createHandler as createIdentityProfileHandler } from "../identity-profile/index.ts";
import { createHandler as createJournalHandler } from "../journal/index.ts";
import { createHandler as createSyncBetaHandler } from "../sync-beta/index.ts";
import { createHandler as createTrainingPlanHandler } from "../training-plan/index.ts";
import { createHandler as createUserRacesHandler } from "../user-races/index.ts";

const ATHLETE_A = 42;
const ATHLETE_B = 99;
const AUTH_USER_A = "auth-user-a";

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function jsonRequest(
  url: string,
  method: string,
  body: unknown,
  authorization?: string,
): Request {
  return new Request(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
}

function createGuard(calls: Array<number | null>): RequireUser {
  return async (req, requestedAthleteId) => {
    calls.push(requestedAthleteId ?? null);
    const authorization = req.headers.get("Authorization");

    if (!authorization) {
      throw new HttpError(401, "MISSING_AUTHORIZATION", "A bearer token is required");
    }

    if (authorization === "Bearer invalid-token") {
      throw new HttpError(401, "INVALID_TOKEN", "The bearer token is invalid");
    }

    if (requestedAthleteId != null && requestedAthleteId !== ATHLETE_A) {
      throw new HttpError(403, "ATHLETE_MISMATCH", "The requested athlete does not match the authenticated user");
    }

    return {
      authUserId: AUTH_USER_A,
      athleteId: ATHLETE_A,
      authorization,
    };
  };
}

type QueryState = {
  table: string;
  selected?: string;
  updated?: unknown;
  inserted?: unknown;
  filters: Array<[string, unknown]>;
  limit?: number;
};

type QueryResolver = (state: QueryState) => { data: unknown; error: unknown };

function createAdmin(
  operations: QueryState[],
  resolve: QueryResolver = (state) => {
    if (state.table === "weekly_training_plans") {
      return { data: null, error: { code: "PGRST116" } };
    }
    return { data: [], error: null };
  },
) {
  return {
    from(table: string) {
      const state: QueryState = { table, filters: [] };
      const query: any = {
        select(columns: string) {
          state.selected = columns;
          return query;
        },
        update(value: unknown) {
          state.updated = value;
          return query;
        },
        insert(value: unknown) {
          state.inserted = value;
          return query;
        },
        upsert(value: unknown) {
          state.inserted = value;
          return query;
        },
        eq(column: string, value: unknown) {
          state.filters.push([column, value]);
          return query;
        },
        gte() {
          return query;
        },
        lt() {
          return query;
        },
        in() {
          return query;
        },
        is() {
          return query;
        },
        order() {
          return query;
        },
        maybeSingle() {
          return query;
        },
        single() {
          return query;
        },
        limit(value: number) {
          state.limit = value;
          return query;
        },
        then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
          operations.push({
            ...state,
            filters: [...state.filters],
          });
          return Promise.resolve(resolve(state)).then(onFulfilled, onRejected);
        },
      };
      return query;
    },
  };
}

type EndpointCase = {
  name: string;
  create: (deps: { requireUser: RequireUser; getAdmin: () => any }) => (req: Request) => Promise<Response>;
  request: (athleteId: number, authorization?: string) => Request;
  ownerRequest: (authorization: string) => Request;
};

const endpointCases: EndpointCase[] = [
  {
    name: "sync-beta",
    create: createSyncBetaHandler,
    request: (athleteId, authorization) =>
      jsonRequest("https://example.test/sync-beta", "POST", {
        user_id: athleteId,
        max_activities: 1,
      }, authorization),
    ownerRequest: (authorization) =>
      jsonRequest("https://example.test/sync-beta", "POST", {
        user_id: ATHLETE_A,
        max_activities: 0,
      }, authorization),
  },
  {
    name: "training-plan",
    create: createTrainingPlanHandler,
    request: (athleteId, authorization) =>
      new Request(
        `https://example.test/training-plan?athlete_id=${athleteId}&week_start_date=2026-08-24`,
        { headers: authorization ? { Authorization: authorization } : undefined },
      ),
    ownerRequest: (authorization) =>
      new Request(`https://example.test/training-plan?athlete_id=${ATHLETE_A}`, {
        headers: { Authorization: authorization },
      }),
  },
  {
    name: "identity-profile",
    create: createIdentityProfileHandler,
    request: (athleteId, authorization) =>
      jsonRequest("https://example.test/identity-profile", "POST", {
        athlete_id: athleteId,
        why_i_run: "health",
        core_values: ["consistency"],
      }, authorization),
    ownerRequest: (authorization) =>
      jsonRequest("https://example.test/identity-profile", "POST", {
        athlete_id: ATHLETE_A,
      }, authorization),
  },
  {
    name: "feedback-workout",
    create: createFeedbackWorkoutHandler,
    request: (athleteId, authorization) =>
      jsonRequest("https://example.test/feedback-workout", "POST", {
        athlete_id: athleteId,
        activity_id: 123,
      }, authorization),
    ownerRequest: (authorization) =>
      jsonRequest("https://example.test/feedback-workout", "POST", {
        athlete_id: ATHLETE_A,
      }, authorization),
  },
  {
    name: "check-milestones",
    create: createCheckMilestonesHandler,
    request: (athleteId, authorization) =>
      jsonRequest("https://example.test/check-milestones", "POST", {
        athlete_id: athleteId,
      }, authorization),
    ownerRequest: (authorization) =>
      jsonRequest("https://example.test/check-milestones", "POST", {
        athlete_id: ATHLETE_A,
      }, authorization),
  },
  {
    name: "backfill-splits",
    create: createBackfillSplitsHandler,
    request: (athleteId, authorization) =>
      jsonRequest("https://example.test/backfill-splits", "POST", {
        athlete_id: athleteId,
        limit: 1,
      }, authorization),
    ownerRequest: (authorization) =>
      jsonRequest("https://example.test/backfill-splits", "POST", {
        athlete_id: ATHLETE_A,
        limit: 0,
      }, authorization),
  },
  {
    name: "journal",
    create: createJournalHandler,
    request: (athleteId, authorization) =>
      new Request(`https://example.test/journal/${athleteId}`, {
        headers: authorization ? { Authorization: authorization } : undefined,
      }),
    ownerRequest: (authorization) =>
      new Request(`https://example.test/journal/${ATHLETE_A}`, {
        headers: { Authorization: authorization },
      }),
  },
];

for (const endpoint of endpointCases) {
  Deno.test(`${endpoint.name}: no token returns 401 before service access`, async () => {
    const guardCalls: Array<number | null> = [];
    let adminCalls = 0;
    const handler = endpoint.create({
      requireUser: createGuard(guardCalls),
      getAdmin: () => {
        adminCalls += 1;
        return createAdmin([]);
      },
    });

    const response = await handler(endpoint.request(ATHLETE_A));
    assertEquals(response.status, 401);
    assertEquals(adminCalls, 0);
  });

  Deno.test(`${endpoint.name}: invalid token returns 401 before service access`, async () => {
    let adminCalls = 0;
    const handler = endpoint.create({
      requireUser: createGuard([]),
      getAdmin: () => {
        adminCalls += 1;
        return createAdmin([]);
      },
    });

    const response = await handler(endpoint.request(ATHLETE_A, "Bearer invalid-token"));
    assertEquals(response.status, 401);
    assertEquals(adminCalls, 0);
  });

  Deno.test(`${endpoint.name}: athlete substitution returns 403 before service access`, async () => {
    const guardCalls: Array<number | null> = [];
    let adminCalls = 0;
    const handler = endpoint.create({
      requireUser: createGuard(guardCalls),
      getAdmin: () => {
        adminCalls += 1;
        return createAdmin([]);
      },
    });

    const response = await handler(endpoint.request(ATHLETE_B, "Bearer valid-token"));
    assertEquals(response.status, 403);
    assertEquals(guardCalls, [ATHLETE_B]);
    assertEquals(adminCalls, 0);
  });

  Deno.test(`${endpoint.name}: matching athlete reaches its domain contract`, async () => {
    const operations: QueryState[] = [];
    const handler = endpoint.create({
      requireUser: createGuard([]),
      getAdmin: () => createAdmin(operations),
    });

    const response = await handler(endpoint.ownerRequest("Bearer valid-token"));
    assert(response.status !== 401 && response.status !== 403, "matching owner must not receive an auth rejection");
  });
}

Deno.test("sync-beta rejects unbounded and invalid workloads before service access", async () => {
  const invalidBodies = [
    { user_id: ATHLETE_A, max_activities: 0 },
    { user_id: ATHLETE_A, max_activities: -1 },
    { user_id: ATHLETE_A, max_activities: 1.5 },
    { user_id: ATHLETE_A, max_activities: 501 },
    { user_id: ATHLETE_A, max_activities: 10, sync_all: true },
  ];

  for (const body of invalidBodies) {
    let adminCalls = 0;
    const handler = createSyncBetaHandler({
      requireUser: createGuard([]),
      getAdmin: () => {
        adminCalls += 1;
        return createAdmin([]);
      },
    });
    const response = await handler(
      jsonRequest("https://example.test/sync-beta", "POST", body, "Bearer valid-token"),
    );
    const payload = await response.json();
    assertEquals(response.status, 400);
    assertEquals(payload.error.code, "INVALID_REQUEST");
    assertEquals(adminCalls, 0);
  }
});

Deno.test("backfill-splits rejects invalid workloads before service access", async () => {
  for (const limit of [0, -1, 1.5, 101]) {
    let adminCalls = 0;
    const handler = createBackfillSplitsHandler({
      requireUser: createGuard([]),
      getAdmin: () => {
        adminCalls += 1;
        return createAdmin([]);
      },
    });
    const response = await handler(
      jsonRequest("https://example.test/backfill-splits", "POST", {
        athlete_id: ATHLETE_A,
        limit,
      }, "Bearer valid-token"),
    );
    const payload = await response.json();
    assertEquals(response.status, 400);
    assertEquals(payload.error.code, "INVALID_REQUEST");
    assertEquals(adminCalls, 0);
  }
});

Deno.test("journal supports path and query athlete IDs and clamps limits", async () => {
  const operations: QueryState[] = [];
  const guardCalls: Array<number | null> = [];
  const handler = createJournalHandler({
    requireUser: createGuard(guardCalls),
    getAdmin: () => createAdmin(operations),
  });

  const pathResponse = await handler(new Request(
    `https://example.test/journal/${ATHLETE_A}?limit=999`,
    { headers: { Authorization: "Bearer valid-token" } },
  ));
  const queryResponse = await handler(new Request(
    `https://example.test/journal?athlete_id=${ATHLETE_A}&limit=-5`,
    { headers: { Authorization: "Bearer valid-token" } },
  ));

  assertEquals(pathResponse.status, 200);
  assertEquals(queryResponse.status, 200);
  assertEquals(guardCalls, [ATHLETE_A, ATHLETE_A]);
  assertEquals(operations.map((operation) => operation.limit), [100, 1]);
});

Deno.test("journal generate-recent caps client work at four weeks", async () => {
  const operations: QueryState[] = [];
  const handler = createJournalHandler({
    requireUser: createGuard([]),
    getAdmin: () => createAdmin(operations),
  });

  const response = await handler(jsonRequest(
    "https://example.test/journal/generate-recent",
    "POST",
    { athlete_id: ATHLETE_A, weeks: 100 },
    "Bearer valid-token",
  ));

  assertEquals(response.status, 200);
  assertEquals(operations.filter((operation) => operation.table === "activities").length, 4);
});

Deno.test("user-races rejects missing and invalid tokens before service access", async () => {
  for (const authorization of [undefined, "Bearer invalid-token"]) {
    let adminCalls = 0;
    const handler = createUserRacesHandler({
      requireUser: createGuard([]),
      getAdmin: () => {
        adminCalls += 1;
        return createAdmin([]);
      },
      getEnv: () => "test-provider-credential",
    });
    const response = await handler(new Request("https://example.test/user-races", {
      headers: authorization ? { Authorization: authorization } : undefined,
    }));
    assertEquals(response.status, 401);
    assertEquals(adminCalls, 0);
  }
});

Deno.test("user-races stores exchanged credentials on the verified athlete base row", async () => {
  const operations: QueryState[] = [];
  const handler = createUserRacesHandler({
    requireUser: createGuard([]),
    getAdmin: () => createAdmin(operations, () => ({ data: null, error: null })),
    getEnv: () => "test-provider-credential",
    fetch: async () => new Response(JSON.stringify({
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
      expires_in: 3600,
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
  });

  const response = await handler(jsonRequest(
    "https://example.test/user-races?action=token",
    "POST",
    { code: "test-code", redirect_uri: "runaway://oauth" },
    "Bearer valid-token",
  ));

  assertEquals(response.status, 200);
  assertEquals(operations.length, 1);
  assertEquals(operations[0].table, "athletes");
  assertEquals(operations[0].filters, [["id", ATHLETE_A]]);
  assert(!operations.some((operation) => operation.table === "profiles"), "credentials must never use profiles");
});

Deno.test("user-races reads credentials from the verified athlete without returning them", async () => {
  const operations: QueryState[] = [];
  const handler = createUserRacesHandler({
    requireUser: createGuard([]),
    getAdmin: () => createAdmin(operations, (state) => {
      if (state.table === "athletes") {
        return {
          data: {
            runsignup_access_token: "test-access-token",
            runsignup_refresh_token: "test-refresh-token",
            runsignup_token_expires_at: "2999-01-01T00:00:00.000Z",
          },
          error: null,
        };
      }
      return { data: null, error: null };
    }),
    getEnv: () => "test-provider-credential",
    fetch: async () => new Response(JSON.stringify({ races: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  });

  const response = await handler(new Request("https://example.test/user-races", {
    headers: { Authorization: "Bearer valid-token" },
  }));
  const responseText = await response.text();

  assertEquals(response.status, 200);
  assertEquals(operations[0].table, "athletes");
  assertEquals(operations[0].filters, [["id", ATHLETE_A]]);
  assert(!operations.some((operation) => operation.table === "profiles"), "credentials must never use profiles");
  assert(!responseText.includes("test-access-token"), "credential values must not be returned");
  assert(!responseText.includes("test-refresh-token"), "credential values must not be returned");
}
);

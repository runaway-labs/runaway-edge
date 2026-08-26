import {
  createHandler,
  type ActivityReflectionRow,
  type ReflectionStore,
} from "./index.ts";

function assertEquals<T>(actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

const context = {
  authUserId: "11111111-1111-4111-8111-111111111111",
  athleteId: 42,
  authorization: "Bearer valid-token",
};

const reflection: ActivityReflectionRow = {
  id: "22222222-2222-4222-8222-222222222222",
  local_id: "33333333-3333-4333-8333-333333333333",
  activity_id: 99,
  athlete_id: context.athleteId,
  auth_user_id: context.authUserId,
  effort: 7,
  body_status: "good",
  mood: "steady",
  condition_tags: ["warm", "windy"],
  note: "Felt controlled.",
  local_debrief: "Strong, controlled work.",
  server_debrief: null,
  reflected_at: "2026-08-25T18:00:00.000Z",
  local_version: 1,
  server_version: 1,
  last_synced_at: "2026-08-25T18:01:00.000Z",
  created_at: "2026-08-25T18:01:00.000Z",
  updated_at: "2026-08-25T18:01:00.000Z",
};

function makeStore(overrides: Partial<ReflectionStore> = {}): ReflectionStore {
  return {
    findOwnedActivity: async () => ({
      id: reflection.activity_id,
      athlete_id: context.athleteId,
      auth_user_id: context.authUserId,
    }),
    findReflection: async () => reflection,
    upsertReflection: async () => reflection,
    ...overrides,
  };
}

Deno.test("activity-reflection rejects invalid reflection before database work", async () => {
  let databaseCalls = 0;
  const store = makeStore({
    findOwnedActivity: async () => {
      databaseCalls += 1;
      return null;
    },
  });
  const handler = createHandler({
    requireUser: async () => context,
    store,
  });

  const response = await handler(new Request("https://example.test/activity-reflection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ activity_id: 99, effort: 11 }),
  }));

  assertEquals(response.status, 400);
  assertEquals(databaseCalls, 0);
});

Deno.test("activity-reflection rejects an activity outside the authenticated athlete", async () => {
  let writes = 0;
  const store = makeStore({
    findOwnedActivity: async () => null,
    upsertReflection: async () => {
      writes += 1;
      return reflection;
    },
  });
  const handler = createHandler({ requireUser: async () => context, store });

  const response = await handler(new Request("https://example.test/activity-reflection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      local_id: reflection.local_id,
      activity_id: reflection.activity_id,
      effort: reflection.effort,
      body_status: reflection.body_status,
      mood: reflection.mood,
      condition_tags: reflection.condition_tags,
      note: reflection.note,
      local_debrief: reflection.local_debrief,
      server_debrief: reflection.server_debrief,
      reflected_at: reflection.reflected_at,
      local_version: reflection.local_version,
    }),
  }));

  assertEquals(response.status, 404);
  assertEquals(writes, 0);
});

Deno.test("activity-reflection derives ownership from auth and upserts once", async () => {
  let written: Record<string, unknown> | null = null;
  const store = makeStore({
    upsertReflection: async (value) => {
      written = value;
      return reflection;
    },
  });
  const handler = createHandler({ requireUser: async () => context, store });

  const response = await handler(new Request("https://example.test/activity-reflection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      local_id: reflection.local_id,
      activity_id: reflection.activity_id,
      athlete_id: 999,
      auth_user_id: "attacker-controlled",
      effort: reflection.effort,
      body_status: reflection.body_status,
      mood: reflection.mood,
      condition_tags: reflection.condition_tags,
      note: reflection.note,
      local_debrief: reflection.local_debrief,
      server_debrief: reflection.server_debrief,
      reflected_at: reflection.reflected_at,
      local_version: reflection.local_version,
    }),
  }));

  assertEquals(response.status, 200);
  assertEquals(written?.athlete_id, context.athleteId);
  assertEquals(written?.auth_user_id, context.authUserId);
  assertEquals(written?.server_debrief, reflection.server_debrief);
  assertEquals((await response.json()).reflection, reflection);
});

Deno.test("activity-reflection fetches one owned activity reflection", async () => {
  const handler = createHandler({ requireUser: async () => context, store: makeStore() });

  const response = await handler(new Request(
    `https://example.test/activity-reflection?activity_id=${reflection.activity_id}`,
    { headers: { Authorization: context.authorization } },
  ));

  assertEquals(response.status, 200);
  assertEquals((await response.json()).reflection, reflection);
});

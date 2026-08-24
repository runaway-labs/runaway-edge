import {
  createOAuthCallbackHandler,
  createOAuthInitiationHandler,
  scopeCredentialWrite,
  type CredentialScopeQuery,
  type OAuthBinding,
} from "./oauth-handler.ts";
import type { OAuthProvider } from "./oauth-state.ts";

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

const providers: OAuthProvider[] = ["strava", "garmin"];

for (const provider of providers) {
  Deno.test(`${provider} initiation requires the user guard before provider or admin work`, async () => {
    const events: string[] = [];
    const handler = createOAuthInitiationHandler({
      requireUser: async () => {
        events.push("guard");
        return { authUserId: "user-a", athleteId: 101 };
      },
      begin: async (_req, user) => {
        events.push("provider-admin");
        assertEquals(user, { authUserId: "user-a", athleteId: 101 });
        return new Response("started");
      },
      errorResponse: () => new Response("error", { status: 500 }),
      methodNotAllowedResponse: () => new Response("method", { status: 405 }),
    });

    const response = await handler(new Request("https://example.test", { method: "GET" }));

    assertEquals(response.status, 200);
    assertEquals(events, ["guard", "provider-admin"]);
  });

  Deno.test(`${provider} callback consumes state before exchange and scopes writes to the consumed pair`, async () => {
    const events: string[] = [];
    const filters: Array<[string, unknown]> = [];
    const binding: OAuthBinding = {
      authUserId: "11111111-1111-1111-1111-111111111111",
      athleteId: 101,
      redirectUrl: `runaway://${provider}-connected`,
    };
    const query: CredentialScopeQuery = {
      eq(column, value) {
        filters.push([column, value]);
        return this;
      },
    };
    const handler = createOAuthCallbackHandler({
      provider,
      consumeState: async () => {
        events.push("consume");
        return binding;
      },
      exchangeCode: async ({ binding: received }) => {
        events.push("exchange");
        assertEquals(received, binding);
        return { accessToken: "not-logged" };
      },
      writeCredentials: async (_token, received) => {
        events.push("write");
        scopeCredentialWrite(query, received);
      },
      successResponse: () => new Response(null, { status: 302 }),
      deniedResponse: () => new Response(null, { status: 302 }),
      failureResponse: () => new Response(null, { status: 302 }),
      invalidStateResponse: () => new Response("invalid", { status: 400 }),
    });

    const response = await handler(new Request(`https://example.test?state=${"a".repeat(43)}&code=provider-code`));

    assertEquals(response.status, 302);
    assertEquals(events, ["consume", "exchange", "write"]);
    assertEquals(filters, [
      ["id", 101],
      ["auth_user_id", "11111111-1111-1111-1111-111111111111"],
    ]);
  });

  Deno.test(`${provider} invalid or expired state causes zero provider calls and zero credential writes`, async () => {
    for (const reason of ["invalid", "expired"]) {
      let providerCalls = 0;
      let credentialWrites = 0;
      const handler = createOAuthCallbackHandler({
        provider,
        consumeState: async () => {
          throw new Error(reason);
        },
        exchangeCode: async () => {
          providerCalls += 1;
          return {};
        },
        writeCredentials: async () => {
          credentialWrites += 1;
        },
        successResponse: () => new Response(null, { status: 302 }),
        deniedResponse: () => new Response(null, { status: 302 }),
        failureResponse: () => new Response(null, { status: 302 }),
        invalidStateResponse: () => new Response("invalid", { status: 400 }),
      });

      const response = await handler(new Request(`https://example.test?state=${"b".repeat(43)}&code=provider-code`));
      assertEquals(response.status, 400);
      assertEquals(providerCalls, 0);
      assertEquals(credentialWrites, 0);
    }
  });

  Deno.test(`${provider} replayed state causes zero additional provider calls and credential writes`, async () => {
    let consumed = false;
    let providerCalls = 0;
    let credentialWrites = 0;
    const binding: OAuthBinding = {
      authUserId: "11111111-1111-1111-1111-111111111111",
      athleteId: 101,
      redirectUrl: `runaway://${provider}-connected`,
    };
    const handler = createOAuthCallbackHandler({
      provider,
      consumeState: async () => {
        if (consumed) throw new Error("replayed");
        consumed = true;
        return binding;
      },
      exchangeCode: async () => {
        providerCalls += 1;
        return {};
      },
      writeCredentials: async () => {
        credentialWrites += 1;
      },
      successResponse: () => new Response(null, { status: 302 }),
      deniedResponse: () => new Response(null, { status: 302 }),
      failureResponse: () => new Response(null, { status: 302 }),
      invalidStateResponse: () => new Response("invalid", { status: 400 }),
    });
    const request = () => new Request(`https://example.test?state=${"c".repeat(43)}&code=provider-code`);

    assertEquals((await handler(request())).status, 302);
    assertEquals((await handler(request())).status, 400);
    assertEquals(providerCalls, 1);
    assertEquals(credentialWrites, 1);
  });
}

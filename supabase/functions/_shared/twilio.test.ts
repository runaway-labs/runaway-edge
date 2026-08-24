import { createSmsSender } from "./twilio.ts";

function assertEquals<T>(actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

const configuredEnv = (name: string): string | undefined => ({
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
  TWILIO_AUTH_TOKEN: "auth-token",
  TWILIO_PHONE_NUMBER: "+15555550100",
})[name];

Deno.test("sendSms marks missing configuration as retryable before provider submission", async () => {
  let providerCalls = 0;
  let submissionCalls = 0;
  const sendSms = createSmsSender({
    getEnv: () => undefined,
    fetch: async () => {
      providerCalls += 1;
      return new Response("{}");
    },
  });

  const result = await sendSms("+15555550101", "test", async () => {
    submissionCalls += 1;
  });

  assertEquals(result.outcome, "pre_provider_failure");
  assertEquals(result.retryable, true);
  assertEquals(providerCalls, 0);
  assertEquals(submissionCalls, 0);
});

Deno.test("sendSms marks invalid recipients as retryable before provider submission", async () => {
  let providerCalls = 0;
  let submissionCalls = 0;
  const sendSms = createSmsSender({
    getEnv: configuredEnv,
    fetch: async () => {
      providerCalls += 1;
      return new Response("{}");
    },
  });

  const result = await sendSms("invalid", "test", async () => {
    submissionCalls += 1;
  });

  assertEquals(result.outcome, "pre_provider_failure");
  assertEquals(result.retryable, true);
  assertEquals(providerCalls, 0);
  assertEquals(submissionCalls, 0);
});

Deno.test("sendSms does not submit when the fenced submission transition fails", async () => {
  let providerCalls = 0;
  const sendSms = createSmsSender({
    getEnv: configuredEnv,
    fetch: async () => {
      providerCalls += 1;
      return new Response("{}");
    },
  });

  const result = await sendSms("+15555550101", "test", async () => {
    throw new Error("database unavailable");
  });

  assertEquals(result.outcome, "pre_provider_failure");
  assertEquals(result.retryable, true);
  assertEquals(providerCalls, 0);
});

Deno.test("sendSms marks network failures after submission as ambiguous and terminal", async () => {
  let submissionCalls = 0;
  const sendSms = createSmsSender({
    getEnv: configuredEnv,
    fetch: async () => {
      throw new Error("connection reset");
    },
  });

  const result = await sendSms("+15555550101", "test", async () => {
    submissionCalls += 1;
  });

  assertEquals(result.outcome, "ambiguous_submission");
  assertEquals(result.retryable, false);
  assertEquals(submissionCalls, 1);
});

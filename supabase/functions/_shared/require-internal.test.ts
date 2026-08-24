import {
  createRequireInternal,
  InternalAuthError,
} from "./require-internal.ts";

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function expectInternalAuthError(
  action: () => void,
  expected: { status: number; code: string; message: string },
): InternalAuthError {
  try {
    action();
  } catch (error) {
    if (!(error instanceof InternalAuthError)) {
      throw error;
    }

    assertEquals(error.status, expected.status);
    assertEquals(error.code, expected.code);
    assertEquals(error.message, expected.message);
    return error;
  }

  throw new Error(`Expected InternalAuthError ${expected.status} ${expected.code}`);
}

function request(secret?: string): Request {
  return new Request("https://example.test/internal-job", {
    method: "POST",
    headers: secret ? { "X-Runaway-Internal-Secret": secret } : undefined,
  });
}

Deno.test("requireInternal fails closed when the server secret is not configured", () => {
  const requireInternal = createRequireInternal(() => undefined);

  expectInternalAuthError(
    () => requireInternal(request("caller-secret")),
    {
      status: 500,
      code: "INTERNAL_AUTH_NOT_CONFIGURED",
      message: "Internal job authentication is not configured",
    },
  );
});

Deno.test("requireInternal gives the same stable error for missing and mismatched credentials", () => {
  const requireInternal = createRequireInternal(() => "server-secret");
  const expected = {
    status: 401,
    code: "INVALID_INTERNAL_CREDENTIALS",
    message: "Invalid internal job credentials",
  };

  const missing = expectInternalAuthError(() => requireInternal(request()), expected);
  const mismatched = expectInternalAuthError(
    () => requireInternal(request("wrong-caller-secret")),
    expected,
  );

  assertEquals(missing.message, mismatched.message);
  assertEquals(JSON.stringify(mismatched).includes("server-secret"), false);
  assertEquals(JSON.stringify(mismatched).includes("wrong-caller-secret"), false);
});

Deno.test("requireInternal accepts the exact internal credential", () => {
  const requireInternal = createRequireInternal(() => "server-secret");

  assertEquals(requireInternal(request("server-secret")), undefined);
});

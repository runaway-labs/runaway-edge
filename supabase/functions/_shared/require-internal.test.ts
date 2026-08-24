import {
  createRequireInternal,
  InternalAuthError,
} from "./require-internal.ts";

const VALID_SECRET = "0123456789abcdef".repeat(4);
const OTHER_VALID_SECRET = "fedcba9876543210".repeat(4);

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

Deno.test("requireInternal rejects malformed, non-canonical, and low-entropy server secrets", () => {
  const invalidSecrets = [
    "short",
    VALID_SECRET.toUpperCase(),
    `${VALID_SECRET} `,
    "0".repeat(64),
    "changeme",
    "YOUR_INTERNAL_JOB_SECRET",
  ];

  for (const secret of invalidSecrets) {
    const requireInternal = createRequireInternal(() => secret);
    expectInternalAuthError(
      () => requireInternal(request(VALID_SECRET)),
      {
        status: 500,
        code: "INTERNAL_AUTH_NOT_CONFIGURED",
        message: "Internal job authentication is not configured",
      },
    );
  }
});

Deno.test("requireInternal gives the same stable error for missing and mismatched credentials", () => {
  const requireInternal = createRequireInternal(() => VALID_SECRET);
  const expected = {
    status: 401,
    code: "INVALID_INTERNAL_CREDENTIALS",
    message: "Invalid internal job credentials",
  };

  const missing = expectInternalAuthError(() => requireInternal(request()), expected);
  const mismatched = expectInternalAuthError(
    () => requireInternal(request(OTHER_VALID_SECRET)),
    expected,
  );

  assertEquals(missing.message, mismatched.message);
  assertEquals(JSON.stringify(mismatched).includes(VALID_SECRET), false);
  assertEquals(JSON.stringify(mismatched).includes(OTHER_VALID_SECRET), false);
});

Deno.test("requireInternal normalizes malformed caller credentials to the stable 401", () => {
  const requireInternal = createRequireInternal(() => VALID_SECRET);
  const malformed = ["short", VALID_SECRET.toUpperCase(), "0".repeat(64)];

  for (const supplied of malformed) {
    expectInternalAuthError(
      () => requireInternal(request(supplied)),
      {
        status: 401,
        code: "INVALID_INTERNAL_CREDENTIALS",
        message: "Invalid internal job credentials",
      },
    );
  }
});

Deno.test("requireInternal accepts the exact internal credential", () => {
  const requireInternal = createRequireInternal(() => VALID_SECRET);

  assertEquals(requireInternal(request(VALID_SECRET)), undefined);
});

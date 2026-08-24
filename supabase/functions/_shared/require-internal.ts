const INTERNAL_SECRET_HEADER = "X-Runaway-Internal-Secret";
const MAX_SECRET_BYTES = 256;

export class InternalAuthError extends Error {
  status: number;
  code: string;

  constructor(
    status: number,
    code: string,
    message: string,
  ) {
    super(message);
    this.name = "InternalAuthError";
    this.status = status;
    this.code = code;
  }
}

function constantTimeEqual(expected: string, supplied: string): boolean {
  const encoder = new TextEncoder();
  const expectedBytes = encoder.encode(expected);
  const suppliedBytes = encoder.encode(supplied);
  let mismatch = expectedBytes.length ^ suppliedBytes.length;

  for (let index = 0; index < MAX_SECRET_BYTES; index += 1) {
    mismatch |= (expectedBytes[index] ?? 0) ^ (suppliedBytes[index] ?? 0);
  }

  return mismatch === 0;
}

export function createRequireInternal(
  getSecret: () => string | undefined,
): (req: Request) => void {
  return function requireInternal(req: Request): void {
    const configuredSecret = getSecret();

    if (!configuredSecret || new TextEncoder().encode(configuredSecret).length > MAX_SECRET_BYTES) {
      throw new InternalAuthError(
        500,
        "INTERNAL_AUTH_NOT_CONFIGURED",
        "Internal job authentication is not configured",
      );
    }

    const suppliedSecret = req.headers.get(INTERNAL_SECRET_HEADER) ?? "";

    if (!constantTimeEqual(configuredSecret, suppliedSecret)) {
      throw new InternalAuthError(
        401,
        "INVALID_INTERNAL_CREDENTIALS",
        "Invalid internal job credentials",
      );
    }
  };
}

export function internalAuthErrorResponse(
  error: unknown,
  headers: HeadersInit = {},
): Response {
  if (!(error instanceof InternalAuthError)) {
    throw error;
  }

  return new Response(
    JSON.stringify({ error: error.message, code: error.code }),
    {
      status: error.status,
      headers: { ...headers, "Content-Type": "application/json" },
    },
  );
}

export const requireInternal = createRequireInternal(() =>
  Deno.env.get("INTERNAL_JOB_SECRET")
);

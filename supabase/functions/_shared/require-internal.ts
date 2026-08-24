const INTERNAL_SECRET_HEADER = "X-Runaway-Internal-Secret";
const SECRET_BYTES = 32;
const SECRET_HEX_LENGTH = SECRET_BYTES * 2;

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

interface DecodedSecret {
  bytes: Uint8Array;
  valid: boolean;
}

function decodeCanonicalSecret(value: string | undefined): DecodedSecret {
  const bytes = new Uint8Array(SECRET_BYTES);
  const canonical =
    value !== undefined &&
    value.length === SECRET_HEX_LENGTH &&
    /^[0-9a-f]{64}$/.test(value) &&
    new Set(value).size >= 8;

  if (canonical) {
    for (let index = 0; index < SECRET_BYTES; index += 1) {
      bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    }
  }

  return { bytes, valid: canonical };
}

function constantTimeEqual(expected: DecodedSecret, supplied: DecodedSecret): boolean {
  let mismatch = Number(!expected.valid) | Number(!supplied.valid);

  for (let index = 0; index < SECRET_BYTES; index += 1) {
    mismatch |= expected.bytes[index] ^ supplied.bytes[index];
  }

  return mismatch === 0;
}

export function createRequireInternal(
  getSecret: () => string | undefined,
): (req: Request) => void {
  return function requireInternal(req: Request): void {
    const configuredSecret = decodeCanonicalSecret(getSecret());

    if (!configuredSecret.valid) {
      throw new InternalAuthError(
        500,
        "INTERNAL_AUTH_NOT_CONFIGURED",
        "Internal job authentication is not configured",
      );
    }

    const suppliedSecret = decodeCanonicalSecret(
      req.headers.get(INTERNAL_SECRET_HEADER) ?? undefined,
    );

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

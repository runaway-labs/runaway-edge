import {
  internalAuthErrorResponse,
  requireInternal,
} from "./require-internal.ts";

export type InternalOperation = (req: Request) => Promise<Response> | Response;
export type InternalRequestHandler = (req: Request) => Promise<Response>;

export interface InternalHandlerOptions {
  headers?: HeadersInit;
  authorize?: (req: Request) => void;
}

export type InternalHandlerFactory = (
  operation: InternalOperation,
  options?: InternalHandlerOptions,
) => InternalRequestHandler;

export const createInternalHandler: InternalHandlerFactory = (
  operation,
  options = {},
) => {
  const headers = options.headers ?? {};
  const authorize = options.authorize ?? requireInternal;

  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers });
    }

    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    try {
      authorize(req);
    } catch (error) {
      return internalAuthErrorResponse(error, headers);
    }

    return await operation(req);
  };
};

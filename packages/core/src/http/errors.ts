// Replyke error envelope: { error, code, field? } with a matching HTTP status.
import type { ContentfulStatusCode } from "hono/utils/http-status";

// The wire shape ({ error, code, field? }) lives in @agora-server/contract; re-exported for reference.
export type { ErrorEnvelope } from "@agora-server/contract";

export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,        // "feature/slug"
    message: string,
    public field?: string
  ) {
    super(message);
  }
}

// Common constructors mirroring Replyke's status codes.
export const Errors = {
  badRequest: (code: string, msg: string, field?: string) => new ApiError(400, code, msg, field),
  unauthorized: (code = "auth/unauthorized", msg = "Unauthorized") => new ApiError(401, code, msg),
  forbidden: (code = "auth/forbidden", msg = "Forbidden") => new ApiError(403, code, msg),
  notFound: (code = "common/not-found", msg = "Not found") => new ApiError(404, code, msg),
  conflict: (code: string, msg: string, field?: string) => new ApiError(409, code, msg, field),
  tooLarge: (code: string, msg: string, field?: string) => new ApiError(413, code, msg, field),
  rateLimited: (msg = "Too many requests") => new ApiError(429, "common/rate-limited", msg),
  tooManyRequests: (code = "common/rate-limited", msg = "Too many requests", field?: string) => new ApiError(429, code, msg, field),
  notImplemented: (code = "common/not-implemented") =>
    new ApiError(501 as ContentfulStatusCode, code, "Endpoint not implemented yet"),
  unavailable: (code = "common/unavailable", msg = "Service unavailable") =>
    new ApiError(503 as ContentfulStatusCode, code, msg),
};

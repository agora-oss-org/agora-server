// Replyke error envelope: { error, code, field? } with a matching HTTP status.
import type { ContentfulStatusCode } from "hono/utils/http-status";

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
  rateLimited: (msg = "Too many requests") => new ApiError(429, "common/rate-limited", msg),
  notImplemented: (code = "common/not-implemented") =>
    new ApiError(501 as ContentfulStatusCode, code, "Endpoint not implemented yet"),
};

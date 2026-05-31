// Same Replyke-shaped error envelope as @agora/api: { error, code, field? } + matching HTTP status.
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type { ErrorEnvelope } from "@agora/contract";

export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string, // "feature/slug"
    message: string,
    public field?: string
  ) {
    super(message);
  }
}

export const Errors = {
  badRequest: (code: string, msg: string, field?: string) => new ApiError(400, code, msg, field),
  unauthorized: (code = "auth/unauthorized", msg = "Unauthorized") => new ApiError(401, code, msg),
  forbidden: (code = "auth/forbidden", msg = "Forbidden") => new ApiError(403, code, msg),
  notFound: (code = "common/not-found", msg = "Not found") => new ApiError(404, code, msg),
  unavailable: (code: string, msg: string) => new ApiError(503 as ContentfulStatusCode, code, msg),
};

// Server-side request validation. The zod request schemas now live in @agora-server/contract
// (shared 1:1 with the admin frontend) and are re-exported here so existing `./validation.js`
// importers keep working unchanged. parseBody() stays server-side — it depends on Errors.
import { z } from "zod";
import { Errors } from "../http/errors.js";

export * from "@agora-server/contract";

/** Validate a parsed JSON body; throw Errors.badRequest with the offending field. */
export function parseBody<T>(schema: z.ZodType<T>, raw: unknown, feature: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path.join(".") || undefined;
    throw Errors.badRequest(`${feature}/invalid-body`, issue?.message ?? "Invalid body", field);
  }
  return result.data;
}

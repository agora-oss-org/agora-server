// Pagination: the { data, pagination } envelope shape + paginate() now live in @agora-server/contract
// (shared with the admin frontend) and are re-exported here so existing `./envelope.js` importers
// keep working. readPagination stays server-side — it parses a Hono request.
import type { Context } from "hono";
export type { PaginationMeta, PaginatedResponse } from "@agora-server/contract";
export { paginate } from "@agora-server/contract";

/** Parse ?page= & ?limit= into safe offset pagination. */
export function readPagination(c: Context, defaults = { page: 1, limit: 20 }) {
  const page = Math.max(1, Number(c.req.query("page") ?? defaults.page) || defaults.page);
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? defaults.limit) || defaults.limit));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

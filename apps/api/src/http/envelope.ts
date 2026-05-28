// Response envelope helpers matching @replyke/core's PaginatedResponse + pagination meta.
import type { Context } from "hono";

export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalPages: number;
  totalItems: number;
  hasMore: boolean;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: PaginationMeta;
}

/** Parse ?page= & ?limit= into safe offset pagination. */
export function readPagination(c: Context, defaults = { page: 1, limit: 20 }) {
  const page = Math.max(1, Number(c.req.query("page") ?? defaults.page) || defaults.page);
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? defaults.limit) || defaults.limit));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

/** Build the standard { data, pagination } envelope. */
export function paginate<T>(data: T[], totalItems: number, page: number, pageSize: number): PaginatedResponse<T> {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  return {
    data,
    pagination: { page, pageSize, totalPages, totalItems, hasMore: page < totalPages },
  };
}

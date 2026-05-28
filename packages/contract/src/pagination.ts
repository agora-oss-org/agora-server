// Response envelope helpers matching @replyke/core's PaginatedResponse + pagination meta.
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

/** Build the standard { data, pagination } envelope. */
export function paginate<T>(data: T[], totalItems: number, page: number, pageSize: number): PaginatedResponse<T> {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  return {
    data,
    pagination: { page, pageSize, totalPages, totalItems, hasMore: page < totalPages },
  };
}

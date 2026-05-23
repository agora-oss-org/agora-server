import { describe, it, expect } from "vitest";
import { paginate, readPagination } from "./envelope.js";

describe("paginate", () => {
  it("computes pagination metadata with hasMore mid-list", () => {
    const { data, pagination } = paginate([1, 2, 3], 93, 1, 20);
    expect(data).toEqual([1, 2, 3]);
    expect(pagination).toEqual({ page: 1, pageSize: 20, totalPages: 5, totalItems: 93, hasMore: true });
  });

  it("sets hasMore=false on the last page", () => {
    expect(paginate([], 93, 5, 20).pagination.hasMore).toBe(false);
  });

  it("reports at least one page when empty", () => {
    expect(paginate([], 0, 1, 20).pagination).toMatchObject({ totalPages: 1, totalItems: 0, hasMore: false });
  });
});

describe("readPagination", () => {
  const ctx = (q: Record<string, string>) => ({ req: { query: (k: string) => q[k] } }) as any;

  it("applies defaults when params are absent", () => {
    expect(readPagination(ctx({}))).toEqual({ page: 1, limit: 20, offset: 0 });
  });

  it("computes offset from page and limit", () => {
    expect(readPagination(ctx({ page: "3", limit: "10" }))).toEqual({ page: 3, limit: 10, offset: 20 });
  });

  it("clamps limit to [1,100] and page to >=1", () => {
    expect(readPagination(ctx({ page: "0", limit: "999" }))).toMatchObject({ page: 1, limit: 100 });
    // negative is truthy so it reaches the clamp; "0" is falsy and falls back to the default
    expect(readPagination(ctx({ limit: "-5" })).limit).toBe(1);
    expect(readPagination(ctx({ limit: "0" })).limit).toBe(20);
  });

  it("falls back to defaults on non-numeric input", () => {
    expect(readPagination(ctx({ page: "abc", limit: "xyz" }))).toEqual({ page: 1, limit: 20, offset: 0 });
  });
});

import { describe, it, expect } from "vitest";
import { paginate } from "./pagination.js";

describe("paginate() envelope", () => {
  it("wraps data and computes meta for a first page with more to come", () => {
    const data = [1, 2, 3];
    const res = paginate(data, 10, 1, 3);
    expect(res.data).toBe(data); // passed through, not copied
    expect(res.pagination).toEqual({
      page: 1,
      pageSize: 3,
      totalPages: 4, // ceil(10/3)
      totalItems: 10,
      hasMore: true,
    });
  });

  it("reports hasMore=false on the last page", () => {
    const res = paginate([10], 10, 4, 3); // page 4 of 4
    expect(res.pagination.totalPages).toBe(4);
    expect(res.pagination.hasMore).toBe(false);
  });

  it("reports hasMore=false on an exact page boundary", () => {
    // 9 items / pageSize 3 = exactly 3 pages, none partial
    expect(paginate([], 9, 3, 3).pagination).toMatchObject({ totalPages: 3, hasMore: false });
    expect(paginate([], 9, 2, 3).pagination.hasMore).toBe(true);
  });

  it("clamps totalPages to a minimum of 1 when there are no items", () => {
    const res = paginate([], 0, 1, 20);
    expect(res.pagination).toEqual({
      page: 1,
      pageSize: 20,
      totalPages: 1, // Math.max(1, ceil(0/20))
      totalItems: 0,
      hasMore: false,
    });
  });

  it("reports hasMore=false for a page past the end", () => {
    const res = paginate([], 5, 9, 10); // only 1 page of data, asked for page 9
    expect(res.pagination.totalPages).toBe(1);
    expect(res.pagination.hasMore).toBe(false);
  });

  it("handles a single partial page", () => {
    expect(paginate([1, 2], 2, 1, 20).pagination).toMatchObject({ totalPages: 1, hasMore: false });
  });
});

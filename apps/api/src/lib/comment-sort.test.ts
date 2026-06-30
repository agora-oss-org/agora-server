import { describe, it, expect } from "vitest";
import { resolveCommentSort, commentOrderBy } from "./comment-sort.js";

describe("resolveCommentSort", () => {
  it("createdAt honors sortDir, default desc, not deprecated", () => {
    expect(resolveCommentSort("createdAt", undefined)).toEqual({ column: "createdAt", dir: "desc", deprecated: false });
    expect(resolveCommentSort("createdAt", "asc")).toEqual({ column: "createdAt", dir: "asc", deprecated: false });
    expect(resolveCommentSort("createdAt", "desc")).toEqual({ column: "createdAt", dir: "desc", deprecated: false });
  });

  it("maps the deprecated aliases to createdAt with a fixed direction", () => {
    expect(resolveCommentSort("new", undefined)).toEqual({ column: "createdAt", dir: "desc", deprecated: true });
    expect(resolveCommentSort("old", undefined)).toEqual({ column: "createdAt", dir: "asc", deprecated: true });
    // aliases ignore sortDir
    expect(resolveCommentSort("new", "asc")).toEqual({ column: "createdAt", dir: "desc", deprecated: true });
    expect(resolveCommentSort("old", "desc")).toEqual({ column: "createdAt", dir: "asc", deprecated: true });
  });

  it("top and controversial are always desc and not deprecated", () => {
    expect(resolveCommentSort("top", "asc")).toEqual({ column: "top", dir: "desc", deprecated: false });
    expect(resolveCommentSort("controversial", "asc")).toEqual({ column: "controversial", dir: "desc", deprecated: false });
  });

  it("coerces unknown/absent sortBy to createdAt desc (not deprecated)", () => {
    expect(resolveCommentSort(undefined, undefined)).toEqual({ column: "createdAt", dir: "desc", deprecated: false });
    expect(resolveCommentSort("bogus", undefined)).toEqual({ column: "createdAt", dir: "desc", deprecated: false });
  });
});

describe("commentOrderBy", () => {
  it("returns a non-empty ORDER BY list for every column", () => {
    for (const column of ["createdAt", "top", "controversial"] as const) {
      const order = commentOrderBy({ column, dir: "desc", deprecated: false });
      expect(Array.isArray(order)).toBe(true);
      expect(order.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("createdAt asc vs desc both produce a 2-clause order", () => {
    expect(commentOrderBy({ column: "createdAt", dir: "asc", deprecated: false }).length).toBe(2);
    expect(commentOrderBy({ column: "createdAt", dir: "desc", deprecated: false }).length).toBe(2);
  });
});

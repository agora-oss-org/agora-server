import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { resolveCommentSort, commentOrderBy } from "./comment-sort.js";

// Serialize one ORDER BY clause to inspect its direction (asc|desc) and the bound params (jsonb keys).
// Bound values (e.g. "upvote") are parameters, so they appear in `params`, not the SQL text.
const dialect = new PgDialect();
const ser = (clause: SQL) => {
  const q = dialect.sqlToQuery(clause);
  return { sql: q.sql.toLowerCase(), params: q.params };
};

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

  it("createdAt honors direction in the emitted SQL, with a stable id-desc tiebreaker", () => {
    const ascOrder = commentOrderBy({ column: "createdAt", dir: "asc", deprecated: false });
    const descOrder = commentOrderBy({ column: "createdAt", dir: "desc", deprecated: false });
    expect(ascOrder.length).toBe(2);
    expect(descOrder.length).toBe(2);
    // Primary clause direction actually reflects `dir` (not hardcoded).
    expect(ser(ascOrder[0]!).sql).toContain("created_at");
    expect(ser(ascOrder[0]!).sql).toContain("asc");
    expect(ser(descOrder[0]!).sql).toContain("desc");
    // Tiebreaker is always id desc for deterministic keyset pagination, regardless of primary dir.
    expect(ser(ascOrder[1]!).sql).toContain("id");
    expect(ser(ascOrder[1]!).sql).toContain("desc");
  });

  it("top ranks by upvote count desc, tie-broken by createdAt", () => {
    const order = commentOrderBy({ column: "top", dir: "asc", deprecated: false }); // dir ignored for top
    const first = ser(order[0]!);
    expect(first.sql).toContain("coalesce");
    expect(first.sql).toContain("desc"); // always desc, never asc
    expect(first.params).toContain("upvote"); // ranks on the upvote jsonb key
    expect(ser(order[1]!).sql).toContain("created_at");
  });

  it("controversial ranks by least(up,down) desc, then sum desc, matching the entity formula", () => {
    const order = commentOrderBy({ column: "controversial", dir: "asc", deprecated: false }); // dir ignored
    expect(order.length).toBe(3);
    const first = ser(order[0]!);
    expect(first.sql).toContain("least");
    expect(first.sql).toContain("desc");
    expect(first.params).toEqual(expect.arrayContaining(["upvote", "downvote"]));
    const second = ser(order[1]!);
    expect(second.sql).toContain("+"); // sum(up, down)
    expect(second.sql).toContain("desc");
    expect(ser(order[2]!).sql).toContain("id"); // deterministic tiebreaker
  });
});

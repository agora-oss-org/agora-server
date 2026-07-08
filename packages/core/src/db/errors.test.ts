// Unit tests for isDbConnectionError — the classifier that decides whether a thrown DB error is a
// *reachability* failure (→ retryable 503) or a query/constraint error (→ 500, a real bug). No DB.
import { describe, expect, it } from "vitest";
import { isDbConnectionError } from "./errors.js";

describe("isDbConnectionError", () => {
  // postgres.js (pinned ^3.4.9) connection-lifecycle codes — src/errors.js `Errors.connection`.
  it.each(["CONNECT_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED"])(
    "returns true for the postgres.js connection code %s",
    (code) => {
      expect(isDbConnectionError(Object.assign(new Error("write " + code), { code }))).toBe(true);
    },
  );

  // Raw Node socket / DNS codes postgres.js surfaces verbatim for an unreachable host.
  it.each(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH", "ECONNRESET"])(
    "returns true for the Node socket/DNS code %s",
    (code) => {
      expect(isDbConnectionError(Object.assign(new Error(code), { code }))).toBe(true);
    },
  );

  // Postgres SQLSTATE query/constraint codes must NOT be mapped — those are bugs/bad data, not
  // "the DB is down", and must keep surfacing as 500 so real defects aren't masked.
  it.each([
    ["23503", "foreign-key violation"],
    ["23505", "unique violation"],
    ["42601", "syntax error"],
    ["42P01", "undefined table"],
    ["22P02", "invalid uuid text"],
  ])("returns false for the query/constraint SQLSTATE %s (%s)", (code) => {
    expect(isDbConnectionError(Object.assign(new Error("boom"), { code }))).toBe(false);
  });

  it("returns false for an error with no code", () => {
    expect(isDbConnectionError(new Error("plain"))).toBe(false);
  });

  it("returns false for a non-string code", () => {
    expect(isDbConnectionError(Object.assign(new Error("x"), { code: 500 }))).toBe(false);
  });

  it("returns false for null / undefined / a bare string", () => {
    expect(isDbConnectionError(null)).toBe(false);
    expect(isDbConnectionError(undefined)).toBe(false);
    expect(isDbConnectionError("ECONNREFUSED")).toBe(false);
  });
});

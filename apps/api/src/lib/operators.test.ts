import { afterEach, describe, expect, it, vi } from "vitest";

// env.ts parses process.env at import time, and operators.ts builds its two allowlist Sets at module
// import time from `env.OPERATOR_USER_IDS` / `env.OPERATOR_EMAILS`. So each case clears those vars,
// resets the module registry, assigns the test env, and re-imports operators.js for a fresh `isOperator`.
const ORIGINAL_ENV = { ...process.env };
const OPERATOR_KEYS = ["OPERATOR_USER_IDS", "OPERATOR_EMAILS"] as const;

async function loadIsOperator(envVars: Partial<Record<(typeof OPERATOR_KEYS)[number], string>>) {
  vi.resetModules();
  for (const k of OPERATOR_KEYS) delete process.env[k];
  Object.assign(process.env, envVars);
  return (await import("./operators.js")).isOperator;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("isOperator (operators)", () => {
  it("returns false for any profile when unconfigured (neither var set)", async () => {
    const isOperator = await loadIsOperator({});
    expect(isOperator({ id: "u1", email: "someone@example.com" })).toBe(false);
    expect(isOperator({ id: "u1" })).toBe(false);
    expect(isOperator({ id: "u1", email: null })).toBe(false);
  });

  describe("OPERATOR_USER_IDS (match by id)", () => {
    it("matches a single configured id", async () => {
      const isOperator = await loadIsOperator({ OPERATOR_USER_IDS: "id-abc" });
      expect(isOperator({ id: "id-abc" })).toBe(true);
    });

    it("matches one of a comma-separated list", async () => {
      const isOperator = await loadIsOperator({ OPERATOR_USER_IDS: "id-1,id-2,id-3" });
      expect(isOperator({ id: "id-2" })).toBe(true);
      expect(isOperator({ id: "id-3" })).toBe(true);
    });

    it("trims whitespace around commas", async () => {
      const isOperator = await loadIsOperator({ OPERATOR_USER_IDS: " id-1 ,  id-2  , id-3 " });
      expect(isOperator({ id: "id-1" })).toBe(true);
      expect(isOperator({ id: "id-2" })).toBe(true);
      expect(isOperator({ id: "id-3" })).toBe(true);
    });

    it("returns false for a non-matching id", async () => {
      const isOperator = await loadIsOperator({ OPERATOR_USER_IDS: "id-1,id-2" });
      expect(isOperator({ id: "id-nope" })).toBe(false);
    });
  });

  describe("OPERATOR_EMAILS (match by email, case-insensitively)", () => {
    it("matches a profile email regardless of case (allowlist mixed-case, profile lower)", async () => {
      const isOperator = await loadIsOperator({ OPERATOR_EMAILS: "Admin@Example.com" });
      expect(isOperator({ id: "u1", email: "admin@example.com" })).toBe(true);
    });

    it("matches when the profile email is mixed-case and the allowlist is lower", async () => {
      const isOperator = await loadIsOperator({ OPERATOR_EMAILS: "admin@example.com" });
      expect(isOperator({ id: "u1", email: "Admin@Example.com" })).toBe(true);
    });

    it("returns false for a non-matching email", async () => {
      const isOperator = await loadIsOperator({ OPERATOR_EMAILS: "admin@example.com" });
      expect(isOperator({ id: "u1", email: "other@example.com" })).toBe(false);
    });

    it("returns false for a null or undefined email", async () => {
      const isOperator = await loadIsOperator({ OPERATOR_EMAILS: "admin@example.com" });
      expect(isOperator({ id: "u1", email: null })).toBe(false);
      expect(isOperator({ id: "u1", email: undefined })).toBe(false);
      expect(isOperator({ id: "u1" })).toBe(false);
    });
  });

  describe("id and email matches are independent", () => {
    it("matches by id even when email is absent", async () => {
      const isOperator = await loadIsOperator({
        OPERATOR_USER_IDS: "id-op",
        OPERATOR_EMAILS: "admin@example.com",
      });
      expect(isOperator({ id: "id-op" })).toBe(true);
    });

    it("matches by email even when the id doesn't match", async () => {
      const isOperator = await loadIsOperator({
        OPERATOR_USER_IDS: "id-op",
        OPERATOR_EMAILS: "admin@example.com",
      });
      expect(isOperator({ id: "not-an-operator-id", email: "admin@example.com" })).toBe(true);
    });
  });

  describe("empty-string env values are treated as unset", () => {
    it("does not match a profile with an empty-string id against an empty/unset id allowlist", async () => {
      const isOperator = await loadIsOperator({ OPERATOR_USER_IDS: "" });
      expect(isOperator({ id: "" })).toBe(false);
      expect(isOperator({ id: "", email: "" })).toBe(false);
    });

    it("does not match a profile with an empty-string email against an empty/unset email allowlist", async () => {
      const isOperator = await loadIsOperator({ OPERATOR_EMAILS: "" });
      expect(isOperator({ id: "u1", email: "" })).toBe(false);
    });
  });
});

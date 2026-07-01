import { describe, it, expect } from "vitest";
import { dbTargetHost, isLocalHost, isProtectedTarget } from "./db-target.mjs";

describe("dbTargetHost", () => {
  it("extracts the hostname (ignoring port/user/pw)", () => {
    expect(dbTargetHost("postgres://postgres:pw@db:5432/postgres")).toBe("db");
    expect(dbTargetHost("postgresql://postgres.ref:pw@aws-1-us-west-2.pooler.supabase.com:6543/postgres"))
      .toBe("aws-1-us-west-2.pooler.supabase.com");
  });
  it("returns null for an unparseable url", () => {
    expect(dbTargetHost("not a url")).toBeNull();
    expect(dbTargetHost(undefined)).toBeNull();
  });
});

describe("isLocalHost", () => {
  it("is true for db / localhost / 127.0.0.1", () => {
    expect(isLocalHost("postgres://postgres:pw@db:5432/postgres")).toBe(true);
    expect(isLocalHost("postgres://postgres:pw@localhost:5432/postgres")).toBe(true);
    expect(isLocalHost("postgres://postgres:pw@127.0.0.1:5432/postgres")).toBe(true);
  });
  it("is false for a cloud pooler host", () => {
    expect(isLocalHost("postgresql://postgres.ref:pw@aws-1-us-west-2.pooler.supabase.com:6543/postgres")).toBe(false);
  });
  it("is false (fail-safe) for an unparseable/missing url", () => {
    expect(isLocalHost("garbage")).toBe(false);
    expect(isLocalHost(undefined)).toBe(false);
  });
});

describe("isProtectedTarget", () => {
  // Not protected: a LOCAL host on a non-prod deployment — the safe throwaway `--force` may drop.
  it("is false for a local host on dev/selfhost (safe throwaway)", () => {
    expect(isProtectedTarget({ agoraEnv: "dev", databaseUrl: "postgres://postgres:pw@localhost:5432/postgres" })).toBe(false);
    expect(isProtectedTarget({ agoraEnv: "selfhost", databaseUrl: "postgres://postgres:pw@db:5432/postgres" })).toBe(false);
    expect(isProtectedTarget({ databaseUrl: "postgres://postgres:pw@db:5432/postgres" })).toBe(false); // no marker
  });
  // Protected because the host is cloud/remote — regardless of the marker (the marker can lie).
  it("is true for a cloud host on any non-prod marker", () => {
    const cloud = "postgresql://postgres.ref:pw@aws-1-us-west-2.pooler.supabase.com:6543/postgres";
    expect(isProtectedTarget({ agoraEnv: "dev", databaseUrl: cloud })).toBe(true);
    expect(isProtectedTarget({ agoraEnv: "selfhost", databaseUrl: cloud })).toBe(true);
    expect(isProtectedTarget({ databaseUrl: cloud })).toBe(true);
  });
  // Protected because AGORA_ENV=prod — even against a LOCAL db (production data is precious).
  it("is true for AGORA_ENV=prod even on a local host", () => {
    expect(isProtectedTarget({ agoraEnv: "prod", databaseUrl: "postgres://postgres:pw@db:5432/postgres" })).toBe(true);
    expect(isProtectedTarget({ agoraEnv: "prod", databaseUrl: "postgres://postgres:pw@localhost:5432/postgres" })).toBe(true);
  });
  // Fail-safe: an unparseable/missing url with no prod marker is treated as non-local → protected.
  it("is true (fail-safe) for an unparseable/missing url", () => {
    expect(isProtectedTarget({ databaseUrl: "garbage" })).toBe(true);
    expect(isProtectedTarget({})).toBe(true);
  });
});

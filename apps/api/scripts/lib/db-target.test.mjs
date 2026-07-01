import { describe, it, expect } from "vitest";
import { dbTargetHost, isLocalTarget } from "./db-target.mjs";

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

describe("isLocalTarget", () => {
  it("is true when AGORA_ENV=selfhost regardless of host", () => {
    expect(isLocalTarget({ agoraEnv: "selfhost", databaseUrl: "postgresql://x:y@cloud.example.com:6543/postgres" })).toBe(true);
  });
  it("is true for db / localhost / 127.0.0.1 hosts", () => {
    expect(isLocalTarget({ databaseUrl: "postgres://postgres:pw@db:5432/postgres" })).toBe(true);
    expect(isLocalTarget({ databaseUrl: "postgres://postgres:pw@localhost:5432/postgres" })).toBe(true);
    expect(isLocalTarget({ databaseUrl: "postgres://postgres:pw@127.0.0.1:5432/postgres" })).toBe(true);
  });
  it("is false for a cloud pooler host with no selfhost marker", () => {
    expect(isLocalTarget({ agoraEnv: "prod", databaseUrl: "postgresql://postgres.ref:pw@aws-1-us-west-2.pooler.supabase.com:6543/postgres" })).toBe(false);
    expect(isLocalTarget({ agoraEnv: "dev", databaseUrl: "postgresql://postgres.ref:pw@aws-1-us-west-2.pooler.supabase.com:6543/postgres" })).toBe(false);
  });
  it("is false (fail-safe toward confirmation) when the url is unparseable and no marker", () => {
    expect(isLocalTarget({ databaseUrl: "garbage" })).toBe(false);
    expect(isLocalTarget({})).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { buildAppleClaims } from "./apple-secret.mjs";

const ARGS = { teamId: "TEAM123456", clientId: "org.example.agora.web", keyId: "KEY1234567", now: 1_750_000_000 };

describe("buildAppleClaims", () => {
  it("builds the ES256 header and Apple-audience payload", () => {
    const { header, payload } = buildAppleClaims(ARGS);
    expect(header).toEqual({ alg: "ES256", kid: "KEY1234567", typ: "JWT" });
    expect(payload).toEqual({
      iss: "TEAM123456",
      sub: "org.example.agora.web",
      aud: "https://appleid.apple.com",
      iat: 1_750_000_000,
      exp: 1_750_000_000 + 180 * 86400,
    });
  });

  it("honors a shorter custom lifetime", () => {
    const { payload } = buildAppleClaims({ ...ARGS, days: 30 });
    expect(payload.exp - payload.iat).toBe(30 * 86400);
  });

  it("rejects a lifetime over Apple's 180-day cap", () => {
    expect(() => buildAppleClaims({ ...ARGS, days: 181 })).toThrow(/180/);
  });

  it("rejects missing required fields", () => {
    expect(() => buildAppleClaims({ ...ARGS, teamId: "" })).toThrow(/teamId/);
  });
});

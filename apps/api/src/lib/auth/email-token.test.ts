import { describe, it, expect } from "vitest";
import { generateEmailToken, hashEmailToken } from "./email-token.js";

describe("email tokens", () => {
  it("generates a raw token plus a matching sha256 hash; raw != hash", () => {
    const { raw, hash } = generateEmailToken();
    expect(raw.length).toBeGreaterThan(20);
    expect(hash).not.toEqual(raw);
    expect(hashEmailToken(raw)).toEqual(hash);
  });
  it("hashing is deterministic and distinct per token", () => {
    const a = generateEmailToken();
    const b = generateEmailToken();
    expect(a.raw).not.toEqual(b.raw);
    expect(hashEmailToken(a.raw)).toEqual(a.hash);
    expect(a.hash).not.toEqual(b.hash);
  });
});

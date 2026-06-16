import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("password hashing (argon2id)", () => {
  it("hashes to a non-plaintext PHC string and verifies the correct password", async () => {
    const hash = await hashPassword("CorrectHorse9!");
    expect(hash).not.toContain("CorrectHorse9!");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, "CorrectHorse9!")).toBe(true);
  });
  it("rejects a wrong password and never throws on a garbage hash", async () => {
    const hash = await hashPassword("CorrectHorse9!");
    expect(await verifyPassword(hash, "wrong")).toBe(false);
    expect(await verifyPassword("not-a-hash", "whatever")).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { jwtVerify } from "jose";
import { buildGotrueKeys } from "./gotrue-keys.mjs";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW = 1_750_000_000; // fixed epoch seconds — keys must be deterministic given (secret, now)

describe("buildGotrueKeys", () => {
  it("signs anon and service_role JWTs verifiable with the same secret", async () => {
    const { anonKey, serviceKey } = await buildGotrueKeys({ secret: SECRET, now: NOW });
    const key = new TextEncoder().encode(SECRET);
    const anon = await jwtVerify(anonKey, key);
    const service = await jwtVerify(serviceKey, key);
    expect(anon.payload.role).toBe("anon");
    expect(service.payload.role).toBe("service_role");
    expect(anon.protectedHeader.alg).toBe("HS256");
  });

  it("stamps iss=supabase and a 10-year lifetime", async () => {
    const { anonKey } = await buildGotrueKeys({ secret: SECRET, now: NOW });
    const { payload } = await jwtVerify(anonKey, new TextEncoder().encode(SECRET));
    expect(payload.iss).toBe("supabase");
    expect(payload.iat).toBe(NOW);
    expect(payload.exp).toBe(NOW + 10 * 365 * 24 * 3600);
  });

  it("rejects a secret shorter than 32 chars", async () => {
    await expect(buildGotrueKeys({ secret: "short", now: NOW })).rejects.toThrow(/32/);
  });
});

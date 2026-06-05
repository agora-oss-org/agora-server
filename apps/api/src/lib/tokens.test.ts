import { jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { signAccessToken } from "./tokens.js";

// signAccessToken is pure crypto: it deterministically shapes an HS256 access JWT (sub/role/operator
// claims) over ACCESS_TOKEN_SECRET — no DB, no network. The unit vitest config supplies the secret.
const secret = new TextEncoder().encode(process.env.ACCESS_TOKEN_SECRET!);

describe("signAccessToken", () => {
  it("mints a verifiable HS256 token with sub = profileId", async () => {
    const token = await signAccessToken("profile-123", "visitor");
    const { payload, protectedHeader } = await jwtVerify(token, secret);
    expect(protectedHeader.alg).toBe("HS256");
    expect(payload.sub).toBe("profile-123");
    expect(payload.role).toBe("visitor");
  });

  it("defaults the operator claim to false", async () => {
    const token = await signAccessToken("p", "visitor");
    const { payload } = await jwtVerify(token, secret);
    expect(payload.operator).toBe(false);
  });

  it("carries operator = true when requested", async () => {
    const token = await signAccessToken("p", "admin", true);
    const { payload } = await jwtVerify(token, secret);
    expect(payload.operator).toBe(true);
    expect(payload.role).toBe("admin");
  });

  it("sets iat and a future exp (TTL window)", async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await signAccessToken("p", "visitor");
    const { payload } = await jwtVerify(token, secret);
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect(payload.exp!).toBeGreaterThan(payload.iat!);
    // exp must be in the future relative to issuance.
    expect(payload.exp!).toBeGreaterThanOrEqual(before);
  });

  it("fails verification under the wrong secret", async () => {
    const token = await signAccessToken("p", "visitor");
    const wrong = new TextEncoder().encode("a-totally-different-secret-value-here");
    await expect(jwtVerify(token, wrong)).rejects.toThrow();
  });
});

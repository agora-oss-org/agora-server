import { jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { signAccessToken } from "./tokens.js";

// signAccessToken is pure crypto: it deterministically shapes an HS256 access JWT (sub/role/operator
// claims) over ACCESS_TOKEN_SECRET — no DB, no network. The unit vitest config supplies the secret.
const secret = new TextEncoder().encode(process.env.ACCESS_TOKEN_SECRET!);

const projectId = "22222222-2222-2222-2222-222222222222";

describe("signAccessToken", () => {
  it("mints a verifiable HS256 token with sub = profileId", async () => {
    const token = await signAccessToken(projectId, "profile-123", "visitor");
    const { payload, protectedHeader } = await jwtVerify(token, secret);
    expect(protectedHeader.alg).toBe("HS256");
    expect(payload.sub).toBe("profile-123");
    expect(payload.role).toBe("visitor");
  });

  it("stamps the pid claim with the projectId", async () => {
    const token = await signAccessToken(projectId, "profile-123", "visitor");
    const { payload } = await jwtVerify(token, secret);
    expect(payload.pid).toBe(projectId);
  });

  it("defaults the operator claim to false", async () => {
    const token = await signAccessToken(projectId, "p", "visitor");
    const { payload } = await jwtVerify(token, secret);
    expect(payload.operator).toBe(false);
  });

  it("carries operator = true when requested", async () => {
    const token = await signAccessToken(projectId, "p", "admin", true);
    const { payload } = await jwtVerify(token, secret);
    expect(payload.operator).toBe(true);
    expect(payload.role).toBe("admin");
  });

  it("sets iat and a future exp (TTL window)", async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await signAccessToken(projectId, "p", "visitor");
    const { payload } = await jwtVerify(token, secret);
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect(payload.exp!).toBeGreaterThan(payload.iat!);
    // exp must be in the future relative to issuance.
    expect(payload.exp!).toBeGreaterThanOrEqual(before);
  });

  it("fails verification under the wrong secret", async () => {
    const token = await signAccessToken(projectId, "p", "visitor");
    const wrong = new TextEncoder().encode("a-totally-different-secret-value-here");
    await expect(jwtVerify(token, wrong)).rejects.toThrow();
  });

  it("defaults the settingsReadonly claim to false", async () => {
    const token = await signAccessToken(projectId, "p", "visitor");
    const { payload } = await jwtVerify(token, secret);
    expect(payload.settingsReadonly).toBe(false);
  });

  it("carries settingsReadonly = true when requested", async () => {
    // positional: (projectId, profileId, role, operator, steward, owner, admin, settingsReadonly)
    const token = await signAccessToken(projectId, "p", "visitor", true, false, false, false, true);
    const { payload } = await jwtVerify(token, secret);
    expect(payload.settingsReadonly).toBe(true);
    expect(payload.operator).toBe(true);
  });
});
